import { expect, test } from "bun:test";
import { phoneBackgroundTick } from "./phone-jarvis-background";
test("a stalled archive cannot suppress later scheduler ticks", async () => {
  let scheduled = 0;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const tick = phoneBackgroundTick(async () => { scheduled++; }, () => pending);
  tick(); tick();
  expect(scheduled).toBe(2);
  finish(); await pending;
});
test("each background failure is reported without stopping the other job", async () => {
  const messages: string[] = []; let archived = 0;
  phoneBackgroundTick(async () => { throw Error("private transport error"); }, async () => { archived++; }, message => messages.push(message))();
  await Promise.resolve(); await Promise.resolve();
  expect(archived).toBe(1);
  expect(messages).toHaveLength(1);
  expect(messages[0]).not.toContain("private transport");
});
