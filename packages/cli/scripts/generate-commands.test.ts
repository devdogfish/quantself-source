import { expect, test } from "bun:test";
import { generateCommands, loadMountedOpenApi, renderCommands } from "./generate-commands.ts";

const jsonResponse = { 200: { content: { "application/json": {} } } };
const security = [{ apiKeyAuth: [] }, { ownerSession: [] }];
const read = (operationId: string, tags = ["Jobs"]) => ({
  operationId,
  tags,
  summary: operationId,
  responses: jsonResponse,
});

test("selects the supported resources, credentials and JSON formats", () => {
  const spec = {
    security,
    paths: {
      "/api/v1/jobs/applications/import": { post: { ...read("importJobApplications"), requestBody: { content: { "application/json": { schema: { type: "object" } } } } } },
      "/api/v1/jobs/applications/export": { get: { ...read("exportJobApplications"), security: [{ ownerSession: [] }] } },
      "/api/v1/jobs/applications/combined": { get: { ...read("needsBothCredentials"), security: [{ apiKeyAuth: [], ownerSession: [] }] } },
      "/api/v1/jobs/work/claim": { post: read("claimJobWork") },
      "/api/v1/todos": { get: read("listTodos", ["To-Dos"]), post: read("createTodo", ["To-Dos"]) },
      "/api/v1/todos/live": { get: { ...read("subscribeTodoChanges", ["To-Dos"]), responses: { 200: { content: { "text/event-stream": {} } } } } },
      "/api/v1/todo-captures": { get: read("listCaptures", ["To-Dos"]) },
      "/api/v1/calendar": { get: read("readCalendar", ["Calendar"]) },
      "/api/v1/calendar/messages": { get: read("listMessages", ["Calendar", "Messages"]) },
    },
  };
  expect(generateCommands(spec).map(command => command.name)).toEqual([
    "importJobApplications", "listTodos", "readCalendar",
  ]);
  const reversed = { ...spec, paths: Object.fromEntries(Object.entries(spec.paths).reverse()) };
  expect(renderCommands(spec)).toBe(renderCommands(reversed));
});

test("preserves inherited inputs, operation overrides and local schemas", () => {
  const commands = generateCommands({
    paths: {
      "/api/v1/jobs/applications/{id}": {
        parameters: [{ $ref: "#/components/parameters/Id" }, { name: "mode", in: "query", schema: { type: "string" } }],
        patch: {
          ...read("patchJobApplication"),
          security,
          "x-required-permissions": ["jobs:write"],
          parameters: [{ name: "mode", in: "query", required: true }],
          requestBody: { $ref: "#/components/requestBodies/Patch" },
        },
      },
    },
    components: {
      parameters: { Id: { name: "id", in: "path", schema: { type: "string" } } },
      requestBodies: { Patch: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Patch" } } } } },
      schemas: { Patch: { type: "object", required: ["expectedRevision"], properties: { expectedRevision: { $ref: "#/components/schemas/Revision" } } }, Revision: { type: "integer" } },
    },
  });
  expect(commands[0]).toMatchObject({
    name: "patchJobApplication",
    method: "PATCH",
    permissions: ["jobs:write"],
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "mode", in: "query", required: true }],
    body: { required: true, schema: { type: "object", required: ["expectedRevision"], properties: { expectedRevision: { type: "integer" } } } },
  });
});

test("committed commands match the mounted OpenAPI contract", async () => {
  const document = await loadMountedOpenApi();
  expect(await Bun.file(new URL("../src/generated/commands.ts", import.meta.url)).text()).toBe(renderCommands(document));
});

test("rejects parameter serialization the CLI cannot send", () => {
  const schema = { type: "string" };
  for (const parameter of [
    { name: "If-Match", in: "header", schema },
    { name: "id", in: "path", style: "matrix", schema },
    { name: "filter", in: "query", style: "deepObject", schema: { type: "object" } },
    { name: "tag", in: "query", explode: false, schema: { type: "array", items: schema } },
  ]) {
    expect(() => generateCommands({
      security,
      paths: {
        "/api/v1/jobs/applications/{id}": { get: { ...read("getJobApplication"), parameters: [parameter] } },
      },
    })).toThrow(`Unsupported OpenAPI ${parameter.in} parameter ${parameter.name} in getJobApplication`);
  }
});
