import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { TodoWriteError } from "./todos-write";

export const categoryColorSchema = z.enum(["gray", "blue", "green", "yellow", "orange", "red", "pink", "purple"]);
export const categorySchema = z.object({ id: z.number().int(), name: z.string(), color: categoryColorSchema, description: z.string().nullable().optional(), priority: z.number().optional() }).openapi("TodoCategory");
export const categoriesSchema = z.object({ categories: z.array(categorySchema), revision: z.string() }).openapi("TodoCategories");
export const categoryCommandSchema = z.object({
  commandId: z.string().uuid(), revision: z.string(),
  action: z.enum(["create", "update", "delete"]),
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  color: categoryColorSchema.optional(),
}).strict().superRefine((v, ctx) => {
  if (v.action !== "create" && !v.id) ctx.addIssue({ code: "custom", message: "Choose a category." });
  if (v.action !== "delete" && (!v.name || !v.color)) ctx.addIssue({ code: "custom", message: "Supply a name and color." });
}).openapi("TodoCategoryCommand");
export type TodoCategories = z.infer<typeof categoriesSchema>;
export type CategoryCommand = z.infer<typeof categoryCommandSchema>;
export type Category = z.infer<typeof categorySchema>;
export type CategoryService = { list(): Promise<TodoCategories>; write(client: string, command: CategoryCommand): Promise<TodoCategories> };
export type CategoryDefinition = { id: number; options?: Category[] };
export function categorySnapshot(field: CategoryDefinition): TodoCategories {
  const categories = field.options ?? [];
  return { categories, revision: createHash("sha256").update(JSON.stringify({ id: field.id, categories })).digest("hex") };
}

// Options are replaced as a set by GitHub. Always retain IDs and unrelated metadata.
export function changedCategories(current: TodoCategories, command: CategoryCommand) {
  if (current.revision !== command.revision) throw new TodoWriteError("TODO_CONFLICT", "Categories changed. Refresh before saving.", 409);
  if (command.action !== "create" && !current.categories.some(c => c.id === command.id)) throw new TodoWriteError("TODO_CONFLICT", "Category no longer exists.", 409);
  if (command.name && current.categories.some(c => c.id !== command.id && c.name.toLowerCase() === command.name!.toLowerCase())) throw new TodoWriteError("TODO_CONFLICT", "A category with that name already exists.", 409);
  if (command.action === "delete") return current.categories.filter(c => c.id !== command.id);
  if (command.action === "update") return current.categories.map(c => c.id === command.id ? { ...c, name: command.name!, color: command.color! } : c);
  return [...current.categories, { name: command.name!, color: command.color!, priority: Math.max(0, ...current.categories.map(c => c.priority ?? 0)) + 1 }];
}

export class CategoryPermissionError extends Error {
  readonly code = "TODO_CATEGORY_PERMISSION";
  readonly status = 403;
}
