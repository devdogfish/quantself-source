import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import type { prisma } from "@quantself/db";
import { registerBudgetingRoutes } from "./budgeting-route";
import { emptyPlan, localDate } from "./budgeting";
import type { Subscription } from "@quantself/budgeting";
const id = "cc4e401d-74a1-4ec7-8b23-b1e97dbc0642";
const changes = { name: "Annual", status: "active", stopsOn: null, websiteUrl: null, cancelUrl: null, logoKey: null, estimated: false, sourceKey: null, evidence: "", terms: [{ effectiveOn: "2026-01-01", startOn: "2026-01-31", amountCents: 12000, frequency: "yearly", interval: 1 }] };
function fixture(kind = "web", permissions = ["budgeting:read", "budgeting:write"], plan: Omit<typeof emptyPlan, "entries"> & { entries: unknown[] } = emptyPlan) {
  let row: any = null; let writes = 0; const owners: string[] = [];
  const reads: string[] = [];
  let posted: { ruleId: string; id: string; date: string; cents: number; billKey: string | null; rank: bigint }[] = [];
  const db: any = {
    budgetPlan: { findUnique: async ({ where }: any) => { reads.push("plan"); owners.push(where.ownerId); return { plan }; } },
    budgetReceipt: { findUnique: async ({ where }: any) => { owners.push(where.ownerId_id.ownerId); return null; } },
    $queryRaw: async (_query: unknown, ownerId: string) => { reads.push("charges"); owners.push(ownerId); return posted; },
    budgetSubscription: {
    findUnique: async ({ where }: any) => { owners.push(where.ownerId_id.ownerId); return row; },
    findMany: async ({ where }: any) => {
      reads.push("subscriptions");
      owners.push(where.ownerId);
      return row && (!where.sourceKey || row.sourceKey) && (!where.status?.in || where.status.in.includes(row.status)) ? [row] : [];
    },
    create: async ({data}: any) => { writes++; row={...data,revision:1,createdAt:new Date(),updatedAt:new Date()}; return row; },
    updateManyAndReturn: async ({data,where}:any) => { if(where.revision!==row?.revision)return []; writes++;row={...row,...data,revision:row.revision+1};return [row]; },
  }, budgetExpense: {findMany:async()=>[]}, $transaction: async(fn:any)=>fn(db) };
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  app.use("*", async (c,next)=>{c.set("accessContext",{owner:{id:"owner-a"},client:{kind},permissions} as AccessContext);await next();});
  registerBudgetingRoutes(app,db as typeof prisma);
  const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost").origin;
  const save = (body:unknown, requestOrigin=origin) => app.request(`/api/v1/budgeting/subscriptions/${id}`,{method:"PUT",headers:{origin:requestOrigin,"content-type":"application/json"},body:JSON.stringify(body)});
  const list = () => app.request("/api/v1/budgeting/subscriptions");
  return {app,save,list,reads,setPosted: (rows: typeof posted) => { posted = rows; },get row(){return row;},get writes(){return writes;},owners};
}
test("subscription commands are owner-scoped, retry-safe and reject stale revisions",async()=>{
 const f=fixture();const command={revision:0,commandId:crypto.randomUUID(),changes};
 expect((await f.save(command)).status).toBe(200);expect(f.writes).toBe(1);
 expect((await f.save(command)).status).toBe(200);expect(f.writes).toBe(1);
 expect((await f.save({...command,changes:{...changes,name:"different"}})).status).toBe(409);
 expect((await f.save({...command,commandId:crypto.randomUUID()})).status).toBe(409);
 expect(f.owners.every(owner=>owner==="owner-a")).toBe(true);
});
test("cancellation preserves dated terms and historical price edits are rejected",async()=>{
 const f=fixture();await f.save({revision:0,commandId:crypto.randomUUID(),changes});
 expect((await f.save({revision:1,commandId:crypto.randomUUID(),changes:{...changes,stopsOn:"2026-11-09"}})).status).toBe(200);
 expect(f.row.terms).toEqual(changes.terms);
 expect((await f.save({revision:2,commandId:crypto.randomUUID(),changes:{...changes,terms:[{...changes.terms[0],amountCents:1}]}})).status).toBe(400);
});
test("subscription access denies non-owner clients, missing permission and cross-origin writes",async()=>{
 for(const f of [fixture("api-key"),fixture("web",[])]) {
  expect((await f.app.request("/api/v1/budgeting/subscriptions")).status).toBe(403);expect(f.owners).toEqual([]);
 }
 const f=fixture();expect((await f.save({revision:0,commandId:crypto.randomUUID(),changes},"https://attacker.invalid")).status).toBe(403);expect(f.writes).toBe(0);
});
test("calendar is range-bounded and returns expected charges without creating transactions",async()=>{
 const f=fixture();await f.save({revision:0,commandId:crypto.randomUUID(),changes});
 const response=await f.app.request("/api/v1/budgeting/subscriptions/calendar?from=2027-01-01&through=2027-02-01");
 expect(response.status).toBe(200);expect(((await response.json()) as {payments:unknown[]}).payments).toMatchObject([{date:"2027-01-31",cents:12000,paid:false}]);
 expect((await f.app.request("/api/v1/budgeting/subscriptions/calendar?from=2026-01-01&through=2030-01-01")).status).toBe(400);
 expect(f.writes).toBe(1);
});


test("list joins recurring plan rules and actual posted amounts in three bulk reads", async () => {
  const f = fixture("web", undefined, {
    ...emptyPlan,
    entries: [
      { id, label: "Rent", date: "2026-11-01", cents: 115000, kind: "bill", frequency: "monthly" },
      { id: crypto.randomUUID(), label: "Paycheque", date: "2026-11-01", cents: 150000, kind: "income", frequency: "weekly", interval: 2 },
      { id: crypto.randomUUID(), label: "One-off", date: "2026-11-01", cents: 150000, kind: "income", frequency: "once" },
    ],
  });
  const actual = { id: crypto.randomUUID(), date: "2026-11-01", cents: 117500 };
  f.setPosted([{ ...actual, ruleId: id, billKey: `${id}:2026-11`, rank: 1n }]);
  const response = await f.list();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    items: [{ id, name: "Rent", kind: "bill", planEntry: true }, { name: "Paycheque", kind: "income" }],
    oneOff: [{ name: "One-off", kind: "income" }],
    paidKeys: [`${id}:2026-11`],
    charges: { [id]: [actual] },
  });
  expect(f.reads).toEqual(["plan", "subscriptions", "charges"]);
  expect(f.owners.every(owner => owner === "owner-a")).toBe(true);
});

test("plan status and review persist under the same URL and keep the plan schedule live", async () => {
  const entry = { id, label: "Rent", date: "2026-11-01", cents: 115000, kind: "bill", frequency: "monthly" };
  const f = fixture("web", undefined, { ...emptyPlan, entries: [entry] });
  const { items: [item] } = await (await f.list()).json() as { items: Subscription[] };
  const { id: _id, revision, commandId: _commandId, planEntry: _planEntry, ...fields } = item;
  const patch = { revision, commandId: crypto.randomUUID(), changes: { ...fields, status: "paused", lastReviewed: localDate() } };
  expect((await f.save(patch)).status).toBe(200);
  expect((await f.save(patch)).status).toBe(200);
  expect(f.writes).toBe(1);
  entry.cents = 120000;
  expect(await (await f.list()).json()).toMatchObject({
    items: [{ id, status: "paused", lastReviewed: localDate(), terms: [{ amountCents: 120000 }] }],
  });
  expect((await f.save({ ...patch, revision: 1, commandId: crypto.randomUUID() })).status).toBe(409);
});

test("rejects a document outside the owner scope", async () => {
  const f = fixture();
  const result = await f.save({ revision: 0, commandId: crypto.randomUUID(), changes: { ...changes, documentId: crypto.randomUUID() } });
  expect(result.status).toBe(404);
  expect(f.writes).toBe(0);
  expect(f.owners.every(owner => owner === "owner-a")).toBe(true);
});
