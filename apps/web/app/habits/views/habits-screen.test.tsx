import { expect, mock, test } from "bun:test";
import { createTestDom } from "@/components/shared/test-dom";

const pushed: string[] = [];
mock.module("next/navigation", () => ({ useRouter: () => ({ push: (href: string) => pushed.push(href) }), usePathname: () => "/habits" }));
const dom = createTestDom();
const { HabitsDataProvider } = await import("./habits-data");
const { HabitsScreen } = await import("./habits-screen");
// Resolve the preview-only chunk before asserting its rendered contents.
await import("./stub-data");

const render = (node: React.ReactNode) => dom.render(<HabitsDataProvider fixture>{node}</HabitsDataProvider>);
const current = () => dom.container.querySelector('nav[aria-label="Habit sections"] a[aria-current="page"]')?.textContent;

test("each Habits page renders its header, section tab and sample-data badge", async () => {
  for (const [view, title, tab] of [["today", "Today", "Today"], ["all", "Habits", "Habits"], ["summary", "Summary", "Summary"], ["ask", "Ask", "Ask"]] as const) {
    await render(<HabitsScreen view={view} />);
    expect(dom.container.querySelector("h1")?.textContent).toContain(title);
    expect(dom.container.textContent).toContain("Sample data");
    expect(current()).toBe(tab);
  }
});

test("Habit page shows the habit in the header with quick stats, and unknown ids say not found", async () => {
  await render(<HabitsScreen view="habit" habitId="park" />);
  expect(dom.container.querySelector("h1")?.textContent).toContain("Park phone");
  expect(dom.container.textContent).toContain("Back after a miss");
  expect(current()).toBe("Habits");
  await render(<HabitsScreen view="habit" habitId="nope" />);
  expect(dom.container.querySelector("h1")?.textContent).toBe("Habit not found");
});

test("logging on Today updates the shared count in the header", async () => {
  await render(<HabitsScreen view="today" />);
  const before = dom.container.textContent!.match(/(\d+) of (\d+) logged/)!;
  // An open habit: none of its Done/Minimum/Skip buttons are pressed yet.
  const done = [...dom.container.querySelectorAll("button")].find((b) => b.textContent === "Done" && ![...b.parentElement!.children].some((c) => c.getAttribute("aria-pressed") === "true"))!;
  await dom.click(done);
  expect(dom.container.textContent).toContain(`${Number(before[1]) + 1} of ${before[2]} logged`);
});
