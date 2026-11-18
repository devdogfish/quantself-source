import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import type { prisma } from "@quantself/db";
import { registerBudgetingRoutes } from "./budgeting-route";
import { emptyPlan } from "./budgeting";
const id = "cc4e401d-74a1-4ec7-8b23-b1e97dbc0642";
function appWith(db: unknown, permissions = ["budgeting:read", "budgeting:write", "inventory:read"], kind: "web" | "api-key" = "web") {
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  app.use("*", async (c, next) => {
    c.set("accessContext", { owner: { id: "owner", email: "owner@example.com", name: "Owner" }, client: { id: "client", kind, name: "Test" }, permissions } as AccessContext);
    await next();
  });
  registerBudgetingRoutes(app, db as typeof prisma); return app;
}
test("affordability has three bulk reads, no writes, and requires the owner session", async () => {
  const calls: string[] = [];
  const db = {
    budgetPlan: { findUnique: async () => { calls.push("plan"); return { plan: emptyPlan }; } },
    budgetSubscription: { findMany: async () => { calls.push("subscriptions"); return []; } },
    budgetExpense: { findMany: async () => { calls.push("expenses"); return []; } },
  };
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Halifax" }).format(new Date());
  const path = `/api/v1/budgeting/affordability?amount=10000&date=${date}`;
  const response = await appWith(db).request(path);
  expect(response.status).toBe(200); expect(calls).toEqual(["plan", "subscriptions", "expenses"]);
  expect((await response.json() as { available: number | null }).available).toBeNull();
  expect((await appWith({}, ["budgeting:read"], "api-key").request(path)).status).toBe(403);
});
test("Calendar reads plan bills/income without duplicating subscription events", async () => {
  const db = { budgetSubscription: { findMany: async () => [] }, budgetPlan: { findUnique: async () => ({ plan: { ...emptyPlan, entries: [
    { id, label: "Rent", kind: "bill", date: "2026-11-30", cents: 100000, frequency: "monthly" },
  ] } }) }, budgetExpense: { findMany: async () => [{ billKey: id + ":2026-11" }] } };
  const response = await appWith(db).request("/api/v1/budgeting/commitments?from=2026-11-01&through=2026-11-30");
  const data = await response.json() as { events: { paid: boolean; label: string }[] };
  expect(response.status).toBe(200); expect(data.events).toHaveLength(1); expect(data.events[0]).toMatchObject({ label: "Rent", paid: true });
});
test("purchase links require inventory read permission and cannot read another owner's purchase", async () => {
  const path = `/api/v1/budgeting/item-links?type=receipt&id=${id}`;
  expect((await appWith({}, ["budgeting:read"]).request(path)).status).toBe(403);
  let where: unknown;
  const db = { budgetReceipt: { findUnique: async (args: { where: unknown }) => { where = args.where; return null; } } };
  expect((await appWith(db).request(path)).status).toBe(404);
  expect(where).toEqual({ ownerId_id: { ownerId: "owner", id } });
});
