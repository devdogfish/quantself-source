import { prisma } from "@quantself/db";
import type { PrismaClient } from "@quantself/db/generated/prisma/client";
import { createTaskDrain } from "./task-drain";

const dayMs = 86_400_000;

export function clearExpiredWebsiteVisitorIds(
  asOf = new Date(),
  db: Pick<PrismaClient, "$executeRaw"> = prisma,
) {
  return db.$executeRaw`
    UPDATE website_event
    SET visitor_id = NULL
    WHERE visitor_id IS NOT NULL
      AND occurred_at < ((${asOf}::timestamptz AT TIME ZONE 'UTC') - INTERVAL '13 months') AT TIME ZONE 'UTC'
  `;
}

export function startWebsiteVisitorRetention() {
  const drain = createTaskDrain();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  const run = () => void drain.run(async () => {
    try {
      await clearExpiredWebsiteVisitorIds();
    } catch {
      console.error("Website visitor ID cleanup failed. Retrying on the next daily run.");
    }
    if (stopping) return;
    timer = setTimeout(run, dayMs);
    timer.unref();
  });
  run();
  return () => {
    stopping = true;
    clearTimeout(timer);
    return drain.stop();
  };
}
