import { expect, test } from "bun:test";
import { phoneJarvisCategoryTools, phoneJarvisHeadlessTaskInstructions } from "./phone-jarvis-task-tools";
import { categoryCommandSchema } from "./todos-categories";

test("phone category tools use existing authorized endpoints and fresh revisions without browser hooks", () => {
  const tools = phoneJarvisCategoryTools("https://quantself.example", "phone-secret");
  expect(tools.map(tool => tool.name)).toEqual(["read_task_categories", "change_task_category"]);
  expect(tools.map(tool => tool.api_schema.method)).toEqual(["GET", "POST"]);
  for (const tool of tools) {
    expect(tool.type).toBe("webhook");
    expect(tool.api_schema.url).toBe("https://quantself.example/api/v1/todo-categories");
    expect(tool.api_schema.request_headers).toEqual({ "X-API-Key": { secret_id: "phone-secret" } });
  }
  const schema = tools[1].api_schema.request_body_schema;
  expect(schema.required).toEqual(["commandId", "revision", "action"]);
  expect(schema.properties.action.enum).toEqual(["create", "update", "delete"]);
  for (const action of schema.properties.action.enum) {
    expect(categoryCommandSchema.safeParse({ commandId: crypto.randomUUID(), revision: "current", action, ...(action === "create" ? {} : { id: 1 }), ...(action === "delete" ? {} : { name: "Fitness", color: "blue" }) }).success).toBe(true);
  }
  expect(phoneJarvisHeadlessTaskInstructions).toContain('closure:');
  expect(phoneJarvisHeadlessTaskInstructions).toContain('trash:');
  expect(phoneJarvisHeadlessTaskInstructions).toContain('plan next week');
});

test("phone category credential transport refuses insecure or overridden origins", () => {
  for (const origin of ["http://example.test", "https://example.test/path", "https://user@example.test", "https://example.test/?key=x"]) {
    expect(() => phoneJarvisCategoryTools(origin, "secret")).toThrow();
  }
});

test("phone category tools omit unused query schemas accepted by ElevenLabs", () => {
  // Provider QueryParamsJsonSchema forbids `type` and requires at least one
  // property when present. These endpoints have no query parameters.
  for (const tool of phoneJarvisCategoryTools("https://quantself.example", "phone-secret")) {
    expect(tool.api_schema.query_params_schema).toBeNull();
  }
});
