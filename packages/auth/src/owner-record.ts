import { prisma } from "@quantself/db";

export const OWNER_RECORD_ID = "singleton";

export async function getOwnerUserId(db: Pick<typeof prisma, "authOwner"> = prisma) {
  const owner = await db.authOwner.findUnique({
    where: { id: OWNER_RECORD_ID },
    select: { userId: true },
  });
  return owner?.userId ?? null;
}
