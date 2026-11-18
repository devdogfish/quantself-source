import { expect, test } from "bun:test";
import { createHabitAsks, askCursor } from "./habits-ask";
import { createHabitAskModel } from "./habits-ask-model";
import { createHabitDocuments } from "./habits-documents";
import { HabitError } from "./habits-service";
const date = new Date("2026-11-13T16:00:00Z"), id = "00000000-0000-4000-8000-000000000001";
const input = { habitId: "walk", text: "I'm wiped after work" };
const answer = { feeling: "Tired" as const, lead: "Keep it small.", step: "Step outside for one minute.", support: "The minimum counts." };
function fixture() {
  const rows = new Map<string, any>(), calls: string[] = []; let status = "open", revision = 0, docReads = 0, modelCalls = 0;
  let generate = async (_context: string, _signal: AbortSignal) => answer;
  const db = {
    habitAsk: {
      findUnique: async (q: any) => { calls.push("find ask"); return rows.get(q.where.ownerId_id.ownerId + q.where.ownerId_id.id) ?? null; },
      findUniqueOrThrow: async (q: any) => rows.get(q.where.ownerId_id.ownerId + q.where.ownerId_id.id),
      create: async ({ data }: any) => { calls.push("create ask"); const row = { ...data, state: "pending", feeling: "Other", answer: null }; const k = data.ownerId + data.id; if (rows.has(k)) throw { code: "P2002" }; rows.set(k, row); return { ...row }; },
      updateMany: async ({ where, data }: any) => {
        calls.push("update ask"); const row = rows.get(where.ownerId + where.id);
        if (!row || where.state && row.state !== where.state || where.updatedAt && +row.updatedAt !== +where.updatedAt) return { count: 0 };
        if (where.OR && !(row.state === "failed" || row.state === "pending" && row.updatedAt < where.OR[1].updatedAt.lt)) return { count: 0 };
        Object.assign(row, data); return { count: 1 };
      },
    },
    habitOccurrence: {
      findMany: async (q: any) => { calls.push("history"); expect(q.where.ownerId).toBe("owner"); expect(q.where.habitId).toBe("walk"); expect(q.take).toBe(28); return [{ date: "2026-11-12", status: "minimum", note: "a short walk" }]; },
      findUnique: async (q: any) => { calls.push("outcome"); expect(q.where.ownerId_habitId_date.ownerId).toBe("owner"); return { status, revision }; },
    },
  };
  const documents = createHabitDocuments(async (_sha, path) => { docReads++; return { sha: "doc", text: path === "SYSTEM.md" ? "Minimum is enough." : "Take one slow breath." }; });
  const catalog = { current: async (owner: string) => { calls.push("catalog"); expect(owner).toBe("owner"); return { revision: 1, projection: { habits: [{ id: "walk", name: "Walk", kind: "build", minimum: "One minute", cue: "After work", full: "20 minutes", fallback: "Walk in the hall", identity: "I move daily", stack: "am" }], stacks: [{ id: "am", name: "Morning" }] } }; } };
  const service = (timeout = 20000) => createHabitAsks(db as any, catalog as any, documents, async (context, signal) => { modelCalls++; return generate(context, signal); }, () => date, timeout);
  return { service, rows, calls, docs: () => docReads, models: () => modelCalls, setModel: (m: typeof generate) => { generate = m; }, checkIn: (s: string) => { status = s; revision++; } };
}
const tick = () => new Promise(r => setTimeout(r, 0));
test("Ask uses own habit, history, System/playbook and persists inferred feeling; retry replays and joins current outcome", async () => {
  const f = fixture(); let context: any;
  f.setModel(async (c) => { context = JSON.parse(c); return answer; });
  const api = f.service(), t = performance.now();
  const result = await api.ask("owner", "client", input, id);
  expect(context.habit).toMatchObject({ cue: "After work", minimum: "One minute", fallback: "Walk in the hall", identity: "I move daily" });
  expect(context.history).toHaveLength(1); expect(context.system).toBe("Minimum is enough."); expect(context.playbook).toBe("Take one slow breath.");
  expect(result).toMatchObject({ id, text: input.text, feeling: "Tired", outcome: "open", outcomeRevision: 0, answer });
  expect(f.calls).toHaveLength(6); expect(f.docs()).toBe(2); expect(f.models()).toBe(1);
  f.checkIn("minimum");
  expect((await api.ask("owner", "client", input, id)).outcome).toBe("did minimum"); expect(f.models()).toBe(1);
  await expect(api.ask("owner", "client", { ...input, text: "different" }, id)).rejects.toMatchObject({ status: 409 });
  await expect(api.ask("owner", "other-client", input, id)).rejects.toMatchObject({ status: 409 });
  await api.ask("owner", "client", input, crypto.randomUUID()); expect(f.docs()).toBe(2);
  console.info(JSON.stringify({ coldAskDatabaseOperations: 6, replayDatabaseReads: 2, coldDocumentLoads: 2, warmDocumentLoads: 0, modelInvocationsPerNewAsk: 1, elapsedMs: performance.now() - t }));
});
test("deferred generation blocks duplicate execution, preserves saved intent and supports same-ID failed retry", async () => {
  const f = fixture(); let resolve!: (a: typeof answer) => void;
  f.setModel(() => new Promise(r => { resolve = r; }));
  const api = f.service(), first = api.ask("owner", "client", input, id); await tick();
  expect(f.rows.get("owner" + id).text).toBe(input.text);
  await expect(api.ask("owner", "client", input, id)).rejects.toMatchObject({ status: 409 }); expect(f.models()).toBe(1);
  resolve(answer); await first; expect(f.rows.get("owner" + id).state).toBe("complete");
  const next = crypto.randomUUID(); f.setModel(async () => { throw Error("private upstream secret"); });
  await expect(api.ask("owner", "client", input, next)).rejects.toThrow("Jarvis unavailable");
  expect(f.rows.get("owner" + next).state).toBe("failed");
  f.setModel(async () => answer); expect((await api.ask("owner", "client", input, next)).id).toBe(next);
  expect(f.rows.size).toBe(2);
});
test("bounded request times out even if a model ignores cancellation; late answer cannot overwrite retry", async () => {
  const f = fixture(); let resolve!: (a: typeof answer) => void;
  f.setModel(() => new Promise(r => { resolve = r; }));
  await expect(f.service(5).ask("owner", "client", input, id)).rejects.toMatchObject({ status: 503 });
  expect(f.rows.get("owner" + id).state).toBe("failed");
  f.setModel(async () => answer); await f.service().ask("owner", "client", input, id);
  resolve({ ...answer, step: "stale" }); await tick(); expect(f.rows.get("owner" + id).answer.step).toBe(answer.step);
});
test("input and opaque pagination cursors validate before source reads", async () => {
  const f = fixture(); await expect(f.service().ask("owner", "client", { ...input, text: "x".repeat(2001) }, id)).rejects.toThrow();
  expect(f.calls).toHaveLength(0); expect(() => askCursor("not-json")).toThrow(HabitError);
  expect(askCursor(Buffer.from(JSON.stringify({ id, at: date.toISOString() })).toString("base64url"))).toEqual({ id, at: date.toISOString() });
});
class FakeSocket extends EventTarget {
  sent: any[] = []; closed = false;
  constructor(private reply: unknown) { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
  receive(message: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
  send(raw: string) {
    const data = JSON.parse(raw); this.sent.push(data);
    if (data.type === "conversation_initiation_client_data") queueMicrotask(() => this.receive({ type: "conversation_initiation_metadata" }));
    if (data.type === "user_message") queueMicrotask(() => {
      this.receive({ type: "ping", ping_event: { event_id: 1 } });
      this.receive(this.reply);
    });
  }
  close() { this.closed = true; this.dispatchEvent(new Event("close")); }
}
const env = () => ({ QUANTSELF_ELEVENLABS_AGENT_ID: "existing_jarvis", QUANTSELF_ELEVENLABS_API_KEY: "secret" });
const signed = "wss://api.elevenlabs.io/v1/convai/conversation?token=temporary";
test("existing Jarvis model uses one signed-URL read and one text socket; no tools, MCP or model override", async () => {
  let reads = 0; let socket!: FakeSocket;
  const model = createHabitAskModel((async (url: string, init: RequestInit) => {
    reads++; expect(url).toContain("get-signed-url?agent_id=existing_jarvis"); expect(init.redirect).toBe("error"); expect(init.signal).toBeDefined();
    return Response.json({ signed_url: signed });
  }) as unknown as typeof fetch, env, url => { expect(url).toBe(signed); return socket = new FakeSocket({ type: "agent_response", agent_response_event: { agent_response: JSON.stringify(answer) } }); });
  expect(await model('{"moment":"tired"}', AbortSignal.timeout(1000))).toEqual(answer);
  expect(reads).toBe(1); expect(socket.closed).toBe(true);
  expect(socket.sent[0].conversation_config_override).toEqual({ conversation: { text_only: true }, agent: { first_message: "", prompt: { tool_ids: [], tool_ids_strict: true, native_mcp_server_ids: [] } } });
  expect(socket.sent[1].text).toContain('"moment":"tired"'); expect(socket.sent[2]).toEqual({ type: "pong", event_id: 1 });
  await expect(model("x".repeat(32001), AbortSignal.timeout(1000))).rejects.toThrow("too large"); expect(reads).toBe(1);
});
test("provider rejects malformed answers, unexpected tools, oversized frames and unsafe signed URLs", async () => {
  for (const result of [ { type: "client_tool_call" }, { type: "agent_response", agent_response_event: { agent_response: "not json" } }, { type: "agent_response", agent_response_event: { agent_response: "x".repeat(64001) } } ]) {
    let socket!: FakeSocket;
    const model = createHabitAskModel((async () => Response.json({ signed_url: signed })) as unknown as typeof fetch, env, () => socket = new FakeSocket(result));
    await expect(model("{}", AbortSignal.timeout(1000))).rejects.toThrow(); expect(socket.closed).toBe(true);
  }
  const unsafe = createHabitAskModel((async () => Response.json({ signed_url: "wss://untrusted.example/steal" })) as unknown as typeof fetch, env, () => { throw Error("must never connect"); });
  await expect(unsafe("{}", AbortSignal.timeout(1000))).rejects.toThrow("Invalid Jarvis connection");
});
test("aborting a quiet socket closes it and rejects; streaming text is assembled only for its response", async () => {
  let socket!: FakeSocket;
  const model = createHabitAskModel((async () => Response.json({ signed_url: signed })) as unknown as typeof fetch, env, () => socket = new FakeSocket({ type: "ignored" }));
  const controller = new AbortController(), pending = model("{}", controller.signal); await tick(); controller.abort();
  await expect(pending).rejects.toThrow(); expect(socket.closed).toBe(true);
  const stream = model("{}", AbortSignal.timeout(1000)); await tick();
  for (const part of [{ type: "start", text: "" }, { type: "delta", text: JSON.stringify(answer) }, { type: "stop", text: "" }]) socket.receive({ type: "agent_chat_response_part", text_response_part: { ...part, response_id: "response" } });
  expect(await stream).toEqual(answer); expect(socket.closed).toBe(true);
});
test("Ask configuration changes only conversation override permissions, preserving Jarvis defaults", async () => {
  const { habitAskAgentPatch } = await import("./habits-ask-config");
  const before = { conversation_config: { agent: { first_message: "Hello", prompt: { llm: "existing", tool_ids: ["ordinary-tools"], prompt: "unchanged" } } }, platform_settings: { auth: { enable_auth: true }, overrides: { conversation_config_override: { agent: { language: false, prompt: { llm: false, tool_ids: false } } } }, privacy: { retention_days: -1 } } };
  const saved = structuredClone(before), patch = habitAskAgentPatch(before);
  expect(before).toEqual(saved); expect(patch).not.toHaveProperty("conversation_config");
  expect(patch.platform_settings.auth).toEqual(before.platform_settings.auth); expect(patch.platform_settings.privacy).toEqual(before.platform_settings.privacy);
  expect(patch.platform_settings.overrides.conversation_config_override.agent.prompt).toEqual({ llm: false, tool_ids: true, tool_ids_strict: true, native_mcp_server_ids: true });
});
