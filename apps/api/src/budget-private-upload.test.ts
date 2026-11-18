import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import type { prisma } from "@quantself/db";
import { registerBudgetingRoutes } from "./budgeting-route";

function fixture() {
  const rows: any[] = [];
  let creates = 0;
  const db = { budgetReceipt: {
    findUnique: async ({ where }: any) => rows.find(row => row.ownerId === where.ownerId_id.ownerId && row.id === where.ownerId_id.id) ?? null,
    upsert: async ({ create, update, where }: any) => {
      expect(update).toEqual({});
      expect(where.ownerId_imageHash.ownerId).toBe("owner");
      const prior = rows.find(row => row.imageHash === create.imageHash);
      if (prior) return prior;
      creates++;
      const row = { ...create, createdAt: new Date() };
      rows.push(row);
      return row;
    },
  } };
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  app.use("*", async (c, next) => {
    c.set("accessContext", { owner: { id: "owner" }, client: { kind: "web" }, permissions: ["budgeting:write"] } as AccessContext);
    await next();
  });
  registerBudgetingRoutes(app, db as unknown as typeof prisma);
  const upload = (scan?: "yes" | "no", id = crypto.randomUUID()) => {
    const body = new FormData();
    body.set("id", id); body.set("kind", "invoice");
    if (scan) body.set("scan", scan);
    body.set("photo", new File(["%PDF-1.7\nSynthetic private invoice fixture"], "invoice.pdf", { type: "application/pdf" }));
    return app.request("/api/v1/budgeting/receipts", { method: "POST", headers: { origin: new URL(process.env.BETTER_AUTH_URL ?? "http://localhost").origin }, body });
  };
  return { upload, rows, get creates() { return creates; } };
}

test("opaque invoice upload archives bytes without OCR and deduplicates retries by hash", async () => {
  const f = fixture();
  const response = await f.upload("no");
  expect(response.status).toBe(200);
  const saved: any = await response.json();
  expect(saved).toMatchObject({ kind: "invoice", scanStatus: "archived", scanProvenance: "upload_only", lines: [], merchant: "", totalCents: null });
  expect(f.rows[0].image).toBeInstanceOf(Uint8Array);
  expect(f.rows[0].scanStatus).toBe("archived");
  const retry: any = await (await f.upload("no")).json();
  expect(retry).toMatchObject({ id: saved.id, scanProvenance: "upload_only" });
  expect(f.creates).toBe(1);
  expect(f.rows[0].scanStatus).toBe("archived");
});

test("ordinary invoice uploads retain automatic OCR; opaque duplicate never promises an unscanned archive", async () => {
  const f = fixture();
  expect((await f.upload()).status).toBe(200);
  expect(f.rows[0]).toMatchObject({ scanStatus: "pending", scanProvenance: null });
  expect((await f.upload("no")).status).toBe(409);
  expect((await f.upload("no", f.rows[0].id)).status).toBe(409);
  expect(f.creates).toBe(1);
  expect(f.rows[0].scanStatus).toBe("pending");
});

test("opaque upload rejects completed OCR and preserves unknown legacy provenance", async () => {
  const f = fixture();
  expect((await f.upload()).status).toBe(200);
  const [row] = f.rows;
  row.scanStatus = "archived";
  row.scanProvenance = "ocr_completed";
  expect((await f.upload("no")).status).toBe(409);
  expect((await f.upload("no", row.id)).status).toBe(409);

  row.scanProvenance = null;
  const legacy = await f.upload("no");
  expect(legacy.status).toBe(200);
  expect(await legacy.json()).toMatchObject({ id: row.id, scanStatus: "archived", scanProvenance: null });
  expect(f.creates).toBe(1);
  expect(row.scanProvenance).toBeNull();
});

test("subscription invoice listing scopes and paginates documents in one read", async () => {
  const subscriptionId = crypto.randomUUID();
  const rows = Array.from({ length: 31 }, () => ({
    id: crypto.randomUUID(), kind: "invoice", createdAt: new Date(), scanStatus: "archived", mime: "application/pdf",
  }));
  const reads: unknown[] = [];
  const db = { budgetReceipt: { findMany: async (query: unknown) => {
    reads.push(query);
    return rows;
  } } };
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  app.use("*", async (c, next) => {
    c.set("accessContext", { owner: { id: "owner" }, client: { kind: "web" }, permissions: ["budgeting:read"] } as AccessContext);
    await next();
  });
  registerBudgetingRoutes(app, db as unknown as typeof prisma);

  const res = await app.request(`/api/v1/budgeting/receipts?kind=invoice&subscriptionId=${subscriptionId}`);
  expect(res.status).toBe(200);
  const page = await res.json() as { receipts: { id: string }[]; next: string };
  expect(page.receipts).toHaveLength(30);
  expect(page.next).toBe(rows[29].id);
  expect(reads).toEqual([expect.objectContaining({
    where: { ownerId: "owner", kind: "invoice", expense: { subscriptionId } },
    take: 31,
  })]);
});

test("receipt exports read all owner-matching records in bounded batches with format-specific fields", async () => {
  const subscriptionId = crypto.randomUUID();
  const createdAt = new Date("2026-11-08T00:00:00Z");
  const rows = Array.from({ length: 502 }, (_, index) => ({
    id: crypto.randomUUID(), kind: "invoice", title: "Shop invoice", merchant: "Shop",
    date: null, totalCents: 1250, currency: "CAD", createdAt, scanStatus: "archived",
    expense: index === 0 ? { bankAccount: "" } : index === 1 ? null : { bankAccount: "Bank" }, image: new Uint8Array([1]), lines: [],
  }));
  type Query = NonNullable<Parameters<typeof prisma.budgetReceipt.findMany>[0]>;
  const reads: Query[] = [];
  const snapshots: unknown[] = [];
  const budgetReceipt = { findMany: async (query: Query) => {
    reads.push(query);
    const cursorId = query.cursor?.ownerId_id?.id;
    const start = cursorId ? rows.findIndex(row => row.id === cursorId) + 1 : 0;
    return rows.slice(start, start + query.take!);
  } };
  const db = { budgetReceipt, $transaction: async (run: (tx: { budgetReceipt: typeof budgetReceipt }) => unknown, options: unknown) => {
    snapshots.push(options);
    return run({ budgetReceipt });
  } };
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  app.use("*", async (c, next) => {
    const access = c.req.header("fixture-access");
    c.set("accessContext", access === "none" ? null : {
      owner: { id: "owner" }, client: { kind: access ?? "web" }, permissions: ["budgeting:read"],
    } as AccessContext);
    await next();
  });
  registerBudgetingRoutes(app, db as unknown as typeof prisma);
  const path = "/api/v1/budgeting/receipts/export";
  expect((await app.request(path + "?format=ids")).status).toBe(400);
  expect((await app.request(path + "?reveal=yes&format=ids", { headers: { "fixture-access": "none" } })).status).toBe(401);
  expect((await app.request(path + "?reveal=yes&format=ids", { headers: { "fixture-access": "api-key" } })).status).toBe(403);
  expect(reads).toHaveLength(0);

  const query = `?reveal=yes&q=Shop&kind=invoice&subscriptionId=${subscriptionId}`;
  const ids = await app.request(path + query + "&format=ids");
  expect(ids.status).toBe(200);
  expect(ids.headers.get("Cache-Control")).toBe("no-store");
  expect(await ids.json()).toEqual({ ids: rows.map(row => row.id) });
  const csv = await app.request(path + query + "&format=csv");
  expect(csv.status).toBe(200);
  expect(csv.headers.get("Cache-Control")).toBe("no-store");
  const expected = rows.map(({ image: _image, lines: _lines, expense: _expense, createdAt, ...row }, index) => ({
    ...row,
    createdAt: createdAt.toISOString(),
    expenseStatus: index === 0 ? "cash" : index === 1 ? null : "matched",
  }));
  expect(await csv.json()).toEqual({ rows: expected });
  expect(snapshots).toEqual(Array(2).fill(expect.objectContaining({ isolationLevel: "RepeatableRead" })));
  expect(reads).toHaveLength(4);
  for (const [index, read] of reads.entries()) {
    expect(read.where).toEqual({
      ownerId: "owner", kind: "invoice", expense: { subscriptionId },
      OR: [{ merchant: { contains: "Shop", mode: "insensitive" } }, { title: { contains: "Shop", mode: "insensitive" } }],
    });
    expect(read.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(read.take).toBe(501);
    expect(read.cursor).toEqual(index % 2 ? { ownerId_id: { ownerId: "owner", id: rows[499].id } } : undefined);
    expect(read.skip).toBe(index % 2 ? 1 : undefined);
    expect(read.select).toEqual(index < 2 ? { id: true } : {
      id: true, kind: true, title: true, merchant: true, date: true, createdAt: true,
      scanStatus: true, scanProvenance: true, totalCents: true, currency: true, expense: { select: { bankAccount: true } },
    });
  }
});
