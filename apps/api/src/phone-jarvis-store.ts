import { randomUUID } from "node:crypto";
import type { PhoneJarvisStore, PhoneSession } from "./phone-jarvis-store-types";
import type { PhoneScheduleStore } from "./phone-jarvis-scheduler";
const db = async () => (await import("@quantself/db")).prisma;
const session = (row: { id: string; callSid: string | null; direction: string; captureId: string; expiresAt: Date; attempts: number; authenticated: boolean; connection: string }): PhoneSession => ({ ...row, direction: row.direction as PhoneSession["direction"], connection: row.connection as PhoneSession["connection"] });
export const phoneJarvisStore: PhoneJarvisStore & PhoneScheduleStore = {
  async createInbound(callSid) {
    const prisma = await db();
    return session(await prisma.phoneJarvisCall.upsert({ where: { callSid }, update: {}, create: { callSid, direction: "inbound", expiresAt: new Date(Date.now() + 10 * 60_000) } }));
  },
  async get(id) { const row = await (await db()).phoneJarvisCall.findUnique({ where: { id } }); return row ? session(row) : null; },
  async bindCall(id, callSid) {
    const result = await (await db()).phoneJarvisCall.updateMany({ where: { id, OR: [{ callSid: null, connection: "pending" }, { callSid }] }, data: { callSid } });
    return result.count === 1;
  },
  async consumePinAttempt(id, callSid, expectedAttempt, correct) {
    const prisma = await db();
    return prisma.$transaction(async tx => {
      const result = await tx.phoneJarvisCall.updateMany({ where: { id, callSid, connection: "pending", authenticated: false, expiresAt: { gt: new Date() }, attempts: { equals: expectedAttempt, lt: 3 } }, data: { attempts: { increment: 1 }, authenticated: correct } });
      if (!result.count) return null;
      return session(await tx.phoneJarvisCall.findUniqueOrThrow({ where: { id } }));
    });
  },
  async claimConnection(id, callSid) {
    return (await (await db()).phoneJarvisCall.updateMany({ where: { id, callSid, authenticated: true, connection: "pending", expiresAt: { gt: new Date() } }, data: { connection: "connecting" } })).count === 1;
  },
  async markConnected(id, callSid) { await (await db()).phoneJarvisCall.updateMany({ where: { id, callSid, connection: "connecting" }, data: { connection: "connected" } }); },
  async close(id, callSid, status) {
    if (!["completed", "busy", "no-answer", "failed", "canceled", "machine-or-unknown"].includes(status)) return;
    await (await db()).phoneJarvisCall.updateMany({ where: { id, callSid, connection: { not: "closed" } }, data: { connection: "closed", status } });
  },
  async status(slot) { return (await (await db()).phoneJarvisCall.findUnique({ where: { slot }, select: { status: true } }))?.status ?? null; },
  async claim(slot, now) {
    const id = randomUUID();
    const result = await (await db()).phoneJarvisCall.createMany({ data: [{ id, slot, direction: "outbound", expiresAt: new Date(now.getTime() + 10 * 60_000) }], skipDuplicates: true });
    return result.count ? { id } : null;
  },
  async uncertain(id) { await (await db()).phoneJarvisCall.updateMany({ where: { id, callSid: null, status: "created" }, data: { status: "uncertain" } }); },
};
