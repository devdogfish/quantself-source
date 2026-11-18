import { expect, test } from "bun:test";
import { phoneJarvisStore as store } from "./phone-jarvis-store";
import { randomUUID } from "node:crypto";
const enabled = process.env.QUANTSELF_PHONE_DB_TEST === "1";
test.skipIf(!enabled)("PostgreSQL serializes delivery claims, PIN attempts and connection claims", async () => {
  const { prisma } = await import("@quantself/db");
  const slot = `integration:${randomUUID()}`;
  const sid = `CA${randomUUID().replaceAll("-", "")}`;
  let id: string | undefined;
  try {
    const claims = await Promise.all(Array.from({length: 8}, () => store.claim(slot, new Date())));
    const winners = claims.filter(x => x !== null);
    expect(winners).toHaveLength(1);
    id = winners[0]!.id;
    expect(await store.bindCall(id, sid)).toBe(true);
    expect(await store.bindCall(id, `CA${"0".repeat(32)}`)).toBe(false);
    const attempts = await Promise.all(Array.from({length: 8}, () => store.consumePinAttempt(id!, sid, 0, true)));
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect((await store.get(id))?.attempts).toBe(1);
    const connected = await Promise.all(Array.from({length: 8}, () => store.claimConnection(id!, sid)));
    expect(connected.filter(Boolean)).toHaveLength(1);
    await store.close(id, sid, "completed");
    await store.close(id, sid, "no-answer");
    expect(await store.status(slot)).toBe("completed");
    expect(await store.claimConnection(id, sid)).toBe(false);
  } finally { if (id) await prisma.phoneJarvisCall.delete({ where: { id } }); }
});
