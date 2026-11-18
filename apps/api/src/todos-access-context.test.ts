import { expect, test } from "bun:test";
import {
  resolveAccessContext,
  resolveApiKeyPermissions,
} from "@quantself/auth";
import { createApp } from "./app";

test("public discovery preserves an explicit to-do-only Client grant", async () => {
  const app = createApp({
    emitAccessLog: () => {},
    resolveAccessContext: (headers) => resolveAccessContext(headers, {
      findOwnerByUserId: async (userId) => ({
        userId,
        user: { id: userId, email: "owner@example.com", name: "Owner" },
      }),
      findExistingOwner: async () => null,
      verifyApiKey: async () => ({
        id: "todo-reader",
        name: "To-Do reader",
        permissions: resolveApiKeyPermissions({
          preset: "custom",
          permissionIds: ["todos:read"],
        }),
        referenceId: "owner",
      }),
    }),
  });

  const response = await app.request("/api/v1/access-context", {
    headers: { "x-api-key": "synthetic-test-key" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    client: { id: "todo-reader", kind: "api-key" },
    permissions: ["todos:read"],
  });
});
