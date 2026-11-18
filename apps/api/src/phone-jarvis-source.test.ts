import { expect, test } from "bun:test";
import type { CaptureStore } from "./todos-captures";
import type { JarvisProvider } from "./todos-jarvis";
import { verifyJarvisSource } from "./todos-jarvis-planning";

function fixture() {
  const rows = new Map<string, any>([["jarvis:capture", { input: { owner: "owner" } }], ["phone-jarvis:capture", { input: { agentId: "phone-agent", sessionId: "session" } }]]);
  const store = { async get(key: string) { return rows.get(key) ?? null; }, async reserve(key: string, input: any) { const old = rows.get(key); if (old && JSON.stringify(old.input) !== JSON.stringify(input)) throw Error("binding conflict"); rows.set(key, old ?? { input }); return rows.get(key); } } as CaptureStore;
  const conversation = { agentId: "phone-agent", userId: "capture", conversationId: "conv", done: false, capturedAt: "2026-10-30T12:00:00Z", conversation: [] };
  const provider = { agentId: () => "browser-agent", finalConversation: async () => conversation } as unknown as JarvisProvider;
  return { store, rows, provider, conversation };
}

test("phone command source requires durable authenticated session and exact capture/conversation/agent", async () => {
  const f = fixture();
  const checked: unknown[] = [];
  await verifyJarvisSource(f.store, f.provider, "owner", "capture", "conv", async (...args) => { checked.push(args); return true; });
  expect(checked).toEqual([["capture", "phone-agent", "session"]]);
  expect(f.rows.get("jarvis-binding:capture").input).toEqual({ conversationId: "conv" });
  await expect(verifyJarvisSource(f.store, f.provider, "owner", "capture", "conv", async () => false)).rejects.toThrow();
  f.conversation.agentId = "untrusted";
  await expect(verifyJarvisSource(f.store, f.provider, "owner", "capture", "conv", async () => true)).rejects.toThrow();
  f.conversation.agentId = "phone-agent"; f.conversation.userId = "another-capture";
  await expect(verifyJarvisSource(f.store, f.provider, "owner", "capture", "conv", async () => true)).rejects.toThrow();
});

test("phone agent without durable phone capture cannot impersonate browser source", async () => {
  const f = fixture(); f.rows.delete("phone-jarvis:capture");
  await expect(verifyJarvisSource(f.store, f.provider, "owner", "capture", "conv", async () => true)).rejects.toThrow();
  f.conversation.agentId = "browser-agent";
  await expect(verifyJarvisSource(f.store, f.provider, "owner", "capture", "conv", async () => false)).resolves.toMatchObject({ agentId: "browser-agent" });
});
