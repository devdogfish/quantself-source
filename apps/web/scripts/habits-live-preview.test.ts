import { expect, test } from "bun:test";
import { createHabitSnapshotPreview, createLiveHabitPreview } from "./habits-live-preview";

const origin = "http://127.0.0.1:3112";
const local = "http://127.0.0.1:3113";
const access = { owner: { id: "owner", name: "Owner" }, permissions: ["habits:read", "inventory:read"] };

test("snapshot preview preserves captured responses and never substitutes samples or sends writes", async () => {
  const overview = { range: { from: "2026-08-12", to: "2026-11-10" }, habits: [], totals: { votes: 1 } };
  const read = createHabitSnapshotPreview({ capturedAt: "2026-11-10T13:47:00Z", responses: {
    "/api/v1/habits/overview?weeks=13": overview,
    "/api/v1/habits/reviews": { paths: [], next: null },
  } }, origin);
  expect(await read(new Request(`${local}/api/v1/habits/overview?weeks=13`)).json()).toEqual(overview);
  expect(await read(new Request(`${local}/api/v1/habits/reviews?offset=0`)).json()).toEqual({ paths: [], next: null });
  expect(read(new Request(`${local}/api/v1/habits/day?date=2026-11-09`)).status).toBe(404);
  expect(read(new Request(`${local}/api/v1/habits/commands`, { method: "POST" })).status).toBe(405);
  expect(read(new Request(`${local}/api/v1/habits/overview?weeks=13`, { headers: { origin: "https://untrusted.example" } })).status).toBe(403);
});

test("live preview keeps credentials server-side, reads only allowlisted habit routes and preserves upstream failures", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const read = await createLiveHabitPreview({
    apiKey: "test-secret", previewOrigin: origin,
    transport: async (url, init) => {
      calls.push({ url, init });
      return url.endsWith("access-context") ? Response.json(access)
        : Response.json({ message: "Missing habits:read." }, { status: 403, headers: { "set-cookie": "not-for-preview=1" } });
    },
  });
  const context = await (await read(new Request(`${local}/api/v1/access-context`, { headers: { "x-forwarded-host": "127.0.0.1:3112" } }))).json();
  expect(context.owner).toEqual(access.owner);
  expect(context.permissions).toEqual(["habits:read"]);
  expect(JSON.stringify(context)).not.toContain("test-secret");
  const internalContext = await read(new Request(`${local}/api/v1/access-context`, { headers: { "x-forwarded-host": "localhost:3112" } }));
  expect(internalContext.status).toBe(200);
  expect((await internalContext.json()).owner).toEqual(access.owner);
  const response = await read(new Request(`${local}/api/v1/habits/overview?weeks=52`, { headers: { cookie: "local-cookie", "X-API-Key": "untrusted", origin } }));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ message: "Missing habits:read." });
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(calls.map(({ url }) => url)).toEqual([
    "https://dashboard.girke.dev/api/v1/access-context",
    "https://dashboard.girke.dev/api/v1/habits/overview?weeks=52",
  ]);
  expect(calls[1]!.init).toMatchObject({ method: "GET", redirect: "error", headers: { "X-API-Key": "test-secret", Accept: "application/json" } });
  expect(new Headers(calls[1]!.init.headers).has("cookie")).toBe(false);

  for (const [url, init, status] of [
    [`${local}/api/v1/habits/commands`, { method: "POST" }, 405],
    [`${local}/api/v1/habits/slips`, { method: "DELETE" }, 405],
    [`${local}/api/v1/inventory-items`, {}, 404],
    [`${local}/api/v1/habits/overview`, { headers: { origin: "https://untrusted.example" } }, 403],
    [`${local}/api/v1/habits/overview`, { headers: { "sec-fetch-site": "cross-site" } }, 403],
    ["http://untrusted.example:3113/api/v1/habits/overview", {}, 403],
    [`${local}/api/v1/habits/overview`, { headers: { "x-forwarded-host": "untrusted.example:3112" } }, 403],
    [`${local}/api/v1/habits/overview`, { headers: { "x-forwarded-host": "127.0.0.1:9999" } }, 403],
    [`${local}/api/v1/habits/overview`, { headers: { "x-forwarded-host": "localhost:9999" } }, 403],
  ] as const) expect((await read(new Request(url, init))).status).toBe(status);
  expect(calls).toHaveLength(2); // Neither writes nor unrelated/cross-site reads reach production.
});

test("live preview fails clearly for invalid credentials and never falls back to sample data", async () => {
  await expect(createLiveHabitPreview({ apiKey: undefined, previewOrigin: origin })).rejects.toThrow("Configure QUANTSELF_API_KEY");
  await expect(createLiveHabitPreview({ apiKey: "test", previewOrigin: origin, transport: async () => new Response(null, { status: 401 }) })).rejects.toThrow("Production authentication failed (401)");
  const read = await createLiveHabitPreview({
    apiKey: "test", previewOrigin: origin,
    transport: async (url) => { if (url.endsWith("access-context")) return Response.json(access); throw Error("network unavailable"); },
  });
  const response = await read(new Request(`${local}/api/v1/habits/overview?weeks=13`));
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ message: "Production habits unavailable. Retry when the connection recovers." });
});


test("writable preview requires scoped setup and forwards only authorized JSON writes unchanged", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const handler = await createLiveHabitPreview({ apiKey: undefined, previewOrigin: origin, writable: true, transport: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("access-context")) return Response.json(new Headers(init.headers).get("X-API-Key") === "limited" ? access : { ...access, permissions: [...access.permissions, "habits:write"] });
    return Response.json({ message: "conflict", revision: 2 }, { status: 409, headers: { "set-cookie": "private=1" } });
  } });
  const setup = `${local}/api/v1/habits/preview-setup`;
  const submit = (apiKey: string, headers: Record<string, string> = { origin, "content-type": "application/json" }) => handler(new Request(setup, { method: "POST", headers, body: JSON.stringify({ apiKey }) }));
  expect((await handler(new Request(setup))).status).toBe(200);
  expect((await handler(new Request(`${local}/api/v1/habits/overview`))).status).toBe(503);
  expect((await submit("limited")).status).toBe(400);
  expect((await submit("secret", { "content-type": "application/json" })).status).toBe(403);
  expect((await submit("secret")).status).toBe(200);
  expect((await submit("other")).status).toBe(403);
  const context = await (await handler(new Request(`${local}/api/v1/access-context`))).json();
  expect(context.permissions).toEqual(["habits:read", "habits:write"]);
  expect(JSON.stringify(context)).not.toContain("secret");
  const body = JSON.stringify({ commandId: "same-id", before: "open", after: "done" });
  const response = await handler(new Request(`${local}/api/v1/habits/commands`, { method: "POST", headers: { origin, "content-type": "application/json", cookie: "private", authorization: "Bearer bad" }, body }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ message: "conflict", revision: 2 });
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(calls.at(-1)!.init.body).toBe(body);
  expect(calls.at(-1)!.init.redirect).toBe("error");
  expect(new Headers(calls.at(-1)!.init.headers).get("X-API-Key")).toBe("secret");
  expect(new Headers(calls.at(-1)!.init.headers).has("cookie")).toBe(false);
  expect(new Headers(calls.at(-1)!.init.headers).has("authorization")).toBe(false);
  for (const [path, method, headers, status] of [
    ["/api/v1/habits/commands", "POST", { "content-type": "application/json" }, 403],
    ["/api/v1/habits/commands", "POST", { origin, "content-type": "text/plain" }, 403],
    ["/api/v1/habits/commands?unexpected=1", "POST", { origin, "content-type": "application/json" }, 405],
    ["/api/v1/habits/definitions", "POST", { origin, "content-type": "application/json" }, 405],
    ["/api/v1/habits/slips", "DELETE", { origin }, 405],
    ["/api/v1/habits/slips", "POST", { origin, "content-type": "application/json" }, 405],
  ] as const) expect((await handler(new Request(`${local}${path}`, { method, headers }))).status).toBe(status);
  expect(calls).toHaveLength(3);
});


test("writable preview recovers to setup when the configured key lacks grants", async () => {
  const handler = await createLiveHabitPreview({ apiKey: "limited", previewOrigin: origin, writable: true, transport: async () => Response.json(access) });
  expect((await handler(new Request(`${local}/api/v1/habits/preview-setup`))).status).toBe(200);
  expect((await handler(new Request(`${local}/api/v1/access-context`))).status).toBe(503);
});

test("Ask relay retains idempotency keys and only forwards in explicitly writable preview", async () => {
  const calls: RequestInit[] = [];
  const handler = await createLiveHabitPreview({ apiKey: "key", previewOrigin: origin, writable: true, transport: async (url, init) => {
    if (url.endsWith("access-context")) return Response.json({ ...access, permissions: ["habits:read", "habits:write"] });
    calls.push(init); return Response.json({ answer: "One step" });
  } });
  const body = JSON.stringify({ habitId: "walk", text: "Tired" });
  const request = () => new Request(`${local}/api/v1/habits/ask`, { method: "POST", body, headers: { origin, "content-type": "application/json", "idempotency-key": "stable-id" } });
  expect((await handler(request())).status).toBe(200); expect((await handler(request())).status).toBe(200);
  expect(calls).toHaveLength(2); expect(new Headers(calls[0]!.headers).get("idempotency-key")).toBe("stable-id"); expect(calls[0]!.body).toBe(body);
  const readonly = await createLiveHabitPreview({ apiKey: "key", previewOrigin: origin, transport: async () => Response.json(access) });
  expect((await readonly(request())).status).toBe(405);
});
