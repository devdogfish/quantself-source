import { expect, test } from "bun:test";
import { createJarvisSessionLifetime, createPlaybackDrain } from "./jarvis-connection";

test("two minutes without Owner speech expires the session; only active sessions renew", () => {
  let now = 0;
  const lifetime = createJarvisSessionLifetime(() => now);
  now = 119999;
  expect(lifetime.idleExpired()).toBe(false);
  now = 120000;
  expect(lifetime.idleExpired()).toBe(true);
  expect(lifetime.renewalDue()).toBe(false);
  now = 119 * 60000;
  lifetime.speech();
  expect(lifetime.idleExpired()).toBe(false);
  expect(lifetime.renewalDue()).toBe(false);
  now += 2000;
  expect(lifetime.renewalDue()).toBe(true);
});

test("playback drain distinguishes audio completion from pending tool delivery", () => {
  let now = 0;
  const drain = createPlaybackDrain(() => now);
  drain.tool(true);
  drain.mode(true);
  now = 60000;
  expect(drain.playbackReady()).toBe(false);
  drain.mode(false);
  now += 1500;
  expect(drain.playbackReady()).toBe(true);
  expect(drain.ready()).toBe(false);
});
test("ending waits for pending reply, tool result, all queued playback and quiet final chunk gap", () => {
  let now = 0;
  const drain = createPlaybackDrain(() => now);
  drain.message("user");
  now = 5000;
  expect(drain.ready()).toBe(false);
  drain.tool(true);
  drain.message("agent");
  now += 5000;
  expect(drain.ready()).toBe(false);
  drain.tool(false);
  drain.mode(true);
  now += 5000;
  expect(drain.ready()).toBe(false);
  drain.mode(false);
  now += 1000;
  expect(drain.ready()).toBe(false);
  drain.activity();
  now += 1500;
  expect(drain.ready()).toBe(true);
});

test("provider tool responses refresh records for success and error without claiming task save success", async () => {
  const { mock } = await import("bun:test");
  let options: any;
  mock.module("@elevenlabs/client", () => ({
    Conversation: {
      startSession: async (value: any) => {
        options = value;
        return {};
      },
    },
  }));
  try {
    const { connectJarvis } = await import("./jarvis-connection");
    let refreshed = 0;
    const messages: string[] = [];
    const events: string[] = [];
    const transcript: unknown[][] = [];
    const uiActions: unknown[] = [];
    const opened: number[] = [];
    let speech = 0;
    await connectJarvis("wss://example", "capture", {
      connected() {},
      disconnected() {},
      message: (...args) => transcript.push(args),
      userActivity: () => { speech++; },
      mode() {},
      activity() {},
      tool() {},
      error() {},
      showTask: (number) => { opened.push(number); return `Opened ${number}`; },
      findTask: async (query) => `Found ${query}`,
      ui: async (action) => { uiActions.push(action); return "Updated"; },
      uiContext: () => "Current screen",
      result: (text) => messages.push(text),
      event: (_type, detail) => events.push(detail),
      changed: () => {
        refreshed++;
      },
    });
    expect(options.dynamicVariables.ui_context).toBe("Current screen");
    expect(["At your service, sir.", "Welcome home, sir."]).toContain(options.dynamicVariables.startup_greeting);
    expect(await options.clientTools.show_task({ number: 7 })).toBe("Opened 7");
    expect(await options.clientTools.show_task({ query: "passport" })).toBe("Found passport");
    for (const input of [{ number: -1 }, { number: "7" }, { number: 1.1 }, {}, { query: "" }, { query: "x", number: 7 }])
      expect(await options.clientTools.show_task(input)).not.toContain("Opened");
    expect(opened).toEqual([7]);
    await options.clientTools.set_calendar_view({ view: "week" });
    await options.clientTools.navigate_calendar({ target: "date", date: "2028-02-29" });
    await options.clientTools.close_panel({});
    expect(uiActions).toEqual([{ type: "view", view: "week" }, { type: "date", target: "date", date: "2028-02-29" }, { type: "close" }]);
    for (const input of [{ target: "date", date: "2026-02-30" }, { target: "date", date: "tomorrow" }, { target: "delete" }, { target: "next", date: "2026-10-26" }])
      expect(await options.clientTools.navigate_calendar(input)).not.toBe("Updated");
    expect(await options.clientTools.set_calendar_view({ view: "admin" })).not.toBe("Updated");
    expect(uiActions).toHaveLength(3);
    expect(await options.clientTools.set_category_filter({ filter: "category", categoryId: 4 })).toBe("Updated");
    expect(uiActions.at(-1)).toEqual({ type: "category_filter", filter: "category", categoryId: 4 });
    for (const input of [{}, { filter: "category" }, { filter: "category", categoryId: "4" }, { filter: "category", categoryId: 0 }, { filter: "all", categoryId: 4 }, { filter: "delete" }])
      expect(await options.clientTools.set_category_filter(input)).not.toBe("Updated");
    expect(uiActions).toHaveLength(4);
    expect(await options.clientTools.change_category({ action: "assign", categoryId: null, taskNumbers: [7] })).toBe("Updated");
    expect(uiActions.at(-1)).toEqual({ type: "change_category", action: "assign", categoryId: null, taskNumbers: [7] });
    expect(await options.clientTools.change_category({ action: "execute" })).not.toBe("Updated");
    options.onMessage({ role: "user", message: "A caption", event_id: 4 });
    options.onAgentResponseCorrection({ corrected_agent_response: "A corrected caption", event_id: 5 });
    expect(transcript).toEqual([["user", "A caption", 4], ["agent", "A corrected caption", 5]]);
    options.onVadScore({ vadScore: .1 });
    options.onVadScore({ vadScore: .8 });
    expect(speech).toBe(1);
    options.onAgentToolResponse({
      tool_name: "apply_task_command",
      is_error: false,
    });
    options.onAgentToolResponse({
      tool_name: "apply_task_command",
      is_error: true,
    });
    options.onAgentToolResponse({
      tool_name: "apply_task_command",
      tool_call_id: "failed-dns",
      is_error: true,
      full_tool_result: JSON.stringify({
        error_type: "external_server",
        raw_error_message: "DNS resolution failed for callback.example",
        status_code: 500,
        request_headers: { "X-API-Key": "private-request-key" },
        message: "HTTP 500. Authorization: Bearer private-bearer-token",
      }),
    });
    options.onAgentToolRequest({ tool_name: "skip_turn" });
    options.onAgentToolResponse({ tool_name: "skip_turn", is_error: false });
    expect(refreshed).toBe(3);
    expect(messages[0]).toContain("individual save outcomes");
    expect(messages[1]).toContain("Client permissions");
    expect(messages.join(" ")).not.toContain("Task saved");
    expect(events.at(-1)).toContain("DNS resolution failed");
    expect(messages.at(-1)).toContain("HTTP 500");
    expect([...events, ...messages].join(" ")).not.toContain("private-request-key");
    expect([...events, ...messages].join(" ")).not.toContain("private-bearer-token");
  } finally {
    mock.restore();
  }
});
