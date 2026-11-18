import { createHmac, timingSafeEqual } from "node:crypto";
import { streamSSE } from "hono/streaming";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { authorizeAccessContext, type AccessContext } from "@quantself/auth";
import type { TodoFreshness, CacheEvent } from "./todos-freshness";
import type { Todo } from "./todos-github";

type Env = { Variables: { accessContext: AccessContext | null } };
export function registerTodoFreshnessRoutes(app: OpenAPIHono<Env>, cache: TodoFreshness, options: {
  resolveAccessContext: (headers: Headers) => Promise<AccessContext | null>;
  env?: Record<string, string | undefined>;
  heartbeatMs?: number;
  shutdownSignal?: AbortSignal;
  projectTodos?: (access: AccessContext, todos: Todo[]) => Promise<Todo[]>;
}) {
  const env = options.env ?? process.env;
  app.post("/api/todo-webhooks/github", async c => {
    if (!env.QUANTSELF_GITHUB_WEBHOOK_SECRET) return c.json({ message: "Webhook not configured." }, 503);
    if (Number(c.req.header("content-length")) > 2_000_000) return c.json({ message: "Payload too large." }, 413);
    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > 2_000_000) return c.json({ message: "Payload too large." }, 413);
    const signature = c.req.header("x-hub-signature-256") ?? "";
    const expected = `sha256=${createHmac("sha256", env.QUANTSELF_GITHUB_WEBHOOK_SECRET).update(raw).digest("hex")}`;
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return c.json({ message: "Invalid signature." }, 401);
    let payload: any;
    try { payload = JSON.parse(raw); } catch { return c.json({ message: "Invalid JSON." }, 400); }
    const event = c.req.header("x-github-event");
    const delivery = c.req.header("x-github-delivery");
    if (!delivery || delivery.length > 200) return c.json({ message: "Missing delivery ID." }, 400);
    // App pings contain hook + zen, without repository/installation scope.
    if (event === "ping") return c.json({ accepted: true });
    if (!payload || typeof payload !== "object") return c.json({ message: "Invalid payload." }, 400);
    if (String(payload.installation?.id) !== env.QUANTSELF_GITHUB_INSTALLATION_ID) return c.json({ message: "Unexpected installation." }, 403);
    const repository = env.QUANTSELF_TODO_REPOSITORY;
    const revoked = (event === "installation" && ["deleted", "suspend"].includes(payload.action)) ||
      (event === "installation_repositories" && payload.repositories_removed?.some((repo: any) => repo.full_name === repository));
    const installationEvent = ["installation", "installation_repositories"].includes(event ?? "");
    if (!installationEvent && payload.repository?.full_name !== repository) return c.json({ message: "Unexpected repository." }, 403);
    if (!["issues", "issue_comment", "issue_dependencies", "sub_issues", "label", "installation", "installation_repositories"].includes(event ?? "")) return c.json({ ignored: true });
    const issueNumber = Number(payload.issue?.number);
    // Relationships need the complete graph; other issue edits refresh one task.
    const numbers = !["closed", "reopened", "transferred", "deleted"].includes(payload.action) && ["issues", "issue_comment"].includes(event ?? "") && Number.isSafeInteger(issueNumber) && issueNumber > 0 ? [issueNumber] : undefined;
    const restored = (event === "installation" && ["unsuspend", "new_permissions_accepted", "created"].includes(payload.action)) || (event === "installation_repositories" && payload.repositories_added?.some((repo: any) => repo.full_name === repository));
    const accepted = await cache.invalidate(numbers, delivery, revoked, Boolean(restored));
    return c.json({ accepted: true, duplicate: !accepted }, 202);
  });
  app.openapi(createRoute({
    method: "get", path: "/api/v1/todos/live", operationId: "subscribeTodoChanges", tags: ["To-Dos"],
    summary: "Subscribe to authorized task changes",
    description: "Authentication: same-origin Owner ingress or non-Agent API Key. Required permissions: todos:read, rechecked during stream life. Inputs: Last-Event-ID or after cursor. Success response: text/event-stream snapshots and ordered changes, heartbeat, resync-required and access-denied events. Failure responses: 401 unauthenticated, 403 denied; after streaming begins failures close the stream. Side effects: refreshes a disposable GitHub read projection; never writes task decisions. Destructive: no. Retry safety: reconnect with the last cursor; gaps return a complete snapshot.",
    security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
    "x-required-permissions": ["todos:read"], "x-destructive": false,
    responses: {
      200: { description: "Task event stream.", content: { "text/event-stream": { schema: z.string() } } },
      403: { description: "To-Do access denied.", content: { "application/json": { schema: z.object({ message: z.string() }), example: { message: "To-Do Read required." } } } },
    },
  }), async c => {
    const allowed = authorizeAccessContext(c.get("accessContext"), { domain: "todos", action: "read" });
    if (!allowed.ok || allowed.accessContext.client.kind === "agent") return c.json({ message: "To-Do stream access denied." }, 403);
    c.header("X-Accel-Buffering", "no");
    const requestHeaders = new Headers(c.req.raw.headers);
    const response = streamSSE(c, async stream => {
      let stopped = options.shutdownSignal?.aborted ?? false;
      let wake: (() => void) | undefined;
      let notified = false;
      const unsubscribe = cache.subscribe(() => { notified = true; wake?.(); });
      const stop = () => { stopped = true; wake?.(); unsubscribe(); };
      stream.onAbort(stop);
      options.shutdownSignal?.addEventListener("abort", stop, { once: true });
      const write = async (event: string, data: unknown, generation?: number) => {
        if (stopped) return;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            stream.writeSSE({ event, data: JSON.stringify(data), ...(generation !== undefined ? { id: String(generation) } : {}) }),
            new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error("Slow event subscriber")), 10000); timeout.unref?.(); }),
          ]);
        } finally { clearTimeout(timeout); }
      };
      const checkAccess = async () => {
        const access = await options.resolveAccessContext(requestHeaders);
        if (access?.client.kind === "agent" || !authorizeAccessContext(access, { domain: "todos", action: "read" }).ok || (await cache.status()).revoked) {
          await write("access-denied", {}); return false;
        }
        return true;
      };
      try {
        if ((await cache.status()).revoked) { await write("access-denied", {}); return; }
        let cursor = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? NaN);
        let snapshot = await cache.snapshot();
        if (!await checkAccess()) return;
        if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > snapshot.generation) {
          const todos = await options.projectTodos?.(allowed.accessContext, snapshot.todos) ?? snapshot.todos;
          await write("snapshot", { ...snapshot, todos }, snapshot.generation); cursor = snapshot.generation;
        }
        while (!stopped) {
          notified = false;
          const access = await options.resolveAccessContext(requestHeaders);
          if (!access || access.client.kind === "agent" || !authorizeAccessContext(access, { domain: "todos", action: "read" }).ok) { await write("access-denied", {}); break; }
          const status = await cache.status();
          if (status.revoked) { await write("access-denied", {}); break; }
          const events = await cache.events(cursor);
          if (status.generation > cursor && (!events.length || events[0].generation !== cursor + 1 || events.length > 100)) {
            snapshot = await cache.snapshot();
            if (!await checkAccess()) break;
            const todos = await options.projectTodos?.(access, snapshot.todos) ?? snapshot.todos;
            await write("snapshot", { ...snapshot, todos }, snapshot.generation); cursor = snapshot.generation;
          } else {
            const upserts = new Map(events.flatMap(event => event.upserts ?? []).map(todo => [todo.id, todo]));
            const projected = await options.projectTodos?.(access, [...upserts.values()]);
            const byId = new Map(projected?.map(todo => [todo.id, todo.delegation]));
            for (const event of events) {
              const payload = projected && event.upserts ? { ...event, upserts: event.upserts.map(todo => ({ ...todo, delegation: byId.get(todo.id) })) } : event;
              await write(event.resync ? "resync-required" : "changes", payload, event.generation);
              cursor = event.generation;
            }
          }
          if (stopped) break;
          await write("heartbeat", { generation: cursor });
          if (stopped) break;
          if (notified) continue;
          await new Promise<void>(resolve => {
            let timer: ReturnType<typeof setTimeout>;
            wake = () => { clearTimeout(timer); resolve(); };
            timer = setTimeout(wake, options.heartbeatMs ?? 20000);
          });
          wake = undefined;
        }
      } finally { unsubscribe(); options.shutdownSignal?.removeEventListener("abort", stop); }
    });
    // Hono sets no-cache internally; override after constructing the response.
    // no-transform prevents Next/compression from buffering SSE frames.
    response.headers.set("Cache-Control", "private, no-store, no-transform");
    return response;
  });
}
