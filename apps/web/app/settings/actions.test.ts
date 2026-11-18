import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

const revalidated: string[] = [];
let ownerSessionAllowed = true;
let createCalls: Array<Record<string, unknown>> = [];
let revokeCalls: Array<Record<string, unknown>> = [];
let rotateCalls: Array<Record<string, unknown>> = [];

mock.module("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidated.push(path);
  },
}));

mock.module("@/lib/owner-session-server", () => ({
  assertOwnerActionSession: async () => {
    if (!ownerSessionAllowed) {
      throw new Error("Authentication required.");
    }

    return {
      session: { id: "session-1" },
      user: {
        email: "owner@quantself.invalid",
        id: "owner",
        name: "Owner",
      },
    };
  },
}));

mock.module("@/lib/owner-api-keys-server", () => ({
  createOwnerApiKey: async (input: Record<string, unknown>) => {
    createCalls.push(input);

    return {
      credential: {
        createdAt: new Date("2026-07-28T10:00:00.000Z"),
        expiresAt: null,
        id: "key-1",
        lastRequestAt: null,
        maskedKey: "qs_key_abcd12...",
        name: "CLI install",
        preset: "editor",
        replacementCredentialId: null,
        revokedAt: null,
        rotatedFromCredentialId: null,
        rotationOverlapEndsAt: null,
        permissions: [
          "inventory:read",
          "inventory:write",
          "notes:read",
          "notes:write",
        ],
        status: "active",
      },
      secret: "qs_key_abcd1234secret",
    };
  },
  loadOwnerApiKeys: async () => [],
  revokeOwnerApiKey: async (input: Record<string, unknown>) => {
    revokeCalls.push(input);

    return {
      createdAt: new Date("2026-07-28T10:00:00.000Z"),
      expiresAt: null,
      id: "key-1",
      lastRequestAt: null,
      maskedKey: "qs_key_abcd12...",
      name: "CLI install",
      preset: "editor",
      replacementCredentialId: null,
      revokedAt: new Date("2026-07-28T10:02:00.000Z"),
      rotatedFromCredentialId: null,
      rotationOverlapEndsAt: null,
      permissions: [
        "inventory:read",
        "inventory:write",
        "notes:read",
        "notes:write",
      ],
      status: "revoked",
    };
  },
  rotateOwnerApiKey: async (input: Record<string, unknown>) => {
    rotateCalls.push(input);

    return {
      credential: {
        createdAt: new Date("2026-07-28T10:03:00.000Z"),
        expiresAt: null,
        id: "key-2",
        lastRequestAt: null,
        maskedKey: "qs_key_rotate2...",
        name: "CLI install",
        preset: "editor",
        replacementCredentialId: null,
        revokedAt: null,
        rotatedFromCredentialId: "key-1",
        rotationOverlapEndsAt: null,
        permissions: [
          "inventory:read",
          "inventory:write",
          "notes:read",
          "notes:write",
        ],
        status: "active",
      },
      revokedCredential: {
        createdAt: new Date("2026-07-28T10:00:00.000Z"),
        expiresAt: new Date("2026-07-28T10:18:00.000Z"),
        id: "key-1",
        lastRequestAt: null,
        maskedKey: "qs_key_abcd12...",
        name: "CLI install",
        preset: "editor",
        replacementCredentialId: "key-2",
        revokedAt: null,
        rotatedFromCredentialId: null,
        rotationOverlapEndsAt: new Date("2026-07-28T10:18:00.000Z"),
        permissions: [
          "inventory:read",
          "inventory:write",
          "notes:read",
          "notes:write",
        ],
        status: "rotating",
      },
      secret: "qs_key_rotatedsecret",
    };
  },
}));

mock.module("@/lib/inventory-enrichment-service", () => ({
  approveInventoryEnrichmentProposal: async () => {},
  rejectInventoryEnrichmentProposal: async () => {},
  updateInventoryEnrichmentSettings: async () => {},
}));

mock.module("@/lib/inventory-prisma-repository", () => ({
  inventoryRepository: {},
}));

afterEach(() => {
  ownerSessionAllowed = true;
  createCalls = [];
  revokeCalls = [];
  rotateCalls = [];
  revalidated.length = 0;
});

afterAll(() => {
  mock.restore();
});

describe("createApiKeyWithStateAction", () => {
  test("creates credentials for the authenticated owner and returns the one-time secret", async () => {
    const { createApiKeyWithStateAction } = await import("./actions");

    const formData = new FormData();
    formData.set("name", "CLI install");
    formData.set("preset", "editor");

    const result = await createApiKeyWithStateAction(
      {
        credential: null,
        message: "",
        secret: null,
        status: "idle",
      },
      formData,
    );

    expect(createCalls).toEqual([
      {
        expiresAt: null,
        name: "CLI install",
        preset: "editor",
        permissionIds: [],
        userId: "owner",
      },
    ]);
    expect(result).toMatchObject({
      credential: {
        id: "key-1",
        maskedKey: "qs_key_abcd12...",
        name: "CLI install",
      },
      message: "API key created.",
      secret: "qs_key_abcd1234secret",
      status: "success",
    });
    expect(revalidated).toEqual(["/settings"]);
  });

  test("creates credentials with an optional expiry window", async () => {
    const { createApiKeyWithStateAction } = await import("./actions");

    const formData = new FormData();
    formData.set("name", "Temporary CLI install");
    formData.set("preset", "reader");
    formData.set("expiresInHours", "48");

    const result = await createApiKeyWithStateAction(
      {
        credential: null,
        message: "",
        secret: null,
        status: "idle",
      },
      formData,
    );

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.name).toBe("Temporary CLI install");
    expect(createCalls[0]?.preset).toBe("reader");
    expect(createCalls[0]?.permissionIds).toEqual([]);
    expect(createCalls[0]?.userId).toBe("owner");
    expect(createCalls[0]?.expiresAt).toBeInstanceOf(Date);
    expect(result.status).toBe("success");
  });

  test("rejects unauthenticated creation attempts", async () => {
    ownerSessionAllowed = false;
    const { createApiKeyWithStateAction } = await import("./actions");

    const formData = new FormData();
    formData.set("name", "CLI install");
    formData.set("preset", "editor");

    const result = await createApiKeyWithStateAction(
      {
        credential: null,
        message: "",
        secret: null,
        status: "idle",
      },
      formData,
    );

    expect(createCalls).toHaveLength(0);
    expect(result).toEqual({
      credential: null,
      message: "Authentication required.",
      secret: null,
      status: "error",
    });
  });

  test("rejects invalid permission presets instead of granting reader access", async () => {
    const { createApiKeyWithStateAction } = await import("./actions");

    const formData = new FormData();
    formData.set("name", "Tampered request");
    formData.set("preset", "unknown");

    const result = await createApiKeyWithStateAction(
      {
        credential: null,
        message: "",
        secret: null,
        status: "idle",
      },
      formData,
    );

    expect(createCalls).toHaveLength(0);
    expect(result).toEqual({
      credential: null,
      message: "Select a valid permission preset.",
      secret: null,
      status: "error",
    });
  });

  test("rejects invalid expiry input", async () => {
    const { createApiKeyWithStateAction } = await import("./actions");

    const formData = new FormData();
    formData.set("name", "Temp key");
    formData.set("preset", "reader");
    formData.set("expiresInHours", "1.5");

    const result = await createApiKeyWithStateAction(
      {
        credential: null,
        message: "",
        secret: null,
        status: "idle",
      },
      formData,
    );

    expect(result).toEqual({
      credential: null,
      message: "Expiry must be a whole number of hours.",
      secret: null,
      status: "error",
    });
  });
});

describe("revokeApiKeyWithStateAction", () => {
  test("revokes an owner credential and revalidates settings", async () => {
    const { revokeApiKeyWithStateAction } = await import("./actions");

    const formData = new FormData();
    formData.set("credentialId", "key-1");

    const result = await revokeApiKeyWithStateAction(
      {
        credential: null,
        message: "",
        status: "idle",
      },
      formData,
    );

    expect(revokeCalls).toEqual([{ credentialId: "key-1", userId: "owner" }]);
    expect(result).toMatchObject({
      credential: {
        id: "key-1",
        status: "revoked",
      },
      message: "API key revoked.",
      status: "success",
    });
    expect(revalidated).toEqual(["/settings"]);
  });
});

describe("rotateApiKeyWithStateAction", () => {
  test("rotates an owner credential with bounded overlap and returns the new secret", async () => {
    const { rotateApiKeyWithStateAction } = await import("./actions");

    const formData = new FormData();
    formData.set("credentialId", "key-1");
    formData.set("overlapMinutes", "15");

    const result = await rotateApiKeyWithStateAction(
      {
        credential: null,
        message: "",
        revokedCredential: null,
        secret: null,
        status: "idle",
      },
      formData,
    );

    expect(rotateCalls).toEqual([
      {
        credentialId: "key-1",
        overlapMinutes: 15,
        userId: "owner",
      },
    ]);
    expect(result).toMatchObject({
      credential: {
        id: "key-2",
        status: "active",
      },
      message: "API key rotated.",
      revokedCredential: {
        id: "key-1",
        replacementCredentialId: "key-2",
        status: "rotating",
      },
      secret: "qs_key_rotatedsecret",
      status: "success",
    });
    expect(revalidated).toEqual(["/settings"]);
  });
});
