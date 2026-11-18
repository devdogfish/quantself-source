import { expect, test } from "bun:test";
import { callbackTools, verifyTunnel } from "./dev-jarvis";

const tool = { id: "edit", tool_config: { type: "webhook", name: "edit_task_command", description: "Keep this", api_schema: { method: "POST", url: "https://old.trycloudflare.com/api/v1/todo-jarvis/{id}/commands", request_headers: { "X-API-Key": { secret_id: "old-secret" } }, request_body_schema: { type: "object" } } } };
test("retargets only existing task webhooks and preserves schemas and unrelated capabilities", () => {
  const [updated] = callbackTools([tool, { id: "nav", tool_config: { type: "client", name: "show_task" } }], "https://fresh-tunnel.trycloudflare.com", "fresh-secret");
  expect(updated.tool_config.api_schema.url).toBe("https://fresh-tunnel.trycloudflare.com/api/v1/todo-jarvis/{id}/commands");
  expect(updated.tool_config.api_schema.request_headers["X-API-Key"]).toEqual({ secret_id: "fresh-secret" });
  expect(updated.tool_config.description).toBe("Keep this");
  expect(updated.tool_config.api_schema.request_body_schema).toEqual(tool.tool_config.api_schema.request_body_schema);
  expect(tool.tool_config.api_schema.request_headers["X-API-Key"].secret_id).toBe("old-secret");
});
test("refuses unrelated callback routes before any remote update", () => {
  const unrelated = structuredClone(tool); unrelated.tool_config.api_schema.url = "https://old.trycloudflare.com/api/internal/admin";
  expect(() => callbackTools([unrelated], "https://fresh.trycloudflare.com", "secret")).toThrow();
  expect(() => callbackTools([tool], "http://localhost:3000", "secret")).toThrow();
});


test("tunnel readiness retries propagation failures but refuses invalid credentials", async () => {
  let calls = 0;
  const request = (async () => { calls++; if (calls === 1) throw Error("DNS pending"); return new Response("", { status: calls === 2 ? 502 : 200 }); }) as typeof fetch;
  await verifyTunnel("https://fresh.trycloudflare.com", "private", request, async () => {});
  expect(calls).toBe(3);
  let rejected = 0;
  await expect(verifyTunnel("https://fresh.trycloudflare.com", "private", (async () => { rejected++; return new Response("", { status: 401 }); }) as typeof fetch, async () => {})).rejects.toThrow("authentication failed");
  expect(rejected).toBe(1);
});



test("tunnel readiness tolerates DNS propagation beyond one minute and still bounds failure", async () => {
  const realNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    const request = (async () => {
      if (now < 75000) throw Error("DNS pending");
      return new Response("", { status: 200 });
    }) as typeof fetch;
    await verifyTunnel("https://fresh.trycloudflare.com", "private", request, async () => { now += 1000; });
    expect(now).toBe(75000);
    now = 0;
    await expect(verifyTunnel("https://fresh.trycloudflare.com", "private", (async () => { throw Error("DNS pending"); }) as typeof fetch, async () => { now += 1000; })).rejects.toThrow("180 seconds");
    expect(now).toBe(180000);
  } finally { Date.now = realNow; }
});


test("development refuses production callbacks, including mixed sets, without changing tools", () => {
  const production = structuredClone(tool);
  production.tool_config.api_schema.url = "https://dashboard.example/api/v1/todo-jarvis/{id}/commands";
  const read = { id: "read", tool_config: { ...structuredClone(production.tool_config), name: "read_tasks", api_schema: { ...structuredClone(production.tool_config.api_schema), method: "GET", url: "https://dashboard.example/api/v1/todos" } } };
  for (const tools of [[production], [tool, production], [tool, read]]) {
    const before = structuredClone(tools);
    expect(() => callbackTools(tools, "https://fresh.trycloudflare.com", "dev-secret")).toThrow("dedicated development agent with cloned tools");
    expect(tools).toEqual(before);
  }
});


test("explicit stable development origin supports quick-tunnel migration and later renewals", () => {
  const stable = "https://quantself-local.girke.dev";
  const [migrated] = callbackTools([tool], stable, "new-secret", stable);
  expect(migrated.tool_config.api_schema.url).toBe(`${stable}/api/v1/todo-jarvis/{id}/commands`);
  const [renewed] = callbackTools([migrated], stable, "renewed-secret", stable);
  expect(renewed.tool_config.api_schema.request_headers["X-API-Key"]).toEqual({ secret_id: "renewed-secret" });
  expect(migrated.tool_config.api_schema.request_headers["X-API-Key"]).toEqual({ secret_id: "new-secret" });
  expect(() => callbackTools([migrated], stable, "secret")).toThrow();
});

test("stable configuration never authorizes production, arbitrary origins, or URL credentials", () => {
  const stable = "https://quantself-local.girke.dev";
  for (const origin of ["https://dashboard.girke.dev", "https://other.girke.dev", `${stable}/nested`, `${stable}?query=1`, "https://user@quantself-local.girke.dev"]) {
    expect(() => callbackTools([tool], origin, "secret", stable)).toThrow();
  }
  for (const origin of ["https://dashboard.girke.dev", "https://other.girke.dev", "https://user@old.trycloudflare.com", "https://nested.old.trycloudflare.com"]) {
    const source = structuredClone(tool);
    source.tool_config.api_schema.url = `${origin}/api/v1/todo-jarvis/{id}/commands`;
    expect(() => callbackTools([source], stable, "secret", stable)).toThrow();
  }
  expect(() => callbackTools([tool], "https://dashboard.girke.dev", "secret", "https://dashboard.girke.dev")).toThrow();
});
