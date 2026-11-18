import { expect, mock, test } from "bun:test";
import { useState } from "react";
import { createTestDom } from "@/components/shared/test-dom";

mock.module("next/dynamic", () => ({
  default:
    () =>
    ({ value }: { value: string }) => (
      <div aria-label="Visual editor">{value}</div>
    ),
}));
const dom = createTestDom();

test("Budget Note keeps source edits across Markdown, Preview and Editor tabs", async () => {
  const { BudgetNoteEditor } = await import("./budget-note-editor");
  function Editor() {
    const [value, setValue] = useState("Original");
    return <BudgetNoteEditor value={value} onChange={setValue} />;
  }
  await dom.render(<Editor />);
  const tab = (label: string) =>
    [...dom.container.querySelectorAll('[role="tab"]')].find(
      (el) => el.textContent === label,
    )!;
  await dom.click(tab("Markdown"));
  const source = dom.container.querySelector("textarea")!;
  await dom.type(source as unknown as HTMLInputElement, "**Updated plan**");
  await dom.click(tab("Preview"));
  expect(
    dom.container.querySelector('[role="tabpanel"]:not([hidden]) strong')
      ?.textContent,
  ).toBe("Updated plan");
  await dom.click(tab("Editor"));
  expect(
    dom.container.querySelector('[aria-label="Visual editor"]')?.textContent,
  ).toBe("**Updated plan**");
  await dom.click(tab("Markdown"));
  expect(source.value).toBe("**Updated plan**");
});
