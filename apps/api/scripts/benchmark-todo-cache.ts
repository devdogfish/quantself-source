/** Synthetic CPU/payload benchmark. No network, real tasks, credentials or database. */
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { createTodoFreshness } from "../src/todos-freshness";
import { memoryTodoCache } from "../src/todos-freshness-store";
import type { Todo, TodoReader } from "../src/todos-github";
import { registerTodoRoutes } from "../src/todos-route";

const samples = 5;
const epoch = Date.parse("2026-10-01T12:00:00Z");
function fixture(number: number): Todo {
  const timed = number % 4 === 0, slot = Math.floor(number / 4);
  const start = new Date(epoch + Math.floor(slot / 16) * 86400000 + slot % 16 * 1800000).toISOString();
  const end = new Date(Date.parse(start) + 1800000).toISOString();
  const description = "Synthetic task notes for reproducible payload measurement. ".repeat(4).trim();
  const fields: Todo["fields"] = { Commitment: "Active", Category: "Work", Rank: number, Client: "Personal", Estimate: 30, Location: "Synthetic office" };
  if (number % 5 === 0) fields.Due = start.slice(0, 10);
  return { id: `synthetic-${String(number).padStart(5, "0")}`, databaseId: number, number, repository: "synthetic/tasks", url: `https://example.invalid/tasks/${number}`, title: `Synthetic task ${number}`, description,
    body: `${description}\n\n<!-- quantself:synthetic {"fixture":true,"originalEvidence":"synthetic-only"} -->`,
    labels: ["needs-triage"], fields, fieldValues: Object.entries(fields).map(([name, value], index) => ({ fieldId: index + 1, name, value })),
    state: number % 5 === 1 ? "closed" : "open", closureReason: number % 5 === 1 ? "completed" : null,
    updatedAt: "2026-10-01T12:00:00Z", start: timed ? start : null, end: timed ? end : null, allDay: false, fixed: false,
    scheduleError: null, deadlineAt: null, deadlineError: null, trashed: false, trashError: null, blockedBy: [], children: [], prerequisiteStates: [], readiness: "ready" } as Todo;
}
const rounded = (n: number) => Math.round(n * 100) / 100;
const results: unknown[] = [];
for (const size of [100, 1000, 10000]) {
  const rows = Array.from({ length: size }, (_, i) => fixture(i + 1));
  let listCalls = 0, detailCalls = 0;
  const source: TodoReader = { list: async () => { listCalls++; return structuredClone(rows); }, detail: async number => { detailCalls++; return structuredClone(rows[number - 1]); } };
  const cache = createTodoFreshness(source, memoryTodoCache());
  const access: AccessContext = { owner: { id: "synthetic", name: "Synthetic", email: "synthetic@example.invalid" }, client: { id: "synthetic", kind: "web", name: "Synthetic" }, permissions: ["todos:read"] };
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  app.use("*", async (c, next) => { c.set("accessContext", access); await next(); }); registerTodoRoutes(app, cache.reader);
  const coldAt = performance.now(); await cache.reader.list();
  const cold = { ms: rounded(performance.now() - coldAt), sourceListCalls: listCalls, sourceDetailCalls: detailCalls };
  async function measure(read: () => Promise<{ bytes: number; count: number }>) {
    const priorList = listCalls, priorDetail = detailCalls, durations: number[] = []; let payload = { bytes: 0, count: 0 };
    for (let i = 0; i < samples; i++) { const start = performance.now(); payload = await read(); durations.push(performance.now() - start); }
    durations.sort((a, b) => a - b);
    return { medianMs: rounded(durations[Math.floor(samples / 2)]), minMs: rounded(durations[0]), maxMs: rounded(durations.at(-1)!), payloadBytes: payload.bytes, records: payload.count, sourceListCalls: listCalls - priorList, sourceDetailCalls: detailCalls - priorDetail };
  }
  const warmCache = await measure(async () => { const todos = await cache.reader.list(); return { bytes: 0, count: todos.length }; });
  const request = async (path: string) => {
    const response = await app.request(path); const text = await response.text();
    if (response.status !== 200) throw Error(`Synthetic route failed: ${response.status} ${text}`);
    return { bytes: Buffer.byteLength(text), count: (JSON.parse(text) as { todos: Todo[] }).todos.length };
  };
  const fullApi = await measure(() => request("/api/v1/todos?trash=include"));
  const weekApi = await measure(() => request("/api/v1/todos?from=2026-10-01&through=2026-10-07&timeZone=America%2FHalifax"));
  results.push({ size, cold, warmCache, fullApi, weekApi }); cache.stop();
}
console.log(JSON.stringify({ synthetic: true, measuredAt: new Date().toISOString(), runtime: Bun.version, platform: `${process.platform}/${process.arch}`, samples, description: "In-process memory-store CPU, JSON serialization/parsing and raw UTF-8 bytes; no network, Docker/PostgreSQL or browser rendering. 25% timed; 20% closed; 20% Due; no scheduled overlaps.", results }, null, 2));
