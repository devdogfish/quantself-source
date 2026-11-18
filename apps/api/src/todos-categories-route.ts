import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { authorizeAccessContext, type AccessContext } from "@quantself/auth";
import { jsonAuthorizationFailure } from "./authorization-response";
import type { TodoReader } from "./todos-github";
import { TodoWriteError } from "./todos-write";
import { CategoryPermissionError, categoriesSchema, categoryCommandSchema } from "./todos-categories";

export function registerCategoryRoutes(app: OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>, reader: TodoReader) {
  for (const method of ["get", "post"] as const) {
    const route = createRoute({
      method, path: "/api/v1/todo-categories", tags: ["To-Dos"],
      operationId: method === "get" ? "listTodoCategories" : "changeTodoCategory",
      summary: method === "get" ? "Read task categories" : "Manage task categories",
      description: `Authentication: X-API-Key or trusted Owner ingress. Required permissions: ${method === "get" ? "todos:read" : "todos:write"}. Inputs: ${method === "get" ? "none" : "category command with UUID, revision, action and option details"}. Success response: 200 current Category options and revision. Failure responses: 400 invalid input, 401 unauthenticated, 403 denied, 409 conflicting revision or category in use, 503 unavailable. Side effects: ${method === "get" ? "none" : "updates organization Category options retaining IDs"}. Destructive: ${method === "get" ? "no" : "yes"}. Retry safety: reads safe to repeat; writes require identical command ID and payload to reconcile. No task-data caching.${method === "get" ? "" : " Agent Clients cannot perform this mutation."}`,
      "x-destructive": method === "post",
      security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
      "x-required-permissions": [method === "get" ? "todos:read" : "todos:write"],
      ...(method === "post" ? { request: { body: { required: true, content: { "application/json": { schema: categoryCommandSchema, example: { commandId: "5d72f10e-99cc-4d46-8bf8-d09f420ba453", revision: "revision", action: "create", name: "Fitness", color: "green" } } } } } } : {}),
      responses: {
        200: { description: "Current categories", content: { "application/json": { schema: categoriesSchema, example: { categories: [], revision: "revision" } } } },
        ...Object.fromEntries([400, 401, 403, 409, 503].map(code => [code, { description: "Request failed", content: { "application/json": { schema: z.object({ code: z.string(), message: z.string() }), example: { code: "TODO_CONFLICT", message: "Categories changed. Refresh before saving." } } } }])),
      },
    });
    app.openapi(route, async context => {
      context.header("Cache-Control", "private, no-store");
      const access = context.get("accessContext") as AccessContext | null;
      const auth = authorizeAccessContext(access, { domain: "todos", action: method === "get" ? "read" : "write" });
      if (!auth.ok) return jsonAuthorizationFailure(context, auth.error);
      try {
        if (!reader.categories) throw new TodoWriteError("TODO_UNAVAILABLE", "Category management unavailable.", 503);
        const result = method === "get" ? await reader.categories.list() : await reader.categories.write(access!.client.id, categoryCommandSchema.parse(await context.req.json()));
        return context.json(result, 200);
      } catch (error) {
        const status = (error instanceof TodoWriteError || error instanceof CategoryPermissionError) ? error.status : 503;
        return context.json({ code: (error instanceof TodoWriteError || error instanceof CategoryPermissionError) ? error.code : "TODO_UNAVAILABLE", message: error instanceof Error ? error.message : "Categories unavailable." }, status);
      }
    });
  }
}
