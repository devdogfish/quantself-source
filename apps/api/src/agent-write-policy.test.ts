import { expect, test } from "bun:test";
import type { AccessContext } from "@quantself/auth";
import { createApp } from "./app";

const owner = { id: "owner", name: "Owner", email: "owner@example.com" };
const agent = {
  owner,
  client: { kind: "agent", id: "agent", name: "Sam", avatar: null },
  permissions: ["jobs:read", "jobs:write", "todos:write"],
} satisfies AccessContext;

test("scoped Agent reads work and unreviewed writes stop before reaching handlers", async () => {
  let writes = 0;
  const app = createApp({
    unsafeSkipContractValidationForTests: true,
    resolveAccessContext: async headers => headers.has("x-api-key")
      ? agent
      : { ...agent, client: { id: "legacy-key", name: "Import", kind: "api-key" } },
    emitAccessLog: () => {},
    registerRoutes: api => {
      api.post("/api/v1/test-action", context => {
        writes++;
        return context.json({ ok: true });
      });
    },
  });

  const headers = { "x-api-key": "agent-key" };
  const read = await app.request("/api/v1/access-context", { headers });
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ client: agent.client });
  const importResponse = await app.request("/api/v1/jobs/applications/import", { method: "POST", headers });
  expect(importResponse.status).toBe(403);
  expect(await importResponse.json()).toMatchObject({ code: "FORBIDDEN" });
  const write = await app.request("/api/v1/test-action", { method: "POST", headers });
  expect(write.status).toBe(403);
  expect(writes).toBe(0);
  expect((await app.request("/api/v1/test-action", { method: "POST" })).status).toBe(200);
  expect(writes).toBe(1);
});
