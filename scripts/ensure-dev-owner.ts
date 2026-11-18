import { prisma } from "../packages/db/index";
import { OWNER_RECORD_ID } from "../packages/auth/src/owner-record";

const databaseUrl = process.env.DATABASE_URL;
const database = databaseUrl && URL.canParse(databaseUrl) ? new URL(databaseUrl) : undefined;
if (process.env.NODE_ENV !== "development" || database?.hostname !== "127.0.0.1" || !database.port) {
  throw new Error("Local Owner fixture creation requires a published loopback development database.");
}

try {
  await prisma.$transaction(async tx => {
    if (await tx.authOwner.findUnique({ where: { id: OWNER_RECORD_ID } })) return;
    if (await tx.user.findFirst({ select: { id: true } })) {
      throw new Error("Restore the local singleton Owner before starting Quantself.");
    }
    await tx.authOwner.create({
      data: {
        id: OWNER_RECORD_ID,
        user: { create: { id: "owner", email: "local@quantself.valid", name: "Quantself Local 2.0" } },
      },
    });
  });
} finally {
  await prisma.$disconnect();
}
