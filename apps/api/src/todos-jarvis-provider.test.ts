import { expect, test } from "bun:test";
import { prepareJarvisHabitConfiguration } from "./jarvis-habits";
import { createJarvisProvider } from "./todos-jarvis";

test("private Jarvis can start with all configured habit tools and rejects drift", async () => {
  const origin = "https://quantself.example";
  const signedUrl = "wss://api.elevenlabs.io/v1/convai/conversation?token=temporary";
  const readTasks = {
    type: "webhook",
    name: "read_tasks",
    api_schema: {
      method: "GET",
      url: `${origin}/api/v1/todos`,
      request_headers: { "X-API-Key": { secret_id: "provider-secret-reference" } },
    },
  };
  const prompt = { prompt: "Jarvis", tool_ids: ["tasks"] };
  const agent = {
    platform_settings: {
      auth: { enable_auth: true },
      privacy: { record_voice: true, retention_days: -1 },
    },
    conversation_config: { agent: { prompt } },
  };
  const { desired } = prepareJarvisHabitConfiguration(agent, [{ id: "tasks", tool_config: readTasks }]);
  const stored = new Map<string, {
    type: string;
    name: string;
    api_schema: { method: string; url: string; request_headers: Record<string, unknown> };
  }>([["tasks", readTasks], ...desired.map(({ toolConfig }) => [toolConfig.name, toolConfig] as const)]);
  prompt.tool_ids.push(...desired.map(({ toolConfig }) => toolConfig.name));
  let signedUrlRequests = 0;
  const provider = createJarvisProvider(
    (async (input: string) => {
      const { pathname } = new URL(input);
      if (pathname === "/v1/convai/conversation/get-signed-url") {
        signedUrlRequests++;
        return Response.json({ signed_url: signedUrl });
      }
      if (pathname.startsWith("/v1/convai/tools/"))
        return Response.json({ tool_config: stored.get(pathname.split("/").at(-1)!) });
      return Response.json(agent);
    }) as typeof fetch,
    () => ({
      QUANTSELF_ELEVENLABS_AGENT_ID: "private-agent",
      QUANTSELF_ELEVENLABS_API_KEY: "server-only",
      BETTER_AUTH_URL: origin,
    }),
  );

  expect(await provider.temporaryAccess()).toBe(signedUrl);
  const write = stored.get("log_habit_occurrence")!;
  for (const drift of [
    { method: "GET" },
    { url: "https://other.example/api/v1/habits/commands" },
    { url: `${origin}/api/v1/habits/commands?extra=true` },
    { url: `${origin}/api/v1/habits/slips` },
    { request_headers: {} },
  ]) {
    stored.set(write.name, { ...write, api_schema: { ...write.api_schema, ...drift } });
    await expect(provider.temporaryAccess()).rejects.toThrow("Allowlisted");
  }
  stored.set(write.name, write);
  prompt.tool_ids.shift();
  await expect(provider.temporaryAccess()).rejects.toThrow("Task read tool required");
  expect(signedUrlRequests).toBe(1);
});

test("provider uses fixed host/server credentials, private retained agent and secret-backed read tools", async () => {
  const calls: string[] = [];
  const tool = {
    type: "webhook",
    name: "read_tasks",
    api_schema: {
      method: "GET",
      url: "https://quantself.example/api/v1/todos",
      request_headers: {
        "X-API-Key": { secret_id: "provider-secret-reference" },
      },
    },
  };
  const agent = {
    workflow: {
      nodes: {
        start_node: {
          type: "start",
          position: { x: 0, y: 0 },
          edge_order: [],
          parent_subgraph_id: null,
          parent_frame_id: null,
        },
      },
      edges: {},
      subgraphs: {},
    },
    platform_settings: {
      auth: { enable_auth: true },
      privacy: { record_voice: true, retention_days: -1 },
    },
    conversation_config: { agent: { prompt: { tools: [tool, {type: "system", name: "end_call", params: {system_tool_type: "end_call"}}, ...["show_task", "set_calendar_view", "navigate_calendar", "set_category_filter", "change_category", "close_panel"].map(name => ({ type: "client", name }))], built_in_tools: { end_call: { type: "system", name: "end_call", params: { system_tool_type: "end_call" } } } } } },
  };
  const provider = createJarvisProvider(
    (async (url: string, init: RequestInit) => {
      calls.push(url);
      expect(init.headers).toEqual({ "xi-api-key": "server-only" });
      expect(init.redirect).toBe("error");
      return Response.json(
        url.includes("get-signed-url")
          ? {
              signed_url:
                "wss://api.elevenlabs.io/v1/convai/conversation?token=temporary",
            }
          : agent,
      );
    }) as typeof fetch,
    () => ({
      QUANTSELF_ELEVENLABS_AGENT_ID: "private-agent",
      QUANTSELF_ELEVENLABS_API_KEY: "server-only",
      BETTER_AUTH_URL: "https://quantself.example",
    }),
  );
  expect(await provider.temporaryAccess()).toContain("wss://api.elevenlabs.io");
  expect(calls.at(-1)).toContain("agent_id=private-agent");
  const builtins = agent.conversation_config.agent.prompt.built_in_tools as Record<string, unknown>;
  builtins.skip_turn = { type: "system", name: "skip_turn", params: { system_tool_type: "skip_turn", wait_timeout_secs: -1, omit_from_transcript: false } };
  expect(await provider.temporaryAccess()).toContain("wss:");
  builtins.skip_turn = { type: "system", name: "skip_turn", params: { system_tool_type: "transfer_to_number" } };
  await expect(provider.temporaryAccess()).rejects.toThrow();
  builtins.skip_turn = { type: "system", name: "end_call", params: { system_tool_type: "end_call" } };
  await expect(provider.temporaryAccess()).rejects.toThrow();
  delete builtins.skip_turn;
  const client = agent.conversation_config.agent.prompt.tools.at(-1)!;
  client.name = "click_anything";
  await expect(provider.temporaryAccess()).rejects.toThrow();
  client.name = "close_panel";
  for (const url of [
    "http://quantself.example/api/v1/todos",
    "https://other.example/api/v1/todos",
    "https://quantself.example/api/v1/inventory-items",
    "https://quantself.example/api/v1/todos?repository=other",
  ]) {
    tool.api_schema.url = url;
    await expect(provider.temporaryAccess()).rejects.toThrow();
  }
  tool.api_schema.url = "https://quantself.example/api/v1/todos";
  tool.api_schema.method = "POST";
  await expect(provider.temporaryAccess()).rejects.toThrow();
  tool.api_schema.method = "GET";
  agent.platform_settings.auth.enable_auth = false;
  await expect(provider.temporaryAccess()).rejects.toThrow();
});

test.each(["done", "failed"])(
  "provider preserves final conversation and original audio after status=%s",
  async (status) => {
    const bytes = new Uint8Array([1, 3, 5]);
    const provider = createJarvisProvider(
      (async (url: string) =>
        url.endsWith("/audio")
          ? new Response(bytes, { headers: { "content-type": "audio/mpeg" } })
          : Response.json({
              agent_id: "agent",
              user_id: "capture",
              conversation_id: "conv_1",
              status,
              metadata: { start_time_unix_secs: 1793016000 },
              transcript: [
                {
                  role: "user",
                  message: "My words",
                  tool_calls: [{ headers: { "x-api-key": "never retain" } }],
                },
                { role: "agent", message: null },
              ],
            })) as typeof fetch,
      () => ({ QUANTSELF_ELEVENLABS_API_KEY: "server" }),
    );
    const result = await provider.finalConversation("conv_1");
    expect(result.done).toBe(true);
    expect(result.conversation).toEqual([{ role: "user", text: "My words" }]);
    expect(JSON.stringify(result)).not.toContain("never retain");
    expect((await provider.audio("conv_1")).bytes).toEqual(bytes);
  },
);

test("temporary access rejects hidden workflow/MCP capabilities, invalid secret references and nonretained audio", async () => {
  const tool = {
    type: "webhook",
    name: "read_tasks",
    api_schema: {
      method: "GET",
      url: "https://quantself.example/api/v1/todos",
      request_headers: { "X-API-Key": { secret_id: "reference" } },
    },
  };
  const base = {
    platform_settings: {
      auth: { enable_auth: true },
      privacy: { record_voice: true, retention_days: -1 },
    },
    conversation_config: { agent: { prompt: { tools: [tool] } } },
  };
  for (const agent of [
    { ...base, workflow: { nodes: { start: { type: "start", parent_frame_id: "hidden-frame" } } } },
    { ...base, workflow: { nodes: { transfer: { type: "phone_number" } } } },
    {
      ...base,
      workflow: {
        nodes: { start: { type: "start", edge_order: ["transfer"] } },
      },
    },
    { ...base, workflow: { subgraphs: { hidden: { nodes: {} } } } },
    {
      ...base,
      conversation_config: {
        agent: { prompt: { tools: [tool, { type: "system", name: "end_call", params: { system_tool_type: "transfer_to_number" } }] } },
      },
    },
    {
      ...base,
      conversation_config: {
        agent: { prompt: { tools: [tool], mcp_server_ids: ["unrelated"] } },
      },
    },
    {
      ...base,
      conversation_config: {
        agent: {
          prompt: { tools: [tool], built_in_tools: { transfer_to_number: {} } },
        },
      },
    },
    {
      ...base,
      conversation_config: {
        agent: {
          prompt: {
            tools: [
              {
                ...tool,
                api_schema: {
                  ...tool.api_schema,
                  request_headers: {
                    "X-API-Key": {
                      secret_id: "reference",
                      value: "literal-key-forbidden",
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
    {
      ...base,
      platform_settings: {
        ...base.platform_settings,
        privacy: { record_voice: false, retention_days: 30 },
      },
    },
    {
      ...base,
      conversation_config: {
        agent: {
          prompt: {
            tools: [
              {
                ...tool,
                api_schema: {
                  ...tool.api_schema,
                  request_headers: { "X-API-Key": "literal-key-forbidden" },
                },
              },
            ],
          },
        },
      },
    },
  ]) {
    const provider = createJarvisProvider(
      (async (input: Parameters<typeof fetch>[0]) =>
        Response.json(
          String(input).includes("get-signed-url")
            ? {
                signed_url:
                  "wss://api.elevenlabs.io/v1/convai/conversation?token=temporary",
              }
            : agent,
        )) as typeof fetch,
      () => ({
        QUANTSELF_ELEVENLABS_AGENT_ID: "agent",
        QUANTSELF_ELEVENLABS_API_KEY: "server",
        BETTER_AUTH_URL: "https://quantself.example",
      }),
    );
    await expect(provider.temporaryAccess()).rejects.toThrow();
  }
});

test("private provider permits only the shared conversational write tool; approval and arbitrary mutations remain forbidden", async () => {
  const read = {
    type: "webhook",
    name: "read_tasks",
    api_schema: {
      method: "GET",
      url: "https://quantself.example/api/v1/todos",
      request_headers: { "X-API-Key": { secret_id: "read-write-only" } },
    },
  };
  const write = structuredClone(read);
  write.name = "apply_task_command";
  write.api_schema.method = "POST";
  write.api_schema.url =
    "https://quantself.example/api/v1/todo-jarvis/{id}/commands";
  const provider = createJarvisProvider(
    (async (url: string) =>
      Response.json(
        url.includes("get-signed-url")
          ? {
              signed_url:
                "wss://api.elevenlabs.io/v1/convai/conversation?token=temporary",
            }
          : {
              platform_settings: {
                auth: { enable_auth: true },
                privacy: { record_voice: true, retention_days: -1 },
              },
              conversation_config: {
                agent: { prompt: { tools: [read, write] } },
              },
            },
      )) as typeof fetch,
    () => ({
      QUANTSELF_ELEVENLABS_AGENT_ID: "agent",
      QUANTSELF_ELEVENLABS_API_KEY: "server",
      BETTER_AUTH_URL: "https://quantself.example",
    }),
  );
  expect(await provider.temporaryAccess()).toContain("wss:");
  for (const path of [
    "/api/v1/todos/{number}/approval",
    "/api/v1/todos",
    "/api/v1/todo-jarvis/{id}/reconcile",
    "/api/v1/inventory-items",
  ]) {
    write.api_schema.url = `https://quantself.example${path}`;
    await expect(provider.temporaryAccess()).rejects.toThrow();
  }
});

test("local auth can use a separate HTTPS callback origin without widening tool access", async () => {
  const tool = {
    type: "webhook",
    name: "read_tasks",
    api_schema: {
      method: "GET",
      url: "https://callback.example/api/v1/todos",
      request_headers: { "X-API-Key": { secret_id: "private-reference" } },
    },
  };
  const env = {
    BETTER_AUTH_URL: "http://localhost:3000",
    QUANTSELF_JARVIS_TOOL_ORIGIN: "https://callback.example",
    QUANTSELF_ELEVENLABS_AGENT_ID: "agent",
    QUANTSELF_ELEVENLABS_API_KEY: "private",
  };
  const provider = createJarvisProvider(
    (async (url: string) =>
      Response.json(
        url.includes("get-signed-url")
          ? {
              signed_url:
                "wss://api.elevenlabs.io/v1/convai/conversation?token=temporary",
            }
          : {
              platform_settings: {
                auth: { enable_auth: true },
                privacy: { record_voice: true, retention_days: -1 },
              },
              conversation_config: { agent: { prompt: { tools: [tool] } } },
            },
      )) as typeof fetch,
    () => env,
  );
  expect(await provider.temporaryAccess()).toContain("wss:");
  env.QUANTSELF_JARVIS_TOOL_ORIGIN = "http://callback.example";
  await expect(provider.temporaryAccess()).rejects.toThrow("HTTPS");
  env.QUANTSELF_JARVIS_TOOL_ORIGIN = "https://other.example";
  await expect(provider.temporaryAccess()).rejects.toThrow("Allowlisted");
});


test("long provider recordings remain recoverable beyond the manual upload limit", async () => {
  const bytes = new Uint8Array(51 * 1024 * 1024);
  const provider = createJarvisProvider((async () => ({
    ok: true,
    headers: new Headers({ "content-type": "audio/mpeg" }),
    arrayBuffer: async () => bytes.buffer,
  })) as unknown as typeof fetch, () => ({ QUANTSELF_ELEVENLABS_API_KEY: "server" }));
  expect((await provider.audio("long-session")).bytes.byteLength).toBe(bytes.length);
});
