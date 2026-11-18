import { expect, test } from "bun:test";
import { createPhoneScheduler, phoneCallSlot } from "./phone-jarvis-scheduler";

test("21:00/21:10 Halifax follows DST; never catches up with a late call", () => {
  expect(phoneCallSlot(new Date("2026-10-31T00:00:00Z"))?.key).toBe("2026-10-30:0");
  expect(phoneCallSlot(new Date("2026-11-02T01:10:00Z"))?.key).toBe("2026-11-01:1");
  expect(phoneCallSlot(new Date("2026-11-02T01:11:00Z"))).toBeNull();
  expect(phoneCallSlot(new Date("2026-11-02T00:00:00Z"))).toBeNull();
});
function fixture(prior: string | null = null) {
  const claims = new Set<string>(); let dials = 0; let uncertain = 0;
  const store = {
    status: async () => prior,
    claim: async (slot: string) => { if (claims.has(slot)) return null; claims.add(slot); return { id: slot }; },
    bindCall: async () => true,
    uncertain: async () => { uncertain++; },
  };
  return { store, dial: async () => { dials++; return "sid"; }, counts: () => ({ dials, uncertain }) };
}
test("competing/restarted workers dial at most once for the same slot", async () => {
  const f = fixture(); const date = new Date("2026-10-31T00:00:05Z");
  await Promise.all([createPhoneScheduler(f.store, f.dial)(date), createPhoneScheduler(f.store, f.dial)(date)]);
  await createPhoneScheduler(f.store, f.dial)(date);
  expect(f.counts().dials).toBe(1);
});
test("only unanswered or busy first call earns one retry", async () => {
  for (const status of [null, "created", "completed", "failed", "uncertain", "no-answer", "busy"]) {
    const f = fixture(status); const tick = createPhoneScheduler(f.store, f.dial);
    await tick(new Date("2026-10-31T00:10:00Z"));
    await tick(new Date("2026-10-31T00:10:20Z"));
    expect(f.counts().dials).toBe(["no-answer", "busy"].includes(status ?? "") ? 1 : 0);
  }
});
test("lost provider response is durable uncertainty, never an automatic redial", async () => {
  const f = fixture(); const tick = createPhoneScheduler(f.store, async () => { throw Error("timeout"); }, () => {});
  await tick(new Date("2026-10-31T00:00:00Z"));
  await tick(new Date("2026-10-31T00:00:30Z"));
  expect(f.counts().uncertain).toBe(1);
});
