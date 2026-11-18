import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { getPublicOrigin } from "@quantself/auth/public-origin";
import { registerBudgetingRoutes } from "./budgeting-route";
import { processPrivateDocument } from "./private-document-worker";
import { PrivateOcrBusyError } from "./private-document-ocr";

const id = "cc4e401d-74a1-4ec7-8b23-b1e97dbc0642";
const original = { id, ownerId: "owner", kind: "invoice", title: "Private customer", merchant: "Private seller", currency: "CAD", date: "2026-11-08", totalCents: 400,
  invoiceNumber: "SECRET-1", dueDate: null, amazonAsin: null, lines: [{ text: "Private address", amount: null }], image: new Uint8Array([1,2]), mime: "application/pdf", createdAt: new Date(), scanStatus: "pending", scanProvenance: null as "ocr_completed" | null, expense: null };
function fixture(kind = "web") {
  const selections: any[] = [];
  const select = (query: any) => { selections.push(query); return Object.fromEntries(Object.entries(original).filter(([key]) => query.select[key])); };
  const db: any = { budgetReceipt: { findUnique: async(q: any) => select(q), findMany: async(q: any) => [select(q)], upsert: async(q: any) => select(q), updateMany: async()=>({count:1}) } };
  const app = new OpenAPIHono<{Variables:{accessContext:AccessContext|null}}>();
  app.use("*",async(c,next)=>{c.set("accessContext",{owner:{id:"owner"},client:{kind},permissions:["budgeting:read","budgeting:write","budgeting:delete"]} as AccessContext);await next();});
  registerBudgetingRoutes(app,db);
  return {app,selections};
}
test("initial detail/list select only metadata; explicit Owner reveal retrieves private fields",async()=>{
  const f=fixture();
  for(const path of ["/receipts",`/receipts/${id}`]) {
    const r=await f.app.request('/api/v1/budgeting'+path);expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.text()).not.toContain('Private');
    expect(f.selections.at(-1).select).not.toHaveProperty('merchant');expect(f.selections.at(-1).select).not.toHaveProperty('image');
  }
  const revealed = [["/receipts?reveal=yes", "Private seller"], [`/receipts/${id}?reveal=yes`, "SECRET-1"]] as const;
  for (const [path, privateValue] of revealed) {
    const response = await f.app.request("/api/v1/budgeting" + path);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toContain(privateValue);
  }
});
test("Owner receives retained receipt bytes from the private route without a redirect", async () => {
  const { app, selections } = fixture();
  const response = await app.request(`/api/v1/budgeting/receipts/${id}/original`);
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("content-type")).toBe("application/pdf");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-disposition")).toBe('attachment; filename="quantself-document.pdf"');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(original.image);
  expect(selections).toHaveLength(1);
  expect(selections[0].where).toEqual({ ownerId_id: { ownerId: "owner", id } });
});
test("API-key clients cannot access documents through reveal, originals, matching, scan or writes",async()=>{
  const f=fixture("api-key");
  for(const [path,method] of [["/receipts?reveal=yes","GET"],[`/receipts/${id}?reveal=yes`,"GET"],[`/receipts/${id}/original`,"GET"],[`/receipts/${id}/candidates`,"GET"],[`/receipts/${id}/scan`,"POST"],[`/receipts/${id}/match`,"PUT"],[`/receipts/${id}`,"PUT"],["/receipts","POST"]]) {
    expect((await f.app.request('/api/v1/budgeting'+path,{method})).status).toBe(403);
  }
  expect(f.selections).toHaveLength(0);
});
test("retrying an already saved upload returns immediately with private fields concealed",async()=>{
  const f=fixture();const form=new FormData();form.set('id',id);form.set('scan','yes');
  const r=await f.app.request('/api/v1/budgeting/receipts',{method:'POST',headers:{origin:getPublicOrigin()??'http://localhost'},body:form});
  expect(r.status).toBe(200);expect(await r.text()).not.toContain('Private');
});

type WorkerRow = typeof original & { scanLeaseId: string | null; scanLeaseUntil: Date | null };
type WorkerFilter = {
  ownerId?: string;
  id?: string;
  scanStatus?: string;
  scanLeaseId?: string;
  kind?: { in: string[] };
  scanLeaseUntil?: null | { lte?: Date; gt?: Date };
  OR?: WorkerFilter[];
};

function matches(row: WorkerRow, filter: WorkerFilter): boolean {
  const { OR, kind, scanLeaseUntil, ...equals } = filter;
  if (Object.entries(equals).some(([key, value]) => row[key as keyof WorkerRow] !== value)) return false;
  if (kind && !kind.in.includes(row.kind)) return false;
  if (scanLeaseUntil === null && row.scanLeaseUntil !== null) return false;
  if (scanLeaseUntil?.lte && (!row.scanLeaseUntil || row.scanLeaseUntil > scanLeaseUntil.lte)) return false;
  if (scanLeaseUntil?.gt && (!row.scanLeaseUntil || row.scanLeaseUntil <= scanLeaseUntil.gt)) return false;
  return !OR || OR.some(clause => matches(row, clause));
}

function workerFixture(status = "pending") {
  const row: WorkerRow = {
    ...original,
    scanStatus: status,
    scanLeaseId: status === "processing" ? "expired" : null,
    scanLeaseUntil: status === "processing" ? new Date(0) : null,
  };
  const rows = [row];
  const updates: Partial<WorkerRow>[] = [];
  const db: any = {
    budgetReceipt: {
      findFirst: async ({ where }: { where: WorkerFilter }) => {
        const next = rows.find(candidate => matches(candidate, where));
        return next ? { ownerId: next.ownerId, id: next.id } : null;
      },
      findUnique: async ({ where }: { where: { ownerId_id: WorkerFilter } }) =>
        rows.find(candidate => matches(candidate, where.ownerId_id)),
      updateMany: async ({ where, data }: { where: WorkerFilter; data: Partial<WorkerRow> }) => {
        updates.push(data);
        const current = rows.find(candidate => matches(candidate, where));
        if (!current) return { count: 0 };
        Object.assign(current, data);
        return { count: 1 };
      },
    },
    $transaction: async (fn: (tx: any) => Promise<void>) => fn(db),
  };
  return { row, rows, db, updates };
}

const extracted = { merchant: "Recovered", date: null, totalCents: null, lines: [] };

test("compute saturation defers just that receipt, then OCR succeeds after the delay", async () => {
  const f = workerFixture();
  const next = { ...f.row, id: "next-receipt", image: new Uint8Array([3, 4]) };
  f.rows.push(next);
  let tick = 60_000;
  const clock = () => new Date(tick);

  await processPrivateDocument(f.db, async image => {
    expect(image).toEqual(original.image);
    tick += 20_000; // Delay starts when the busy response arrives.
    throw new PrivateOcrBusyError();
  }, clock);
  expect(f.row).toMatchObject({ scanStatus: "pending", scanProvenance: null, scanLeaseId: null, scanLeaseUntil: new Date(110_000) });
  expect(f.row.image).toEqual(original.image);
  expect(f.row.merchant).toBe(original.merchant);

  await processPrivateDocument(f.db, async image => {
    expect(image).toEqual(next.image);
    return extracted;
  }, clock);
  expect(next).toMatchObject({ scanStatus: "archived", scanProvenance: "ocr_completed" });
  tick = 109_999;
  expect(await processPrivateDocument(f.db, async () => { throw Error("ran before retry"); }, clock)).toBe(false);

  tick = 110_000;
  await processPrivateDocument(f.db, async image => {
    expect(image).toEqual(original.image);
    return extracted;
  }, clock);
  expect(f.row).toMatchObject({ scanStatus: "archived", scanProvenance: "ocr_completed", scanLeaseId: null, scanLeaseUntil: null, merchant: "Recovered" });
});

test("genuine OCR failure keeps original and marks failed without private error text", async () => {
  const f = workerFixture();
  await processPrivateDocument(f.db, async () => { throw Error("SECRET OCR CONTENT"); });
  expect(f.row).toMatchObject({ scanStatus: "failed", scanProvenance: null });
  expect(f.row.image).toEqual(original.image);
  expect(JSON.stringify(f.updates)).not.toContain("SECRET");
});

test("expired lease can be reclaimed, but a busy response cannot overwrite a replacement lease", async () => {
  const f = workerFixture("processing");
  const now = () => new Date(60_000);
  const newerDeadline = new Date(900_000);
  await processPrivateDocument(f.db, async () => {
    expect(f.row.scanLeaseId).not.toBe("expired");
    f.row.scanLeaseId = "newer-claim";
    f.row.scanLeaseUntil = newerDeadline;
    throw new PrivateOcrBusyError();
  }, now);
  expect(f.row).toMatchObject({ scanStatus: "processing", scanLeaseId: "newer-claim", scanLeaseUntil: newerDeadline });
});

test("OCR completion cannot archive a receipt once its lease expires", async () => {
  const f = workerFixture();
  let tick = 60_000;
  await processPrivateDocument(f.db, async () => {
    tick += 10 * 60_000;
    return extracted;
  }, () => new Date(tick));
  expect(f.row).toMatchObject({ scanStatus: "processing", scanProvenance: null });
  expect(f.row.merchant).toBe(original.merchant);
});
