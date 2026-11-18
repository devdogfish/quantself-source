import { z } from "@hono/zod-openapi";
import type { Prisma } from "@quantself/db/generated/prisma/client";

export const personalAssistantCaptureResource = "personalAssistantCapture";
const commandId = z.uuid();

export function personalCaptureCommandId(body: string | null | undefined) {
  const id = /^Source: Personal Gmail\nCaptured: [^\n]+\nCommand ID: ([a-f0-9-]{36})\n<!-- quantself:command [a-f0-9]{64} -->/.exec(body ?? "")?.[1];
  return id && commandId.safeParse(id).success ? id : undefined;
}

export async function personalCaptureResourceIds(
  db: Pick<Prisma.TransactionClient, "agentWriteAudit">,
  ownerId: string,
  tasks: readonly { id: string; body?: string | null }[],
) {
  // The writer stamps the issue before it can save an audit receipt. A
  // single bulk audit read also keeps later-edited source bodies private.
  const privateIds = new Set<string>();
  const unstamped = new Set<string>();
  for (const task of tasks) {
    if (personalCaptureCommandId(task.body)) privateIds.add(task.id);
    else unstamped.add(task.id);
  }
  for (const id of privateIds) unstamped.delete(id);
  if (!unstamped.size) return privateIds;
  const rows = await db.agentWriteAudit.findMany({
    where: { ownerId, resourceType: personalAssistantCaptureResource, resourceId: { in: [...unstamped] } },
    select: { resourceId: true },
  });
  for (const row of rows) privateIds.add(row.resourceId);
  return privateIds;
}
