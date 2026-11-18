import { apiKey } from "@better-auth/api-key";
import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { API_KEY_RATE_LIMIT } from "./auth-config";

describe("API key Better Auth seam", () => {
  test("verifies API keys directly without impersonating Owner Sessions", async () => {
    const testAuth = betterAuth({
      basePath: "/api/auth",
      baseURL: "http://localhost:3000",
      emailAndPassword: {
        enabled: true,
      },
      plugins: [
        apiKey({
          defaultPrefix: "qs_key_",
          enableMetadata: true,
          enableSessionForAPIKeys: false,
          keyExpiration: {
            minExpiresIn: 1 / (24 * 60),
          },
          rateLimit: API_KEY_RATE_LIMIT,
          requireName: true,
          startingCharactersConfig: {
            charactersLength: 12,
            shouldStore: true,
          },
        }),
      ],
      secret: "yE8wV4pN6sZ2jR9mF7cQ1xK5uH3aD0tL",
    });
    const signUp = await testAuth.api.signUpEmail({
      body: {
        email: "owner@example.com",
        name: "Owner",
        password: "test-password-only",
      },
      returnHeaders: true,
    });
    const sessionCookie = signUp.headers
      .get("set-cookie")
      ?.match(/better-auth\.session_token=[^;]+/)?.[0];
    if (!sessionCookie) {
      throw new Error("Expected owner session cookie.");
    }
    const ownerHeaders = new Headers({
      cookie: sessionCookie,
    });
    const createCredential = (input: {
      expiresIn?: number;
      name: string;
      prefix?: string;
      rotatedFromCredentialId?: string;
    }) =>
      testAuth.api.createApiKey({
        body: {
          expiresIn: input.expiresIn,
          metadata: {
            preset: "reader",
            rotatedFromCredentialId: input.rotatedFromCredentialId,
          },
          name: input.name,
          permissions: {
            inventory: ["read"],
          },
          prefix: input.prefix ?? "qs_key_",
          userId: signUp.response.user.id,
        },
      });
    const verify = (secret: string) =>
      testAuth.api.verifyApiKey({
        body: { key: secret },
      });
    const overlapCredential = await createCredential({
      expiresIn: 60,
      name: "rotating old",
    });
    const replacement = await createCredential({
      name: "replacement",
      rotatedFromCredentialId: overlapCredential.id,
    });
    const revoked = await createCredential({
      name: "revoked",
    });
    const unrelated = await createCredential({
      name: "unrelated",
    });
    expect(unrelated).toMatchObject({
      rateLimitEnabled: true,
      rateLimitMax: 25_000,
      rateLimitTimeWindow: 86_400_000,
    });
    const legacyPrefix = await createCredential({
      name: "legacy prefix",
      prefix: "qs_mc_",
    });
    const overlapEndsAt = overlapCredential.expiresAt;
    if (!overlapEndsAt) {
      throw new Error("Expected overlap credential expiry.");
    }

    await testAuth.api.updateApiKey({
      body: {
        keyId: overlapCredential.id,
        metadata: {
          preset: "reader",
          replacementCredentialId: replacement.id,
          revokedReason: "rotation",
          rotationOverlapEndsAt: overlapEndsAt.toISOString(),
        },
      },
      headers: ownerHeaders,
    });

    expect(await verify(overlapCredential.key)).toMatchObject({
      error: null,
      key: { id: overlapCredential.id },
      valid: true,
    });
    expect(
      await testAuth.api.getSession({
        headers: new Headers({ "x-api-key": overlapCredential.key }),
      }),
    ).toBeNull();

    const listed = await testAuth.api.listApiKeys({
      headers: ownerHeaders,
    });
    const overlapSummary = listed.apiKeys.find(
      (credential) => credential.id === overlapCredential.id,
    );

    expect(overlapSummary).toMatchObject({
      lastRequest: expect.any(Date),
      metadata: {
        preset: "reader",
        replacementCredentialId: replacement.id,
        revokedReason: "rotation",
        rotationOverlapEndsAt: overlapEndsAt,
      },
    });
    expect(
      listed.apiKeys.find((credential) => credential.id === replacement.id),
    ).toMatchObject({
      metadata: {
        preset: "reader",
        rotatedFromCredentialId: overlapCredential.id,
      },
    });
    expect(JSON.stringify(listed)).not.toContain(overlapCredential.key);
    expect(listed.apiKeys.every((credential) => !("key" in credential))).toBe(
      true,
    );

    await testAuth.api.updateApiKey({
      body: {
        enabled: false,
        keyId: revoked.id,
        metadata: {
          preset: "reader",
          revokedAt: new Date().toISOString(),
          revokedReason: "manual",
        },
      },
      headers: ownerHeaders,
    });

    expect(await verify(revoked.key)).toMatchObject({
      key: null,
      valid: false,
    });
    expect(
      (
        await testAuth.api.listApiKeys({
          headers: ownerHeaders,
        })
      ).apiKeys.find((credential) => credential.id === revoked.id),
    ).toMatchObject({
      enabled: false,
      metadata: {
        preset: "reader",
        revokedReason: "manual",
      },
    });
    expect(await verify(unrelated.key)).toMatchObject({
      error: null,
      key: { id: unrelated.id },
      valid: true,
    });
    expect(await verify(legacyPrefix.key)).toMatchObject({
      error: null,
      key: { id: legacyPrefix.id },
      valid: true,
    });

    const realDateNow = Date.now;
    Date.now = () => overlapEndsAt.getTime() + 1;
    try {
      expect(await verify(overlapCredential.key)).toMatchObject({
        key: null,
        valid: false,
      });
      expect(await verify(replacement.key)).toMatchObject({
        key: { id: replacement.id },
        valid: true,
      });
      expect(await verify(unrelated.key)).toMatchObject({
        key: { id: unrelated.id },
        valid: true,
      });
    } finally {
      Date.now = realDateNow;
    }

    expect(await verify(`qs_key_${"x".repeat(64)}`)).toMatchObject({
      key: null,
      valid: false,
    });
    expect(await verify("")).toMatchObject({ key: null, valid: false });
  });
});
