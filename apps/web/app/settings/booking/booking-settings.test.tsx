import { expect, test } from "bun:test";
import { act } from "react";
import { createTestDom } from "@/components/shared/test-dom";

const dom = createTestDom();
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); });
const settings = { timeZone: "America/Halifax", weeklyHours: { mon: [["09:00", "17:00"]] }, noticeMinutes: 720, horizonDays: 14 };

test("loads booking settings, opens a day and saves the whole value once", async () => {
  const requests: { method: string; body?: unknown }[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (request: Request) => {
    const body = request.method === "PUT" ? await request.json() : undefined;
    requests.push({ method: request.method, body });
    return new Response(JSON.stringify(body ?? settings), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const { BookingSettings } = await import("./booking-settings");
    await dom.render(<BookingSettings />);
    await settle();
    const text = () => document.body.textContent ?? "";
    expect(text()).toContain("Monday");
    expect(text()).toContain("Unavailable");
    const button = (label: string) => [...document.querySelectorAll("button")].find(element => element.textContent === label) as HTMLButtonElement;
    expect(button("Save").disabled).toBe(true);
    const tuesday = [...document.querySelectorAll("label")].find(label => label.textContent === "Tuesday")!;
    await dom.click(tuesday);
    await settle();
    expect(button("Save").disabled).toBe(false);
    await dom.click(button("Save"));
    await settle();
    expect(requests).toEqual([
      { method: "GET", body: undefined },
      { method: "PUT", body: { ...settings, weeklyHours: { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]] } } },
    ]);
    expect(button("Save").disabled).toBe(true);
  } finally {
    globalThis.fetch = previous;
  }
});
