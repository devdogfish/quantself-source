import { z } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { prisma } from "@quantself/db";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { BudgetRoute } from "./budget-route-types";
import { createTaxPlanningStore, TaxPlanningError } from "./budget-tax-planning";
import { taxChanges, taxCommand, taxPlan, taxRecordPath, taxRevisions, taxYearPath, taxYearQuery } from "./budget-tax-planning-schema";

const createExample = { revision: 0, commandId: "cc4e401d-74a1-4ec7-8b23-b1e97dbc0642" };
const deleteExample = { revision: 1, commandId: "617dc75b-89c8-4a7a-abe9-4fdda561fcad" };
const savedExample = { ...createExample, revision: 1 };
const deletedExample = { ...deleteExample, revision: 2 };
const rulesExample = {
  bands: [{ upToCents: 5000000, rate: 0.2 }, { upToCents: null, rate: 0.3 }],
  creditRate: 0.2, baselineCreditsCents: 300000, medical: { floorRate: 0.03, floorCapCents: 280000 },
};
const incomeExample = { label: "Employment", note: "T4", cents: 7800000 };
const withheldExample = { label: "Employment withholding", note: "T4 box 22", cents: 1450000 };
type TaxContext = Context<{ Variables: { accessContext: AccessContext | null } }>;

export function registerBudgetTaxPlanning(route: BudgetRoute, db = prisma) {
  const store = createTaxPlanningStore(db);
  const path = "/tax-planning";
  route("get", path, "getBudgetTaxPlan", "Read a tax year plan", taxPlan, {
    year: 2026, rules: rulesExample, income: [incomeExample], withheld: [withheldExample],
    claims: [], items: [], documentsToGather: [],
  },
    (c, ownerId, _input, { year }) => store.getPlan(ownerId, Number(year), c.get("accessContext")?.client.kind === "web"),
    { query: taxYearQuery });
  route("get", path + "/{year}/revisions", "getBudgetTaxPlanRevisions", "Read tax year record IDs and revisions for writes", taxRevisions, {
    rules: null, income: [{ ...incomeExample, ...savedExample, id: "t4-income" }],
    withheld: [], claims: [], items: [], documentsToGather: [],
  },
    (c, ownerId) => store.getState(ownerId, Number(c.req.param("year"))),
    { params: taxYearPath });

  type Mutation = Parameters<typeof store.write>[2];
  async function write(c: TaxContext, ownerId: string, mutation: Mutation) {
    try {
      return await store.write(ownerId, Number(c.req.param("year")), mutation, c.get("accessContext")?.client.kind === "web");
    } catch (cause) {
      if (cause instanceof TaxPlanningError) throw new HTTPException(cause.status, { message: cause.message });
      throw cause;
    }
  }

  const retry = "repeat an identical command with the same commandId and revision";
  const rulesPath = path + "/{year}/rules";
  route("put", rulesPath, "saveBudgetTaxRules", "Set the tax rules for a year", taxCommand, savedExample,
    (c, ownerId, input) => write(c, ownerId, { ...input, kind: "rules", operation: "put" }),
    { params: taxYearPath, input: taxCommand.extend({ changes: taxChanges.rules.describe("Complete replacement rules for this year.") }), inputExample: { ...createExample, changes: rulesExample }, retry });
  route("delete", rulesPath, "deleteBudgetTaxRules", "Reset the tax rules for a year to their defaults", taxCommand, deletedExample,
    (c, ownerId, input) => write(c, ownerId, { ...input, kind: "rules", operation: "delete" }),
    { params: taxYearPath, input: taxCommand, inputExample: deleteExample, retry });

  function records<Changes extends z.ZodType>(
    segment: string,
    operation: string,
    label: string,
    kind: Exclude<Mutation["kind"], "rules">,
    changes: Changes,
    example: NoInfer<z.input<Changes>>,
    toPut: (id: string, input: z.output<Changes>, command: z.output<typeof taxCommand>) => Mutation,
  ) {
    const recordPath = path + "/{year}/" + segment + "/{id}";
    route("put", recordPath, "saveBudgetTax" + operation, "Create or update a tax " + label, taxCommand, savedExample,
      (c, ownerId, input) => {
        const { changes, ...command } = input as z.output<typeof taxCommand> & { changes: z.output<Changes> };
        return write(c, ownerId, toPut(c.req.param("id")!, changes, command));
      }, { params: taxRecordPath, input: taxCommand.extend({ changes: changes.describe("Complete replacement of the record fields.") }), inputExample: { ...createExample, changes: example }, retry });
    route("delete", recordPath, "deleteBudgetTax" + operation, "Delete a tax " + label, taxCommand, deletedExample,
      (c, ownerId, input) => write(c, ownerId, { ...input, kind, operation: "delete", id: c.req.param("id")! }),
      { params: taxRecordPath, input: taxCommand, inputExample: deleteExample, retry });
  }
  records("income", "IncomeLine", "income line", "income", taxChanges.income, incomeExample,
    (id, changes, command) => ({ ...command, id, changes, kind: "income", operation: "put" }));
  records("withheld", "WithheldLine", "withholding line", "withheld", taxChanges.withheld, withheldExample,
    (id, changes, command) => ({ ...command, id, changes, kind: "withheld", operation: "put" }));
  records("claims", "Claim", "claim", "claims", taxChanges.claims,
    { title: "Home office", certainty: "likely", treatment: "deduction", amountCents: 50000, note: "Confirm eligible expenses." },
    (id, changes, command) => ({ ...command, id, changes, kind: "claims", operation: "put" }));
  records("items", "Item", "item", "items", taxChanges.items,
    { title: "Office supplies", type: "Deduction", amountCents: 50000, claimId: "home-office", links: [] },
    (id, changes, command) => ({ ...command, id, changes, kind: "items", operation: "put" }));
  records("documents-to-gather", "GatherDocument", "document to gather", "documentsToGather", taxChanges.documentsToGather,
    { name: "Office supplies receipt", itemId: "office-supplies", where: "Email", dueDate: "2027-04-01", status: "To gather" },
    (id, changes, command) => ({ ...command, id, changes, kind: "documentsToGather", operation: "put" }));
}
