import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createTestDom } from "../shared/test-dom";

const dom = createTestDom();
const originalFetch = globalThis.fetch;
const replies: (() => void)[] = [];
const writes: unknown[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  replies.length = 0;
  writes.length = 0;
});

function deferWrites(value: unknown) {
  globalThis.fetch = (async (_url, options) => {
    if (!options?.method) return Response.json(value);
    writes.push(JSON.parse(String(options.body)));
    await new Promise<void>((resolve) => replies.push(resolve));
    return Response.json({});
  }) as typeof fetch;
}
function button(text: string) {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((el) => el.textContent === text);
  expect(found).toBeDefined();
  return found!;
}
async function flushWrites() {
  await act(async () => {
    for (let i = 0; i < writes.length; i++) {
      replies[i]!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

test("notification controls stay usable for successive changes and Undo/Redo during saving", async () => {
  deferWrites({ enabled: true, morning: "09:00" });
  const { NotificationSettings } = await import("./settings");
  await dom.render(<NotificationSettings />);
  await dom.click(button("Turn notifications off"));
  expect(document.querySelector('[role="status"]')?.textContent).toBe(
    "Saving…",
  );
  await dom.click(button("Turn notifications on"));
  await dom.click(button("Undo"));
  expect(button("Turn notifications on").disabled).toBe(false);
  await dom.click(button("Redo"));
  expect(button("Turn notifications off").disabled).toBe(false);
  await flushWrites();
  expect(button("Turn notifications off").disabled).toBe(false);
  expect(writes).toEqual(
    [false, true, false, true].map((enabled) => ({
      enabled,
      morning: "09:00",
    })),
  );
  expect(document.querySelector('[role="status"]')).toBeNull();
});

test("task alert native radios support selection, Escape and optimistic Undo/Redo", async () => {
  deferWrites({ minutes: 10, morning: null });
  const { TaskAlert } = await import("./task-alert");
  await dom.render(<TaskAlert number={169001} />);
  await dom.click(button("10 minutes before"));
  const selected = document.querySelector<HTMLInputElement>(
    'input[type="radio"][value="10"]',
  )!;
  expect(selected).not.toBeNull();
  expect(selected.checked).toBe(true);
  // Browser-native radio arrow navigation selects through the input click event.
  await dom.click(
    document.querySelector<HTMLInputElement>(
      'input[type="radio"][value="15"]',
    )!,
  );
  expect(button("15 minutes before")).toBeDefined();
  await dom.click(button("Undo"));
  expect(button("10 minutes before")).toBeDefined();
  await dom.click(button("Redo"));
  expect(button("15 minutes before")).toBeDefined();
  await dom.click(button("15 minutes before"));
  await act(async () => {
    document
      .querySelector<HTMLInputElement>('input[type="radio"][value="15"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(button("15 minutes before").getAttribute("aria-expanded")).toBe(
    "false",
  );
  await flushWrites();
  expect(button("15 minutes before")).toBeDefined();
  expect(writes).toEqual(
    [15, 10, 15].map((minutes) => ({ minutes, morning: null })),
  );
});

test("custom date-only alerts retain their morning field and presets", async () => {
  deferWrites({ minutes: null, morning: null });
  const { TaskAlert } = await import("./task-alert");
  await dom.render(<TaskAlert number={169002} dateOnly />);
  await dom.click(button("None"));
  await dom.click(button("Custom…"));
  expect(document.querySelector('input[type="number"]')).toBeNull();
  expect(
    document.querySelector('label[for="alert-morning-169002"]')?.textContent,
  ).toBe("Date-only deadline");
  await dom.type(
    document.querySelector<HTMLInputElement>('input[type="time"]')!,
    "08:30",
  );
  expect(button("On due date (08:30)")).toBeDefined();
  await dom.click(button("‹ Alert presets"));
  expect(
    document.querySelector('input[type="radio"][value="10"]'),
  ).not.toBeNull();
  await flushWrites();
});
