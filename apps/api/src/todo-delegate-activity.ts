import { z } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import type { Prisma, TodoDelegation } from "@quantself/db/generated/prisma/client";

const minuteMs = 60_000;
const defaultStaleMinutes = 24 * 60;
const permissions = { read: "todos:read", write: "todos:write" } as const;

export const todoDelegateActivitySchema = z.object({
  lastActivityAt: z.iso.datetime().nullable(),
  stale: z.boolean(),
  staleAt: z.iso.datetime().optional(),
  botHqUrl: z.url().nullable(),
});
export type TodoDelegateActivity = z.output<typeof todoDelegateActivitySchema>;

type ActivityRow = Pick<TodoDelegation, "ownerId" | "delegateId" | "assignedAt" | "lastActivityAt">;
export type ObservedTodoDelegation = Pick<TodoDelegation, "todoId" | "revision">;
export type TodoDelegateActivityConfig = {
  staleAfterMs: number;
  linksByDelegateId: ReadonlyMap<string, string>;
};

export function readTodoDelegateActivityConfig(env: NodeJS.ProcessEnv = process.env): TodoDelegateActivityConfig {
  const rawMinutes = env.QUANTSELF_TODO_DELEGATION_STALE_MINUTES?.trim() ?? "";
  const minutes = /^\d+$/.test(rawMinutes) ? Number(rawMinutes) : 0;
  const staleAfterMs = minutes > 0 && Number.isSafeInteger(minutes * minuteMs)
    ? minutes * minuteMs : defaultStaleMinutes * minuteMs;
  const linksByDelegateId = new Map<string, string>();
  try {
    const links: unknown = JSON.parse(env.QUANTSELF_BOT_HQ_AGENT_LINKS ?? "{}");
    if (typeof links === "object" && links !== null && !Array.isArray(links)) {
      for (const [id, value] of Object.entries(links)) {
        if (!id.trim() || typeof value !== "string") continue;
        const url = URL.parse(value);
        if (url?.protocol === "https:" && !url.username && !url.password) {
          linksByDelegateId.set(id, url.href);
        }
      }
    }
  } catch {
    // Bot HQ links are optional display configuration.
  }
  return { staleAfterMs, linksByDelegateId };
}

export function toTodoDelegateActivity(
  row: ActivityRow | null | undefined,
  access: AccessContext,
  working: boolean,
  config = readTodoDelegateActivityConfig(),
  now = new Date(),
): TodoDelegateActivity | null {
  if (!row?.delegateId || row.ownerId !== access.owner.id || !access.permissions.includes(permissions.read)) return null;
  if (access.client.kind !== "web" && !(access.client.kind === "agent" && access.client.id === row.delegateId)) return null;
  const since = row.lastActivityAt ?? row.assignedAt;
  const staleAt = working && since ? since.getTime() + config.staleAfterMs : null;
  return {
    lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
    stale: staleAt !== null && now.getTime() >= staleAt,
    ...(staleAt !== null && staleAt < Date.UTC(10_000, 0) && { staleAt: new Date(staleAt).toISOString() }),
    botHqUrl: access.client.kind === "web" ? config.linksByDelegateId.get(row.delegateId) ?? null : null,
  };
}

// The handler supplies the revision observed for each authorized to-do and the time it observed the activity.
export async function recordTodoDelegateActivity(
  db: Pick<Prisma.TransactionClient, "todoDelegation">,
  access: AccessContext,
  action: keyof typeof permissions,
  observed: readonly ObservedTodoDelegation[],
  at = new Date(),
): Promise<number> {
  if (access.client.kind !== "agent" || !access.permissions.includes(permissions[action]) || !observed.length) return 0;
  const updated = await db.todoDelegation.updateMany({
    where: {
      ownerId: access.owner.id,
      delegateId: access.client.id,
      assignedAt: { lte: at },
      OR: observed.map(({ todoId, revision }) => ({ todoId, revision })),
      AND: [{ OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: at } }] }],
    },
    data: { lastActivityAt: at },
  });
  return updated.count;
}
