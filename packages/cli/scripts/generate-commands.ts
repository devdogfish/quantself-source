import { readFile, writeFile } from "node:fs/promises";
import type { CommandDefinition } from "../src/command.ts";

const excludedTags = new Set(["Admin", "Auth", "Messages"]);
const privilegedPermissions = new Set(["jobs:execute", "jobs:revise", "todos:approve"]);
const methods = ["delete", "get", "head", "options", "patch", "post", "put", "trace"];
const output = new URL("../src/generated/commands.ts", import.meta.url);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function resolve(document: JsonObject, value: unknown, seen = new Set<string>()): JsonObject {
  const object = asObject(value);
  const reference = object.$ref;
  if (typeof reference !== "string") return object;
  if (!reference.startsWith("#/") || seen.has(reference)) {
    throw new Error(`Unsupported OpenAPI reference ${reference}`);
  }

  let target: unknown = document;
  for (const segment of decodeURIComponent(reference.slice(2)).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    const parent = asObject(target);
    if (!Object.hasOwn(parent, key)) throw new Error(`Unresolved OpenAPI reference ${reference}`);
    target = parent[key];
  }
  return { ...resolve(document, target, new Set([...seen, reference])), ...Object.fromEntries(
    Object.entries(object).filter(([key]) => key !== "$ref"),
  ) };
}

function supportsApiKey(security: unknown): boolean {
  return Array.isArray(security) && security.some(requirement =>
    isObject(requirement) && Object.keys(requirement).length === 1 && Object.hasOwn(requirement, "apiKeyAuth"));
}

function isInScope(path: string, method: string, tags: unknown): boolean {
  if (!Array.isArray(tags) || tags.some(tag => excludedTags.has(tag))) return false;
  if (tags.includes("Jobs") && /^\/api\/v1\/jobs\/(?:applications|candidate-context|import)(?:\/|$)/.test(path)) return true;
  if (tags.includes("To-Dos")) {
    if (method === "post" && (path === "/api/v1/agent-inbox-todos" || path === "/api/v1/todo-suggestions/review" || path === "/api/v1/todos/{number}/hand-back")) return true;
    if (method === "get" && (path === "/api/v1/agent-inbox-todos/{id}" || /^\/api\/v1\/(?:todos|todo-categories)(?:\/|$)/.test(path))) return true;
  }
  if (method === "get" && tags.includes("Habits") && path === "/api/v1/habits/calendar") return true;
  return method === "get" && tags.some(tag => ["Appointment", "Appointments", "Calendar"].includes(tag));
}

function supportsJsonResponse(document: JsonObject, operation: JsonObject): boolean {
  return Object.entries(asObject(operation.responses)).some(([status, response]) =>
    /^2(?:\d\d|XX)$/.test(status) &&
    Object.hasOwn(asObject(resolve(document, response).content), "application/json"));
}

function collectParameters(document: JsonObject, pathItem: JsonObject, operation: JsonObject): CommandDefinition["parameters"] {
  const parameters = new Map<string, JsonObject>();
  for (const list of [pathItem.parameters, operation.parameters]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const parameter = resolve(document, item);
      parameters.set(`${parameter.in}:${parameter.name}`, parameter);
    }
  }
  return [...parameters.values()].map(
    ({ name, in: location, required, description, schema, style, explode, allowReserved, content }) => {
      if (typeof name !== "string" || (location !== "path" && location !== "query" && location !== "header")) {
        throw new Error(`Unsupported OpenAPI parameter in ${operation.operationId}`);
      }
      const defaultStyle = location === "query" ? "form" : "simple";
      const inputSchema = inlineSchema(document, schema);
      const type = asObject(inputSchema).type;
      const itemType = asObject(asObject(inputSchema).items).type;
      const scalarTypes = ["string", "number", "integer", "boolean"];
      const supportsType = type === undefined || (typeof type === "string" && scalarTypes.includes(type)) ||
        (location === "query" && type === "array" && typeof itemType === "string" && scalarTypes.includes(itemType));
      if ((location === "header" && name.toLowerCase() !== "idempotency-key") ||
          (style !== undefined && style !== defaultStyle) ||
          (explode !== undefined && explode !== (location === "query")) ||
          allowReserved === true || content !== undefined || !supportsType) {
        throw new Error(`Unsupported OpenAPI ${location} parameter ${name} in ${operation.operationId}`);
      }
      return {
        name,
        in: location,
        required: location === "path" || required === true,
        ...(typeof description === "string" ? { description } : {}),
        ...(schema === undefined ? {} : { schema: inputSchema }),
      };
    },
  );
}

function inlineSchema(document: JsonObject, value: unknown, seen = new Set<string>()): unknown {
  if (Array.isArray(value)) return value.map(item => inlineSchema(document, item, seen));
  if (!isObject(value)) return value;
  const reference = value.$ref;
  if (typeof reference === "string" && seen.has(reference)) {
    throw new Error(`Recursive OpenAPI request schema ${reference}`);
  }
  const next = typeof reference === "string" ? new Set([...seen, reference]) : seen;
  return Object.fromEntries(
    Object.entries(resolve(document, value)).map(([key, item]) => [key, inlineSchema(document, item, next)]),
  );
}

export function generateCommands(input: unknown): readonly CommandDefinition[] {
  const document = asObject(input);
  if (!isObject(document.paths)) throw new Error("OpenAPI paths are missing.");
  const commands = new Map<string, CommandDefinition>();
  for (const [path, entry] of Object.entries(document.paths)) {
    if (!path.startsWith("/api/v1/")) continue;
    const pathItem = resolve(document, entry);
    for (const method of methods) {
      const operation = asObject(pathItem[method]);
      const { tags, operationId, summary, description } = operation;
      if (!isInScope(path, method, tags)) continue;
      if (!supportsApiKey(operation.security ?? document.security)) continue;
      const permissions = operation["x-required-permissions"];
      if (operation["x-destructive"] === true || (Array.isArray(permissions) && permissions.some(permission => privilegedPermissions.has(permission)))) continue;
      if (!supportsJsonResponse(document, operation)) continue;

      const requestBody = resolve(document, operation.requestBody);
      const json = asObject(asObject(requestBody.content)["application/json"]);
      if (operation.requestBody && !Object.hasOwn(json, "schema")) continue;
      if (typeof operationId !== "string" || !operationId.trim() || typeof summary !== "string" || !summary.trim()) {
        throw new Error(`Missing operationId or summary for ${method.toUpperCase()} ${path}`);
      }
      if (commands.has(operationId)) throw new Error(`Duplicate OpenAPI operationId ${operationId}`);
      commands.set(operationId, {
        name: operationId,
        method: method.toUpperCase(),
        path,
        summary,
        ...(typeof description === "string" ? { description } : {}),
        ...(Array.isArray(permissions) && permissions.every(permission => typeof permission === "string") ? { permissions } : {}),
        parameters: collectParameters(document, pathItem, operation),
        ...(operation.requestBody ? { body: { required: requestBody.required === true, schema: inlineSchema(document, json.schema) } } : {}),
      });
    }
  }
  if (commands.size === 0) throw new Error("OpenAPI has no supported Quantself CLI operations.");
  return [...commands.values()].sort((left, right) => left.name < right.name ? -1 : 1);
}

export function renderCommands(input: unknown): string {
  return `// Generated by packages/cli/scripts/generate-commands.ts.\nimport type { CommandDefinition } from "../command.ts";\n\nexport const commands: readonly CommandDefinition[] = ${JSON.stringify(generateCommands(input), null, 2)};\n`;
}

export async function loadMountedOpenApi(): Promise<unknown> {
  const { app } = await import("../../../apps/api/src/app.ts");
  const { getOpenAPIDocument } = await import("../../../apps/api/src/openapi.ts");
  return getOpenAPIDocument(app);
}

async function main(args: string[]) {
  const paths = args.filter(argument => !argument.startsWith("-"));
  if (paths.length > 1 || args.some(argument => argument.startsWith("-") && argument !== "--check")) {
    throw new Error("Usage: bun packages/cli/scripts/generate-commands.ts [--check] [openapi.json]");
  }
  const document = paths.length ? JSON.parse(await readFile(paths[0], "utf8")) : await loadMountedOpenApi();
  const generated = renderCommands(document);
  if (args.includes("--check")) {
    const existing = await readFile(output, "utf8").catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing !== generated) throw new Error("CLI commands are stale. Run bun packages/cli/scripts/generate-commands.ts.");
    return;
  }
  await writeFile(output, generated, "utf8");
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
