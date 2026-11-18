import { expect, test } from "bun:test";
import { prepareJarvisHabitConfiguration } from "./jarvis-habits";
import { syncJarvisHabitConfiguration } from "./jarvis-habits-sync";

function fixture() {
  const tools = new Map<string, any>([
    [
      "show",
      {
        id: "show",
        tool_config: {
          type: "webhook",
          name: "read_tasks",
          api_schema: {
            method: "GET",
            url: "https://api.example.test/api/v1/todos",
            request_headers: { "X-API-Key": { secret_id: "scoped" } },
          },
        },
      },
    ],
  ]);
  const systemTools = [
    {
      type: "system",
      name: "end_call",
      params: { system_tool_type: "end_call" },
    },
  ];
  let agent = {
    platform_settings: {
      auth: { enable_auth: true },
      privacy: { record_voice: true },
    },
    conversation_config: {
      tts: { voice_id: "preserve" },
      agent: {
        prompt: {
          prompt: "Identity {{ui_context}}",
          tool_ids: ["show"],
          tools: [tools.get("show").tool_config, ...systemTools],
        },
      },
    },
  };
  const calls: string[] = [];
  const backups: unknown[] = [];
  const transport = {
    async request(path: string, method = "GET", body?: any): Promise<any> {
      calls.push(`${method} ${path}`);
      if (path === "agents/agent") {
        if (method === "PATCH") {
          Object.assign(
            agent.conversation_config.agent.prompt,
            body.conversation_config.agent.prompt,
          );
        }
        agent.conversation_config.agent.prompt.tools = [
          ...agent.conversation_config.agent.prompt.tool_ids.map(
            (id) => tools.get(id).tool_config,
          ),
          ...systemTools,
        ];
        return structuredClone(agent);
      }
      if (path.startsWith("tools?"))
        return {
          tools: [...tools.values()].filter(
            (tool) =>
              tool.tool_config.name ===
              new URLSearchParams(path.slice(6)).get("search"),
          ),
          has_more: false,
        };
      if (path === "tools" && method === "POST") {
        const id = `created_${tools.size}`;
        const created = structuredClone(body);
        tools.set(id, { id, ...created });
        return { id };
      }
      const id = path.slice(6);
      if (method === "PATCH") tools.set(id, { id, ...structuredClone(body) });
      return structuredClone(tools.get(id));
    },
    async backup(value: unknown) {
      backups.push(structuredClone(value));
    },
  };
  return { tools, agent, calls, backups, transport };
}

test("habit sync previews without writes then attaches exact server capabilities, preserving configuration and idempotence", async () => {
  const f = fixture();
  const dry = await syncJarvisHabitConfiguration(f.transport, "agent");
  expect(dry.applied).toBe(false);
  expect(f.backups).toHaveLength(0);
  expect(f.calls.every((call) => call.startsWith("GET"))).toBe(true);
  await syncJarvisHabitConfiguration(f.transport, "agent", true);
  expect(f.tools.size).toBe(7);
  expect(f.backups.length).toBe(7);
  expect(
    f.agent.conversation_config.agent.prompt.tools.map((tool) => tool.name),
  ).toEqual([
    "read_tasks",
    "read_habit_day",
    "log_habit_occurrence",
    "log_habit_urge",
    "read_habit_context",
    "read_habit_system",
    "change_habit_system",
    "end_call",
  ]);
  expect(f.agent.conversation_config.tts).toEqual({ voice_id: "preserve" });
  const before = f.calls.length;
  await syncJarvisHabitConfiguration(f.transport, "agent", true);
  expect(f.calls.slice(before).every((call) => call.startsWith("GET"))).toBe(
    true,
  );
});

test("configuration rejects duplicate tools and nonprivate agents", () => {
  const f = fixture();
  const tools = [...f.tools.values()];
  expect(() =>
    prepareJarvisHabitConfiguration(
      { ...f.agent, platform_settings: { auth: { enable_auth: false } } },
      tools,
    ),
  ).toThrow("Private");
  expect(() =>
    prepareJarvisHabitConfiguration(f.agent, [
      ...tools,
      ...[1, 2].map((id) => ({
        id: `${id}`,
        tool_config: { type: "webhook", name: "read_habit_day" },
      })),
    ]),
  ).toThrow("Ambiguous");
});

test("sync recovers tools created before attachment without creating duplicates", async () => {
  const f = fixture();
  const prepared = prepareJarvisHabitConfiguration(f.agent, [
    ...f.tools.values(),
  ]);
  f.tools.set("orphan", {
    id: "orphan",
    tool_config: prepared.desired[0].toolConfig,
  });
  await syncJarvisHabitConfiguration(f.transport, "agent", true);
  expect(f.tools.size).toBe(7);
  expect(f.agent.conversation_config.agent.prompt.tool_ids).toContain("orphan");
  expect(f.calls.filter((call) => call === "POST tools")).toHaveLength(5);
});

test("sync rejects incomplete discovery pagination before writes", async () => {
  const f = fixture();
  const original = f.transport.request;
  f.transport.request = async (path, method, body) =>
    path.startsWith("tools?")
      ? { tools: [], has_more: true }
      : original(path, method, body);
  await expect(
    syncJarvisHabitConfiguration(f.transport, "agent", true),
  ).rejects.toThrow("pagination");
  expect(f.backups).toHaveLength(0);
  expect(f.calls.every((call) => call.startsWith("GET"))).toBe(true);
});

test("sync refuses concurrent prompt edits before mutation", async () => {
  const f = fixture();
  const request = f.transport.request;
  let reads = 0;
  f.transport.request = async (path, method, body) => {
    const result = await request(path, method, body);
    if (path === "agents/agent" && ++reads === 2)
      result.conversation_config.agent.prompt.prompt += " newer intent";
    return result;
  };
  await expect(
    syncJarvisHabitConfiguration(f.transport, "agent", true),
  ).rejects.toThrow("changed");
  expect(f.calls.every((call) => call.startsWith("GET"))).toBe(true);
});

test("discovery keeps production and development tools separate", async () => {
  const f = fixture();
  const prepared = prepareJarvisHabitConfiguration(f.agent, [
    ...f.tools.values(),
  ]);
  const foreign = structuredClone(prepared.desired[0]!.toolConfig);
  foreign.api_schema.url = "https://dev.example.test/api/v1/habits/day";
  f.tools.set("development", { id: "development", tool_config: foreign });
  await syncJarvisHabitConfiguration(f.transport, "agent", true);
  expect(f.agent.conversation_config.agent.prompt.tool_ids).not.toContain(
    "development",
  );
  expect(f.tools.get("development").tool_config).toEqual(foreign);
});
