import type { JarvisCategoryCommand } from "./jarvis-category-commands";
import type { Conversation } from "@elevenlabs/client";
import { validCalendarDate, type JarvisUiAction, type JarvisCalendarView } from "./jarvis-ui";

export type JarvisConnection = Pick<Conversation, "endSession" | "setMicMuted"> & Partial<Pick<Conversation, "getInputVolume" | "getOutputVolume" | "sendContextualUpdate" | "sendUserActivity">>;
export type JarvisCallbacks = {
  connected(id: string): void;
  disconnected(reason?: "duration"): void;
  message(role: string, text: string, eventId?: number): void;
  userActivity?(): void;
  mode(speaking: boolean): void;
  activity(): void;
  tool(pending: boolean): void;
  result(text: string): void;
  changed(): void;
  error(detail?: string): void;
  showTask(number: number): void | string | Promise<string>;
  findTask?(query: string): Promise<string>;
  ui?(action: JarvisUiAction): Promise<string>;
  uiContext?(): string;
  event?(type: string, detail: string): void;
};

// Keep diagnostics separate from speech/archive data and omit request/transport fields.
export function jarvisErrorDetail(input: string): string {
  const fields = new Set(["code", "message", "detail", "reason", "status", "status_code", "error", "error_type", "raw_error_message", "body", "result", "issues", "path"]);
  let detail = input;
  try {
    detail = JSON.stringify(JSON.parse(input), (key, value) => !key || fields.has(key) || /^\d+$/.test(key) ? value : undefined);
  } catch { /* Providers can return plain-text transport errors. */ }
  return detail
    .replace(/((?:authorization|proxy-authorization|x-api-key|xi-api-key|cookie|set-cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,;}]+)/gi, "$1<REDACTED>")
    .replace(/Bearer\s+[^\s"',;}]+/gi, "Bearer <REDACTED>")
    .replace(/\bsk_[a-z0-9_]+/gi, "<REDACTED>")
    .replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, (url) => {
      try { return new URL(url).origin; } catch { return "<REDACTED URL>"; }
    })
    .slice(0, 2000);
}
export async function connectJarvis(
  signedUrl: string,
  captureId: string,
  callbacks: JarvisCallbacks,
): Promise<JarvisConnection> {
  const { Conversation } = await import("@elevenlabs/client");
  return Conversation.startSession({
    signedUrl,
    connectionType: "websocket",
    userId: captureId,
    dynamicVariables: {
      startup_greeting: Math.random() < 0.5 ? "At your service, sir." : "Welcome home, sir.",
      ...(callbacks.uiContext ? { ui_context: callbacks.uiContext() } : {}),
    },
    onConnect: ({ conversationId }) => callbacks.connected(conversationId),
    onDisconnect: (details) => callbacks.disconnected("context" in details && details.context?.type === "max_duration_exceeded" ? "duration" : undefined),
    onMessage: ({ role, message, event_id }) => callbacks.message(role, message, event_id),
    onAgentResponseCorrection: ({ corrected_agent_response, event_id }) => callbacks.message("agent", corrected_agent_response, event_id),
    onVadScore: ({ vadScore }) => { if (vadScore >= .5) callbacks.userActivity?.(); },
    onModeChange: ({ mode }) => callbacks.mode(mode === "speaking"),
    onAudio: () => callbacks.activity(),
    onAgentToolRequest: (event) => {
      if (event.tool_name === "skip_turn") return;
      callbacks.event?.("tool.request", `${event.tool_name} · ${event.tool_call_id}`);
      callbacks.tool(true);
    },
    onAgentToolResponse: (result) => {
      if (result.tool_name === "skip_turn") return;
      const detail = result.is_error && "full_tool_result" in result ? jarvisErrorDetail(result.full_tool_result) : "";
      callbacks.event?.("tool.response", `${result.tool_name} · ${result.tool_call_id} · ${result.is_error ? "failed" : "returned"}${detail ? ` · ${detail}` : ""}`);
      callbacks.tool(false);
      callbacks.result(
        result.is_error
          ? `Task tool failed.${detail ? ` ${detail}` : " Check Client permissions and refresh tasks; retry identical commands to reconcile."}`
          : "Task tool returned. Check individual save outcomes; information may need refresh.",
      );
      callbacks.changed();
    },
    onError: (message) => callbacks.error(jarvisErrorDetail(message)),
    clientTools: {
      show_task: ({ number, query }: { number?: number; query?: string }) => {
        if (query !== undefined) {
          if (number !== undefined || typeof query !== "string" || !query.trim() || query.length > 200)
            return "Provide either a task number or a task name, not both.";
          return callbacks.findTask?.(query.trim()) ?? "Task name lookup unavailable. Use its number.";
        }
        if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
          return "Invalid task number";
        return callbacks.showTask(number!) ?? `Opened task #${number}`;
      },
      set_calendar_view: ({ view }: { view: JarvisCalendarView }) =>
        ["day", "week", "month", "year", "list"].includes(view)
          ? callbacks.ui?.({ type: "view", view }) ?? "Calendar controls unavailable."
          : "Choose day, week, month, year or list.",
      navigate_calendar: ({ target, date }: { target: "today" | "next" | "previous" | "date"; date?: string }) => {
        if (!["today", "next", "previous", "date"].includes(target) || (target === "date" ? !validCalendarDate(date) : date !== undefined))
          return "Choose today, next, previous, or date with a valid YYYY-MM-DD date.";
        return callbacks.ui?.({ type: "date", target, ...(date ? { date } : {}) }) ?? "Calendar controls unavailable.";
      },
      set_category_filter: ({ filter, categoryId }: { filter: "all" | "uncategorized" | "category"; categoryId?: number }) => {
        if (!["all", "uncategorized", "category"].includes(filter) || (filter === "category" ? !Number.isSafeInteger(categoryId) || categoryId === 0 : categoryId !== undefined))
          return "Choose all, uncategorized, or category with an existing categoryId.";
        return callbacks.ui?.({ type: "category_filter", filter, ...(categoryId === undefined ? {} : { categoryId }) }) ?? "Category filter unavailable.";
      },
      change_category: (command: JarvisCategoryCommand) => {
        if (!command || !["create", "update", "delete", "assign", "priority"].includes(command.action)) return "Choose create, update, delete, assign or priority.";
        return callbacks.ui?.({ ...command, type: "change_category" }) ?? "Category controls unavailable.";
      },
      close_panel: () => callbacks.ui?.({ type: "close" }) ?? "Panel controls unavailable.",
    },
  });
}

// SDK listening mode is emitted by the output worklet after queued playback finishes.
// Also wait for in-flight tool/reply work and a quiet gap between final audio chunks.
export function createPlaybackDrain(now = Date.now) {
  let speaking = false;
  let awaitingReply = false;
  let tools = 0;
  let activity = now();
  let audioActivity = now();
  return {
    mode(value: boolean) {
      speaking = value;
      activity = now();
      audioActivity = now();
    },
    message(role: string) {
      awaitingReply = role === "user";
      activity = now();
    },
    tool(pending: boolean) {
      tools = Math.max(0, tools + (pending ? 1 : -1));
      activity = now();
    },
    activity() {
      activity = now();
      audioActivity = now();
    },
    failed() {
      awaitingReply = false;
      tools = 0;
      activity = now();
    },
    ready() {
      return (
        !speaking && !awaitingReply && tools === 0 && now() - activity >= 1500
      );
    },
    playbackReady() {
      return !speaking && now() - audioActivity >= 1500;
    },
  };
}

// Renew during a quiet gap before ElevenLabs' two-hour maximum.
export function createJarvisSessionLifetime(now = Date.now) {
  const started = now();
  let lastSpeech = started;
  return {
    speech() { lastSpeech = now(); },
    idleExpired() { return now() - lastSpeech >= 120000; },
    renewalDue() { return now() - started >= 119 * 60000 && now() - lastSpeech >= 2000 && now() - lastSpeech < 120000; },
  };
}
