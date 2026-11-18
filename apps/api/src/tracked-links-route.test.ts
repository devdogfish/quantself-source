import { expect, test } from "bun:test";
import { createApp } from "./app";

const readToken = "tracked-links-read-credential-for-tests";
const applicationToken = "tracked-links-application-credential-for-tests";
const shareToken = "tracked-links-share-credential-for-tests";
const code = "a".repeat(24);

test("the portfolio can resolve an already-issued code with one lookup and no private fields", async () => {
  const reads: string[] = [];
  const app = createApp({
    emitAccessLog: () => {},
    resolveAccessContext: async () => null,
    trackedLinks: {
      token: (scope: string) => scope === "read" ? readToken : undefined,
      lookup: async (key: string) => {
        reads.push(key);
        if (key === "unavailable") throw new Error("offline");
        return key === code ? { code, kind: "application", track: "backend" } : null;
      },
    },
  });
  const headers = { "X-API-Key": readToken };
  const found = await app.request(`/api/v1/tracked-links/${code}`, { headers });
  expect(found.status).toBe(200);
  expect(await found.json()).toEqual({ code, kind: "application", track: "backend" });
  expect(found.headers.get("cache-control")).toBe("public, max-age=86400");
  expect(found.headers.get("vary")).toBe("X-API-Key");
  expect(reads).toEqual([code]);

  const missing = await app.request("/api/v1/tracked-links/unknown", { headers });
  expect(missing.status).toBe(404);
  expect(missing.headers.get("cache-control")).toBe("no-store");
  expect((await app.request(`/api/v1/tracked-links/${code}`)).status).toBe(401);
  const badKey = await app.request(`/api/v1/tracked-links/${code}`, { headers: { "X-API-Key": shareToken } });
  expect(badKey.status).toBe(401);
  expect(badKey.headers.get("cache-control")).toBe("no-store");
  expect(badKey.headers.get("vary")).toBe("X-API-Key");
  const unavailable = await app.request("/api/v1/tracked-links/unavailable", { headers });
  expect(unavailable.status).toBe(503);
  expect(unavailable.headers.get("cache-control")).toBe("no-store");
  expect((await app.request("/api/v1/access-context", { headers })).status).toBe(401);
  expect(reads).toEqual([code, "unknown", "unavailable"]);
});

test("only the application credential can register an application revision", async () => {
  const app = createApp({
    emitAccessLog: () => {},
    resolveAccessContext: async () => null,
    trackedLinks: {
      token: scope => ({ read: readToken, application: applicationToken, share: shareToken })[scope],
      registerApplication: async (input) => input.revision === 2 ? { code } : null,
    },
  });
  const payload = { applicationId: "49db114d-041b-4e68-a82c-2050a3a47ac5", company: "Example", role: "Developer", track: "backend", revision: 2 };
  function register(token: string, revision: number, track = payload.track) {
    return app.request("/api/v1/tracked-links/applications", {
      method: "POST", headers: { "X-API-Key": token, "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, revision, track }),
    });
  }
  expect((await register(readToken, 2)).status).toBe(401);
  expect((await register(shareToken, 2)).status).toBe(401);
  const first = await register(applicationToken, 2);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ code });
  expect(await (await register(applicationToken, 2)).json()).toEqual({ code });
  expect((await register(applicationToken, 1)).status).toBe(409);
  for (const track of ["devops", "frontend", "full-stack", "software"]) {
    expect((await register(applicationToken, 2, track)).status).toBe(200);
  }
  expect((await register(applicationToken, 2, "client")).status).toBe(400);
});

test("only the share credential can mint an opaque code with an optional track", async () => {
  const shareCode = "k3Vw9QpX";
  const app = createApp({
    emitAccessLog: () => {},
    resolveAccessContext: async () => null,
    trackedLinks: {
      token: scope => ({ read: readToken, application: applicationToken, share: shareToken })[scope],
      registerShare: async () => ({ code: shareCode }),
    },
  });
  const register = (token: string, payload: unknown) => app.request("/api/v1/tracked-links/shares", {
    method: "POST", headers: { "X-API-Key": token, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const title = "Kristina Girke footer";
  expect((await register(applicationToken, { title })).status).toBe(401);
  expect((await register(readToken, { title })).status).toBe(401);
  for (const input of [{ title: " " }, { title, track: "unknown" }, { title, track: "software" }, { title, slug: "footer" }]) {
    expect((await register(shareToken, input)).status).toBe(400);
  }
  for (const input of [{ title }, ...["client", "devops", "frontend", "backend", "full-stack"].map(track => ({ title, track }))]) {
    const response = await register(shareToken, input);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: shareCode });
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
});
