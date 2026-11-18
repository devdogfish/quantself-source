import { randomInt } from "node:crypto";
import { prisma } from "@quantself/db";
import { Prisma } from "@quantself/db/generated/prisma/client";
import { normalizeTrackedLinkTrack, trackedLinkLookup, type TrackedApplicationInput, type TrackedLinkLookup, type TrackedShareInput } from "./tracked-links-contract";

const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomCode() {
  return Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");
}

async function allocateCode<T>(insert: (code: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const code = randomCode();
    try {
      return await insert(code);
    } catch (error) {
      if (attempt === 2 || !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== "P2010" || error.meta?.code !== "23505") throw error;
    }
  }
}

export async function lookupTrackedLink(code: string): Promise<TrackedLinkLookup | null> {
  const row = await prisma.trackedLink.findUnique({
    where: { code }, select: { code: true, kind: true, track: true },
  });
  return row && trackedLinkLookup.parse({ ...row, track: normalizeTrackedLinkTrack(row.track) });
}

export async function registerTrackedApplication(input: TrackedApplicationInput) {
  return allocateCode(async code => {
    const [row] = await prisma.$queryRaw<{ code: string }[]>`
      INSERT INTO "tracked_link" (code, kind, application_id, company, title, track, revision)
      VALUES (${code}, 'application', ${input.applicationId}::uuid,
        ${input.company}, ${input.role}, ${input.track}, ${input.revision})
      ON CONFLICT (application_id) DO UPDATE SET company = EXCLUDED.company, title = EXCLUDED.title,
        track = EXCLUDED.track, revision = EXCLUDED.revision
      WHERE "tracked_link".revision < EXCLUDED.revision OR
        ("tracked_link".revision = EXCLUDED.revision
         AND ("tracked_link".track = EXCLUDED.track OR ("tracked_link".track = 'software' AND EXCLUDED.track = 'backend'))
         AND "tracked_link".company = EXCLUDED.company AND "tracked_link".title = EXCLUDED.title)
      RETURNING code
    `;
    return row ?? null;
  });
}

/** Used by confirmed Jobs receipts, including Owner reconciliation. */
export async function recordTrackedApplicationSent(
  tx: Prisma.TransactionClient,
  applicationId: string,
  sentAt: Date,
): Promise<void> {
  await tx.trackedLink.updateMany({
    where: { applicationId, kind: "application", sentAt: null },
    data: { sentAt },
  });
}

export async function registerTrackedShare({ title, track }: TrackedShareInput, db: Pick<Prisma.TransactionClient, "$queryRaw"> = prisma) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = randomCode();
    const [row] = await db.$queryRaw<{ code: string }[]>`
      INSERT INTO "tracked_link" (code, kind, title, track)
      VALUES (${code}, 'share', ${title}, ${track ?? null})
      ON CONFLICT (code) DO NOTHING
      RETURNING code
    `;
    if (row) return row;
  }
  throw new Error("Could not allocate a share code.");
}

export async function archiveTrackedShare(code: string) {
  await prisma.trackedLink.updateMany({
    where: { code, kind: "share", archivedAt: null },
    data: { archivedAt: new Date() },
  });
}
