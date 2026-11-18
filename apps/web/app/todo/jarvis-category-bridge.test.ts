import { expect, test } from "bun:test";
import { createJarvisUiBridge, reconciledCategoryFilter, type JarvisUiContext } from "./jarvis-ui";

test("pending category saves do not block filters or later mutations and filters preserve drafts", async () => {
  const bridge = createJarvisUiBridge();
  const context: JarvisUiContext = { page: "/todo", calendarView: "list", date: "2026-10-27", selectedTask: null, panel: "new-task", categoryFilter: { filter: "all" } };
  bridge.setPage("/todo"); bridge.publish(context);
  const finishes: ((value: string) => void)[] = [];
  bridge.register(action => {
    if (action.type === "change_category") return new Promise(resolve => finishes.push(resolve));
    if (action.type === "category_filter") {
      bridge.publish({ ...context, categoryFilter: { filter: action.filter, categoryId: action.categoryId } });
      return { message: "Filtered", complete: current => current.categoryFilter?.filter === action.filter };
    }
    return "Unexpected";
  });
  const first = bridge.run({ type: "change_category", action: "update", categoryId: 1, color: "blue" });
  const second = bridge.run({ type: "change_category", action: "update", categoryId: 2, color: "green" });
  expect(finishes).toHaveLength(2);
  bridge.draft("draft", true);
  expect(await bridge.run({ type: "category_filter", filter: "uncategorized" })).toBe("Filtered");
  expect(bridge.context().panel).toBe("new-task");
  expect(bridge.hasDrafts()).toBe(true);
  expect(await bridge.run({ type: "change_category", action: "assign", categoryId: 1, taskNumbers: [1] })).toContain("Unsaved task changes");
  expect(finishes).toHaveLength(2);
  finishes[1]("Second saved"); expect(await second).toBe("Second saved");
  finishes[0]("First saved"); expect(await first).toBe("First saved");
});


test("category filter follows a saved temporary category and resets after deletion", () => {
  expect(reconciledCategoryFilter("-1", [{ id: -1, name: "Home" }], [{ id: 10, name: "Home" }])).toBe("10");
  expect(reconciledCategoryFilter("10", [{ id: 10, name: "Home" }], [])).toBe("__all");
  expect(reconciledCategoryFilter("10", [{ id: 10, name: "Home" }], [{ id: 20, name: "Home" }])).toBe("__all");
  expect(reconciledCategoryFilter("__none", [], [])).toBe("__none");
});
