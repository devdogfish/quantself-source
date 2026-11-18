import { expect, test } from "bun:test";
import { readTaskDescription } from "./todos-description";
import { todoCreateSchema, todoEditSchema } from "./todos-write";
test("legacy description excludes managed metadata", () => {
  expect(readTaskDescription("Existing notes\n<!-- protected -->")).toBe("Existing notes");
});
test("location uses the ordinary issue-fields contract", () => {
  const commandId = crypto.randomUUID();
  expect(todoCreateSchema.safeParse({ commandId, title: "Visit", description: "Notes", fields: { Location: "Office" } }).success).toBe(true);
  expect(todoEditSchema.safeParse({ commandId, fields: { Location: { before: "Office", after: null } } }).success).toBe(true);
  expect(todoCreateSchema.safeParse({ commandId, title: "Visit", location: "Office" }).success).toBe(false);
  expect(todoCreateSchema.safeParse({ commandId, title: "Visit", fields: { Location: "x".repeat(2001) } }).success).toBe(false);
});
