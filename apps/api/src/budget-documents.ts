import { z } from "@hono/zod-openapi";
import type { prisma } from "@quantself/db";
import { Prisma } from "@quantself/db/generated/prisma/client";
import { budgetDocumentKind, budgetDocumentScanProvenance, date } from "./budgeting";

export const documentFilters = z.object({
  segment: z.enum(["receipts", "invoices", "agreements"]).optional(),
  year: z.string().regex(/^\d{4}$/).optional(),
  linked: z.enum(["yes", "no"]).optional(),
});

const documentLink = z.object({ id: z.uuid(), label: z.string() });
const documentTransaction = documentLink.omit({ label: true }).extend({
  date,
  totalCents: z.number().int(),
  estimated: z.boolean(),
});
export const budgetDocument = z.object({
  id: z.uuid(), kind: budgetDocumentKind, date, mime: z.string().nullable(),
  title: z.string().nullable(), merchant: z.string(), totalCents: z.number().int().nullable(),
  currency: z.string().nullable(), scanProvenance: budgetDocumentScanProvenance, transaction: documentTransaction.nullable(),
  subscriptions: z.array(documentLink),
}).openapi("BudgetDocument");
export const documentPage = z.object({
  rows: z.array(budgetDocument),
  total: z.number().int().nonnegative(),
  years: z.array(z.string()),
});

type Document = z.infer<typeof budgetDocument>;
type Filters = z.infer<typeof documentFilters> & {
  reveal?: "yes";
  q?: string;
  kind?: Document["kind"];
  subscriptionId?: string;
};
type Reader = Pick<typeof prisma, "$queryRaw">;
export const documentPageSize = 20;

const documentDate = Prisma.sql`COALESCE(r.date, TO_CHAR(r."createdAt", 'YYYY-MM-DD'))`;
const concealedDate = Prisma.sql`TO_CHAR(r."createdAt", 'YYYY-MM-DD')`;

// Plan rules have no subscription row until their metadata is edited. Resolve their
// labels from the same owner Plan used by the recurring rules list.
const planRuleId = Prisma.sql`split_part(e."billKey", ':', 1)`;
const visibleRule = Prisma.sql`s.status IN ('active', 'trial', 'paused', 'cancelled')`;
function planEntries(ownerId: string) {
  return Prisma.sql`plan_entries AS MATERIALIZED (
    SELECT entry->>'id' AS id, entry->>'label' AS label, entry->>'frequency' AS frequency
    FROM budget_plan p CROSS JOIN LATERAL jsonb_array_elements(p.plan->'entries') AS entries(entry)
    LEFT JOIN budget_subscription s ON s."ownerId" = p."ownerId" AND s.id = entry->>'id'
      AND s."planEntry" AND entry->>'frequency' <> 'once'
    WHERE p."ownerId" = ${ownerId} AND (s.id IS NULL OR ${visibleRule})
  )`;
}

function documentMatches(ownerId: string, query: Filters) {
  const filters: Prisma.Sql[] = [Prisma.sql`r."ownerId" = ${ownerId}`];
  if (query.kind) filters.push(Prisma.sql`r.kind = ${query.kind}`);
  if (query.reveal && query.subscriptionId) {
    filters.push(Prisma.sql`(
      EXISTS (SELECT 1 FROM budget_expense e
        WHERE e."ownerId" = r."ownerId" AND e."receiptId" = r.id
          AND ((e."subscriptionId" = ${query.subscriptionId} AND EXISTS (
            SELECT 1 FROM budget_subscription s WHERE s."ownerId" = e."ownerId" AND s.id = e."subscriptionId" AND ${visibleRule}
              AND (NOT s."planEntry" OR EXISTS (SELECT 1 FROM plan_entries p WHERE p.id = s.id AND p.frequency <> 'once'))
          )) OR (e."subscriptionId" IS NULL AND EXISTS (
            SELECT 1 FROM plan_entries p WHERE p.id = ${query.subscriptionId} AND p.id = ${planRuleId}
          ))))
      OR EXISTS (SELECT 1 FROM budget_subscription s
        WHERE s."ownerId" = r."ownerId" AND s."documentId" = r.id AND s.id = ${query.subscriptionId} AND ${visibleRule}
          AND (NOT s."planEntry" OR EXISTS (SELECT 1 FROM plan_entries p WHERE p.id = s.id AND p.frequency <> 'once')))
    )`);
  }
  const segment = query.segment;
  if (segment === "receipts") filters.push(Prisma.sql`r.kind = 'receipt'`);
  if (segment === "invoices") filters.push(Prisma.sql`r.kind = 'invoice'`);
  if (segment === "agreements") filters.push(Prisma.sql`r.kind IN ('contract', 'msa', 'sow')`);
  if (query.year) {
    filters.push(Prisma.sql`LEFT(${query.reveal ? documentDate : concealedDate}, 4) = ${query.year}`);
  }
  if (query.reveal && query.linked) {
    const linked = Prisma.sql`(
      EXISTS (SELECT 1 FROM budget_expense e WHERE e."ownerId" = r."ownerId" AND e."receiptId" = r.id)
      OR EXISTS (SELECT 1 FROM budget_subscription s WHERE s."ownerId" = r."ownerId" AND s."documentId" = r.id AND ${visibleRule}
        AND (NOT s."planEntry" OR EXISTS (SELECT 1 FROM plan_entries p WHERE p.id = s.id AND p.frequency <> 'once')))
    )`;
    filters.push(query.linked === "yes" ? linked : Prisma.sql`NOT ${linked}`);
  }
  const q = query.q?.trim();
  if (query.reveal && q) {
    // Treat wildcard characters as literal search text.
    const pattern = "%" + q.replaceAll(/[\\%_]/g, character => "\\" + character) + "%";
    filters.push(Prisma.sql`CONCAT_WS(' ', r.title, r.merchant,
      CASE WHEN r.currency = 'JPY' THEN r."totalCents"::text
        WHEN r.currency IN ('KWD', 'BHD') THEN ROUND(r."totalCents"::numeric / 1000, 3)::text
        ELSE ROUND(r."totalCents"::numeric / 100, 2)::text
      END
    ) ILIKE ${pattern}`);
  }
  return Prisma.join(filters, " AND ");
}

function documentFields(revealed: boolean) {
  return revealed ? Prisma.sql`
    r.id, r.kind, ${documentDate} AS date, r.mime, r.title, r.merchant, r."totalCents", r.currency,
    r."scanProvenance"::text AS "scanProvenance",
    CASE WHEN e.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', e.id, 'date', e.date,
      'totalCents', e."totalCents", 'estimated', COALESCE(e.conversion->'estimated' = 'true'::jsonb, false)
    ) END AS transaction,
    COALESCE(related.subscriptions, '[]'::jsonb) AS subscriptions
  ` : Prisma.sql`
    r.id, r.kind, ${concealedDate} AS date, r.mime, NULL AS title, '' AS merchant,
    NULL AS "totalCents", NULL AS currency, NULL AS transaction, '[]'::jsonb AS subscriptions
  `;
}

const linkJoins = Prisma.sql`
  LEFT JOIN budget_expense e ON e."ownerId" = r."ownerId" AND e."receiptId" = r.id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('id', links.id, 'label', links.label) ORDER BY links.label, links.id) AS subscriptions
    FROM (
      SELECT s.id, COALESCE(p.label, s.name) AS label
      FROM budget_subscription s
      LEFT JOIN plan_entries p ON p.id = s.id AND p.frequency <> 'once' AND s."planEntry"
      WHERE s."ownerId" = r."ownerId" AND (s."documentId" = r.id OR s.id = e."subscriptionId") AND ${visibleRule}
        AND (NOT s."planEntry" OR p.id IS NOT NULL)
      UNION
      SELECT p.id, p.label FROM plan_entries p
      WHERE e."subscriptionId" IS NULL AND p.id = ${planRuleId}
    ) links
  ) related ON true
`;

export async function listDocuments(db: Reader, ownerId: string, query: Filters, page: number, includeYears: boolean) {
  const revealed = !!query.reveal;
  const visibleDate = revealed ? documentDate : concealedDate;
  const [result] = await db.$queryRaw<z.infer<typeof documentPage>[]>(Prisma.sql`
    WITH ${revealed ? Prisma.sql`${planEntries(ownerId)},` : Prisma.empty} matching AS (
      SELECT r.id, ${visibleDate} AS date
      FROM budget_receipt r
      WHERE ${documentMatches(ownerId, query)}
    ), page AS (
      SELECT id FROM matching ORDER BY date DESC, id DESC
      LIMIT ${documentPageSize} OFFSET ${(page - 1) * documentPageSize}
    ), documents AS (
      SELECT ${documentFields(revealed)}
      FROM page JOIN budget_receipt r ON r."ownerId" = ${ownerId} AND r.id = page.id
      ${revealed ? linkJoins : Prisma.empty}
    )
    SELECT
      COALESCE((SELECT jsonb_agg(to_jsonb(documents) ORDER BY date DESC, id DESC) FROM documents), '[]'::jsonb) AS rows,
      (SELECT COUNT(*)::int FROM matching) AS total,
      ${includeYears ? Prisma.sql`ARRAY(
        SELECT DISTINCT LEFT(${visibleDate}, 4) AS year
        FROM budget_receipt r WHERE r."ownerId" = ${ownerId} ORDER BY year DESC
      )` : Prisma.sql`ARRAY[]::text[]`} AS years
  `);
  return result;
}

export async function getDocument(db: Reader, ownerId: string, id: string, revealed: boolean) {
  const [row] = await db.$queryRaw<Document[]>(Prisma.sql`
    ${revealed ? Prisma.sql`WITH ${planEntries(ownerId)}` : Prisma.empty}
    SELECT ${documentFields(revealed)}
    FROM budget_receipt r
    ${revealed ? linkJoins : Prisma.empty}
    WHERE r."ownerId" = ${ownerId} AND r.id = ${id}
  `);
  return row;
}

export function exportDocumentsPage(
  db: Reader, ownerId: string, query: Filters, limit: number, cursor?: { id: string; date: string },
) {
  return db.$queryRaw<Document[]>(Prisma.sql`
    WITH ${planEntries(ownerId)}, page AS (
      SELECT r.id
      FROM budget_receipt r
      WHERE ${documentMatches(ownerId, query)}
      ${cursor ? Prisma.sql`AND (${documentDate}, r.id) < (${cursor.date}, ${cursor.id})` : Prisma.empty}
      ORDER BY ${documentDate} DESC, r.id DESC
      LIMIT ${limit}
    )
    SELECT ${documentFields(true)}
    FROM page JOIN budget_receipt r ON r."ownerId" = ${ownerId} AND r.id = page.id
    ${linkJoins}
    ORDER BY date DESC, r.id DESC
  `);
}
