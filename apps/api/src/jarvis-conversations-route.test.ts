import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { parseTranscriptTurns, registerJarvisConversationRoutes, type JarvisConversationRow } from "./jarvis-conversations-route";
const access: AccessContext = { owner: { id: "owner", email: "o@example.com", name: "Owner" }, client: { id: "key", kind: "api-key", name: "Reader" }, permissions: ["todos:read"] };
const uid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const mk = (n: number, source: string, transcript: string, summary?: string): JarvisConversationRow => ({
  rowId: `row${String(n).padStart(3, "0")}`, captureId: uid(n), createdAt: new Date(Date.UTC(2026, 9, 30, 12, 0, 0) - Math.floor(n / 2) * 1000),
  body: { input: { source, capturedAt: "2026-10-30T12:00:00.000Z", transcript, secret: "SECRET" }, result: summary ? { summary } : null },
});
const all = [
  mk(1, "jarvis", "user: hi\n\nassistant: hello"), mk(2, "jarvis-phone", "user: " + "x".repeat(300), "Sum"),
  mk(3, "jarvis", "user: gone"), mk(4, "text", "plain"), mk(5, "jarvis", "legacy text"), mk(6, "jarvis", "user: a"),
].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.rowId.localeCompare(a.rowId));
function fixture() {
  let ctx: AccessContext | null = access; let lists = 0, flags = 0, gets = 0;
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  app.use("*", async (c, next) => { c.set("accessContext", ctx); await next(); });
  registerJarvisConversationRoutes(app, {
    list: async (limit, cur) => { lists++; return all.filter(r => !["text"].includes((r.body as any).input.source) && (!cur || r.createdAt < cur.createdAt || (r.createdAt.getTime() === cur.createdAt.getTime() && r.rowId < cur.id))).slice(0, limit); },
    get: async id => { gets++; return all.find(r => r.captureId === id) ?? null; },
    flags: async ids => { flags++; return { deleted: new Set(ids.filter(i => i === uid(3))), audio: new Set(ids.filter(i => i === uid(1))) }; },
  });
  return { app, setAccess: (v: AccessContext | null) => { ctx = v; }, counts: () => ({ lists, flags, gets }) };
}
test("parser handles colons, multiline, legacy", () => {
  expect(parseTranscriptTurns("user: a: b\n\nassistant: line1\nline2\n\nstill assistant\n\nuser: c")).toEqual([{ role: "user", text: "a: b" }, { role: "assistant", text: "line1\nline2\n\nstill assistant" }, { role: "user", text: "c" }]);
  expect(parseTranscriptTurns("note: just text")).toEqual([{ role: "user", text: "note: just text" }]);
  expect(parseTranscriptTurns("  ")).toEqual([]);
});
test("auth required before store access", async () => {
  const f = fixture(); f.setAccess(null);
  expect((await f.app.request("/api/v1/jarvis/conversations")).status).toBe(401);
  f.setAccess({ ...access, permissions: [] });
  expect((await f.app.request("/api/v1/jarvis/conversations")).status).toBe(403);
  expect((await f.app.request(`/api/v1/jarvis/conversations/${uid(1)}`)).status).toBe(403);
  expect(f.counts()).toEqual({ lists: 0, flags: 0, gets: 0 });
});
test("list projects, hides deleted, 2 store calls per page, paginates", async () => {
  const f = fixture();
  const res = await f.app.request("/api/v1/jarvis/conversations?limit=100");
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  const body = await res.json() as any;
  expect(f.counts()).toEqual({ lists: 1, flags: 1, gets: 0 });
  expect(JSON.stringify(body)).not.toContain("SECRET");
  const ids = body.conversations.map((c: any) => c.id);
  expect(ids).not.toContain(uid(3)); expect(ids).not.toContain(uid(4));
  const one = body.conversations.find((c: any) => c.id === uid(1));
  expect(one).toEqual({ id: uid(1), channel: "app", capturedAt: "2026-10-30T12:00:00.000Z", summary: null, preview: "hi", turnCount: 2, hasAudio: true });
  const phone = body.conversations.find((c: any) => c.id === uid(2));
  expect(phone.channel).toBe("phone"); expect(phone.summary).toBe("Sum"); expect(phone.preview.length).toBe(160);
  expect(body.conversations.find((c: any) => c.id === uid(5)).preview).toBe("legacy text");
  const seen: string[] = []; let cursor: string | null = null; let pages = 0;
  const g = fixture();
  do { const b = await (await g.app.request(`/api/v1/jarvis/conversations?limit=2${cursor ? `&cursor=${cursor}` : ""}`)).json() as any; seen.push(...b.conversations.map((c: any) => c.id)); cursor = b.nextCursor; pages++; } while (cursor && pages < 10);
  expect(seen.sort()).toEqual(ids.sort()); expect(g.counts().lists).toBe(g.counts().flags);
});
test("invalid cursor/limit rejected before store", async () => {
  const f = fixture();
  for (const q of ["cursor=invalid", "limit=0", "limit=101"]) expect((await f.app.request(`/api/v1/jarvis/conversations?${q}`)).status).toBe(400);
  expect(f.counts().lists).toBe(0);
});
test("detail returns turns; 404 for missing, deleted, non-jarvis", async () => {
  const f = fixture();
  const ok = await f.app.request(`/api/v1/jarvis/conversations/${uid(1)}`);
  expect(await ok.json()).toEqual({ id: uid(1), channel: "app", capturedAt: "2026-10-30T12:00:00.000Z", summary: null, hasAudio: true, turns: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }] });
  for (const n of [3, 4, 99]) expect((await f.app.request(`/api/v1/jarvis/conversations/${uid(n)}`)).status).toBe(404);
});
