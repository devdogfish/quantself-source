import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import type { prisma } from "@quantself/db";
import type { Prisma } from "@quantself/db/generated/prisma/client";
import { registerBudgetingRoutes } from "./budgeting-route";

const id = "38906710-6507-44be-8ed0-187fd11c77fe";
const document = {
  id, kind: "msa", title: "Agreement", merchant: "Acme", totalCents: null, currency: null,
  date: "2026-09-12", mime: "application/pdf", transaction: null, subscriptions: [],
};

function fixture(...responses: unknown[][]) {
  const reads: Prisma.Sql[] = [];
  const $queryRaw = async (query: Prisma.Sql) => {
    reads.push(query);
    return responses.shift() ?? [];
  };
  const db = {
    $queryRaw,
    $transaction: async (work: (tx: { $queryRaw: typeof $queryRaw }) => unknown, options: unknown) => {
      expect(options).toMatchObject({ isolationLevel: "RepeatableRead" });
      return work({ $queryRaw });
    },
  };
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  app.use("*", async (c, next) => {
    c.set("accessContext", { owner: { id: "owner" }, client: { kind: c.req.header("client") ?? "web" }, permissions: ["budgeting:read"] } as AccessContext);
    await next();
  });
  registerBudgetingRoutes(app, db as unknown as typeof prisma);
  return {
    reads,
    get: (path: string, headers?: Record<string, string>) => app.request(`/api/v1/budgeting/receipts${path}`, { headers }),
  };
}

test("the numbered page returns a count and year options in one owner-scoped read", async () => {
  const documents = { rows: [document], total: 21, years: ["2026", "2024"] };
  const f = fixture([documents]);
  const response = await f.get("?page=2&years=yes&reveal=yes&segment=agreements&year=2026&linked=yes&q=Acme");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ receipts: [], next: null, documents });
  expect(f.reads).toHaveLength(1);
  expect(f.reads[0].values).toEqual(["owner", "owner", "2026", "%Acme%", 20, 20, "owner", "owner"]);
  expect(f.reads[0].sql).toContain("COUNT(*)");
  expect(f.reads[0].sql).toContain("s.\"documentId\"");
  expect(f.reads[0].sql).toContain("r.kind IN ('contract', 'msa', 'sow')");
  expect(f.reads[0].sql).not.toContain("r.image");
  expect(f.reads[0].sql).not.toContain("r.lines");
});

test("concealed list and drawer SQL omit private columns, private filters and joins", async () => {
  const metadata = { ...document, merchant: "", title: null };
  const f = fixture([{ rows: [metadata], total: 1, years: [] }], [metadata]);
  expect((await f.get("?page=1&linked=yes&q=private&subscriptionId=" + id)).status).toBe(200);
  expect((await f.get(`/${id}?view=documents`)).status).toBe(200);
  expect((await f.get(`/${id}?view=documents&reveal=yes`, { client: "api-key" })).status).toBe(403);
  expect(f.reads).toHaveLength(2);
  for (const read of f.reads) {
    expect(read.values).not.toContain("%private%");
    expect(read.sql).not.toContain("r.title");
    expect(read.sql).not.toContain("r.date");
    expect(read.sql).not.toContain("r.merchant");
    expect(read.sql).not.toContain("budget_expense");
    expect(read.sql).not.toContain("budget_subscription");
    expect(read.sql).not.toContain("budget_plan");
  }
});

test("export requires reveal and returns all filtered documents in bounded date-and-ID order", async () => {
  const rows = Array.from({ length: 502 }, () => ({ ...document, id: crypto.randomUUID() }));
  const f = fixture(rows.slice(0, 501), rows.slice(500));
  const filters = "segment=agreements&linked=no&format=documents";
  expect((await f.get(`/export?${filters}`)).status).toBe(400);
  const response = await f.get(`/export?reveal=yes&${filters}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ documents: rows });
  expect(f.reads).toHaveLength(2);
  expect(f.reads[0].values).toEqual(["owner", "owner", 501, "owner"]);
  expect(f.reads[1].values).toEqual(["owner", "owner", rows[499].date, rows[499].id, 501, "owner"]);
  expect(f.reads.every(read => read.sql.includes("NOT (") && read.sql.includes("ORDER BY date DESC, r.id DESC"))).toBe(true);
});

test("revealed list, detail and export resolve legacy Plan charges in the same owner-scoped query", async () => {
  const rule = { id: crypto.randomUUID(), label: "Rent" };
  const linked = { ...document, subscriptions: [rule] };
  const f = fixture([{ rows: [linked], total: 1, years: [] }], [linked], [linked]);
  const list = await f.get("?page=1&reveal=yes&subscriptionId=" + rule.id);
  expect(await list.json()).toMatchObject({ documents: { rows: [linked], total: 1 } });
  const detail = await f.get(`/${id}?view=documents&reveal=yes`);
  expect(await detail.json()).toMatchObject({ document: linked });
  const exported = await f.get("/export?format=documents&reveal=yes&subscriptionId=" + rule.id);
  expect(await exported.json()).toEqual({ documents: [linked] });
  expect(f.reads).toHaveLength(3);
  for (const read of f.reads) {
    expect(read.sql).toContain("plan_entries AS MATERIALIZED");
    expect(read.sql).toContain('p."ownerId" = ?');
    expect(read.sql).toContain(`split_part(e."billKey", ':', 1)`);
    expect(read.sql).toContain('e."ownerId" = r."ownerId"');
    expect(read.sql).toContain("s.status IN ('active', 'trial', 'paused', 'cancelled')");
  }
  expect(f.reads[0].values.filter(value => value === rule.id)).toHaveLength(3);
  expect(f.reads[2].values.filter(value => value === rule.id)).toHaveLength(3);
});
