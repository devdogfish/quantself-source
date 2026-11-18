import { expect, test } from "bun:test";
import { planCategoryFieldRename, verifyCategoryFieldRename } from "../scripts/rename-todo-category-field";

const field = { id: 123, name: "Area", data_type: "single_select", description: "Owner categories", updated_at: "before", options: [{ id: 456, name: "Work", color: "blue", priority: 1 }] };

test("rename plan retains exact existing field identity/options and canonical field is a no-op", () => {
  const plan = planCategoryFieldRename([field]);
  expect(plan).toMatchObject({ action: "rename", fieldId: 123, optionCount: 1 });
  expect(plan.field).toBe(field);
  expect(planCategoryFieldRename([{ ...field, name: "Category" }]).action).toBe("no-op");
  expect(planCategoryFieldRename([{ ...field, options: [] }]).fingerprint).not.toBe(plan.fingerprint);
});

test("rename refuses missing fields, wrong types and duplicate names", () => {
  for (const fields of [[], [{ ...field, data_type: "text" }], [field, { ...field, id: 789 }], [{ ...field, name: "Category" }, { ...field, id: 789, name: "Category" }], [field, { ...field, id: 789, name: "Category" }]]) {
    expect(() => planCategoryFieldRename(fields)).toThrow();
  }
});

test("rename readback permits only name and field update timestamp changes", () => {
  const renamed = { ...field, name: "Category", updated_at: "after" };
  expect(() => verifyCategoryFieldRename(field, renamed)).not.toThrow();
  for (const changed of [{ ...renamed, id: 789 }, { ...renamed, options: [{ ...field.options[0], id: 999 }] }, { ...renamed, options: [] }, { ...renamed, description: "Changed" }, field]) {
    expect(() => verifyCategoryFieldRename(field, changed)).toThrow();
  }
});
