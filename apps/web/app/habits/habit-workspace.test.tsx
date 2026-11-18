import { expect, test } from "bun:test";
import { createTestDom } from "@/components/shared/test-dom";

const dom = createTestDom();
const { HabitWorkspace } = await import("./habit-workspace");

test("Habits header exposes current section and page content", async () => {
  await dom.render(<HabitWorkspace actions="Saved locally"><p>System content</p></HabitWorkspace>);
  expect(dom.container.querySelector("h1")?.textContent).toBe("Habits");
  expect(dom.container.querySelector('nav[aria-label="Habit sections"] a[aria-current="page"]')?.textContent).toBe("System");
  expect(dom.container.querySelector("main")?.textContent).toContain("System content");
  expect(dom.container.textContent).toContain("Saved locally");
});
