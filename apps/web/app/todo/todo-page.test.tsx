import { afterAll, expect, mock, test } from "bun:test";

const redirect = mock((href: string) => { throw new Error(href); });
mock.module("next/navigation", () => ({ redirect }));
mock.module("./todo-workspace", () => ({ TodoWorkspace: () => null }));
afterAll(() => mock.restore());

test("legacy calendar deep links redirect with the same query", async () => {
  const { default: TodoPage } = await import("./page");
  const searchParams = Promise.resolve({ view: "week", date: "2026-11-07", task: "42", tag: ["a", "b"] });
  await expect(TodoPage({ searchParams })).rejects.toThrow("/calendar?view=week&date=2026-11-07&task=42&tag=a&tag=b");
  expect(redirect).toHaveBeenCalledTimes(1);
});

test("task list and detail URLs stay on To-Do", async () => {
  const { default: TodoPage } = await import("./page");
  redirect.mockClear();
  await TodoPage({ searchParams: Promise.resolve({ view: "list", task: "42" }) });
  expect(redirect).not.toHaveBeenCalled();
});
