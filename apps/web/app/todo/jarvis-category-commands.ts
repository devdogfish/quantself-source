"use client";
import { useRef } from "react";
import { useCategories, categoryColors, type Color } from "./todo-categories";
import { readTodoJson, type LiveTodo } from "./todo-live";

export type JarvisCategoryCommand = {
  action: "create" | "update" | "delete" | "assign" | "priority";
  categoryId?: number | null;
  name?: string;
  color?: string;
  taskNumbers?: number[];
  replacementCategoryId?: number | null;
  highPriority?: boolean;
};

type Result = { status: "saved" | "partial"; action: string; category?: { id: number; name: string; color: Color }; saved?: number[]; failed?: { number: number; message: string }[] };

/** Reuse the manual UI's optimistic category and task queues, including their history. */
export function useJarvisCategoryCommands({ todos, writable }: { todos: LiveTodo[]; writable: boolean }) {
  const categories = useCategories();
  const current = useRef({ todos, writable, categories });
  current.current = { todos, writable, categories };
  // Overlay only the gap before React publishes the shared queue's projection. Later manual edits/Undo win.
  const overlays = useRef(new Map<number, { token: symbol; source: LiveTodo[]; todo: LiveTodo }>());
  const pending = useRef(new Map<string, { token: symbol; after: string | null; promise: Promise<void> }>());
  function task(number: number) {
    const overlay = overlays.current.get(number);
    return overlay?.source === current.current.todos ? overlay.todo : current.current.todos.find(todo => todo.number === number);
  }
  function queue(todo: LiveTodo, field: "Category" | "Top priority", after: string | null) {
    const token = Symbol(), key = `${todo.number}:${field}`;
    overlays.current.set(todo.number, { token, source: current.current.todos, todo: { ...todo, fields: { ...todo.fields, [field]: after } } });
    let save: Promise<void>;
    try { save = current.current.categories.queueEdit({ commandId: crypto.randomUUID(), fields: { [field]: { before: todo.fields[field] ?? null, after } } }, todo); }
    catch (error) { save = Promise.reject(error); }
    const promise = save.finally(() => {
      if (pending.current.get(key)?.token === token) pending.current.delete(key);
      if (overlays.current.get(todo.number)?.token === token) overlays.current.delete(todo.number);
    });
    pending.current.set(key, { token, after, promise });
    return promise;
  }
  async function assign(rows: LiveTodo[], field: "Category" | "Top priority", after: string | null) {
    // Queue synchronously so every row projects in this interaction; the existing task queue serializes delivery.
    const results = await Promise.allSettled(rows.map(todo => {
      if (todo.fields[field] === after || todo.fields[field] == null && after === null) {
        const saving = pending.current.get(`${todo.number}:${field}`);
        return saving?.after === after ? saving.promise : Promise.resolve();
      }
      return queue(todo, field, after);
    }));
    const saved: number[] = [], failed: { number: number; message: string }[] = [];
    results.forEach((result, index) => result.status === "fulfilled" ? saved.push(rows[index].number) : failed.push({ number: rows[index].number, message: result.reason instanceof Error ? result.reason.message : "Save failed." }));
    return { saved, failed };
  }
  async function execute(command: JarvisCategoryCommand): Promise<Result> {
    if (!current.current.writable) throw Error("Task write access unavailable.");
    const state = current.current.categories;
    if (command.action !== "priority" && !(command.action === "assign" && command.categoryId == null) && !state.revision) throw Error("Categories are still loading or unavailable.");
    if ((command.action === "create" || command.action === "update") && command.color !== undefined && !Object.hasOwn(categoryColors, command.color)) throw Error("Choose gray, blue, green, yellow, orange, red, pink or purple.");
    const color = command.color as Color | undefined;
    if (command.action === "create") {
      if (!command.name?.trim()) throw Error("A category name is required.");
      const category = await state.change({ action: "create", name: command.name, color: color ?? "blue" });
      return { status: "saved", action: command.action, category };
    }
    let category = command.categoryId == null ? undefined : state.getCategory(command.categoryId);
    if (command.action === "update") {
      if (!category) throw Error("Category not found. Read the current categories first.");
      const updated = await state.change({ action: "update", id: category.id, name: command.name, color });
      return { status: "saved", action: command.action, category: updated };
    }
    if (command.action === "delete") {
      if (!category) throw Error("Category not found. Read the current categories first.");
      let replacement = command.replacementCategoryId == null ? undefined : state.getCategory(command.replacementCategoryId);
      if (command.replacementCategoryId != null && (!replacement || replacement.id === category.id)) throw Error("Choose a different existing replacement category.");
      // Deletion requires complete membership, including trashed tasks. One read per deletion, never per row.
      await state.waitForWrites();
      const { todos: all } = await readTodoJson<{ todos: LiveTodo[] }>("/api/v1/todos?trash=include");
      if (!current.current.writable) throw Error("Task write access unavailable.");
      category = current.current.categories.getCategory(command.categoryId!);
      replacement = command.replacementCategoryId == null ? undefined : current.current.categories.getCategory(command.replacementCategoryId);
      if (!category || command.replacementCategoryId != null && !replacement) throw Error("Categories changed while checking tasks. Refresh and retry.");
      const deleting = category;
      const affected = all.map(row => {
        const local = task(row.number);
        return local?.updatedAt === row.updatedAt ? local : row;
      }).filter(row => row.fields.Category === deleting.name);
      const result = await assign(affected, "Category", replacement?.name ?? null);
      if (result.failed.length) return { status: "partial", action: command.action, ...result };
      const latest = current.current.categories.getCategory(command.categoryId!);
      if (!latest || latest.name !== deleting.name) throw Error("Category changed during reassignment; category kept. Review task outcomes before retrying.");
      await current.current.categories.change({ action: "delete", id: latest.id });
      return { status: "saved", action: command.action, ...result };
    }
    if (command.action !== "assign" && command.action !== "priority") throw Error("Unknown category action.");
    if (!Array.isArray(command.taskNumbers) || !command.taskNumbers.length || command.taskNumbers.length > 100 || command.taskNumbers.some(number => !Number.isSafeInteger(number) || number <= 0)) throw Error("Supply 1–100 saved task numbers.");
    const rows = [...new Set(command.taskNumbers)].map(number => {
      const row = task(number);
      if (!row || row.optimistic || row.trashed) throw Error(`Task #${number} is unavailable. Refresh its current facts.`);
      return row;
    });
    let field: "Category" | "Top priority" = "Category", after: string | null = null;
    if (command.action === "assign") {
      if (command.categoryId != null && !category) throw Error("Category not found. Read the current categories first.");
      after = category?.name ?? null;
    } else {
      if (typeof command.highPriority !== "boolean") throw Error("Supply highPriority true or false.");
      field = "Top priority"; after = command.highPriority ? "Yes" : "No";
      const selected = new Set(current.current.todos.filter(row => (task(row.number) ?? row).fields["Top priority"] === "Yes").map(row => row.number));
      for (const row of rows) command.highPriority ? selected.add(row.number) : selected.delete(row.number);
      if (selected.size > 3) throw Error("Only three tasks can be high priority. Remove one before adding another.");
    }
    const result = await assign(rows, field, after);
    return { status: result.failed.length ? "partial" : "saved", action: command.action, ...result };
  }
  return { execute };
}
