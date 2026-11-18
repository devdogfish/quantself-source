import { apiKey } from "@better-auth/api-key";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { prisma } from "@quantself/db";
import { betterAuth } from "better-auth";
import { resolveAuthSecret } from "./auth-secret";
import { getPublicOrigin } from "./public-origin";

const publicOrigin = getPublicOrigin();
if (
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PHASE !== "phase-production-build" &&
  !publicOrigin
) {
  throw new Error("QUANTSELF_PUBLIC_ORIGIN is required in production.");
}

export const API_KEY_RATE_LIMIT = {
  enabled: true,
  maxRequests: 25_000,
  timeWindow: 24 * 60 * 60 * 1000,
} as const;

export function createQuantSelfAuth(
  appName = process.env.QUANTSELF_INSTANCE_NAME?.trim() || "QuantSelf",
) {
  return betterAuth({
    appName,
    baseURL: publicOrigin ?? "http://localhost",
    secret: resolveAuthSecret(),
    database: prismaAdapter(prisma, {
      provider: "postgresql",
    }),
    plugins: [
      apiKey({
        enableSessionForAPIKeys: false,
        defaultPrefix: "qs_key_",
        enableMetadata: true,
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
  });
}

export const auth = createQuantSelfAuth();
