/** The schedule has no dependency on tasks or a planning-completion flag. */
export function phoneCallSlot(now: Date): { day: string; attempt: 0 | 1; key: string } | null {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Halifax", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const value = (name: string) => parts.find(p => p.type === name)!.value;
  if (value("hour") !== "21" || !["00", "10"].includes(value("minute"))) return null;
  const day = `${value("year")}-${value("month")}-${value("day")}`;
  const attempt = value("minute") === "00" ? 0 : 1;
  return { day, attempt, key: `${day}:${attempt}` };
}
export interface PhoneScheduleStore {
  status(slot: string): Promise<string | null>;
  /** Unique slot insert. Returns null if any worker already claimed delivery. */
  claim(slot: string, now: Date): Promise<{ id: string } | null>;
  bindCall(id: string, callSid: string): Promise<boolean>;
  uncertain(id: string): Promise<void>;
}
export function createPhoneScheduler(store: PhoneScheduleStore, dial: (id: string) => Promise<string>, report: (message: string) => void = console.error) {
  let running = false;
  return async (now = new Date()) => {
    if (running) return;
    const slot = phoneCallSlot(now);
    if (!slot) return;
    running = true;
    try {
      if (slot.attempt === 1 && !["no-answer", "busy"].includes(await store.status(`${slot.day}:0`) ?? "")) return;
      const call = await store.claim(slot.key, now);
      if (!call) return;
      // Claim before external side effect. Lost responses cannot cause duplicate calls.
      try {
        const sid = await dial(call.id);
        if (!await store.bindCall(call.id, sid)) report("Phone Jarvis call binding requires reconciliation");
      } catch {
        await store.uncertain(call.id);
        report("Phone Jarvis call delivery uncertain; automatic redial suppressed");
      }
    } finally { running = false; }
  };
}
