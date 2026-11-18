import { expect, test } from "bun:test";
import type { AccessContext } from "@quantself/auth";
import { readTodoDelegateActivityConfig, recordTodoDelegateActivity, toTodoDelegateActivity } from "./todo-delegate-activity";

const owner = { id: "fixture-owner", name: "Owner", email: "owner@example.test" };
const ownerAccess: AccessContext = {
  owner, client: { kind: "web", id: "quantself-web", name: "Owner Client" }, permissions: ["todos:read", "todos:write"],
};
const agentAccess = (id: string, permissions: AccessContext["permissions"] = ["todos:read", "todos:write"]): AccessContext => ({
  owner, client: { kind: "agent", id, name: id, avatar: null }, permissions,
});
const assignedAt = new Date("2026-11-14T12:00:00Z");
const at = (minutes: number) => new Date(assignedAt.getTime() + minutes * 60_000);
const samUrl = "https://bot-hq.example.test/agents/sam";

test("projects the current Delegate's activity, with the stale threshold starting at assignment or the latest touch", () => {
  const config = readTodoDelegateActivityConfig({
    QUANTSELF_TODO_DELEGATION_STALE_MINUTES: "90",
    QUANTSELF_BOT_HQ_AGENT_LINKS: JSON.stringify({ sam: samUrl }),
  });
  const assignment = { ownerId: owner.id, delegateId: "sam", assignedAt, lastActivityAt: null };
  const read = (row: Parameters<typeof toTodoDelegateActivity>[0], minutes: number, working = true) =>
    toTodoDelegateActivity(row, ownerAccess, working, config, at(minutes));

  expect(read(assignment, 89)).toEqual({ lastActivityAt: null, stale: false, staleAt: at(90).toISOString(), botHqUrl: samUrl });
  expect(read(assignment, 90)).toMatchObject({ stale: true });
  expect(read(assignment, 90, false)).toMatchObject({ stale: false });
  const touched = { ...assignment, lastActivityAt: at(80) };
  expect(read(touched, 169)).toMatchObject({ lastActivityAt: at(80).toISOString(), stale: false });
  expect(read(touched, 170)).toMatchObject({ stale: true });
  expect(read({ ...assignment, assignedAt: null }, 1000)).toMatchObject({ lastActivityAt: null, stale: false });
  expect(read({ ...assignment, delegateId: null }, 1000)).toBeNull();
});

test("Bot HQ links use per-Agent server configuration without requests or access across assignments", () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = Object.assign(async () => {
    requests++;
    throw new Error("Outbound requests are outside Delegate Activity.");
  }, { preconnect: originalFetch.preconnect });
  try {
    const stacyUrl = "https://private-bot-hq.example.test/agents/stacy?tab=tasks";
    const config = readTodoDelegateActivityConfig({
      QUANTSELF_BOT_HQ_AGENT_LINKS: JSON.stringify({
        sam: samUrl, stacy: stacyUrl, plain: "http://bot-hq.example.test/agents/plain",
        credentialed: "https://user:password@bot-hq.example.test/agent", script: "javascript:alert(1)",
      }),
      QUANTSELF_TODO_DELEGATION_STALE_MINUTES: "invalid",
      NEXT_PUBLIC_BOT_HQ_URL: "https://old-bot-hq.example.test",
    });
    const row = { ownerId: owner.id, delegateId: "sam", assignedAt, lastActivityAt: at(5) };
    expect(config.staleAfterMs).toBe(86_400_000);
    expect([...config.linksByDelegateId.entries()]).toEqual([["sam", samUrl], ["stacy", stacyUrl]]);
    expect(toTodoDelegateActivity({ ...row, delegateId: "stacy" }, ownerAccess, true, config, at(6))?.botHqUrl).toBe(stacyUrl);
    expect(toTodoDelegateActivity({ ...row, delegateId: "unconfigured" }, ownerAccess, true, config, at(6))?.botHqUrl).toBeNull();
    expect(toTodoDelegateActivity(row, agentAccess("sam"), true, config, at(6)))
      .toMatchObject({ lastActivityAt: at(5).toISOString(), botHqUrl: null });
    expect(toTodoDelegateActivity(row, agentAccess("stacy"), true, config, at(6))).toBeNull();
    expect(toTodoDelegateActivity(row, agentAccess("sam", ["todos:write"]), true, config, at(6))).toBeNull();
    expect(toTodoDelegateActivity({ ...row, ownerId: "other-owner" }, ownerAccess, true, config, at(6))).toBeNull();
    expect(readTodoDelegateActivityConfig({ QUANTSELF_BOT_HQ_AGENT_LINKS: "invalid" }).linksByDelegateId.size).toBe(0);
    expect(requests).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ignores activity from the Owner, API keys without scope, and empty reads before persistence", async () => {
  const db: Parameters<typeof recordTodoDelegateActivity>[0] = new Proxy({} as Parameters<typeof recordTodoDelegateActivity>[0], {
    get() { throw new Error("An ignored activity must not access persistence."); },
  });
  const claimed = [{ todoId: "todo", revision: 1 }];
  expect(await recordTodoDelegateActivity(db, ownerAccess, "read", claimed)).toBe(0);
  expect(await recordTodoDelegateActivity(db, {
    ...ownerAccess, client: { kind: "api-key", id: "fixture-key", name: "Unscoped Client" },
  }, "write", claimed)).toBe(0);
  expect(await recordTodoDelegateActivity(db, agentAccess("sam", ["todos:read"]), "write", claimed)).toBe(0);
  expect(await recordTodoDelegateActivity(db, agentAccess("sam", ["todos:write"]), "read", claimed)).toBe(0);
  expect(await recordTodoDelegateActivity(db, agentAccess("sam"), "read", [])).toBe(0);
});
