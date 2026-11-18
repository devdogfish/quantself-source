import { expect, test } from "bun:test";
import { OpenAPIHono, type z } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import type { prisma } from "@quantself/db";
import { registerBudgetingRoutes } from "./budgeting-route";
import { emptyPlan, type budgetState } from "./budgeting";

test("pending money saves an undated item to the owner's plan and rejects stale edits", async () => {
  const ownerId = "owner-a";
  const rows = new Map<string, z.infer<typeof budgetState>>([
    [ownerId, { revision: 1, note: "Keep this note", plan: emptyPlan, proposal: { foodCents: 5000 } }],
  ]);
  const db = { budgetPlan: {
    findUnique: async ({ where }: { where: { ownerId: string } }) => rows.get(where.ownerId),
    updateManyAndReturn: async ({ where, data }: {
      where: { ownerId: string; revision: number };
      data: { plan: z.infer<typeof budgetState>["plan"] };
    }) => {
      const prior = rows.get(where.ownerId);
      if (!prior || prior.revision !== where.revision) return [];
      const saved = { ...prior, revision: prior.revision + 1, plan: data.plan };
      rows.set(where.ownerId, saved);
      return [saved];
    },
  } };
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  app.use("*", async (c, next) => {
    c.set("accessContext", { owner: { id: ownerId }, client: { kind: "web" }, permissions: ["budgeting:write"] } as AccessContext);
    await next();
  });
  registerBudgetingRoutes(app, db as unknown as typeof prisma);
  const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost").origin;
  const id = crypto.randomUUID();
  const item = { id, label: "Reimbursement", date: null, cents: 5000 };
  const save = (before: unknown, after: unknown) => app.request("/api/v1/budgeting/pending-money", {
    method: "PUT", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ id, before, after }),
  });

  expect((await save(null, item)).status).toBe(200);
  expect(rows.get(ownerId)).toMatchObject({
    revision: 2, note: "Keep this note", proposal: { foodCents: 5000 },
    plan: { ...emptyPlan, pendingMoney: [item] },
  });
  expect((await save(null, item)).status).toBe(200);
  expect(rows.get(ownerId)?.revision).toBe(2);
  expect((await save(null, { ...item, cents: 6000 })).status).toBe(409);
  expect((await save(item, null)).status).toBe(200);
  expect(rows.get(ownerId)?.plan.pendingMoney).toEqual([]);
});
