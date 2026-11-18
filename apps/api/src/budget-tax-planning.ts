import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@quantself/db/generated/prisma/client";
import { calc, defaultOn, totalIncome, totalWithheld } from "@quantself/budgeting/tax-calc";
import type { AppLink, Claim, GatherDocument, MoneyLine, TaxItem, TaxRules, TaxYearPlan } from "@quantself/budgeting/tax-model";
import { defaultTaxRules, unconfiguredTaxRules } from "./budget-tax-planning-rules";
import { budgetPlan } from "./budgeting";

type Revision = { revision: number; commandId: string };
type RecordKind = keyof RecordChanges;
type RecordChanges = {
  income: MoneyLine;
  withheld: MoneyLine;
  claims: Omit<Claim, "id">;
  items: Omit<TaxItem, "id">;
  documentsToGather: Omit<GatherDocument, "id">;
};
type RecordMutation<K extends RecordKind = RecordKind> = {
  [P in K]: { kind: P; id: string } & (
    | { operation: "put"; changes: RecordChanges[P] }
    | { operation: "delete" }
  )
}[K];
type RulesMutation = { kind: "rules" } & (
  | { operation: "put"; changes: TaxRules }
  | { operation: "delete" }
);
type Mutation = Revision & (RecordMutation | RulesMutation);
type Scope = { ownerId: string; year: number };
type Tx = Prisma.TransactionClient;

export class TaxPlanningError extends Error {
  constructor(readonly status: 400 | 403 | 409, message: string) {
    super(message);
  }
}

const stableOrder = [{ createdAt: "asc" }, { id: "asc" }] as const;
const revisionFields = { revision: true, commandId: true } as const;
const recordRevisionFields = { id: true, ...revisionFields } as const;

function planRules(row: Pick<Prisma.BudgetTaxRulesGetPayload<object>,
  "bands" | "creditRate" | "baselineCreditsCents" | "medicalFloorRate" | "medicalFloorCapCents"> | undefined,
year: number) {
  if (!row) return defaultTaxRules(year) ?? unconfiguredTaxRules;
  return {
    bands: row.bands as TaxRules["bands"],
    creditRate: row.creditRate,
    baselineCreditsCents: row.baselineCreditsCents,
    medical: { floorRate: row.medicalFloorRate, floorCapCents: row.medicalFloorCapCents },
  };
}

async function getPlan(tx: Tx, ownerId: string, year: number, canAccessDocumentLinks: boolean): Promise<TaxYearPlan> {
  const where = { ownerId, year: { in: [year - 1, year] } };
  const orderBy = [...stableOrder];
  const [rules, money, claims, items, documents] = await Promise.all([
    tx.budgetTaxRules.findMany({ where, select: {
      year: true, bands: true, creditRate: true, baselineCreditsCents: true, medicalFloorRate: true, medicalFloorCapCents: true,
    } }),
    tx.budgetTaxMoneyLine.findMany({ where, orderBy, select: { year: true, kind: true, label: true, note: true, cents: true } }),
    tx.budgetTaxClaim.findMany({ where, orderBy, select: {
      year: true, id: true, title: true, certainty: true, treatment: true, amountCents: true, note: true,
    } }),
    tx.budgetTaxItem.findMany({ where: { ownerId, year }, orderBy, select: {
      id: true, title: true, type: true, amountCents: true, claimId: true, links: true,
    } }),
    tx.budgetTaxGatherDocument.findMany({ where: { ownerId, year }, orderBy, select: {
      id: true, name: true, itemId: true, where: true, dueDate: true, status: true,
    } }),
  ]);
  function financialLines(selectedYear: number) {
    const selectedMoney = money.filter(row => row.year === selectedYear);
    return {
      income: selectedMoney.filter(row => row.kind === "income").map(({ label, note, cents }) => ({ label, note, cents })),
      withheld: selectedMoney.filter(row => row.kind === "withheld").map(({ label, note, cents }) => ({ label, note, cents })),
      claims: claims.filter(row => row.year === selectedYear).map(({ year: _year, ...claim }) => claim),
    };
  }
  const plan: TaxYearPlan = {
    year,
    rules: planRules(rules.find(row => row.year === year), year),
    ...financialLines(year),
    items: items.map(({ claimId, links, ...item }) => ({
      ...item, ...(claimId === null ? {} : { claimId }),
      links: (links as AppLink[]).filter(link => canAccessDocumentLinks || link.kind !== "document"),
    })),
    documentsToGather: documents.map(document => ({
      ...document, status: document.status === "ToGather" ? "To gather" : "Requested",
    })),
  };
  const priorRules = planRules(rules.find(row => row.year === year - 1), year - 1);
  const priorLines = financialLines(year - 1);
  // A rules override or a checklist by itself supplies no previous-year financial totals.
  if (priorLines.income.length || priorLines.withheld.length || priorLines.claims.length) {
    const previous = { year: year - 1, rules: priorRules, ...priorLines, items: [], documentsToGather: [] };
    const totals = calc(previous, defaultOn(previous));
    plan.prior = {
      incomeCents: totalIncome(previous),
      deductionsCents: totals.deductions,
      creditsCents: totals.credits,
      withheldCents: totalWithheld(previous),
      taxOwedCents: totals.owed,
    };
  }
  return plan;
}

async function getState(tx: Tx, where: Scope) {
  const orderBy = [...stableOrder];
  const [rules, money, claims, items, documentsToGather] = await Promise.all([
    tx.budgetTaxRules.findUnique({ where: { ownerId_year: where }, select: revisionFields }),
    tx.budgetTaxMoneyLine.findMany({ where, orderBy, select: { kind: true, label: true, note: true, cents: true, ...recordRevisionFields } }),
    tx.budgetTaxClaim.findMany({ where, orderBy, select: recordRevisionFields }),
    tx.budgetTaxItem.findMany({ where, orderBy, select: recordRevisionFields }),
    tx.budgetTaxGatherDocument.findMany({ where, orderBy, select: recordRevisionFields }),
  ]);
  return {
    rules,
    income: money.filter(row => row.kind === "income").map(({ kind: _kind, ...row }) => row),
    withheld: money.filter(row => row.kind === "withheld").map(({ kind: _kind, ...row }) => row),
    claims, items, documentsToGather,
  };
}

async function countSubscriptionTargets(tx: Tx, ownerId: string, ids: Set<string>) {
  if (!ids.size) return 0;
  const records = await tx.budgetSubscription.findMany({
    where: { ownerId, id: { in: [...ids] } }, select: { id: true, status: true, planEntry: true },
  });
  const hidden = (status: string) => status === "candidate" || status === "dismissed";
  const visibleIds = new Set(records.filter(row => !row.planEntry && !hidden(row.status)).map(row => row.id));
  if (visibleIds.size === ids.size) return visibleIds.size;

  // Subscriptions also opens plan entries that have no Subscription row. Metadata
  // can hide a recurring entry, while one-off entries are shown independently.
  const plan = await tx.budgetPlan.findUnique({ where: { ownerId }, select: { plan: true } });
  const hiddenEntries = new Set(records.filter(row => row.planEntry && hidden(row.status)).map(row => row.id));
  for (const entry of plan ? budgetPlan.parse(plan.plan).entries : []) {
    if (ids.has(entry.id) && (entry.frequency === "once" || !hiddenEntries.has(entry.id))) visibleIds.add(entry.id);
  }
  return visibleIds.size;
}

async function validateLinks(tx: Tx, ownerId: string, links: AppLink[]) {
  const documentIds = new Set<string>();
  const subscriptionIds = new Set<string>();
  const inventoryIds = new Set<string>();
  for (const link of links) {
    if (link.kind === "transactions" || !link.id) continue;
    if (link.kind === "document") documentIds.add(link.id);
    if (link.kind === "subscription") subscriptionIds.add(link.id);
    if (link.kind === "inventoryItem") inventoryIds.add(link.id);
  }
  const [documents, subscriptionCount, inventory] = await Promise.all([
    documentIds.size ? tx.budgetReceipt.findMany({
      where: { ownerId, id: { in: [...documentIds] } }, select: { id: true },
    }) : [],
    countSubscriptionTargets(tx, ownerId, subscriptionIds),
    // Inventory belongs to the installation's single Owner. Confirm that Owner before
    // accepting an ID from the global inventory table.
    inventoryIds.size ? tx.authOwner.findUnique({
      where: { userId: ownerId }, select: { id: true },
    }).then(owner => owner ? tx.inventoryItem.findMany({
      where: { id: { in: [...inventoryIds] } }, select: { id: true },
    }) : []) : [],
  ]);
  if (documents.length !== documentIds.size) throw new TaxPlanningError(400, "A linked document was not found.");
  if (subscriptionCount !== subscriptionIds.size) throw new TaxPlanningError(400, "A linked subscription was not found.");
  if (inventory.length !== inventoryIds.size) throw new TaxPlanningError(400, "A linked inventory item was not found.");
}

async function updateRecord(tx: Tx, scope: Scope, mutation: Mutation, revision: Revision, retainedLinks: AppLink[]) {
  if (mutation.kind === "rules") {
    const where = { ownerId_year: scope };
    if (mutation.operation === "delete") {
      await tx.budgetTaxRules.delete({ where });
    } else {
      const { medical, ...fields } = mutation.changes;
      const data = { ...fields, medicalFloorRate: medical.floorRate, medicalFloorCapCents: medical.floorCapCents, ...revision };
      await tx.budgetTaxRules.upsert({ where, create: { ...scope, ...data }, update: data });
    }
    return;
  }

  const key = { ...scope, id: mutation.id };
  const where = { ownerId_year_id: key };
  switch (mutation.kind) {
    case "income":
    case "withheld": {
      const moneyKey = { ...key, kind: mutation.kind };
      const where = { ownerId_year_kind_id: moneyKey };
      if (mutation.operation === "delete") await tx.budgetTaxMoneyLine.delete({ where });
      else {
        const data = { ...mutation.changes, ...revision };
        await tx.budgetTaxMoneyLine.upsert({ where, create: { ...moneyKey, ...data }, update: data });
      }
      return;
    }
    case "claims": {
      if (mutation.operation === "delete") await tx.budgetTaxClaim.delete({ where });
      else {
        const data = { ...mutation.changes, ...revision };
        await tx.budgetTaxClaim.upsert({ where, create: { ...key, ...data }, update: data });
      }
      return;
    }
    case "items": {
      if (mutation.operation === "delete") await tx.budgetTaxItem.delete({ where });
      else {
        const { claimId, links, ...fields } = mutation.changes;
        await validateLinks(tx, scope.ownerId, links);
        const data = { ...fields, links: [...links, ...retainedLinks], claimId: claimId ?? null, ...revision };
        await tx.budgetTaxItem.upsert({ where, create: { ...key, ...data }, update: data });
      }
      return;
    }
    case "documentsToGather": {
      if (mutation.operation === "delete") await tx.budgetTaxGatherDocument.delete({ where });
      else {
        const { status, ...fields } = mutation.changes;
        const data = { ...fields, status: status === "To gather" ? "ToGather" as const : "Requested" as const, ...revision };
        await tx.budgetTaxGatherDocument.upsert({ where, create: { ...key, ...data }, update: data });
      }
    }
  }
}

function activeRecord(tx: Tx, scope: Scope, mutation: Mutation, retainDocumentLinks: boolean) {
  if (mutation.kind === "rules") {
    return tx.budgetTaxRules.findUnique({ where: { ownerId_year: scope }, select: { revision: true } });
  }
  const key = { ...scope, id: mutation.id };
  const where = { ownerId_year_id: key };
  const select = { revision: true } as const;
  switch (mutation.kind) {
    case "income":
    case "withheld":
      return tx.budgetTaxMoneyLine.findUnique({ where: { ownerId_year_kind_id: { ...key, kind: mutation.kind } }, select });
    case "claims":
      return tx.budgetTaxClaim.findUnique({ where, select });
    case "items":
      return tx.budgetTaxItem.findUnique({ where, select: { ...select, links: retainDocumentLinks } });
    case "documentsToGather":
      return tx.budgetTaxGatherDocument.findUnique({ where, select });
  }
}

function fingerprint(value: Mutation) {
  // Sort object keys at every level so equivalent JSON payloads retry identically.
  const canonical = JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]]))
      : entry);
  return createHash("sha256").update(canonical).digest("hex");
}

export function createTaxPlanningStore(db: PrismaClient) {
  return {
    getPlan: (ownerId: string, year: number, canAccessDocumentLinks = true) =>
      db.$transaction(tx => getPlan(tx, ownerId, year, canAccessDocumentLinks), { isolationLevel: "RepeatableRead" }),
    getState: (ownerId: string, year: number) =>
      db.$transaction(tx => getState(tx, { ownerId, year }), { isolationLevel: "RepeatableRead" }),
    async write(ownerId: string, year: number, mutation: Mutation, canAccessDocumentLinks = true): Promise<Revision> {
      const retainDocumentLinks = !canAccessDocumentLinks && mutation.kind === "items" && mutation.operation === "put";
      if (retainDocumentLinks && mutation.changes.links.some(link => link.kind === "document")) {
        throw new TaxPlanningError(403, "Document links require the Owner interface.");
      }
      const scope = { ownerId, year };
      const commandId = mutation.commandId;
      const hash = fingerprint(mutation);
      const recordId = mutation.kind === "rules" ? "" : mutation.id;
      for (let attempt = 0; ; attempt++) {
        try {
          return await db.$transaction(async tx => {
            const prior = await tx.budgetTaxCommand.findUnique({
              where: { ownerId_year_commandId: { ...scope, commandId } },
              select: { revision: true, fingerprint: true },
            });
            if (prior) {
              if (prior.fingerprint !== hash) throw new TaxPlanningError(409, "This command ID was already used.");
              return { revision: prior.revision, commandId };
            }
            const current = await activeRecord(tx, scope, mutation, retainDocumentLinks);
            if ((current?.revision ?? 0) !== mutation.revision || (!current && mutation.operation === "delete")) {
              throw new TaxPlanningError(409, "The tax planning record has changed. Refresh its revision and try again.");
            }
            // Preserve monotonic revisions across deletion and recreation of the same identity.
            const last = current ?? await tx.budgetTaxCommand.findFirst({
              where: { ...scope, kind: mutation.kind, recordId }, orderBy: { revision: "desc" }, select: { revision: true },
            });
            const response = { revision: (last?.revision ?? 0) + 1, commandId };
            // A scoped replacement only controls the links that caller can see.
            const retainedLinks = retainDocumentLinks && current && "links" in current
              ? (current.links as AppLink[]).filter(link => link.kind === "document") : [];
            await updateRecord(tx, scope, mutation, response, retainedLinks);
            await tx.budgetTaxCommand.create({ data: { ...scope, ...response, fingerprint: hash, kind: mutation.kind, recordId } });
            return response;
          }, { isolationLevel: "Serializable" });
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
          // PostgreSQL reports ON DELETE RESTRICT as SQLSTATE 23001. Prisma's
          // pg adapter forwards it as a driver error instead of a P2003.
          const cause = error instanceof Error ? error.cause : undefined;
          const sqlState = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
          if (code === "P2003" || sqlState === "23001") {
            if (mutation.operation === "delete") throw new TaxPlanningError(409, "Remove references to this record before deleting it.");
            throw new TaxPlanningError(400, "The referenced claim or item was not found in this tax year.");
          }
          if (code !== "P2034" && code !== "P2002" && code !== "P2025" && sqlState !== "40P01") throw error;
          if (attempt >= 2) throw new TaxPlanningError(409, "The tax planning record changed concurrently. Try again.");
        }
      }
    },
  };
}
