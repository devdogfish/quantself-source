import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { ComponentProps } from "react";
import { createTestDom } from "@/components/shared/test-dom";

mock.module("next/link", () => ({
  default: ({ prefetch, ...props }: ComponentProps<"a"> & { prefetch?: boolean }) => <a {...props} data-prefetch={prefetch} />,
}));
mock.module("next/navigation", () => ({ usePathname: () => "/" }));

const dom = createTestDom();
const realFetch = globalThis.fetch;
const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const todo = (number: number, title: string, extra: object = {}) => ({
  id: `t${number}`, number, title, state: "open", closureReason: null, allDay: false, start: null, end: null, fields: {}, ...extra,
});
const bodies: Record<string, unknown> = {
  "/api/v1/todos": { todos: [
    todo(1, "Write report", { start: iso(3_600_000), end: iso(7_200_000) }),
    todo(2, "Pay rent"),
    todo(3, "Email Sam", { state: "closed", closureReason: "completed" }),
  ], readAt: iso(0) },
  "/api/v1/habits/day": {
    date: "2026-11-12", today: "2026-11-12", sha: null, stale: false, error: null,
    projection: { stacks: [{ id: "am", name: "Morning" }], habits: [
      { id: "h1", name: "Stretch", stack: "am", order: 0 }, { id: "h2", name: "Read", stack: "am", order: 1 },
    ], gate: { window: 14, required: 10 }, diagnostics: [] },
    occurrences: [
      { habitId: "h1", status: "done", missed: false }, { habitId: "h2", status: "open", missed: true },
    ],
  },
  "/api/v1/budgeting": { foodLimit: 10000, otherLimit: null, foodSpent: 2500, otherSpent: 500 },
  "/api/v1/inventory-proposals": { proposals: [{ id: "p1" }, { id: "p2" }] },
  "/api/v1/jobs/applications": { counts: { review: 3 }, applications: [] },
};
let calls: string[] = [];
let failing = new Set<string>();

beforeEach(() => {
  calls = [];
  failing = new Set();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost:3000");
    calls.push(url.pathname + url.search);
    const body = failing.has(url.pathname) ? { message: "Missing permission." } : bodies[url.pathname];
    return new Response(JSON.stringify(body), { status: failing.has(url.pathname) ? 403 : 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const settle = () => dom.click(document.body);
const hrefs = () => [...dom.container.querySelectorAll("a")].map((a) => a.getAttribute("href"));

test("shows the headline, tiles and act-on lists from five requests", async () => {
  const { HomeDashboard } = await import("./home-dashboard");
  await dom.render(<HomeDashboard />);
  await settle();
  expect(calls).toHaveLength(5);
  const text = dom.container.textContent!;
  expect(text).toContain("2 of 5 things done today");
  expect(text).toContain("2 tasks due");
  expect(text).toContain("1 habit left");
  expect(text).toContain("1/2");
  expect(text).toContain("$70.00");
  expect(text).toContain("Write report");
  expect(text).toContain("Read");
  expect(text).toContain("2 inventory proposals to review");
  expect(text).toContain("3 job applications awaiting decision");
  for (const href of ["/habits", "/todo", "/calendar", "/budgeting", "/inventory/processing", "/jobs"]) expect(hrefs()).toContain(href);
});

test("one failing area shows its error without hiding the others", async () => {
  failing.add("/api/v1/budgeting");
  const { HomeDashboard } = await import("./home-dashboard");
  await dom.render(<HomeDashboard />);
  await settle();
  expect(calls).toHaveLength(5);
  const text = dom.container.textContent!;
  expect(text).toContain("Budget: Missing permission.");
  expect(text).toContain("Retry budget");
  expect(text).toContain("2 of 5 things done today");
  expect(text).toContain("Write report");
});
