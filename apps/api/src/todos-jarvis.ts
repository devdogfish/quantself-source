import { getPublicOrigin } from "@quantself/auth/public-origin";
import { jarvisCategoryClientToolNames } from "./todos-jarvis-category-config";
import { z } from "zod";
import { jarvisHabitTools } from "./jarvis-habits";
import { TodoWriteError } from "./todos-write";

export type JarvisProvider = {
  agentId(): string;
  temporaryAccess(): Promise<string>;
  finalConversation(id: string): Promise<{
    agentId: string;
    userId: string;
    conversationId: string;
    done: boolean;
    capturedAt: string;
    summary?: string;
    conversation: { role: "user" | "assistant"; text: string }[];
  }>;
  audio(id: string): Promise<{ bytes: Uint8Array; mime: string }>;
};
const providerConversation = z.object({
  agent_id: z.string(),
  user_id: z.string(),
  conversation_id: z.string(),
  status: z.string(),
  metadata: z.object({ start_time_unix_secs: z.number() }),
  analysis: z.object({ transcript_summary: z.string().nullable().optional() }).nullish(),
  transcript: z.array(
    z.object({
      role: z.enum(["user", "agent"]),
      message: z.string().nullable(),
    }),
  ),
});
const endCallToolSchema = z.object({
  type: z.literal("system"),
  name: z.literal("end_call"),
  params: z.object({ system_tool_type: z.literal("end_call") }).strict(),
});
const skipTurnToolSchema = z.object({
  type: z.literal("system"),
  name: z.literal("skip_turn"),
  params: z.object({
    system_tool_type: z.literal("skip_turn"),
    wait_timeout_secs: z.number().min(-1).optional(),
    omit_from_transcript: z.boolean().optional(),
  }).strict(),
});
const silentSystemToolSchema = z.union([endCallToolSchema, skipTurnToolSchema]);
const toolSchema = z.object({
  type: z.string(),
  name: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
  api_schema: z
    .object({
      method: z.string(),
      url: z.string(),
      request_headers: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});
const agentSchema = z.object({
  workflow: z
    .object({
      nodes: z.record(z.string(), z.unknown()).optional(),
      edges: z.record(z.string(), z.unknown()).optional(),
      subgraphs: z.record(z.string(), z.unknown()).optional(),
    })
    .nullish(),
  platform_settings: z.object({
    auth: z.object({ enable_auth: z.boolean() }),
    privacy: z.object({
      record_voice: z.boolean(),
      retention_days: z.number(),
      delete_audio: z.boolean().optional(),
      delete_transcript_and_pii: z.boolean().optional(),
      zero_retention_mode: z.boolean().optional(),
    }),
  }),
  conversation_config: z.object({
    agent: z.object({
      prompt: z.object({
        tools: z.array(toolSchema).optional(),
        tool_ids: z.array(z.string()).optional(),
        mcp_server_ids: z.array(z.string()).optional(),
        built_in_tools: z.record(z.string(), z.unknown()).optional(),
      }),
    }),
  }),
});
export function createJarvisProvider(
  request: typeof fetch = fetch,
  env = () => process.env,
): JarvisProvider {
  function agentId() {
    const id = env().QUANTSELF_ELEVENLABS_AGENT_ID;
    if (!id || !/^[\w-]+$/.test(id))
      throw Error("Jarvis configuration unavailable");
    return id;
  }
  async function get(path: string, timeoutMs = 15000) {
    const key = env().QUANTSELF_ELEVENLABS_API_KEY;
    if (!key) throw Error("Jarvis configuration unavailable");
    const response = await request(
      `https://api.elevenlabs.io/v1/convai/${path}`,
      {
        headers: { "xi-api-key": key },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) throw Error("Jarvis provider unavailable");
    return response;
  }
  return {
    agentId,
    async temporaryAccess() {
      // Refuse drift to public agents, unrelated tools, or non-retained recordings.
      const agent = agentSchema.parse(
        await (await get(`agents/${agentId()}`)).json(),
      );
      const privacy = agent.platform_settings.privacy;
      if (
        !agent.platform_settings.auth.enable_auth ||
        !privacy.record_voice ||
        privacy.retention_days !== -1 ||
        privacy.delete_audio ||
        privacy.delete_transcript_and_pii ||
        privacy.zero_retention_mode
      )
        throw Error("Private retained Jarvis required");
      const prompt = agent.conversation_config.agent.prompt;
      // ElevenLabs includes an inert start node even for a single agent.
      const nodes = Object.values(agent.workflow?.nodes ?? {});
      const inertStart = z
        .object({
          type: z.literal("start"),
          position: z.object({ x: z.number(), y: z.number() }).optional(),
          edge_order: z.array(z.never()).optional(),
          parent_subgraph_id: z.null().optional(),
          parent_frame_id: z.null().optional(),
        })
        .strict();
      if (
        (nodes.length > 0 &&
          !(nodes.length === 1 && inertStart.safeParse(nodes[0]).success)) ||
        Object.keys(agent.workflow?.subgraphs ?? {}).length ||
        Object.keys(agent.workflow?.edges ?? {}).length ||
        prompt.mcp_server_ids?.length ||
        Object.entries(prompt.built_in_tools ?? {}).some(([name, tool]) =>
          !!tool && !(["end_call", "skip_turn"].includes(name) && silentSystemToolSchema.safeParse(tool).success && (tool as { name: string }).name === name),
        )
      )
        throw Error("Unrelated agent capabilities forbidden");
      const tools = [...(prompt.tools ?? [])];
      for (const id of prompt.tool_ids ?? []) {
        const stored = await (
          await get(`tools/${encodeURIComponent(id)}`)
        ).json();
        tools.push(
          z.object({ tool_config: toolSchema }).parse(stored).tool_config,
        );
      }
      const origin = new URL(
        env().QUANTSELF_JARVIS_TOOL_ORIGIN || getPublicOrigin(env()) || "",
      );
      if (origin.protocol !== "https:")
        throw Error("HTTPS tool origin required");
      let hasTaskReadTool = false;
      for (const tool of tools) {
        if (silentSystemToolSchema.safeParse(tool).success) continue;
        if (tool.type === "client" && ["show_task", "set_calendar_view", "navigate_calendar", "close_panel", ...jarvisCategoryClientToolNames].includes(tool.name)) continue;
        const schema = tool.api_schema;
        const secret = z
          .object({ secret_id: z.string().min(1) })
          .strict()
          .safeParse(schema?.request_headers?.["X-API-Key"]);
        const url = new URL(schema?.url ?? "invalid:");
        const pathname = decodeURI(url.pathname);
        const isTaskRead =
          schema?.method === "GET" &&
          [
            "/api/v1/todos",
            "/api/v1/todos/{number}",
            "/api/v1/access-context",
          ].includes(pathname);
        const isTaskCommand =
          schema?.method === "POST" &&
          ["/api/v1/todo-jarvis/{id}/commands"].includes(pathname);
        const isHabitTool = jarvisHabitTools.some(
          (habit) =>
            habit.name === tool.name &&
            habit.method === schema?.method &&
            habit.pathname === url.pathname,
        );
        if (
          tool.type !== "webhook" ||
          !(isTaskRead || isTaskCommand || isHabitTool) ||
          url.origin !== origin.origin ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !secret.success
        )
          throw Error("Allowlisted secret-backed Jarvis tools required");
        if (pathname === "/api/v1/todos") hasTaskReadTool = true;
      }
      if (!hasTaskReadTool) throw Error("Task read tool required");
      const body = await (
        await get(
          `conversation/get-signed-url?agent_id=${encodeURIComponent(agentId())}`,
        )
      ).json();
      const url = new URL(
        z.object({ signed_url: z.string() }).parse(body).signed_url,
      );
      if (
        url.protocol !== "wss:" ||
        url.host !== "api.elevenlabs.io" ||
        url.username ||
        url.password ||
        url.pathname !== "/v1/convai/conversation"
      )
        throw Error("Invalid temporary access");
      return url.toString();
    },
    async finalConversation(id) {
      const value = providerConversation.parse(
        await (await get(`conversations/${encodeURIComponent(id)}`)).json(),
      );
      return {
        ...(value.analysis?.transcript_summary ? { summary: value.analysis.transcript_summary } : {}),
        agentId: value.agent_id,
        userId: value.user_id,
        conversationId: value.conversation_id,
        // Failed calls are terminal too; their retained evidence still needs archiving.
        done: value.status === "done" || value.status === "failed",
        capturedAt: new Date(
          value.metadata.start_time_unix_secs * 1000,
        ).toISOString(),
        conversation: value.transcript.flatMap((message) => {
          if (!message.message) return [];
          return [
            {
              role: message.role === "agent" ? "assistant" : "user",
              text: message.message,
            },
          ];
        }),
      };
    },
    async audio(id) {
      const response = await get(
        `conversations/${encodeURIComponent(id)}/audio`,
        120000,
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      const mime =
        response.headers.get("content-type")?.split(";")[0] ??
        "application/octet-stream";
      if (
        !bytes.length ||
        // Two-hour provider recordings can exceed the separate 50 MiB upload limit.
        bytes.length > 512 * 1024 * 1024 ||
        !/^(audio\/[a-z0-9.+-]+|application\/octet-stream)$/.test(mime)
      )
        throw Error("Recording unavailable");
      return { bytes, mime };
    },
  };
}
export function jarvisConflict() {
  return new TodoWriteError(
    "JARVIS_SOURCE_MISMATCH",
    "Conversation does not belong to this capture.",
    409,
  );
}
