import type { PhoneScheduleStore } from "./phone-jarvis-scheduler";
/** Actions run ID is stable across reruns. No destination or clock override. */
export async function requestPhoneVerificationCall(invocationId: string, store: PhoneScheduleStore, dial: (id: string) => Promise<string>): Promise<"requested" | "already-requested" | "uncertain"> {
  if (!/^[1-9]\d{0,19}$/.test(invocationId)) throw Error("Invalid verification invocation");
  const call = await store.claim(`manual-verification:${invocationId}`, new Date());
  if (!call) return "already-requested";
  try {
    const sid = await dial(call.id);
    if (!await store.bindCall(call.id, sid)) return "uncertain";
    return "requested";
  } catch {
    await store.uncertain(call.id);
    return "uncertain";
  }
}
