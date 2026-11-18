import { expect, test } from "bun:test";
import { reconcilePhoneJarvisWrite } from "./phone-jarvis-write-retry";

test("reconciles uncertain delivery before returning saved outcome; reuses original command", async () => {
  const command = { commandId: "original", provenance: { capturedAt: "original-time" } };
  const inputs: typeof command[] = [];
  const receipts = new Set<string>();
  let creates = 0;
  const result = await reconcilePhoneJarvisWrite(async () => {
    inputs.push(command);
    if (!receipts.has(command.commandId)) { creates++; receipts.add(command.commandId); return { retryable: true, outcomes: { issue: "uncertain" } }; }
    return { retryable: false, outcomes: { issue: "saved" } };
  });
  expect(result.outcomes.issue).toBe("saved");
  expect(inputs).toHaveLength(2);
  expect(inputs.every(input => input === command)).toBe(true);
  expect(creates).toBe(1);
});

test("persistent uncertainty stops after two attempts and remains uncertain", async () => {
  let calls = 0;
  const uncertain = { retryable: true, outcomes: { issue: "uncertain", title: "saved" } };
  expect(await reconcilePhoneJarvisWrite(async () => { calls++; return uncertain; })).toBe(uncertain);
  expect(calls).toBe(2);
});

test("conflicts/validation/auth failures and saved results never trigger automatic retry", async () => {
  for (const code of ["OVERLAP_REVIEW_REQUIRED", "IDEMPOTENCY_CONFLICT", "FORBIDDEN", "INVALID_COMMAND"]) {
    let calls = 0;
    const error = new Error(code);
    await expect(reconcilePhoneJarvisWrite(async () => { calls++; throw error; })).rejects.toBe(error);
    expect(calls).toBe(1);
  }
  let calls = 0;
  await reconcilePhoneJarvisWrite(async () => { calls++; return { retryable: false }; });
  expect(calls).toBe(1);
});

test("slow first attempt does not start another provider request", async () => {
  let calls = 0;
  const times = [0, 20_000];
  await reconcilePhoneJarvisWrite(async () => { calls++; return { retryable: true }; }, () => times.shift()!);
  expect(calls).toBe(1);
});


test("typed transient failure respects Retry-After and never exceeds two attempts", async () => {
  const { TodoReadError } = await import("./todos-github");
  let calls = 0, time = 0;
  const waits: number[] = [];
  expect(await reconcilePhoneJarvisWrite(async () => {
    if (++calls === 1) throw new TodoReadError("TODO_UNAVAILABLE", "Unavailable", 2);
    return { retryable: false };
  }, () => time, async ms => { waits.push(ms); time += ms; })).toEqual({ retryable: false });
  expect(calls).toBe(2); expect(waits).toEqual([2000]);
  calls = 0;
  const error = new TodoReadError("TODO_UNAVAILABLE", "Unavailable", 21);
  await expect(reconcilePhoneJarvisWrite(async () => { calls++; throw error; }, () => 0)).rejects.toBe(error);
  expect(calls).toBe(1);
});

test("failed reconciliation retains known partial outcomes", async () => {
  let calls = 0;
  const partial = { retryable: true, outcomes: { title: "saved", issue: "uncertain" } };
  expect(await reconcilePhoneJarvisWrite(async () => {
    if (++calls === 1) return partial;
    throw new TypeError("fetch failed");
  })).toBe(partial);
  expect(calls).toBe(2);
});

test("network and typed 503 retry once; other exceptions retain original denial", async () => {
  const { TodoWriteError } = await import("./todos-write");
  for (const error of [new TypeError("fetch failed"), new TodoWriteError("JARVIS_UNAVAILABLE", "Unavailable", 503)]) {
    let calls = 0;
    await expect(reconcilePhoneJarvisWrite(async () => { calls++; throw error; })).rejects.toBe(error);
    expect(calls).toBe(2);
  }
  for (const error of [new TypeError("invalid argument"), new TodoWriteError("IDEMPOTENCY_CONFLICT", "Conflict"), new Error("Unknown failure")]) {
    let calls = 0;
    await expect(reconcilePhoneJarvisWrite(async () => { calls++; throw error; })).rejects.toBe(error);
    expect(calls).toBe(1);
  }
});
