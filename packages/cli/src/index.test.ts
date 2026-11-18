import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const apiKey = "quantself-offline-smoke-fixture";
const applicationId = "49db114d-041b-4e68-a82c-2050a3a47ac5";
const jobPath = `/api/v1/jobs/applications/${applicationId}`;

async function quantself(args: string[], origin = "") {
  const child = Bun.spawn([process.execPath, "run", "--silent", "quantself", ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      QUANTSELF_API_KEY: origin ? apiKey : "",
      QUANTSELF_API_URL: origin,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

test("the checkout command discovers generated operations without credentials", async () => {
  const [general, operation] = await Promise.all([
    quantself(["--help"]),
    quantself(["importJobApplications", "--help"]),
  ]);

  expect(general.status).toBe(0);
  expect(JSON.parse(general.stdout).commands.map(({ name }: { name: string }) => name)).toEqual(
    expect.arrayContaining(["listJobApplications", "getJobApplication", "importJobApplications", "patchJobApplication", "listTodos", "submitTodoHandBack", "getHabitCalendar"]),
  );
  expect(operation.status).toBe(0);
  expect(JSON.parse(operation.stdout)).toMatchObject({
    name: "importJobApplications",
    permissions: ["jobs:write", "jobs:import-tailored"],
    options: { "--body": expect.any(String), "--idempotency-key": expect.any(String) },
  });
});

test("a scoped checkout command cannot discover or invoke private receipts", async () => {
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      return Response.json({ error: "Private commands must be rejected before HTTP." }, { status: 403 });
    },
  });
  try {
    const discover = await quantself(["--help"], server.url.origin);
    expect(discover.status).toBe(0);
    expect(discover.stdout).toContain("listJobApplications");
    expect(discover.stdout).not.toMatch(/BudgetReceipt|\/budgeting\/receipts/);
    const path = ["--path", JSON.stringify({ id: applicationId })];
    const attempts = [
      ["getBudgetReceiptOriginal", "--help"],
      ["getBudgetReceipt", ...path, "--query", '{"reveal":"yes"}'],
      ["getBudgetReceiptOriginal", ...path],
    ];
    for (const args of attempts) {
      const result = await quantself(args, server.url.origin);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({ error: "usage", message: expect.stringContaining("Unknown command") });
    }
    expect(calls).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test("the checkout command sends generated Jobs and To-Do requests to the configured origin", async () => {
  const posting = {
    company: "Example Studio", role: "Web Engineer",
    track: "web", sourceUrl: "https://example.com/jobs/123", postingText: "Build internal web tools.",
  };
  const patch = { expectedRevision: 3, summaryMarkdown: "Built internal web tools." };
  const dateRange = { from: "2026-11-16", through: "2026-11-22", timeZone: "America/Halifax" };
  const habitRange = { from: dateRange.from, to: dateRange.through };
  const handBack = { todoId: "I_fixture", commandId: crypto.randomUUID(), expectedRevision: 2,
    handBack: { kind: "question", question: "Which version?", choices: ["Draft", "Final"] } };
  const calls: Array<{ method: string; path: string; query: object; key: string | null; body: unknown }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("X-API-Key") !== apiKey) return Response.json({}, { status: 401 });
      const url = new URL(request.url);
      const key = request.headers.get("Idempotency-Key");
      const body = request.body ? await request.json() : null;
      calls.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), key, body });
      switch (url.pathname) {
        case "/api/v1/jobs/applications/import":
          return Response.json({ imported: 1, duplicates: 0 });
        case jobPath:
          return Response.json({ message: "The Owner edited this application within the last 3 minutes. Try again later." }, { status: 409 });
        case "/api/v1/todos":
          return Response.json({ todos: [{ fixed: true, number: 42 }] });
        case "/api/v1/todos/42/hand-back":
          return Response.json({ delegation: { revision: 3, state: "waiting_on_owner" } });
        case "/api/v1/habits/calendar":
          return Response.json({ blocks: [], stale: false, error: null });
        default:
          return Response.json({}, { status: 404 });
      }
    },
  });

  try {
    const origin = server.url.origin;
    const imported = await quantself(["importJobApplications", "--idempotency-key", "smoke-import", "--body", JSON.stringify({ applications: [posting] })], origin);
    expect(imported.status).toBe(0);
    expect(imported.stdout).toBe('{"imported":1,"duplicates":0}\n');
    expect(imported.stderr).toBe("");

    const denied = await quantself(["patchJobApplication", "--idempotency-key", "smoke-edit", "--path", JSON.stringify({ id: applicationId }), "--body", JSON.stringify(patch)], origin);
    expect(denied.status).toBe(1);
    expect(denied.stdout).toBe("");
    expect(denied.stderr).toMatch(/^[^\n]+\n$/);
    expect(JSON.parse(denied.stderr)).toMatchObject({ status: 409, action: expect.stringContaining("three minutes") });

    const todos = await quantself(["listTodos", "--query", JSON.stringify(dateRange)], origin);
    expect(todos.status).toBe(0);
    expect(JSON.parse(todos.stdout)).toEqual({ todos: [{ fixed: true, number: 42 }] });

    const habits = await quantself(["getHabitCalendar", "--query", JSON.stringify(habitRange)], origin);
    expect(habits.status).toBe(0);
    expect(JSON.parse(habits.stdout)).toEqual({ blocks: [], stale: false, error: null });

    const submitted = await quantself(["submitTodoHandBack", "--path", '{"number":42}', "--body", JSON.stringify(handBack)], origin);
    expect(submitted.status).toBe(0);
    expect(JSON.parse(submitted.stdout)).toMatchObject({ delegation: { state: "waiting_on_owner" } });

    expect(calls).toEqual([
      { method: "POST", path: "/api/v1/jobs/applications/import", query: {}, key: "smoke-import", body: { applications: [posting] } },
      { method: "PATCH", path: jobPath, query: {}, key: "smoke-edit", body: patch },
      { method: "GET", path: "/api/v1/todos", query: dateRange, key: null, body: null },
      { method: "GET", path: "/api/v1/habits/calendar", query: habitRange, key: null, body: null },
      { method: "POST", path: "/api/v1/todos/42/hand-back", query: {}, key: null, body: handBack },
    ]);
  } finally {
    await server.stop(true);
  }
});

test("the checkout command leaves the key at the configured origin on redirect", async () => {
  let sinkRequests = 0;
  const sink = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch() {
      sinkRequests++;
      return Response.json({});
    },
  });
  try {
    const origin = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => Response.redirect(sink.url.href, 307),
    });
    try {
      const result = await quantself(["listTodos"], origin.url.origin);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: "redirect", status: 307 });
      expect(sinkRequests).toBe(0);
    } finally {
      await origin.stop(true);
    }
  } finally {
    await sink.stop(true);
  }
});
