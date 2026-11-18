import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";
import { clearExpiredWebsiteVisitorIds } from "./website-visitor-retention";

test.skipIf(process.env.QUANTSELF_WEBSITE_DB_TEST !== "1")(
  "clears IDs strictly older than 13 UTC calendar months without deleting events",
  async () => {
    const { prisma } = await import("@quantself/db");
    const visitor = randomUUID();
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`
        CREATE TEMP TABLE website_event (occurred_at timestamptz, visitor_id uuid) ON COMMIT DROP
      `;
      await tx.$executeRaw`
        INSERT INTO website_event VALUES
        ('2025-09-30T11:59:59.999Z', ${visitor}::uuid),
        ('2025-09-30T12:00:00.000Z', ${visitor}::uuid),
        ('2025-10-01T12:00:00.000Z', ${visitor}::uuid)
      `;
      const asOf = new Date("2026-10-31T12:00:00Z");
      expect(await clearExpiredWebsiteVisitorIds(asOf, tx)).toBe(1);
      expect(await clearExpiredWebsiteVisitorIds(asOf, tx)).toBe(0);
      const rows = await tx.$queryRaw<{ visitor_id: string | null }[]>`
        SELECT visitor_id FROM website_event ORDER BY occurred_at
      `;
      expect(rows.map(row => row.visitor_id)).toEqual([null, visitor, visitor]);
    });
  },
);
