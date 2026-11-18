import { expect, test } from "bun:test";
import type { CommandDefinition } from "./command.ts";
import { runCli } from "./runtime.ts";

const commands: CommandDefinition[] = [
  {
    name: "readExample", method: "GET", path: "/api/v1/example/{id}", summary: "Read an example",
    permissions: ["example:read"],
    parameters: [
      { name: "id", in: "path", required: true },
      { name: "filter", in: "query", required: false },
      { name: "tag", in: "query", required: false, schema: { type: "array" } },
    ],
  },
  {
    name: "writeExample", method: "POST", path: "/api/v1/example", summary: "Create an example",
    parameters: [{ name: "idempotency-key", in: "header", required: true, schema: { maxLength: 200 } }],
    body: { required: true, schema: { type: "object" } },
  },
  {
    name: "reviewExample", method: "POST", path: "/api/v1/example/review", summary: "Review an example",
    parameters: [], body: { required: true, schema: { type: "object" } },
  },
];

const key = "qs_key_example";
const environment = { QUANTSELF_API_KEY: key, QUANTSELF_API_URL: "https://example.test" };
const readArgs = ["readExample", "--path", '{"id":123}'];
const writeArgs = ["writeExample", "--body", '{ "example": true }', "--idempotency-key", "stable-123"];

async function invoke(
  args: string[],
  reply: () => Response = () => Response.json({ ok: true }),
  env: Record<string, string | undefined> = environment,
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Request[] = [];
  const exitCode = await runCli(args, commands, {
    env,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    fetch: (async (url, options) => {
      requests.push(url instanceof Request ? new Request(url, options) : new Request(String(url), options));
      return reply();
    }) as typeof globalThis.fetch,
  });
  return { exitCode, stdout, stderr, requests };
}

test("discovers commands and command input without credentials or a network request", async () => {
  const help = await invoke(["--help"], undefined, {});
  expect(help.exitCode).toBe(0);
  expect(help.requests).toHaveLength(0);
  expect(JSON.parse(help.stdout[0]).commands).toEqual([
    { name: "readExample", summary: "Read an example" },
    { name: "writeExample", summary: "Create an example" },
    { name: "reviewExample", summary: "Review an example" },
  ]);

  const detail = await invoke(["writeExample", "--help"], undefined, {});
  expect(detail.requests).toHaveLength(0);
  expect(JSON.parse(detail.stdout[0])).toMatchObject({
    options: { "--body": expect.any(String), "--idempotency-key": expect.any(String) },
    body: { schema: { type: "object" } },
  });
});

test("encodes path and query and makes one request with the environment key", async () => {
  const result = await invoke([
    "readExample", "--path", '{"id":"x/y #"}',
    "--query", '{"filter":"a&b","tag":["parent","child"]}',
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toEqual([]);
  expect(result.stdout).toEqual(['{"ok":true}\n']);
  expect(result.requests).toHaveLength(1);
  const request = result.requests[0];
  expect(request.url).toBe("https://example.test/api/v1/example/x%2Fy%20%23?filter=a%26b&tag=parent&tag=child");
  expect(request.headers.get("X-API-Key")).toBe(key);
  expect(request.redirect).toBe("manual");
});

test("sends the supplied idempotency key and JSON body verbatim and never retries", async () => {
  const result = await invoke(writeArgs, () => {
    throw new Error(`could not send ${key}`);
  });
  expect(result.requests).toHaveLength(1);
  const request = result.requests[0];
  expect(request.method).toBe("POST");
  expect(request.headers.get("idempotency-key")).toBe("stable-123");
  expect(request.headers.get("content-type")).toBe("application/json");
  expect(await request.text()).toBe('{ "example": true }');
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toEqual([]);
  expect(result.stderr[0]).toContain("original idempotency key");
  expect(result.stderr[0]).not.toContain(key);

  const latinKey = await invoke([...writeArgs.slice(0, -1), "--café"]);
  expect(latinKey.exitCode).toBe(0);
  expect(latinKey.requests[0].headers.get("idempotency-key")).toBe("--café");
});

test("rejects unsafe origins, traversal, undocumented options and missing required input before fetching", async () => {
  const cases = [
    { args: readArgs, env: {} },
    { args: readArgs, env: { ...environment, QUANTSELF_API_URL: "http://example.test" } },
    { args: readArgs, env: { ...environment, QUANTSELF_API_URL: "https://user:password@example.test" } },
    { args: ["readExample", "--path", '{"id":".."}'] },
    { args: [...readArgs, "--query", '{"filter":null}'] },
    { args: [...readArgs, "--query", '{"filter":[1]}'] },
    { args: [...readArgs, "--headers", '{"X-API-Key":"other"}'] },
    { args: [...readArgs, "--idempotency-key", "stable-123"] },
    { args: ["writeExample", "--body", "{}"] },
    { args: ["writeExample", "--idempotency-key", "stable-123"] },
  ];
  for (const { args, env } of cases) {
    const result = await invoke(args, undefined, env);
    expect(result.exitCode).toBe(1);
    expect(result.requests).toHaveLength(0);
    expect(JSON.parse(result.stderr[0]).error).toBe("usage");
    expect(result.stderr[0]).not.toContain(key);
  }
});

test("rejects redirects without following or printing the location", async () => {
  const result = await invoke(readArgs, () => Response.redirect(`https://other.test/path?token=${key}`));
  expect(result.exitCode).toBe(1);
  expect(result.requests).toHaveLength(1);
  expect(result.stdout).toEqual([]);
  expect(JSON.parse(result.stderr[0])).toMatchObject({ error: "redirect", status: 302 });
  expect(result.stderr[0]).not.toContain("other.test");
  expect(result.stderr[0]).not.toContain(key);
});

test("reports authentication, permission, conflict, hands-off and rate limit actions in JSON", async () => {
  const cases = [
    { status: 401, message: "Unauthorized", hint: "QUANTSELF_API_KEY" },
    { status: 403, message: "Forbidden", hint: "example:read" },
    { status: 403, message: "This operation does not support audited, revision-checked Agent writes with Undo.", hint: "required credential type" },
    { status: 403, message: "An Owner session is required to edit a saved résumé.", hint: "Ask the Owner to review and perform" },
    { status: 409, message: "This application changed. Refresh to review the latest version.", hint: "latest revision" },
    { status: 409, message: "The application has reached its revision limit for reversible edits.", hint: "Resolve the reported conflict" },
    { status: 409, message: "Agents can only edit drafts in progress or awaiting review.", hint: "Leave this record for the Owner" },
    { status: 409, message: "Idempotency-Key was already used.", hint: "identical input" },
    { status: 409, message: "The Owner edited this application within the last 3 minutes.", hint: "Wait until three minutes" },
    { status: 429, message: "Too many requests", hint: "back off", retryAfter: "30" },
  ];
  for (const { status, message, hint, retryAfter } of cases) {
    const result = await invoke(readArgs, () => Response.json({ code: "EXAMPLE", message }, {
      status, headers: retryAfter ? { "Retry-After": retryAfter } : undefined,
    }));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(JSON.parse(result.stderr[0])).toEqual({
      error: "api", status, code: "EXAMPLE", message,
      ...(retryAfter ? { retryAfter } : {}),
      action: expect.stringContaining(hint),
    });
  }
});

test("points to the request body when API validation incorrectly asks for an undocumented key", async () => {
  const reply = () => Response.json({
    code: "INVALID_IDEMPOTENCY_KEY",
    message: "Idempotency-Key header is required and must not exceed 255 characters.",
  }, { status: 400 });
  const review = await invoke(["reviewExample", "--body", "{}"], reply);
  expect(review.exitCode).toBe(1);
  expect(JSON.parse(review.stderr[0])).toMatchObject({
    status: 400, code: "INVALID_REQUEST", message: expect.stringContaining("--body"),
  });
  const write = await invoke(writeArgs, reply);
  expect(JSON.parse(write.stderr[0]).code).toBe("INVALID_IDEMPOTENCY_KEY");
});

test("redacts echoed credentials and handles non-JSON replies", async () => {
  const error = await invoke(readArgs, () => Response.json({ message: `Invalid key: ${key}` }, { status: 400 }));
  expect(JSON.parse(error.stderr[0]).message).toBe("Invalid key: [redacted]");
  const success = await invoke(readArgs, () => Response.json({ [key]: { data: key } }));
  expect(JSON.parse(success.stdout[0])).toEqual({ "[redacted]": { data: "[redacted]" } });
  const proxy = await invoke(readArgs, () => new Response(`<p>${key}</p>`));
  expect(proxy.exitCode).toBe(1);
  expect(JSON.parse(proxy.stderr[0]).error).toBe("invalid_response");
  expect(proxy.stderr[0]).not.toContain(key);
  const empty = await invoke(readArgs, () => new Response(null, { status: 204 }));
  expect(empty.stdout).toEqual(["null\n"]);
});
