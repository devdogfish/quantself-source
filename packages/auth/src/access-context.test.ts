import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  authenticateAccessContext,
  authorizeAccessContext,
  authorizationFailureStatus,
  flattenApiKeyPermissions,
  resolveAccessContext,
  type AccessContext,
} from "./access-context";

describe("flattenApiKeyPermissions", () => {
  it("returns stable cross-domain permissions", () => {
    expect(
      flattenApiKeyPermissions(
        JSON.stringify({
          health: ["read", "delete"],
          inventory: ["write", "read"],
          notes: ["delete"],
        }),
      ),
    ).toEqual([
      "health:delete",
      "health:read",
      "inventory:read",
      "inventory:write",
      "notes:delete",
    ]);
  });

  it("treats missing or invalid permissions as no permissions", () => {
    expect(flattenApiKeyPermissions(null)).toEqual([]);
    expect(flattenApiKeyPermissions("{")).toEqual([]);
  });
});

describe("resolveAccessContext", () => {
  const ownerRecord = (userId = "user-1") => ({
    user: {
      email: "owner@example.com",
      id: userId,
      name: "QuantSelf Owner",
    },
    userId,
  });

  const proof = "a".repeat(64);
  const proofHeaders = () => new Headers({ "x-quantself-owner-proof": proof });
  const noOwnerLookup = async () => { throw new Error("must not fall back to Owner ingress"); };
  const previousProof = process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
  beforeEach(() => { process.env.QUANTSELF_OWNER_INGRESS_TOKEN = proof; });
  afterEach(() => {
    if (previousProof === undefined) delete process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
    else process.env.QUANTSELF_OWNER_INGRESS_TOKEN = previousProof;
  });

  it("maps trusted Owner ingress to Web Client permissions", async () => {
    const accessContext = await resolveAccessContext(proofHeaders(), {
      findOwnerByUserId: noOwnerLookup,
      findExistingOwner: async () => ownerRecord(),
      verifyApiKey: async () => {
        throw new Error("should not verify an API key without X-API-Key");
      },
    });

    expect(accessContext).toEqual({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "quantself-web",
        kind: "web",
        name: "Quantself Web Client",
      },
      permissions: [
        "jobs:read",
        "jobs:write",
        "budgeting:read",
        "budgeting:write",
        "budgeting:delete",
        "habits:read",
        "habits:write",
        "habits:delete",
        "todos:read",
        "todos:write",
        "todos:approve",
        "todos:delete",
        "health:delete",
        "health:read",
        "health:write",
        "inventory:delete",
        "inventory:read",
        "inventory:write",
        "meetings:read",
        "meetings:write",
      ],
    } satisfies AccessContext);
  });

  it("maps an X-API-Key credential directly to a named API Key Client", async () => {
    const accessContext = await resolveAccessContext(
      new Headers({
        "x-quantself-owner-proof": proof,
        "x-api-key": "qs_test_credential",
      }),
      {
        findOwnerByUserId: async (userId) => ownerRecord(userId),
        findExistingOwner: noOwnerLookup,
        verifyApiKey: async () => ({
          id: "api-key-1",
          name: "inventory-bot",
          permissions: {
            health: ["write"],
            inventory: ["write", "read"],
            notes: ["delete"],
          },
          referenceId: "user-1",
        }),
      },
    );

    expect(accessContext).toEqual({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-1",
        kind: "api-key",
        name: "inventory-bot",
      },
      permissions: [
        "health:write",
        "inventory:read",
        "inventory:write",
        "notes:delete",
      ],
    } satisfies AccessContext);
  });

  it("resolves both rotating credentials to the same Agent Client", async () => {
    const agent = {
      avatar: "https://example.com/sam.png",
      id: "985304a5-6feb-42a3-8247-559c102ff4fa",
      kind: "agent",
      name: "Sam",
    };
    const dependencies = {
      findOwnerByUserId: async () => ownerRecord(),
      findExistingOwner: noOwnerLookup,
      verifyApiKey: async (key: string) => ({
        id: key,
        metadata: { quantselfAgentClient: { avatar: agent.avatar, id: agent.id, name: agent.name } },
        name: "Sam credential",
        permissions: { jobs: ["read"] },
        referenceId: "user-1",
      }),
    };

    for (const key of ["old-key", "replacement-key"]) {
      expect(await resolveAccessContext(new Headers({ "x-api-key": key }), dependencies))
        .toMatchObject({ client: agent, permissions: ["jobs:read"] });
    }
  });

  it("treats an invalid, expired, disabled, or revoked API key as unauthenticated", async () => {
    const accessContext = await resolveAccessContext(
      new Headers({
        "x-api-key": "qs_invalid_credential",
      }),
      {
        findOwnerByUserId: async () => {
          throw new Error("should not resolve an owner for a rejected key");
        },
        findExistingOwner: noOwnerLookup,
        verifyApiKey: async () => null,
      },
    );

    expect(accessContext).toBeNull();
  });

  it("denies an invalid API key even with trusted ingress proof", async () => {
    const accessContext = await resolveAccessContext(
      new Headers({
        "x-quantself-owner-proof": proof,
        "x-api-key": "qs_invalid_credential",
      }),
      {
        findOwnerByUserId: async () => ownerRecord(),
        findExistingOwner: noOwnerLookup,
        verifyApiKey: async () => null,
      },
    );

    expect(accessContext).toBeNull();
  });

  it("does not hide infrastructure failures during AccessContext resolution", async () => {
    expect(
      resolveAccessContext(proofHeaders(), {
        findOwnerByUserId: noOwnerLookup,
        findExistingOwner: async () => {
          throw new Error("database unavailable");
        },
        verifyApiKey: async () => null,
      }),
    ).rejects.toThrow("database unavailable");
  });

  it("denies missing and forged ingress proof, even with a legacy cookie", async () => {
    const credentials = { cookie: "better-auth.session_token=old-session" };
    for (const headers of [credentials, { ...credentials, "x-quantself-owner-proof": "b".repeat(64) }]) {
      expect(await resolveAccessContext(new Headers(headers), {
        findOwnerByUserId: noOwnerLookup,
        findExistingOwner: noOwnerLookup,
        verifyApiKey: async () => null,
      })).toBeNull();
    }
  });

  it("denies trusted ingress if the singleton Owner is missing", async () => {
    expect(await resolveAccessContext(proofHeaders(), {
      findOwnerByUserId: noOwnerLookup,
      findExistingOwner: async () => null,
      verifyApiKey: async () => null,
    })).toBeNull();
  });
});

describe("authenticateAccessContext", () => {
  it("returns a stable unauthenticated failure", () => {
    const result = authenticateAccessContext(null);

    expect(result).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication required.",
      },
      ok: false,
    });
    if (result.ok) {
      throw new Error(
        "expected authenticateAccessContext to fail without credentials",
      );
    }
    expect(authorizationFailureStatus(result.error)).toBe(401);
  });
});

describe("authorizeAccessContext", () => {
  it("allows an explicitly granted Web Client permission", () => {
    const accessContext: AccessContext = {
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "quantself-web",
        kind: "web",
        name: "Quantself Web Client",
      },
      permissions: ["inventory:delete"],
    };

    expect(
      authorizeAccessContext(accessContext, {
        action: "delete",
        domain: "inventory",
      }),
    ).toEqual({
      accessContext,
      ok: true,
    });
  });

  it("distinguishes unauthenticated requests from authenticated Clients lacking permission", () => {
    const accessContext: AccessContext = {
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "key-1",
        kind: "api-key",
        name: "inventory-bot",
      },
      permissions: ["inventory:read", "inventory:write"],
    };

    const unauthenticated = authorizeAccessContext(null, {
      action: "read",
      domain: "inventory",
    });
    const forbidden = authorizeAccessContext(accessContext, {
      action: "delete",
      domain: "inventory",
    });

    expect(unauthenticated).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication required.",
      },
      ok: false,
    });
    if (unauthenticated.ok) {
      throw new Error("expected unauthenticated authorization to fail");
    }
    expect(authorizationFailureStatus(unauthenticated.error)).toBe(401);
    expect(forbidden).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Missing required permission.",
      },
      ok: false,
    });
    if (forbidden.ok) {
      throw new Error("expected missing-permission authorization to fail");
    }
    expect(authorizationFailureStatus(forbidden.error)).toBe(403);
  });

  it("keeps read, write, and delete independent across domains", () => {
    const accessContext: AccessContext = {
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "key-1",
        kind: "api-key",
        name: "inventory-bot",
      },
      permissions: ["inventory:write", "notes:delete"],
    };

    expect(
      authorizeAccessContext(accessContext, {
        action: "write",
        domain: "inventory",
      }),
    ).toEqual({
      accessContext,
      ok: true,
    });
    expect(
      authorizeAccessContext(accessContext, {
        action: "delete",
        domain: "inventory",
      }),
    ).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Missing required permission.",
      },
      ok: false,
    });
    expect(
      authorizeAccessContext(accessContext, {
        action: "delete",
        domain: "notes",
      }),
    ).toEqual({
      accessContext,
      ok: true,
    });
    expect(
      authorizeAccessContext(accessContext, {
        action: "read",
        domain: "notes",
      }),
    ).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Missing required permission.",
      },
      ok: false,
    });
  });
});
