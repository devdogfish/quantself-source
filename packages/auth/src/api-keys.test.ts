import { describe, expect, test } from "bun:test";
import { flattenApiKeyPermissions } from "./access-context";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  resolveApiKeyPermissions,
  rotateApiKey,
} from "./api-keys";

const CREATED_AT = new Date("2026-07-28T10:00:00.000Z");
const UPDATED_AT = new Date("2026-07-28T10:05:00.000Z");
const LAST_REQUEST_AT = new Date("2026-07-28T10:06:00.000Z");
const NOW = new Date("2026-07-28T10:00:00.000Z");

describe("resolveApiKeyPermissions", () => {
  test("grants the booking scope only to explicitly scoped keys", () => {
    expect(resolveApiKeyPermissions({
      preset: "custom",
      permissionIds: ["meetings:book", "notes:book", "meetings:approve"],
    })).toEqual({ meetings: ["book"] });
    expect(resolveApiKeyPermissions({
      preset: "custom",
      permissionIds: ["meetings:read", "meetings:write"],
    })).toEqual({ meetings: ["read", "write"] });
    expect(resolveApiKeyPermissions({ preset: "maintainer" })).not.toHaveProperty("meetings");
  });

  test("grants to-do read independently and reserves execution approval", () => {
    expect(resolveApiKeyPermissions({
      preset: "custom",
      permissionIds: ["todos:read"],
    })).toEqual({ todos: ["read"] });
    for (const action of ["write", "approve", "delete"] as const) {
      expect(resolveApiKeyPermissions({
        preset: "custom",
        permissionIds: [`todos:${action}`],
      })).toEqual({ todos: [action] });
    }
    expect(() => resolveApiKeyPermissions({
      preset: "custom",
      permissionIds: ["inventory:approve"],
    })).toThrow("Select at least one custom permission.");
  });

  test("expands reader, editor, and maintainer presets to explicit permissions", () => {
    expect(resolveApiKeyPermissions({ preset: "reader" })).toEqual({
      health: ["read"],
      inventory: ["read"],
      notes: ["read"],
    });
    expect(resolveApiKeyPermissions({ preset: "editor" })).toEqual({
      health: ["read", "write"],
      inventory: ["read", "write"],
      notes: ["read", "write"],
    });
    expect(resolveApiKeyPermissions({ preset: "maintainer" })).toEqual({
      health: ["delete", "read", "write"],
      inventory: ["delete", "read", "write"],
      notes: ["delete", "read", "write"],
    });
  });

  test("deduplicates custom cross-domain permissions and keeps delete independent", () => {
    expect(
      resolveApiKeyPermissions({
        preset: "custom",
        permissionIds: [
          "health:delete",
          "notes:delete",
          "inventory:write",
          "inventory:read",
          "inventory:write",
        ],
      }),
    ).toEqual({
      health: ["delete"],
      inventory: ["read", "write"],
      notes: ["delete"],
    });
  });
});

describe("createApiKey", () => {
  test("returns the full secret once and verifies stored hashing", async () => {
    const expiresAt = new Date("2026-07-29T10:00:00.000Z");
    const created = await createApiKey(
      {
        expiresAt,
        name: "CLI install",
        preset: "editor",
        userId: "owner",
      },
      {
        createApiKey: async (input) => {
          expect(input).toMatchObject({
            expiresIn: 24 * 60 * 60,
            metadata: { preset: "editor" },
            name: "CLI install",
            permissions: {
              health: ["read", "write"],
              inventory: ["read", "write"],
              notes: ["read", "write"],
            },
            prefix: "qs_key_",
          });

          return {
            createdAt: CREATED_AT,
            enabled: true,
            expiresAt,
            id: "key-1",
            key: "qs_key_abcd1234secret",
            lastRefillAt: null,
            lastRequest: null,
            metadata: { preset: "editor" },
            name: "CLI install",
            permissions: {
              health: ["read", "write"],
              inventory: ["read", "write"],
              notes: ["read", "write"],
            },
            prefix: "qs_key_",
            rateLimitEnabled: true,
            rateLimitMax: null,
            rateLimitTimeWindow: null,
            referenceId: "owner",
            refillAmount: null,
            refillInterval: null,
            remaining: null,
            requestCount: 0,
            start: "qs_key_abcd12",
            updatedAt: UPDATED_AT,
          };
        },
        findStoredApiKeyById: async () => ({
          id: "key-1",
          key: "4f6b5ca0b7ef62c1af9b4eaa0ab0b2cc",
        }),
      },
      { now: () => NOW },
    );

    expect(created.secret).toBe("qs_key_abcd1234secret");
    expect(created.credential).toMatchObject({
      expiresAt,
      id: "key-1",
      maskedKey: "qs_key_abcd12...",
      name: "CLI install",
      preset: "editor",
      permissions: [
        "health:read",
        "health:write",
        "inventory:read",
        "inventory:write",
        "notes:read",
        "notes:write",
      ],
      status: "active",
    });
    expect(
      flattenApiKeyPermissions(
        JSON.stringify({
          health: ["read", "write"],
          inventory: ["read", "write"],
          notes: ["read", "write"],
        }),
      ),
    ).toEqual(created.credential.permissions);
  });

  test("rejects plaintext persistence", async () => {
    await expect(
      createApiKey(
        {
          name: "Unsafe key",
          preset: "reader",
          userId: "owner",
        },
        {
          createApiKey: async () => ({
            createdAt: CREATED_AT,
            enabled: true,
            expiresAt: null,
            id: "key-unsafe",
            key: "qs_key_plaintext",
            lastRefillAt: null,
            lastRequest: null,
            metadata: { preset: "reader" },
            name: "Unsafe key",
            permissions: {
              health: ["read"],
              inventory: ["read"],
              notes: ["read"],
            },
            prefix: "qs_key_",
            rateLimitEnabled: true,
            rateLimitMax: null,
            rateLimitTimeWindow: null,
            referenceId: "owner",
            refillAmount: null,
            refillInterval: null,
            remaining: null,
            requestCount: 0,
            start: "qs_key_plain",
            updatedAt: UPDATED_AT,
          }),
          findStoredApiKeyById: async () => ({
            id: "key-unsafe",
            key: "qs_key_plaintext",
          }),
        },
        { now: () => NOW },
      ),
    ).rejects.toThrow("API key storage must stay hashed.");
  });
});

describe("listApiKeys", () => {
  test("returns safe metadata without the full key", async () => {
    const credentials = await listApiKeys(
      { userId: "owner" },
      {
        listApiKeys: async () => ({
          apiKeys: [
            {
              createdAt: CREATED_AT,
              enabled: true,
              expiresAt: null,
              id: "key-1",
              lastRefillAt: null,
              lastRequest: LAST_REQUEST_AT,
              metadata: { preset: "custom" },
              name: "MCP server",
              permissions: {
                health: ["delete"],
                inventory: ["read", "write"],
                notes: ["delete"],
              },
              prefix: "qs_key_",
              rateLimitEnabled: true,
              rateLimitMax: null,
              rateLimitTimeWindow: null,
              referenceId: "owner",
              refillAmount: null,
              refillInterval: null,
              remaining: null,
              requestCount: 3,
              start: "qs_key_abcd12",
              updatedAt: UPDATED_AT,
            },
          ],
        }),
      },
      { now: () => NOW },
    );

    expect(credentials).toEqual([
      {
        createdAt: CREATED_AT,
        expiresAt: null,
        id: "key-1",
        lastRequestAt: LAST_REQUEST_AT,
        maskedKey: "qs_key_abcd12...",
        name: "MCP server",
        preset: "custom",
        replacementCredentialId: null,
        revokedAt: null,
        rotatedFromCredentialId: null,
        rotationOverlapEndsAt: null,
        permissions: [
          "health:delete",
          "inventory:read",
          "inventory:write",
          "notes:delete",
        ],
        status: "active",
      },
    ]);
    expect("secret" in credentials[0]!).toBeFalse();
  });

  test("distinguishes disabled, expired, rotating, and revoked summaries", async () => {
    const credentials = await listApiKeys(
      { userId: "owner" },
      {
        listApiKeys: async () => ({
          apiKeys: [
            {
              createdAt: CREATED_AT,
              enabled: false,
              expiresAt: null,
              id: "disabled-key",
              lastRequest: null,
              metadata: { preset: "reader" },
              name: "Disabled key",
              permissions: {
                inventory: ["read"],
                notes: ["read"],
              },
              prefix: "qs_key_",
              start: "qs_key_disabl",
              updatedAt: UPDATED_AT,
            },
            {
              createdAt: CREATED_AT,
              enabled: true,
              expiresAt: new Date("2026-07-28T09:59:00.000Z"),
              id: "expired-key",
              lastRequest: LAST_REQUEST_AT,
              metadata: { preset: "editor" },
              name: "Expired key",
              permissions: {
                inventory: ["read", "write"],
                notes: ["read", "write"],
              },
              prefix: "qs_key_",
              start: "qs_key_expire",
              updatedAt: UPDATED_AT,
            },
            {
              createdAt: CREATED_AT,
              enabled: true,
              expiresAt: new Date("2026-07-28T10:15:00.000Z"),
              id: "rotating-key",
              lastRequest: LAST_REQUEST_AT,
              metadata: {
                preset: "editor",
                replacementCredentialId: "replacement-key",
                revokedReason: "rotation",
                rotationOverlapEndsAt: new Date("2026-07-28T10:15:00.000Z"),
              },
              name: "Rotating key",
              permissions: {
                inventory: ["read", "write"],
                notes: ["read", "write"],
              },
              prefix: "qs_key_",
              start: "qs_key_rotate",
              updatedAt: UPDATED_AT,
            },
            {
              createdAt: CREATED_AT,
              enabled: false,
              expiresAt: new Date("2026-07-28T10:15:00.000Z"),
              id: "revoked-key",
              lastRequest: LAST_REQUEST_AT,
              metadata: {
                preset: "editor",
                revokedAt: new Date("2026-07-28T10:01:00.000Z"),
                revokedReason: "manual",
              },
              name: "Revoked key",
              permissions: {
                inventory: ["read", "write"],
                notes: ["read", "write"],
              },
              prefix: "qs_key_",
              start: "qs_key_revokd",
              updatedAt: UPDATED_AT,
            },
          ],
        }),
      },
      { now: () => new Date("2026-07-28T10:05:00.000Z") },
    );

    expect(credentials.map((credential) => credential.status)).toEqual([
      "disabled",
      "expired",
      "rotating",
      "revoked",
    ]);
    expect(credentials[2]?.rotationOverlapEndsAt).toEqual(
      new Date("2026-07-28T10:15:00.000Z"),
    );
    expect(credentials[3]?.revokedAt).toEqual(
      new Date("2026-07-28T10:01:00.000Z"),
    );
  });
});

describe("revokeApiKey", () => {
  test("marks a credential revoked without returning its secret", async () => {
    let updatedInput: Record<string, unknown> | null = null;

    const credential = await revokeApiKey(
      {
        credentialId: "key-1",
        userId: "owner",
      },
      {
        createApiKey: async () => {
          throw new Error("not used");
        },
        findStoredApiKeyById: async () => {
          throw new Error("not used");
        },
        findOwnedApiKey: async () => ({
          createdAt: CREATED_AT,
          enabled: true,
          expiresAt: null,
          id: "key-1",
          lastRequest: LAST_REQUEST_AT,
          metadata: { preset: "editor" },
          name: "MCP server",
          permissions: {
            inventory: ["read", "write"],
            notes: ["read", "write"],
          },
          prefix: "qs_key_",
          start: "qs_key_abcd12",
          updatedAt: UPDATED_AT,
        }),
        updateApiKey: async (input) => {
          updatedInput = input;

          return {
            createdAt: CREATED_AT,
            enabled: false,
            expiresAt: null,
            id: "key-1",
            lastRequest: LAST_REQUEST_AT,
            metadata: {
              preset: "editor",
              revokedAt: "2026-07-28T10:00:00.000Z",
              revokedReason: "manual",
            },
            name: "MCP server",
            permissions: {
              inventory: ["read", "write"],
              notes: ["read", "write"],
            },
            prefix: "qs_key_",
            start: "qs_key_abcd12",
            updatedAt: UPDATED_AT,
          };
        },
      },
      { now: () => NOW },
    );

    expect(updatedInput).toMatchObject({
      enabled: false,
      keyId: "key-1",
      metadata: {
        preset: "editor",
        revokedAt: "2026-07-28T10:00:00.000Z",
        revokedReason: "manual",
      },
    });
    expect(credential.status).toBe("revoked");
    expect("secret" in credential).toBeFalse();
  });
});

describe("rotateApiKey", () => {
  test("creates a replacement secret once and leaves the old key in overlap", async () => {
    const updatedInputs: Array<Record<string, unknown>> = [];

    const rotated = await rotateApiKey(
      {
        credentialId: "key-1",
        overlapMinutes: 15,
        userId: "owner",
      },
      {
        createApiKey: async (input) => {
          expect(input).toMatchObject({
            expiresIn: 15 * 60,
            metadata: {
              preset: "editor",
              rotatedFromCredentialId: "key-1",
            },
            name: "MCP server",
          });

          return {
            createdAt: CREATED_AT,
            enabled: true,
            expiresAt: new Date("2026-07-28T10:15:00.000Z"),
            id: "key-2",
            key: "qs_key_rotatedsecret",
            lastRequest: null,
            metadata: {
              preset: "editor",
              rotatedFromCredentialId: "key-1",
            },
            name: "MCP server",
            permissions: {
              inventory: ["read", "write"],
              notes: ["read", "write"],
            },
            prefix: "qs_key_",
            start: "qs_key_rotate2",
            updatedAt: UPDATED_AT,
          };
        },
        findStoredApiKeyById: async () => ({
          id: "key-2",
          key: "hashed-key-2",
        }),
        findOwnedApiKey: async () => ({
          createdAt: CREATED_AT,
          enabled: true,
          expiresAt: new Date("2026-07-29T10:00:00.000Z"),
          id: "key-1",
          lastRequest: LAST_REQUEST_AT,
          metadata: { preset: "editor" },
          name: "MCP server",
          permissions: {
            inventory: ["read", "write"],
            notes: ["read", "write"],
          },
          prefix: "qs_key_",
          start: "qs_key_abcd12",
          updatedAt: UPDATED_AT,
        }),
        updateApiKey: async (input) => {
          updatedInputs.push(input);

          return input.keyId === "key-1"
            ? {
                createdAt: CREATED_AT,
                enabled: true,
                expiresAt: new Date("2026-07-28T10:15:00.000Z"),
                id: "key-1",
                lastRequest: LAST_REQUEST_AT,
                metadata: {
                  preset: "editor",
                  replacementCredentialId: "key-2",
                  revokedReason: "rotation",
                  rotationOverlapEndsAt: "2026-07-28T10:15:00.000Z",
                },
                name: "MCP server",
                permissions: {
                  inventory: ["read", "write"],
                  notes: ["read", "write"],
                },
                prefix: "qs_key_",
                start: "qs_key_abcd12",
                updatedAt: UPDATED_AT,
              }
            : {
                createdAt: CREATED_AT,
                enabled: true,
                expiresAt: new Date("2026-07-29T10:00:00.000Z"),
                id: "key-2",
                lastRequest: null,
                metadata: {
                  preset: "editor",
                  rotatedFromCredentialId: "key-1",
                },
                name: "MCP server",
                permissions: {
                  inventory: ["read", "write"],
                  notes: ["read", "write"],
                },
                prefix: "qs_key_",
                start: "qs_key_rotate2",
                updatedAt: UPDATED_AT,
              };
        },
      },
      { now: () => NOW },
    );

    expect(updatedInputs).toEqual([
      expect.objectContaining({
        expiresIn: 15 * 60,
        keyId: "key-1",
        metadata: {
          preset: "editor",
          replacementCredentialId: "key-2",
          revokedReason: "rotation",
          rotationOverlapEndsAt: "2026-07-28T10:15:00.000Z",
        },
      }),
      expect.objectContaining({
        expiresIn: 24 * 60 * 60,
        keyId: "key-2",
      }),
    ]);
    expect(rotated.secret).toBe("qs_key_rotatedsecret");
    expect(rotated.credential.status).toBe("active");
    expect(rotated.revokedCredential.status).toBe("rotating");
    expect(rotated.revokedCredential.replacementCredentialId).toBe("key-2");
  });

  test("bounds an undisclosed replacement when shortening the old key fails", async () => {
    let replacementExpiresIn: number | undefined;

    await expect(
      rotateApiKey(
        {
          credentialId: "key-1",
          overlapMinutes: 15,
          userId: "owner",
        },
        {
          createApiKey: async (input) => {
            replacementExpiresIn = input.expiresIn;

            return {
              createdAt: CREATED_AT,
              enabled: true,
              expiresAt: new Date("2026-07-28T10:15:00.000Z"),
              id: "key-2",
              key: "qs_key_undisclosedsecret",
              lastRequest: null,
              metadata: {
                preset: "editor",
                rotatedFromCredentialId: "key-1",
              },
              name: "MCP server",
              permissions: {
                inventory: ["read", "write"],
                notes: ["read", "write"],
              },
              prefix: "qs_key_",
              start: "qs_key_rotate2",
              updatedAt: UPDATED_AT,
            };
          },
          findStoredApiKeyById: async () => ({
            id: "key-2",
            key: "hashed-key-2",
          }),
          findOwnedApiKey: async () => ({
            createdAt: CREATED_AT,
            enabled: true,
            expiresAt: null,
            id: "key-1",
            lastRequest: LAST_REQUEST_AT,
            metadata: { preset: "editor" },
            name: "MCP server",
            permissions: {
              inventory: ["read", "write"],
              notes: ["read", "write"],
            },
            prefix: "qs_key_",
            start: "qs_key_abcd12",
            updatedAt: UPDATED_AT,
          }),
          updateApiKey: async () => {
            throw new Error("database unavailable");
          },
        },
        { now: () => NOW },
      ),
    ).rejects.toThrow("database unavailable");

    expect(replacementExpiresIn).toBe(15 * 60);
  });
});

test("Habits requires custom grants and never silently joins broad API Key presets", () => {
  for (const preset of ["reader", "editor", "maintainer"] as const) {
    expect(resolveApiKeyPermissions({ preset })).not.toHaveProperty("habits");
  }
  expect(resolveApiKeyPermissions({ preset: "custom", permissionIds: ["habits:read", "habits:write"] })).toEqual({ habits: ["read", "write"] });
});

test("Jobs worker grants are explicit and independent from draft writes", () => {
  for (const preset of ["reader", "editor", "maintainer"] as const) {
    expect(resolveApiKeyPermissions({ preset }).jobs).toBeUndefined();
  }
  expect(resolveApiKeyPermissions({ preset: "custom", permissionIds: ["jobs:execute"] })).toEqual({ jobs: ["execute"] });
  expect(resolveApiKeyPermissions({ preset: "custom", permissionIds: ["jobs:revise"] })).toEqual({ jobs: ["revise"] });
  expect(resolveApiKeyPermissions({ preset: "custom", permissionIds: ["jobs:write"] })).toEqual({ jobs: ["write"] });
  expect(resolveApiKeyPermissions({ preset: "custom", permissionIds: ["jobs:import-tailored"] })).toEqual({ jobs: ["import-tailored"] });
});

test("provisioned Agent keys have exactly the requested permissions and a distinct Client identity", async () => {
  const { createAgentApiKey } = await import("./api-keys");
  const created = await createAgentApiKey({
    avatar: "https://example.com/sam.png",
    name: " Sam ",
    permissionIds: ["jobs:read", "todos:write"],
    userId: "owner",
  }, {
    createApiKey: async (input) => ({
      createdAt: CREATED_AT,
      enabled: true,
      expiresAt: null,
      id: "credential-123",
      key: "qs_key_test_secret",
      lastRequest: null,
      metadata: input.metadata,
      name: input.name,
      permissions: input.permissions,
      prefix: input.prefix,
      start: "qs_key_test",
      updatedAt: UPDATED_AT,
    }),
    findStoredApiKeyById: async () => ({ id: "credential-123", key: "hashed-key" }),
  }, { now: () => NOW });

  expect(created).toMatchObject({
    client: { kind: "agent", id: expect.any(String), name: "Sam", avatar: "https://example.com/sam.png" },
    credential: { id: "credential-123", preset: "custom", permissions: ["jobs:read", "todos:write"] },
    secret: "qs_key_test_secret",
  });
  expect(created.client.id).not.toBe(created.credential.id);
});

test("rotation and revocation preserve Agent identity in managed credentials", async () => {
  const agent = { avatar: null, id: "985304a5-6feb-42a3-8247-559c102ff4fa", name: "Sam" };
  const original = {
    createdAt: CREATED_AT,
    enabled: true,
    expiresAt: null,
    id: "original",
    lastRequest: null,
    metadata: { preset: "custom", quantselfAgentClient: agent },
    name: "Sam",
    permissions: { jobs: ["read"] },
    prefix: "qs_key_",
    start: "qs_key_sam",
    updatedAt: UPDATED_AT,
  };
  const credentials = new Map([[original.id, original]]);
  const dependencies: NonNullable<Parameters<typeof rotateApiKey>[1]> = {
    createApiKey: async (input) => {
      const replacement = { ...original, id: "replacement", metadata: input.metadata } as typeof original;
      credentials.set(replacement.id, replacement);
      return { ...replacement, key: "qs_key_replacement_secret" };
    },
    findStoredApiKeyById: async (id) => ({ id, key: "hashed-key" }),
    findOwnedApiKey: async (id) => credentials.get(id) ?? null,
    updateApiKey: async (input) => {
      const prior = credentials.get(input.keyId)!;
      const updated = {
        ...prior,
        enabled: input.enabled ?? prior.enabled,
        metadata: input.metadata ?? prior.metadata,
      } as typeof original;
      credentials.set(updated.id, updated);
      return updated;
    },
  };
  const clock = { now: () => NOW };
  const rotated = await rotateApiKey({ credentialId: "original", overlapMinutes: 15, userId: "owner" }, dependencies, clock);
  expect(rotated.credential).toMatchObject({ agentClient: { ...agent, kind: "agent" }, permissions: ["jobs:read"] });
  expect(rotated.revokedCredential).toMatchObject({ agentClient: { ...agent, kind: "agent" }, status: "rotating" });
  const revoked = await revokeApiKey({ credentialId: "replacement", userId: "owner" }, dependencies, clock);
  expect(revoked).toMatchObject({ agentClient: { ...agent, kind: "agent" }, status: "revoked" });
});
