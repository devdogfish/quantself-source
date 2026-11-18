import { expect, test } from "bun:test";
import { createTestDom } from "./test-dom";

const dom = createTestDom();
const items = [{ value: "all", label: "All types" }, { value: "a", label: "Type A" }];

test("trigger is marked active only when a non-first item is selected", async () => {
  const { FilterSelect } = await import("./filter-select");
  await dom.render(<FilterSelect label="Type" w="40" value="all" onChange={() => {}} items={items} />);
  const trigger = () => dom.container.querySelector<HTMLElement>('button[aria-label="Type"]')!;
  expect(trigger().textContent).toContain("All types");
  expect(trigger().hasAttribute("data-active")).toBe(false);
  await dom.render(<FilterSelect label="Type" w="40" value="a" onChange={() => {}} items={items} />);
  expect(trigger().textContent).toContain("Type A");
  expect(trigger().hasAttribute("data-active")).toBe(true);
});
