import { getPublicOrigin } from "@quantself/auth/public-origin";
import { originalFiles, queueOriginalDeletion } from "./original-files";
import { originalsEnabled, OriginalStorageError, assertOriginalWritesEnabled, withOriginalUploadSlot } from "./original-storage";
import { registerBudgetModuleOverview } from "./budget-module-overview";
import { createCurrencyConverter, currencyCode, conversionSchema, FxUnavailable } from "./budget-fx";
import { convertMoney } from "@quantself/budgeting";
import { budgetDocument, documentFilters, documentPage, exportDocumentsPage, getDocument, listDocuments } from "./budget-documents";
import { registerBudgetExtras } from "./budget-extras-route";
import { registerBudgetTaxPlanning } from "./budget-tax-planning-route";
import { effectiveBudgetLimits, readBudgetLimitSchedule, recordPlanLimits, registerBudgetTransactions } from "./budget-transactions-route";
import { createHash } from "node:crypto";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { createMiddleware } from "hono/factory";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import type { AccessContext } from "@quantself/auth";
import { prisma } from "@quantself/db";
import { Prisma } from "@quantself/db/generated/prisma/client";
import { bankImportInput, importBankRows, prepareBankRows, reconcileBankReceipts } from "./budget-bank-import";

import { subscriptionPayments } from "@quantself/budgeting";
import { subscription, subscriptionWrite, subscriptionList, subscriptionCalendar, subscriptionRange,
  subscriptionSelect, reconcileSubscriptionPayments, subscriptionEntries, priceSubscriptions, subscriptionIntent,
  combineRecurringRules, planRecurringRule, withRecurringPlanStatus, recurringChanges } from "./budget-subscriptions";

import {
  applyInput, billMatchInput, billOccurrences, budgetDocumentKind, budgetDocumentScanProvenance, budgetPlan, budgetState, checkpointInput,
  emptyPlan, expense, expenseInput, forecast, isCadBudgetDocument, isFinancialDocument, localDate, noteInput, overview, summarizeBudgetActivity,
  pendingMoneyInput, proposalInput, receipt, receiptInput, samePendingMoney, shiftDate, weekStart,
} from "./budgeting";

type Env = { Variables: { accessContext: AccessContext | null } };
const maxDocumentBytes = 24 * 1024 * 1024;
const receiptFields = {
  id: true, merchant: true, date: true, totalCents: true, lines: true,
  mime: true, createdAt: true, scanStatus: true, scanProvenance: true, expense: true,
  kind: true, title: true, currency: true, invoiceNumber: true, dueDate: true, amazonAsin: true,
} as const;
const fail = (status: 400 | 403 | 404 | 409, message: string): never => { throw new HTTPException(status, { message }); };
const protectedExpense = "This expense requires the Owner interface.";
const stampCheckpoint = (point: { date: string; cents: number }) =>
  point.date === localDate() ? { ...point, recordedAt: new Date().toISOString() } : point;
const acknowledge = z.object({ ok: z.boolean() });
const listing = z.object({ receipts: z.array(receipt.omit({ lines: true })), next: z.string().nullable(), documents: documentPage.optional() });
const sampleId = "cc4e401d-74a1-4ec7-8b23-b1e97dbc0642";
const sampleState: z.infer<typeof budgetState> = { revision: 0, note: "", plan: emptyPlan, proposal: null };
const sampleExpense = { id: sampleId, merchant: "Grocer", date: "2026-11-08", totalCents: 2500, foodCents: 2500, receiptId: null, billKey: null };
const sampleReceipt: z.infer<typeof receipt> = { id: sampleId, kind: "receipt", title: null, currency: null, invoiceNumber: null, dueDate: null, amazonAsin: null, merchant: "", date: null, totalCents: null, lines: [], mime: null, createdAt: "2026-11-08T00:00:00Z", scanStatus: "manual", expense: null };
const scenario = z.object({
  food: z.coerce.number().int().min(0).max(100_000_000).optional(),
  other: z.coerce.number().int().min(0).max(100_000_000).optional(),
  uncertain: z.enum(["true", "false"]).optional(),
});
const receiptFilters = z.object({
  reveal: z.literal("yes").optional(), q: z.string().max(180).optional(),
  kind: budgetDocumentKind.optional(), subscriptionId: z.uuid().optional(),
});
const listQuery = receiptFilters.extend({
  ...documentFilters.shape,
  cursor: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(100_000_000).optional(),
  years: z.literal("yes").optional(),
});
const exportQuery = receiptFilters.extend({
  ...documentFilters.shape,
  reveal: z.literal("yes"),
  format: z.enum(["ids", "csv", "documents"]),
});
const receiptExportRow = receipt.pick({
  id: true, kind: true, title: true, merchant: true, date: true,
  createdAt: true, scanStatus: true, scanProvenance: true, totalCents: true, currency: true,
}).extend({ expenseStatus: z.enum(["matched", "cash"]).nullable() });
const receiptExport = z.union([z.object({ ids: z.array(z.uuid()) }), z.object({ rows: z.array(receiptExportRow) }), z.object({ documents: z.array(budgetDocument) })]);
const receiptOrder: Prisma.BudgetReceiptOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];
const exportBatchSize = 500;

function receiptWhere(ownerId: string, query: z.infer<typeof receiptFilters>): Prisma.BudgetReceiptWhereInput {
  return {
    ownerId,
    kind: query.kind,
    ...(query.subscriptionId ? { expense: { subscriptionId: query.subscriptionId } } : {}),
    ...(query.reveal && query.q ? { OR: [
      { merchant: { contains: query.q, mode: "insensitive" } },
      { title: { contains: query.q, mode: "insensitive" } },
    ] } : {}),
  };
}

function receiptCursor(ownerId: string, cursor?: string): Pick<Prisma.BudgetReceiptFindManyArgs, "cursor" | "skip"> {
  return cursor ? { cursor: { ownerId_id: { ownerId, id: cursor } }, skip: 1 } : {};
}

async function readReceiptExport<T extends { id: string }, Row>(
  readPage: (cursor?: string) => Promise<T[]>,
  project: (row: T) => Row,
  signal: AbortSignal,
) {
  const result: Row[] = [];
  let cursor: string | undefined;
  do {
    signal.throwIfAborted();
    const rows = await readPage(cursor);
    signal.throwIfAborted();
    result.push(...rows.slice(0, exportBatchSize).map(project));
    cursor = rows.length > exportBatchSize ? rows[exportBatchSize - 1].id : undefined;
  } while (cursor);
  return result;
}
const upload = z.object({
  id: z.uuid(), scan: z.enum(["yes", "no"]).optional().describe("Use no to archive the original without OCR; omitted preserves automatic scanning."), kind: budgetDocumentKind.optional(),
  title: z.string().trim().min(1).max(180).optional(),
  photo: z.file().max(maxDocumentBytes).openapi({ type: "string", format: "binary" }).optional(),
});
const originalMedia = { schema: z.string().openapi({ format: "binary" }) };

export function registerBudgetingRoutes(app: OpenAPIHono<Env>, db = prisma) {
  const fx = createCurrencyConverter(db);
  const serializable = { isolationLevel: "Serializable" } as const;
  const budgetSpend = { OR: [{ bankFlow: null }, { bankFlow: { in: ["expense", "refund"] } }] };

  const error = { description: "Budget request failed.", content: { "application/json": {
    schema: z.object({ message: z.string() }), example: { message: "Budget data changed. Reload and try again." },
  } } };

  function route<Output extends z.ZodType, Input extends z.ZodType, Query extends z.ZodObject>(
    method: "get" | "post" | "put" | "delete",
    path: string,
    operationId: string,
    summary: string,
    output: Output,
    example: unknown,
    handler: (c: Context<Env>, ownerId: string, input: z.output<Input>, query: z.output<Query>) => Promise<z.input<Output> | Response>,
    options: { input?: Input; query?: Query; params?: z.ZodObject; inputExample?: unknown; multipart?: boolean; image?: boolean; ownerOnly?: boolean; retry?: string } = {},
  ) {
    const destructive = method === "delete";
    const permission = `budgeting:${method === "get" ? "read" : destructive ? "delete" : "write"}`;
    const authorize = createMiddleware<Env>(async (c, next) => {
      c.header("Cache-Control", "no-store");
      const access = c.get("accessContext");
      if (!access) return c.json({ message: "Authentication required." }, 401);
      if (!access.permissions.includes(permission) || (options.ownerOnly && access.client.kind !== "web"))
        return c.json({ message: "Missing budget permission." }, 403);
      if (method !== "get" && access.client.kind === "web" &&
        c.req.header("origin") !== (getPublicOrigin() ?? new URL(c.req.url).origin))
        return c.json({ message: "Invalid origin." }, 403);
      await next();
    });
    app.openapi(createRoute({
      method, path: "/api/v1/budgeting" + path, operationId, summary, tags: ["Budgeting"],
      description: `Authentication: ${options.ownerOnly ? "trusted Owner ingress" : "trusted Owner ingress or API Key"}. Required permissions: ${permission}. Inputs: ${summary}. Success response: budget result. Failure responses: invalid request, access denied, missing record, conflict or service unavailable. Side effects: ${method === "get" ? "none" : summary}. Destructive: ${destructive ? "yes" : "no"}. Retry safety: ${options.retry ?? (method === "get" ? "safe read" : "reconcile with current state after a conflict")}.`,
      security: options.ownerOnly ? [{ ownerSession: [] }] : [{ apiKeyAuth: [] }, { ownerSession: [] }],
      "x-required-permissions": [permission], "x-destructive": destructive,
      middleware: options.multipart ? [authorize, bodyLimit({ maxSize: maxDocumentBytes + 8192 })] : [authorize],
      request: {
        params: options.params ?? (path.includes("{id}") ? z.object({ id: z.uuid() }) : undefined),
        ...(options.query ? { query: options.query } : {}),
        ...(options.input ? { body: { required: true, content: {
          [options.multipart ? "multipart/form-data" : "application/json"]: { schema: options.input, example: options.inputExample },
        } } } : {}),
      },
      responses: {
        ...(options.image ? { 206: { description: "Original byte range", content: { "application/octet-stream": originalMedia } }, 416: { description: "Requested byte range is unsatisfiable" } } : {}),
        200: { description: summary, content: options.image
          ? { "image/jpeg": originalMedia, "image/png": originalMedia, "image/webp": originalMedia, "application/pdf": originalMedia }
          : { "application/json": { schema: output, example } } },
        400: error, 401: error, 403: error, 404: error, 409: error, 413: error, 503: error,
      },
    }), async c => {
      const access = c.get("accessContext")!;
      try {
        const input = options.input?.parse(options.multipart ? await c.req.parseBody() : await c.req.json());
        const query = options.query?.parse(c.req.query());
        const result = await handler(c, access.owner.id, input as z.output<Input>, query as z.output<Query>);
        return (result instanceof Response ? result : c.json(output.parse(result), 200)) as never;
      } catch (cause) {
        if (cause instanceof OriginalStorageError) return c.json({ code: cause.code, message: cause.message }, cause.status as 503) as never;
        if (cause instanceof FxUnavailable) return c.json({ message: cause.message }, 503) as never;
        if (cause instanceof HTTPException) return c.json({ message: cause.message }, cause.status) as never;
        if (cause instanceof z.ZodError || cause instanceof SyntaxError)
          return c.json({ message: "Invalid budget input." }, 400) as never;
        if (cause instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2003", "P2034"].includes(cause.code))
          return c.json({ message: "Budget data changed. Reload and try again." }, 409) as never;
        if (path.startsWith("/receipts")) return c.json({ message: "Document request failed. Please retry." }, 500) as never;
        throw cause;
      }
    });
  }

  registerBudgetExtras(route, db);
  registerBudgetModuleOverview(route, db);
  registerBudgetTransactions(route, db);
  registerBudgetTaxPlanning(route, db);
  route("get", "/currency/convert", "convertBudgetCurrency", "Preview a dated currency conversion", conversionSchema, null,
    async (_c, _owner, _input, query) => (await fx.convertMany([{ money: { amountMinor: query.amountMinor, currency: query.currency }, target: query.target, date: query.date }]))[0],
    { ownerOnly: true, query: z.object({ amountMinor: z.coerce.number().int().min(-100_000_000).max(100_000_000), currency: currencyCode, target: currencyCode, date: z.iso.date() }) });


  async function state(ownerId: string) {
    const row = await db.budgetPlan.findUnique({ where: { ownerId } });
    return row ? budgetState.parse(row) : sampleState;
  }
  type PlanLimitChanges = { foodCents?: number; otherCents?: number };
  async function changeState(
    ownerId: string,
    revision: number,
    change: (prior: z.infer<typeof budgetState>) => Partial<z.infer<typeof budgetState>> & { limits?: PlanLimitChanges },
    priorState?: z.infer<typeof budgetState>,
  ) {
    if (!priorState || priorState === sampleState)
      await db.budgetPlan.upsert({ where: { ownerId }, create: { ownerId, plan: emptyPlan }, update: {} });
    const prior = priorState ?? await state(ownerId);
    if (prior.revision !== revision) return fail(409, "Budget plan changed. Reload before applying changes.");
    const { plan, note, proposal, limits } = change(prior);
    const save = async (client: Prisma.TransactionClient) => {
      const rows = await client.budgetPlan.updateManyAndReturn({
        where: { ownerId, revision }, data: { revision: { increment: 1 }, plan, note, proposal: proposal === null ? Prisma.DbNull : proposal },
      });
      if (!rows[0]) return fail(409, "Budget plan changed. Reload before applying changes.");
      if (limits) await recordPlanLimits(client, ownerId, weekStart(localDate()), prior.plan, limits);
      return budgetState.parse(rows[0]);
    };
    return limits ? db.$transaction(save, serializable) : save(db);
  }

  route("get", "/subscriptions", "listBudgetSubscriptions", "List recurring rules and posted charges", subscriptionList, { today: "2026-11-08", items: [], paidKeys: [], charges: {}, oneOff: [] },
    async (_c, ownerId) => {
      const today = localDate();
      const [planRow, rows, posted] = await Promise.all([
        db.budgetPlan.findUnique({ where: { ownerId }, select: { plan: true } }),
        db.budgetSubscription.findMany({ where: { ownerId }, select: subscriptionSelect, orderBy: { name: "asc" } }),
        db.$queryRaw<{ ruleId: string; id: string; date: string; cents: number; billKey: string | null; rank: bigint }[]>`
          WITH posted AS (
            SELECT COALESCE("subscriptionId", split_part("billKey", ':', 1)) AS "ruleId", "id", "date",
              "totalCents" AS cents, "billKey"
            FROM "budget_expense"
            WHERE "ownerId" = ${ownerId} AND ("subscriptionId" IS NOT NULL OR "billKey" IS NOT NULL)
          ), ranked AS (
            SELECT *, row_number() OVER (PARTITION BY "ruleId" ORDER BY "date" DESC, "id" DESC) AS rank
            FROM posted
          )
          SELECT "ruleId", "id", "date", cents, "billKey", rank
          FROM ranked
          WHERE rank <= 4 OR ("billKey" IS NOT NULL AND "date" >= ${shiftDate(today, -35)})
          ORDER BY "ruleId", rank
        `,
      ]);
      const plan = planRow ? budgetPlan.parse(planRow.plan) : emptyPlan;
      const items = await priceSubscriptions(combineRecurringRules(plan, rows.map(row => subscription.parse(row))), fx, today);
      const oneOff = plan.entries.filter(entry => entry.frequency === "once").map(entry => ({
        id: entry.id, name: entry.label, kind: entry.kind === "bill" ? "bill" as const : "income" as const, date: entry.date, cents: entry.cents,
      }));
      const ids = new Set([...items, ...oneOff].map(item => item.id));
      const charges: Record<string, { id: string; date: string; cents: number }[]> = {};
      const paidKeys: string[] = [];
      for (const { ruleId, id, date, cents, billKey, rank } of posted) {
        if (!ids.has(ruleId)) continue;
        if (rank <= BigInt(4)) (charges[ruleId] ??= []).push({ id, date, cents });
        if (billKey) paidKeys.push(billKey);
      }
      return { today, items: items.map(item => subscription.parse(item)), paidKeys, charges, oneOff };
    }, { ownerOnly: true });
  route("get", "/subscriptions/calendar", "getSubscriptionCalendar", "Read expected subscription payments for a date range", subscriptionCalendar, { payments: [] },
    async (_c, ownerId, _input, query) => {
      const [items, paid] = await Promise.all([
        db.budgetSubscription.findMany({ where: { ownerId, planEntry: false, kind: { not: "income" }, status: { in: ["active", "trial"] } }, select: subscriptionSelect }),
        db.budgetExpense.findMany({ where: { ownerId, subscriptionId: { not: null }, date: { gte: shiftDate(query.from, -3), lte: shiftDate(query.through, 3) } }, select: { billKey: true, totalCents: true } }),
      ]);
      const amounts = new Map(paid.map(row => [row.billKey, row.totalCents]));
      return { payments: subscriptionEntries(await priceSubscriptions(items.map(row => subscription.parse(row)), fx, localDate()), query.from, query.through)
        .flatMap(payment => payment.kind === "bill"
          ? [{ ...payment, kind: payment.kind, paid: amounts.has(payment.key), cents: amounts.get(payment.key) ?? payment.cents }]
          : []) };
    }, { ownerOnly: true, query: subscriptionRange });
  route("put", "/subscriptions/{id}", "saveBudgetSubscription", "Create or update a subscription", subscription, null,
    async (c, ownerId, input) => {
      const id = c.req.param("id")!;
      const where = { ownerId_id: { ownerId, id } };
      const observed = await db.budgetSubscription.findUnique({ where, select: subscriptionSelect });
      const observedTerms = observed ? subscription.parse(observed).terms : [];
      const signature = (terms: typeof observedTerms) => JSON.stringify(subscriptionIntent({ terms }).terms);
      const terms = input.changes.terms.map(term => observedTerms.find(prior => signature([prior]) === signature([term])) ?? term);
      const newTerms = terms.flatMap((term, index) => term.currency && term.currency !== "CAD" && !observedTerms.includes(term) ? [{ index, term }] : []);
      const conversions = observed?.commandId === input.commandId ? [] : await fx.convertMany(newTerms.map(({ term }) =>
        ({ money: { amountMinor: term.amountCents, currency: term.currency! }, target: "CAD", date: term.effectiveOn })));
      newTerms.forEach(({ index }, i) => { if (conversions[i]) terms[index] = { ...terms[index], cadAmountCents: conversions[i].converted.amountMinor, conversion: conversions[i] }; });

      return db.$transaction(async tx => {
        const row = await tx.budgetSubscription.findUnique({ where, select: subscriptionSelect });
        const prior = row ? subscription.parse(row) : null;
        const desired = subscription.parse({
          ...prior, ...input.changes, id, revision: input.revision, commandId: input.commandId,
        });
        if (prior?.commandId === input.commandId) {
          if (JSON.stringify(subscriptionIntent(recurringChanges(prior))) !== JSON.stringify(subscriptionIntent(recurringChanges(desired))))
            return fail(409, "Retry with the original command payload.");
          return prior;
        }
        if ((prior?.revision ?? 0) !== input.revision) return fail(409, "This subscription changed elsewhere. Refresh before editing.");

        let planRule: ReturnType<typeof planRecurringRule> = null;
        if (!prior || prior.planEntry) {
          const planRow = await tx.budgetPlan.findUnique({ where: { ownerId }, select: { plan: true } });
          const entry = planRow && budgetPlan.parse(planRow.plan).entries.find(entry => entry.id === id);
          if (entry) planRule = planRecurringRule(entry, prior ?? undefined);
          if (prior?.planEntry && !planRule) return fail(409, "This recurring plan entry was removed. Refresh before editing.");
        }
        const today = localDate();
        if (planRule) {
          const planSchedule = ({ name, kind, stopsOn, terms }: typeof desired) => ({ name, kind, stopsOn, terms: signature(terms) });
          if (JSON.stringify(planSchedule(desired)) !== JSON.stringify(planSchedule(planRule)))
            return fail(409, "This recurring schedule comes from the Budget Plan. Refresh before editing.");
        } else if (prior) {
          const historical = (terms: typeof prior.terms) => terms.filter(term => term.effectiveOn < today).sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn));
          if (signature(historical(prior.terms)) !== signature(historical(desired.terms)))
            return fail(400, "Keep earlier billing terms; add a dated change for today or later.");
        }
        if (desired.lastReviewed && desired.lastReviewed > today)
          return fail(400, "The review date cannot be in the future.");
        if (desired.documentId && desired.documentId !== prior?.documentId) {
          const document = await tx.budgetReceipt.findUnique({
            where: { ownerId_id: { ownerId, id: desired.documentId } }, select: { id: true },
          });
          if (!document) return fail(404, "Agreement not found.");
        }

        const data = { ...recurringChanges(desired), terms, commandId: input.commandId, planEntry: !!planRule };
        const saved = prior
          ? await tx.budgetSubscription.updateManyAndReturn({ where: { ownerId, id, revision: input.revision }, data: { ...data, revision: { increment: 1 } } })
          : [await tx.budgetSubscription.create({ data: { ...data, ownerId, id } })];
        if (!saved[0]) return fail(409, "This subscription changed elsewhere. Refresh before editing.");
        const reconciliationChanged = !prior || prior.sourceKey !== desired.sourceKey ||
          prior.status !== desired.status || prior.stopsOn !== desired.stopsOn || prior.kind !== desired.kind ||
          signature(prior.terms) !== signature(desired.terms);
        if (!planRule && desired.sourceKey && desired.kind !== "income" && ["active", "trial"].includes(desired.status) && reconciliationChanged)
          await reconcileSubscriptionPayments(tx, ownerId, shiftDate(today, -90), today);
        return subscription.parse(saved[0]);
      }, serializable);
    }, { ownerOnly: true, input: subscriptionWrite, retry: "reuse commandId and identical payload; revision prevents lost updates" });

  route("get", "/plan", "getBudgetPlan", "Read Budget Note and plan", budgetState, sampleState, (_c, ownerId) => state(ownerId));
  route("put", "/pending-money", "savePendingBudgetMoney", "Update a pending money item", budgetState, sampleState,
    async (_c, ownerId, { id, before, after }) => {
      const prior = await state(ownerId);
      const items = new Map(prior.plan.pendingMoney?.map(item => [item.id, item]));
      const current = items.get(id) ?? null;
      if (samePendingMoney(current, after)) return prior;
      if (!samePendingMoney(current, before)) return fail(409, "This item changed elsewhere. Review it before editing.");
      if (after) items.set(id, after);
      else items.delete(id);
      if (items.size > 100) return fail(400, "Track up to 100 pending payments.");
      return changeState(ownerId, prior.revision, () => ({
        plan: { ...prior.plan, pendingMoney: [...items.values()] },
      }), prior);
    }, { ownerOnly: true, input: pendingMoneyInput, retry: "reuse the identical before and after values",
      inputExample: { id: sampleId, before: null, after: { id: sampleId, label: "Reimbursement", cents: 5000, date: null } } });
  route("put", "/note", "saveBudgetNote", "Save Budget Note Markdown", budgetState, sampleState,
    (_c, ownerId, input) => changeState(ownerId, input.revision, () => ({ note: input.note, proposal: null })),
    { input: noteInput, inputExample: { revision: 0, note: "Set food to $80 per week." } });
  route("put", "/proposal", "proposeBudgetChanges", "Propose explicit Budget Note changes", budgetState, sampleState,
    (_c, ownerId, input) => changeState(ownerId, input.revision, () => ({ proposal: input.changes })),
    { input: proposalInput, inputExample: { revision: 1, changes: { foodCents: 8000 } } });
  route("post", "/proposal/decision", "decideBudgetProposal", "Apply or dismiss proposed changes", budgetState, sampleState,
    (_c, ownerId, input) => changeState(ownerId, input.revision, prior => {
      if (!prior.proposal) return fail(409, "There is no pending proposal.");
      if (input.action === "dismiss") return { proposal: null };
      const { upsert = [], remove = [], ...fields } = prior.proposal;
      const entries = new Map(prior.plan.entries.map(entry => [entry.id, entry]));
      for (const entry of upsert) entries.set(entry.id, entry);
      for (const id of remove) entries.delete(id);
      const plan = budgetPlan.parse({ ...prior.plan, ...fields, entries: [...entries.values()],
        ...(fields.checkpoint ? { checkpoint: stampCheckpoint(fields.checkpoint) } : {}),
      });
      if (plan.checkpoint && plan.checkpoint.date > localDate()) return fail(400, "A cash checkpoint cannot be in the future.");
      const { foodCents, otherCents } = fields;
      const limits = foodCents !== undefined || otherCents !== undefined ? { foodCents, otherCents } : undefined;
      return { plan, proposal: null, limits };
    }), { ownerOnly: true, input: applyInput, inputExample: { revision: 2, action: "apply" } });
  route("put", "/checkpoint", "resetBudgetCheckpoint", "Reset available cash", budgetState, sampleState,
    (_c, ownerId, input) => changeState(ownerId, input.revision, prior => {
      if (input.checkpoint.date > localDate()) return fail(400, "A cash checkpoint cannot be in the future.");
      return { plan: { ...prior.plan, checkpoint: stampCheckpoint(input.checkpoint) }, proposal: null };
    }), { ownerOnly: true, input: checkpointInput, inputExample: { revision: 2, checkpoint: { date: "2026-11-08", cents: 420000 } } });

  route("get", "", "getBudgetOverview", "Read cash runway, cash flow, and weekly spending", overview,
    { ...forecast(emptyPlan, [], "2026-11-08"), ...summarizeBudgetActivity("2026-11-08", []), recent: [] }, async (_c, ownerId, _input, query) => {
      const today = localDate();
      const week = weekStart(today);
      const horizon = shiftDate(today, 365);
      const [{ plan: savedPlan }, subscriptions, limits] = await Promise.all([
        state(ownerId),
        db.budgetSubscription.findMany({ where: { ownerId, OR: [{ status: { in: ["active", "trial"] } }, { planEntry: true }] }, select: subscriptionSelect }),
        readBudgetLimitSchedule(db, ownerId, week, weekStart(horizon)),
      ]);
      const plan = withRecurringPlanStatus(savedPlan, subscriptions.map(row => subscription.parse(row)));
      const from = plan.checkpoint && plan.checkpoint.date < week ? plan.checkpoint.date : week;
      const orderBy = [{ date: "desc" }, { id: "desc" }] as const;
      const activityFrom = shiftDate(today.slice(0, 7) + "-01", -1).slice(0, 7) + "-01";
      const [activity, recent, pricedSubscriptions] = await Promise.all([
        db.budgetExpense.findMany({
          where: { ownerId, OR: [
            { date: { gte: from < activityFrom ? from : activityFrom, lte: today },
              OR: [...budgetSpend.OR, { bankFlow: "deposit", date: { gte: activityFrom } }] },
            { billKey: { not: null }, ...budgetSpend },
          ] },
          select: { date: true, totalCents: true, foodCents: true, billKey: true, createdAt: true, bankAccount: true, bankFlow: true },
        }),
        db.budgetExpense.findMany({ where: { ownerId, ...budgetSpend }, orderBy: [...orderBy], take: 25 }),
        priceSubscriptions(subscriptions.map(row => subscription.parse(row)), fx, today),
      ]);
      const expenses = activity.filter(row => row.bankFlow !== "deposit");
      const payments = subscriptionEntries(pricedSubscriptions, plan.checkpoint?.date ?? today, horizon);
      const limitsForWeek = (date: string) => effectiveBudgetLimits(plan, limits, date);
      const result = forecast(plan, expenses, today, { ...query, uncertain: query.uncertain === "true", payments, limitsForWeek });
      const comparing = query.food !== undefined || query.other !== undefined || query.uncertain === "true";
      const baseline = comparing ? forecast(plan, expenses, today, { payments, limitsForWeek }).projection : [];
      return {
        ...result,
        projection: result.projection.map((point, index) => ({ ...point, baseline: baseline[index]?.cents })),
        ...summarizeBudgetActivity(today, activity), recent: recent.map(row => expense.parse(row)),
      };
    }, { query: scenario, ownerOnly: true });

  route("post", "/bank/import", "importBudgetBank", "Import posted bank transactions", z.object({ inserted: z.number(), existing: z.number() }), { inserted: 1, existing: 0 },
    async (_c, ownerId, input) => {
      if (input.rows.some(row => row.date > localDate())) return fail(400, "Import posted transactions with dates through today.");
      const prepared = await prepareBankRows(ownerId, [input], fx);
      return db.$transaction(async tx => {
        const result = await importBankRows(tx, ownerId, [input], prepared);
        if (input.rows.length) {
          const dates = input.rows.map(row => row.date).sort();
          await reconcileSubscriptionPayments(tx, ownerId, dates[0], dates.at(-1)!);
        }
        return result;
      }, serializable);
    }, { ownerOnly: true, input: bankImportInput, inputExample: { account: "account-1", rows: [{ date: "2026-11-08", merchant: "Grocer", totalCents: 2500, flow: "expense" }] }, retry: "repeated source rows are skipped" });

  route("get", "/receipts/{id}/candidates", "listBudgetReceiptCandidates", "Find nearby bank transactions; foreign amounts require confirmation", z.object({ candidates: z.array(expense), next: z.string().nullable().optional() }), { candidates: [] },
    async (c, ownerId, _input, query) => {
      const row = await db.budgetReceipt.findUnique({ where: { ownerId_id: { ownerId, id: c.req.param("id")! } }, select: { kind: true, currency: true, date: true, totalCents: true, expense: { select: { id: true } } } });
      if (!row) return fail(404, "Receipt not found.");
      if (!isFinancialDocument(row.kind) || !row.date || row.totalCents === null || row.expense) return { candidates: [] };
      const sameCurrency = isCadBudgetDocument(row.kind, row.currency);
      const candidates = await db.budgetExpense.findMany({
        where: { ownerId, bankFlow: { in: ["expense", "refund"] }, receiptId: null, ...(sameCurrency ? { totalCents: row.totalCents } : {}),
          date: { gte: shiftDate(row.date, -3), lte: shiftDate(row.date, 7) } },
        ...(query.cursor ? { cursor: { ownerId_id: { ownerId, id: query.cursor } }, skip: 1 } : {}),
        orderBy: [{ date: "desc" }, { id: "asc" }], take: 31,
      });
      return { candidates: candidates.slice(0, 30).map(candidate => expense.parse(candidate)), next: candidates.length > 30 ? candidates[29].id : null };
    }, { ownerOnly: true, query: z.object({ cursor: z.uuid().optional() }) });

  const receiptMatchInput = z.object({ expenseId: z.uuid().nullable() }).strict();
  route("put", "/receipts/{id}/match", "matchBudgetReceipt", "Link or unlink a bank transaction", receipt, sampleReceipt,
    async (c, ownerId, input) => db.$transaction(async tx => {
      const id = c.req.param("id")!;
      const row = await tx.budgetReceipt.findUnique({ where: { ownerId_id: { ownerId, id } }, select: receiptFields });
      if (!row) return fail(404, "Receipt not found.");
      if (row.expense && !row.expense.bankAccount) return fail(409, "This receipt is recorded as a cash expense.");
      if (row.expense && input.expenseId && row.expense.id !== input.expenseId) return fail(409, "Unlink the current transaction first.");
      if (input.expenseId) {
        if (!isFinancialDocument(row.kind)) return fail(400, "Only receipts and invoices can link to bank transactions.");
        const changed = await tx.budgetExpense.updateMany({
          where: { ownerId, id: input.expenseId, bankFlow: { in: ["expense", "refund"] }, OR: [{ receiptId: null }, { receiptId: id }] },
          data: { receiptId: id, manualReceiptMatch: true },
        });
        if (!changed.count) return fail(409, "The bank transaction is no longer available.");
      } else if (row.expense) {
        await tx.budgetExpense.update({ where: { ownerId_id: { ownerId, id: row.expense.id } }, data: { receiptId: null, manualReceiptMatch: true } });
      }
      const updated = await tx.budgetReceipt.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id } }, select: receiptFields });
      return view(updated);
    }, serializable), { ownerOnly: true, input: receiptMatchInput, inputExample: { expenseId: sampleId } });

  route("put", "/expenses/{id}", "saveBudgetExpense", "Create or correct a confirmed expense", expense, sampleExpense,
    async (c, ownerId, input) => {
      if (input.id !== c.req.param("id") || input.date > localDate()) return fail(400, "Check expense ID and date.");
      const ownerClient = c.get("accessContext")?.client.kind === "web";
      if (!ownerClient && input.receiptId) return fail(403, "Missing budget permission.");
      const nativeCurrency = input.currency ?? "CAD";
      const existing = await db.budgetExpense.findUnique({ where: { ownerId_id: { ownerId, id: input.id } } });
      if (!ownerClient && (existing?.bankAccount || existing?.receiptId)) return fail(409, protectedExpense);
      if (existing?.bankAccount) return fail(409, "Imported bank rows preserve the posted amount.");
      const savedConversion = existing?.date === input.date && existing.originalCurrency === nativeCurrency && existing.originalAmountMinor === input.totalCents
        ? conversionSchema.safeParse(existing.conversion) : null;
      const conversion = savedConversion?.success ? savedConversion.data : (await fx.convertMany([{ money: { amountMinor: input.totalCents, currency: nativeCurrency }, target: "CAD", date: input.date }]))[0];
      const { currency: _currency, ...fields } = input;
      const data = { ...fields, totalCents: conversion.converted.amountMinor,
        foodCents: conversion.quote ? convertMoney({ amountMinor: input.foodCents, currency: nativeCurrency }, "CAD", conversion.quote.rate).amountMinor : input.foodCents,
        originalAmountMinor: nativeCurrency === "CAD" ? null : input.totalCents, originalFoodMinor: nativeCurrency === "CAD" ? null : input.foodCents,
        originalCurrency: nativeCurrency === "CAD" ? null : nativeCurrency, conversion: nativeCurrency === "CAD" ? Prisma.DbNull : conversion,
      };
      return db.$transaction(async tx => {
      const ownerId_id = { ownerId, id: input.id };
      const prior = await tx.budgetExpense.findUnique({ where: { ownerId_id } });
      if (!ownerClient && (prior?.bankAccount || prior?.receiptId)) return fail(409, protectedExpense);
      if (prior?.bankAccount) return fail(409, "Imported bank rows preserve the posted amount.");
      if (prior && prior.receiptId !== input.receiptId) return fail(409, "The receipt link cannot be changed.");
      if ((prior?.billKey ?? null) !== input.billKey) return fail(400, "Use the bill matching action.");
      if (input.receiptId) {
        const where = { ownerId_id: { ownerId, id: input.receiptId } };
        const document = await tx.budgetReceipt.findUnique({ where, select: { kind: true, currency: true, expense: { select: { id: true } } } });
        if (!document) return fail(404, "Receipt not found.");
        if (!isFinancialDocument(document.kind) || (document.kind === "invoice" && !document.currency) || (document.currency ?? "CAD") !== nativeCurrency) return fail(400, "Cash expense currency must match the receipt or invoice.");
        if (document.expense && document.expense.id !== input.id) return fail(409, "This receipt is already linked to a transaction.");
        await tx.budgetReceipt.update({ where,
          data: { ...(!prior ? { merchant: input.merchant, date: input.date, totalCents: input.totalCents } : {}), scanStatus: "confirmed" } });
      }
      return expense.parse(await tx.budgetExpense.upsert({ where: { ownerId_id }, create: { ownerId, ...data }, update: data }));
      }, { isolationLevel: "Serializable" });
    },
    { input: expenseInput, inputExample: sampleExpense, retry: "same ID updates the same expense" });

  route("put", "/expenses/{id}/bill", "matchBudgetBill", "Match or unmatch a paid bill", expense, sampleExpense,
    async (c, ownerId, input) => db.$transaction(async tx => {
      const id = c.req.param("id")!;
      const ownerId_id = { ownerId, id };
      const prior = await tx.budgetExpense.findUnique({ where: { ownerId_id } });
      if (!prior) return fail(404, "Expense not found.");
      if ((prior.bankAccount || prior.receiptId) && c.get("accessContext")?.client.kind !== "web") return fail(403, "Only the owner can match this transaction.");
      let subscriptionId: string | null = null;
      if (input.billKey) {
        const row = await tx.budgetPlan.findUnique({ where: { ownerId } });
        const plan = row ? budgetPlan.parse(row.plan) : emptyPlan;
        const [entryId, period] = input.billKey.split(":");
        const entry = plan.entries.find(item => item.id === entryId && item.kind === "bill");
        const subscriptionRow = await tx.budgetSubscription.findUnique({ where: { ownerId_id: { ownerId, id: entryId } } });
        if (subscriptionRow && !subscriptionRow.planEntry) {
          const recurring = subscription.parse(subscriptionRow);
          if (!z.iso.date().safeParse(period).success || (recurring.kind === "income" ? prior.totalCents >= 0 : prior.totalCents <= 0) ||
            !subscriptionPayments({ ...recurring, status: "active" }, period, period).some(payment => payment.key === input.billKey))
            return fail(400, "Choose a valid subscription payment.");
          subscriptionId = entryId;
        } else {
          const first = period === "once" ? entry?.date : period.length === 10 ? period : period + "-01";
          const last = first && period !== "once" && period.length !== 10 && z.iso.date().safeParse(first).success
            ? shiftDate(shiftDate(first, 32).slice(0, 7) + "-01", -1) : first;
          if (prior.totalCents <= 0 || !entry || !first || !last || !z.iso.date().safeParse(first).success ||
            !billOccurrences({ ...plan, entries: [entry] }, first, last).some(e => e.key === input.billKey))
            return fail(400, "Choose a valid planned bill.");
        }
      }
      return expense.parse(await tx.budgetExpense.update({ where: { ownerId_id }, data: { billKey: input.billKey, subscriptionId } }));
    }, { isolationLevel: "Serializable" }), { input: billMatchInput, inputExample: { billKey: null } });

  route("delete", "/expenses/{id}", "deleteBudgetExpense", "Delete a manual expense", acknowledge, { ok: true },
    async (c, ownerId) => {
      const id = c.req.param("id")!;
      const result = await db.budgetExpense.deleteMany({ where: { ownerId, id, receiptId: null, bankAccount: null } });
      if (!result.count && await db.budgetExpense.findUnique({ where: { ownerId_id: { ownerId, id } } }))
        return fail(409, c.get("accessContext")?.client.kind === "web" ? "Delete the receipt to remove its linked expense." : protectedExpense);
      return { ok: true };
    }, { retry: "already deleted expenses return success" });

  const view = (row: NonNullable<Awaited<ReturnType<typeof getReceipt>>>) => receipt.parse({ ...row, createdAt: row.createdAt.toISOString() });
  const getReceipt = (ownerId: string, id: string) =>
    db.budgetReceipt.findUnique({ where: { ownerId_id: { ownerId, id } }, select: receiptFields });
  // Safe metadata only until the Owner explicitly reveals this document.
  const privateMetadata = { id: true, kind: true, mime: true, createdAt: true, scanStatus: true, scanProvenance: true } as const;
  const concealed = (row: { id: string; kind: string; mime: string | null; createdAt: Date; scanStatus: string;
    scanProvenance?: z.infer<typeof budgetDocumentScanProvenance> }) => receipt.parse({
    ...sampleReceipt, id: row.id, kind: row.kind, mime: row.mime, scanStatus: row.scanStatus,
    scanProvenance: row.scanProvenance, createdAt: row.createdAt.toISOString(),
  });
  async function scanReceipt(ownerId: string, id: string) {
    await db.budgetReceipt.updateMany({ where: { ownerId, id, kind: { in: ["receipt", "invoice"] }, scanStatus: "failed" },
      data: { scanStatus: "pending", scanLeaseId: null, scanLeaseUntil: null } });
    const row = await db.budgetReceipt.findUnique({ where: { ownerId_id: { ownerId, id } }, select: privateMetadata });
    return row ? concealed(row) : fail(404, "Document not found.");
  }

  route("get", "/receipts", "listBudgetReceipts", "Search receipts", listing, { receipts: [], next: null }, async (_c, ownerId, _input, query) => {
    if (query.page) {
      const documents = await listDocuments(db, ownerId, query, query.page, query.years === "yes");
      return { receipts: [], next: null, documents };
    }
    const rows = await db.budgetReceipt.findMany({
      where: receiptWhere(ownerId, query),
      ...receiptCursor(ownerId, query.cursor),
      select: query.reveal ? { ...receiptFields, lines: false } : privateMetadata,
      orderBy: receiptOrder,
      take: 31,
    });
    const page = rows.slice(0, 30);
    return {
      receipts: page.map(row => query.reveal ? receipt.omit({ lines: true }).parse({ ...sampleReceipt, ...row, createdAt: row.createdAt.toISOString() }) : concealed(row)),
      next: rows.length > 30 ? page.at(-1)!.id : null,
    };
  }, { query: listQuery, ownerOnly: true });
  route("get", "/receipts/export", "exportBudgetReceipts", "Export matching receipt IDs or CSV fields", receiptExport, { ids: [sampleId] },
    async (c, ownerId, _input, query) => {
      const options = { where: receiptWhere(ownerId, query), orderBy: receiptOrder, take: exportBatchSize + 1 };
      const signal = c.req.raw.signal;
      // Keep the complete export consistent if receipts are added, edited, or removed during a batch read.
      return db.$transaction(async tx => {
        if (query.format === "documents") {
          const documents: z.infer<typeof budgetDocument>[] = [];
          let cursor: { id: string; date: string } | undefined;
          do {
            signal.throwIfAborted();
            const rows = await exportDocumentsPage(tx, ownerId, query, exportBatchSize + 1, cursor);
            signal.throwIfAborted();
            documents.push(...rows.slice(0, exportBatchSize));
            cursor = rows.length > exportBatchSize ? rows[exportBatchSize - 1] : undefined;
          } while (cursor);
          return { documents };
        }
        if (query.format === "ids") {
          const ids = await readReceiptExport(
            cursor => tx.budgetReceipt.findMany({ ...options, ...receiptCursor(ownerId, cursor), select: { id: true } }),
            row => row.id,
            signal,
          );
          return { ids };
        }
        const rows = await readReceiptExport(
          cursor => tx.budgetReceipt.findMany({
            ...options,
            ...receiptCursor(ownerId, cursor),
            select: {
              id: true, kind: true, title: true, merchant: true, date: true, createdAt: true,
              scanStatus: true, scanProvenance: true, totalCents: true, currency: true, expense: { select: { bankAccount: true } },
            },
          }),
          ({ expense, ...row }): z.infer<typeof receiptExportRow> => ({
            ...row,
            kind: budgetDocumentKind.parse(row.kind),
            createdAt: row.createdAt.toISOString(),
            expenseStatus: expense?.bankAccount ? "matched" : expense ? "cash" : null,
          }),
          signal,
        );
        return { rows };
      }, { isolationLevel: "RepeatableRead", timeout: 30_000 });
    }, { query: exportQuery, ownerOnly: true });
  route("post", "/receipts", "createBudgetReceipt", "Save a document original or create a manual draft", receipt, sampleReceipt,
    async (_c, ownerId, input) => {
      const uploaded = (row: Parameters<typeof concealed>[0]) => {
        if (input.scan === "no" && (row.scanProvenance === "ocr_completed" || !["archived", "manual"].includes(row.scanStatus)))
          return fail(409, "This document already exists with OCR queued or completed. It was not imported as an unscanned archive.");
        return concealed(row);
      };
      const prior = await db.budgetReceipt.findUnique({ where: { ownerId_id: { ownerId, id: input.id } }, select: { ...privateMetadata, originalKey: true, imageHash: true } });
      assertOriginalWritesEnabled();
      if (prior && !prior.originalKey && !originalsEnabled()) return uploaded(prior);
      const image = input.photo?.size ? new Uint8Array(await input.photo.arrayBuffer()) : undefined;
      const kind = input.kind ?? "receipt";
      if (!image && !isFinancialDocument(kind)) return fail(400, "Choose an original file to archive.");
      let mime: string | undefined;
      if (image) {
        const head = Buffer.from(image.subarray(0, 12));
        if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) mime = "image/jpeg";
        else if (head.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = "image/png";
        else if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") mime = "image/webp";
        else if (head.subarray(0, 5).toString("ascii") === "%PDF-") mime = "application/pdf";
        else return fail(400, "Upload a JPEG, PNG, WebP, or PDF.");
      }
      const imageHash = image && createHash("sha256").update(image).digest("hex");
      const scanStatus = !image ? "manual" : input.scan !== "no" && isFinancialDocument(kind) ? "pending" : "archived";
      const scanProvenance = scanStatus === "archived" ? "upload_only" : null;
      if (prior && imageHash !== prior.imageHash) return fail(409, "Receipt ID already used with different bytes.");
      if (prior) return uploaded(prior);
      if (originalsEnabled() && image && mime && imageHash) {
        // Serialize duplicate content before external work, including different request IDs.
        // The independent durable file ledger survives a failure of this record transaction.
        return withOriginalUploadSlot(() => db.$transaction(async tx => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`receipt-original:${ownerId}:${imageHash}`}, 0))`;
          const existing = await tx.budgetReceipt.findUnique({ where: { ownerId_imageHash: { ownerId, imageHash } }, select: privateMetadata });
          if (existing) return uploaded(existing);
          const unfinished = await tx.originalFile.findFirst({ where: { key: { startsWith: `receipt:${ownerId}:` }, sha256: imageHash, state: { in: ["pending", "ready"] } }, orderBy: { createdAt: "asc" }, select: { key: true } });
          const originalKey = await originalFiles.put(unfinished?.key ?? `receipt:${ownerId}:${input.id}`, image, mime, "Receipts", input.photo?.name || "receipt");
          return uploaded(await tx.budgetReceipt.create({ data: {
            ownerId, id: input.id, kind, title: input.title, originalKey, imageHash, mime, lines: [], scanStatus, scanProvenance,
          }, select: privateMetadata }));
        }, { timeout: 600_000, maxWait: 10_000 }));
      }
      const data = {
        ownerId, id: input.id, kind, title: input.title, image, imageHash, mime, lines: [], scanStatus, scanProvenance,
      } satisfies Prisma.BudgetReceiptUncheckedCreateInput;
      if (imageHash) {
        const row = await db.budgetReceipt.upsert({ where: { ownerId_imageHash: { ownerId, imageHash } }, create: data, update: {}, select: privateMetadata });
        return uploaded(row);
      }
      return uploaded(await db.budgetReceipt.upsert({ where: { ownerId_id: { ownerId, id: input.id } }, create: data, update: {}, select: privateMetadata }));
    }, { input: upload, multipart: true, ownerOnly: true, retry: "same ID or image returns the existing receipt" });
  const receiptDetail = receipt.extend({ document: budgetDocument.optional() });
  route("get", "/receipts/{id}", "getBudgetReceipt", "Read receipt detail", receiptDetail, sampleReceipt, async (c, ownerId, _input, query) => {
    if (query.view === "documents") {
      const document = await getDocument(db, ownerId, c.req.param("id")!, query.reveal === "yes");
      if (!document) return fail(404, "Document not found.");
      return { ...sampleReceipt, id: document.id, kind: document.kind, mime: document.mime, createdAt: document.date, document };
    }
    if (query.reveal) {
      const row = await getReceipt(ownerId, c.req.param("id")!);
      return row ? view(row) : fail(404, "Receipt not found.");
    }
    const row = await db.budgetReceipt.findUnique({ where: { ownerId_id: { ownerId, id: c.req.param("id")! } }, select: privateMetadata });
    return row ? concealed(row) : fail(404, "Receipt not found.");
  }, { ownerOnly: true, query: z.object({ reveal: z.literal("yes").optional(), view: z.literal("documents").optional() }) });
  route("get", "/receipts/{id}/original", "getBudgetReceiptOriginal", "Read the original document file", z.string(), null,
    async (c, ownerId) => {
      const row = await db.budgetReceipt.findUnique({ where: { ownerId_id: { ownerId, id: c.req.param("id")! } }, select: { image: true, mime: true, originalKey: true } });
      if (row?.originalKey) {
        const response = await originalFiles.open(row.originalKey, c.req.header("range"));
        if (row.mime === "application/pdf") response.headers.set("Content-Disposition", 'attachment; filename="quantself-document.pdf"');
        return response;
      }
      if (!row?.image || !row.mime) return fail(404, "Original document not found.");
      return new Response(new Blob([row.image]), { headers: {
        "Content-Type": row.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
        ...(row.mime === "application/pdf" ? { "Content-Disposition": 'attachment; filename="quantself-document.pdf"' } : {}),
      } });
    }, { image: true, ownerOnly: true });
  route("post", "/receipts/{id}/scan", "extractBudgetReceipt", "Extract receipt fields from the original", receipt, sampleReceipt,
    async (c, ownerId) => scanReceipt(ownerId, c.req.param("id")!), { ownerOnly: true });
  route("put", "/receipts/{id}", "editBudgetReceipt", "Correct the receipt reconstruction", receipt, sampleReceipt,
    async (c, ownerId, input) => db.$transaction(async tx => {
      const id = c.req.param("id")!;
      const where = { ownerId_id: { ownerId, id } };
      const prior = await tx.budgetReceipt.findUnique({ where, select: {
        totalCents: true, kind: true, currency: true, expense: { select: { bankAccount: true, manualReceiptMatch: true } },
      } });
      if (!prior) return fail(404, "Receipt not found.");
      const kind = input.kind ?? prior.kind;
      const currency = input.currency === undefined ? prior.currency : input.currency;
      if (prior.expense && (!isFinancialDocument(kind) || (!prior.expense.bankAccount && currency !== prior.currency))) {
        return fail(409, "Remove the linked transaction before changing this document's type or currency.");
      }
      await tx.budgetReceipt.update({ where, data: { ...input, scanStatus: "edited" } });
      await reconcileBankReceipts(tx, ownerId, [prior.totalCents, input.totalCents].filter((amount): amount is number => amount !== null));
      return view(await tx.budgetReceipt.findUniqueOrThrow({ where, select: receiptFields }));
    }, serializable), { ownerOnly: true, input: receiptInput, inputExample: { merchant: "Grocer", date: null, totalCents: null, lines: [] } });
  route("delete", "/receipts/{id}", "deleteBudgetReceipt", "Delete a receipt, preserving any bank transaction", acknowledge, { ok: true },
    async (c, ownerId) => db.$transaction(async tx => {
      const id = c.req.param("id")!;
      const prior = await tx.budgetReceipt.findUnique({ where: { ownerId_id: { ownerId, id } }, select: { totalCents: true, originalKey: true } });
      assertOriginalWritesEnabled();
      if (prior?.originalKey) await queueOriginalDeletion(prior.originalKey, tx);
      await tx.budgetExpense.updateMany({ where: { ownerId, receiptId: id, OR: [{ bankAccount: { not: null } }, { manualReceiptMatch: true }] }, data: { receiptId: null, manualReceiptMatch: false } });
      await tx.budgetSubscription.updateMany({
        where: { ownerId, documentId: id },
        data: { documentId: null, revision: { increment: 1 }, commandId: crypto.randomUUID() },
      });
      await tx.budgetReceipt.deleteMany({ where: { ownerId, id } });
      if (prior?.totalCents != null) await reconcileBankReceipts(tx, ownerId, [prior.totalCents]);
      return { ok: true };
    }, serializable), { ownerOnly: true, retry: "already deleted receipts return success" });
}
