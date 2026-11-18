import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import type { prisma } from "@quantself/db";
import { registerBudgetingRoutes } from "./budgeting-route";
import { taxPlan } from "./budget-tax-planning-schema";

const path = "/api/v1/budgeting/tax-planning";
const commandId = "cc4e401d-74a1-4ec7-8b23-b1e97dbc0642";
const permissions = ["budgeting:read", "budgeting:write", "budgeting:delete"];
const claim = { title: "Home office", certainty: "likely", treatment: "deduction", amountCents: 50000, note: "" };
const privateLink = { kind: "document" as const, id: "c3add694-b73c-4ea4-adeb-21022073d438", label: "Fictional receipt label" };
const transactionLink = { kind: "transactions" as const, label: "Bank charges", search: "example shop" };
const taxItem = { id: "desk", title: "Desk", type: "Deduction", amountCents: 2300, claimId: null,
  links: [privateLink, transactionLink] };

function appWith(allowed: string[] | null = permissions, kind: "web" | "api-key" = "api-key", db: unknown = {}) {
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  app.use("*", async (c, next) => {
    c.set("accessContext", allowed && {
      permissions: allowed,
      owner: { id: "owner", email: "owner@example.com", name: "Owner" },
      client: { id: "client", kind, name: "Test client" },
    });
    await next();
  });
  registerBudgetingRoutes(app, db as typeof prisma);
  return app;
}

function command(method: "PUT" | "DELETE", changes?: unknown) {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId, revision: 0, ...(changes === undefined ? {} : { changes }) }),
  };
}

test("tax planning applies per-operation budgeting permissions before reading or writing", async () => {
  expect((await appWith(null).request(path + "?year=2026")).status).toBe(401);
  const app = appWith([]);
  expect((await app.request(path + "?year=2026")).status).toBe(403);
  expect((await app.request(path + "/2026/revisions")).status).toBe(403);
  expect((await app.request(path + "/2026/claims/home-office", command("PUT", claim))).status).toBe(403);
  expect((await appWith(["budgeting:write"]).request(path + "/2026/claims/home-office", command("DELETE"))).status).toBe(403);
  expect((await appWith(permissions, "web").request(path + "/2026/claims/home-office", command("PUT", claim))).status).toBe(403);
});

test("tax planning rejects invalid years, commands, enum values, dates, and link variants", async () => {
  const app = appWith();
  expect((await app.request(path + "?year=2026.5")).status).toBe(400);
  expect((await app.request(path + "/26/revisions")).status).toBe(400);
  expect((await app.request(path + "/2026/claims/bad.id", command("PUT", claim))).status).toBe(400);
  const mutations: [string, unknown][] = [
    ["claims/home-office", { ...claim, certainty: "possible" }],
    ["claims/home-office", { ...claim, treatment: "expense" }],
    ["claims/home-office", { ...claim, amountCents: 50.5 }],
    ["items/desk", { title: "Desk", type: "Expense", amountCents: 0, links: [] }],
    ["items/desk", { title: "Desk", type: "Deduction", amountCents: 0, links: [{ kind: "transactions", label: "Desk", search: "desk", id: "record" }] }],
    ["items/desk", { title: "Desk", type: "Deduction", amountCents: 0, links: [{ kind: "transactions", label: "Desk", search: "x".repeat(181) }] }],
    ["documents-to-gather/receipt", { name: "Receipt", itemId: "desk", where: "", dueDate: "2026-02-30", status: "Requested" }],
    ["documents-to-gather/receipt", { name: "Receipt", itemId: "desk", where: "", dueDate: "2026-02-28", status: "Received" }],
    ["rules", { bands: [{ upToCents: null, rate: 0.2 }, { upToCents: null, rate: 0.3 }], creditRate: 0.2, baselineCreditsCents: 0, medical: { floorRate: 0.03, floorCapCents: 200000 } }],
  ];
  for (const [suffix, changes] of mutations) {
    expect((await app.request(path + "/2026/" + suffix, command("PUT", changes))).status).toBe(400);
  }
  expect((await app.request(path + "/2026/income/t4", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: 0 }),
  })).status).toBe(400);
});

test("OpenAPI exposes the plan and revision reads and all tax writes to permitted API keys", () => {
  const spec = appWith().getOpenAPI31Document({ openapi: "3.1.0", info: { title: "Tests", version: "1" } });
  expect(spec.paths?.[path]?.get?.operationId).toBe("getBudgetTaxPlan");
  expect(spec.paths?.[path + "/{year}/revisions"]?.get?.operationId).toBe("getBudgetTaxPlanRevisions");
  const writePaths = ["rules", ...["income", "withheld", "claims", "items", "documents-to-gather"].map(segment => segment + "/{id}")];
  for (const suffix of writePaths) {
    const endpoints = spec.paths?.[path + "/{year}/" + suffix];
    for (const method of ["put", "delete"] as const) {
      expect(endpoints?.[method]?.security).toContainEqual({ apiKeyAuth: [] });
      expect(endpoints?.[method]?.parameters).toContainEqual(expect.objectContaining({ in: "path", name: "year", required: true }));
      expect(endpoints?.[method]?.requestBody).toMatchObject({ required: true });
      expect(endpoints?.[method]?.responses?.["409"]).toBeDefined();
    }
  }
});

test("tax plan reads the authenticated owner's plan in five bulk queries and omits absent prior totals", async () => {
  const calls: Array<[string, unknown]> = [];
  const read = (table: string) => ({
    findMany: async ({ where }: { where: unknown }) => { calls.push([table, where]); return []; },
  });
  const tx = {
    budgetTaxRules: read("rules"),
    budgetTaxMoneyLine: read("money"),
    budgetTaxClaim: read("claims"),
    budgetTaxItem: read("items"),
    budgetTaxGatherDocument: read("documents"),
  };
  const db = { $transaction: (run: (client: typeof tx) => unknown) => run(tx) };
  const response = await appWith(permissions, "api-key", db).request(path + "?year=2026");
  expect(response.status).toBe(200);
  const payload = await response.json();
  const plan = taxPlan.parse(payload);
  expect(Object.keys(payload as object).sort()).toEqual(["claims", "documentsToGather", "income", "items", "rules", "withheld", "year"]);
  expect(plan).toMatchObject({ year: 2026, income: [], withheld: [], claims: [], items: [], documentsToGather: [] });
  expect(plan.rules.bands.length).toBeGreaterThan(1);
  const twoYears = { ownerId: "owner", year: { in: [2025, 2026] } };
  const thisYear = { ownerId: "owner", year: 2026 };
  expect(calls).toEqual([
    ["rules", twoYears], ["money", twoYears], ["claims", twoYears], ["items", thisYear], ["documents", thisYear],
  ]);
});

test("scoped tax reads conceal private document links while the Owner can see them", async () => {
  const empty = { findMany: async () => [] };
  const tx = { budgetTaxRules: empty, budgetTaxMoneyLine: empty, budgetTaxClaim: empty,
    budgetTaxGatherDocument: empty, budgetTaxItem: { findMany: async () => [taxItem] } };
  const db = { $transaction: (run: (client: typeof tx) => unknown) => run(tx) };
  const [scoped, owner] = await Promise.all([
    appWith(["budgeting:read"], "api-key", db).request(path + "?year=2026"),
    appWith(["budgeting:read"], "web", db).request(path + "?year=2026"),
  ]);
  expect(scoped.status).toBe(200);
  expect(owner.status).toBe(200);
  expect(taxPlan.parse(await owner.json()).items[0].links).toEqual([privateLink, transactionLink]);
  expect(taxPlan.parse(await scoped.json()).items[0].links).toEqual([transactionLink]);
});

test("scoped tax edits preserve existing private document links and cannot probe a receipt ID", async () => {
  let documentLookups = 0;
  let transactions = 0;
  let storedLinks = taxItem.links;
  const tx = {
    budgetTaxCommand: { findUnique: async () => null, create: async () => {} },
    budgetTaxItem: {
      findUnique: async () => ({ revision: 1, links: storedLinks }),
      upsert: async ({ update }: { update: { links: typeof storedLinks } }) => { storedLinks = update.links; },
    },
    budgetReceipt: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
      documentLookups++;
      return where.id.in.includes(privateLink.id) ? [{ id: privateLink.id }] : [];
    } },
  };
  const db = { $transaction: (run: (client: typeof tx) => unknown) => { transactions++; return run(tx); } };
  const app = appWith(["budgeting:write"], "api-key", db);
  const itemPath = path + "/2026/items/desk";
  const edit = (links: typeof storedLinks) => ({
    ...command("PUT"),
    body: JSON.stringify({ commandId: crypto.randomUUID(), revision: 1,
      changes: { title: "Updated desk", type: "Deduction", amountCents: 2300, links } }),
  });
  const [known, unknown] = await Promise.all([
    app.request(itemPath, edit([privateLink])),
    app.request(itemPath, edit([{ ...privateLink, id: "f1a03f4e-3e24-4bd2-912e-14ccd3680dc1" }])),
  ]);
  expect([known.status, unknown.status]).toEqual([403, 403]);
  expect(await known.text()).toEqual(await unknown.text());
  expect(transactions).toBe(0);
  expect((await app.request(itemPath, edit([transactionLink]))).status).toBe(200);
  expect(storedLinks).toHaveLength(2);
  expect(storedLinks).toContainEqual(privateLink);
  expect(storedLinks).toContainEqual(transactionLink);
  expect(documentLookups).toBe(0);
});

test("tax claim commands replay the first revision and return 409 for conflicts", async () => {
  const commands = new Map<string, { revision: number; fingerprint: string }>();
  let revision = 0;
  let writes = 0;
  const tx = {
    budgetTaxCommand: {
      findUnique: async ({ where }: { where: { ownerId_year_commandId: { ownerId: string; year: number; commandId: string } } }) => {
        expect(where.ownerId_year_commandId).toMatchObject({ ownerId: "owner", year: 2026 });
        return commands.get(where.ownerId_year_commandId.commandId) ?? null;
      },
      findFirst: async () => null,
      create: async ({ data }: { data: { commandId: string; revision: number; fingerprint: string } }) => commands.set(data.commandId, data),
    },
    budgetTaxClaim: {
      findUnique: async ({ where }: { where: unknown }) => {
        expect(where).toEqual({ ownerId_year_id: { ownerId: "owner", year: 2026, id: "home-office" } });
        return revision === 0 ? null : { revision };
      },
      upsert: async ({ create }: { create: typeof claim & { revision: number } }) => {
        expect(create).toMatchObject(claim);
        revision = create.revision;
        writes++;
      },
      delete: async ({ where }: { where: unknown }) => {
        expect(where).toEqual({ ownerId_year_id: { ownerId: "owner", year: 2026, id: "home-office" } });
        revision = 0;
        writes++;
      },
    },
  };
  const db = { $transaction: (run: (client: typeof tx) => unknown) => run(tx) };
  const claimPath = path + "/2026/claims/home-office";
  const app = appWith(permissions, "api-key", db);
  const first = await app.request(claimPath, command("PUT", claim));
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ commandId, revision: 1 });
  const replay = await app.request(claimPath, command("PUT", claim));
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ commandId, revision: 1 });
  expect((await app.request(claimPath, command("PUT", { ...claim, amountCents: 25000 }))).status).toBe(409);
  const stale = command("PUT", claim);
  stale.body = JSON.stringify({ commandId: crypto.randomUUID(), revision: 0, changes: claim });
  expect((await app.request(claimPath, stale)).status).toBe(409);
  expect(writes).toBe(1);

  const remove = command("DELETE");
  const removeId = crypto.randomUUID();
  remove.body = JSON.stringify({ commandId: removeId, revision: 1 });
  const deleted = await app.request(claimPath, remove);
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toEqual({ commandId: removeId, revision: 2 });
  const retriedDelete = await app.request(claimPath, remove);
  expect(retriedDelete.status).toBe(200);
  expect(await retriedDelete.json()).toEqual({ commandId: removeId, revision: 2 });
  expect(writes).toBe(2);
});
