import { z } from "@hono/zod-openapi";

const taxId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const pathYear = z.string().regex(/^[1-9][0-9]{3}$/).describe("Four-digit tax year");
export const taxYearQuery = z.object({ year: pathYear });
export const taxYearPath = z.object({ year: pathYear });
export const taxRecordPath = taxYearPath.extend({ id: taxId });

const cents = z.int32();
const nonnegativeCents = cents.nonnegative();
const rate = z.number().min(0).max(1);
const title = z.string().min(1).max(500);
const note = z.string().max(4000);
const moneyLine = z.strictObject({ label: title, note, cents });
const claimFields = z.strictObject({
  title,
  certainty: z.enum(["confirmed", "likely", "uncertain"]),
  treatment: z.enum(["deduction", "credit", "medicalCredit"]),
  amountCents: nonnegativeCents,
  note,
});
const link = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("transactions"), label: title, search: z.string().trim().max(180) }),
  z.strictObject({ kind: z.literal("document"), label: title, id: taxId.optional() }),
  z.strictObject({ kind: z.literal("subscription"), label: title, id: taxId.optional() }),
  z.strictObject({ kind: z.literal("inventoryItem"), label: title, id: taxId.optional() }),
]);
const itemFields = z.strictObject({
  title,
  type: z.enum(["Income", "Deduction", "Credit", "Payment"]),
  amountCents: cents,
  claimId: taxId.optional(),
  links: z.array(link),
});
const gatherFields = z.strictObject({
  name: title,
  itemId: taxId,
  where: note,
  dueDate: z.iso.date(),
  status: z.enum(["To gather", "Requested"]),
});
const rules = z.strictObject({
  bands: z.array(z.strictObject({ upToCents: cents.positive().nullable(), rate }))
    .min(1).refine((bands) => {
      let prior = 0;
      for (const band of bands.slice(0, -1)) {
        if (band.upToCents === null || band.upToCents <= prior) return false;
        prior = band.upToCents;
      }
      return bands.at(-1)?.upToCents === null;
    }, "Use ascending band thresholds followed by a final uncapped band."),
  creditRate: rate,
  baselineCreditsCents: nonnegativeCents,
  medical: z.strictObject({ floorRate: rate, floorCapCents: nonnegativeCents }),
});
const prior = z.object({
  incomeCents: z.number().int(),
  deductionsCents: z.number().int(),
  creditsCents: z.number().int(),
  withheldCents: z.number().int(),
  taxOwedCents: z.number().int(),
});

export const taxPlan = z.object({
  year: z.number().int(),
  rules: rules.describe(
    "Uses the built-in Nova Scotia defaults in 2026. Other years without owner-supplied rules use zero rates and credits.",
  ),
  income: z.array(moneyLine),
  withheld: z.array(moneyLine),
  claims: z.array(claimFields.extend({ id: taxId })),
  items: z.array(itemFields.extend({ id: taxId })),
  documentsToGather: z.array(gatherFields.extend({ id: taxId })),
  prior: prior.optional().describe(
    "Previous-year totals using that year's effective rules and Confirmed and Likely claims. Included when that year has financial lines or claims.",
  ),
});
export const taxCommand = z.strictObject({
  revision: z.int32().nonnegative().describe("Current record revision, or 0 for a new record."),
  commandId: z.uuid().describe("Reuse for an identical retry of this command."),
});
const recordRevision = taxCommand.extend({ id: taxId });
const moneyLineRevision = recordRevision.extend(moneyLine.shape);
export const taxRevisions = z.object({
  rules: taxCommand.nullable().describe("Null when the year uses its default rules."),
  income: z.array(moneyLineRevision).describe("Income lines with their record IDs and current revisions."),
  withheld: z.array(moneyLineRevision).describe("Withholding lines with their record IDs and current revisions."),
  claims: z.array(recordRevision),
  items: z.array(recordRevision),
  documentsToGather: z.array(recordRevision),
});
export const taxChanges = {
  rules,
  income: moneyLine,
  withheld: moneyLine,
  claims: claimFields,
  items: itemFields,
  documentsToGather: gatherFields,
};
