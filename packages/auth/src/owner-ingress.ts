import { timingSafeEqual } from "node:crypto";

export const OWNER_INGRESS_HEADER = "x-quantself-owner-proof";
const OWNER_ORIGIN = "https://qs.girke.dev";
const TOKEN_FORMAT = /^[0-9a-f]{64}$/;

export function hasOwnerIngressProof(headers: Headers) {
  const expected = process.env.QUANTSELF_OWNER_INGRESS_TOKEN ?? "";
  const supplied = headers.get(OWNER_INGRESS_HEADER) ?? "";
  return TOKEN_FORMAT.test(expected) && TOKEN_FORMAT.test(supplied) &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export function ownerIngressAllowsOrigin(headers: Headers, method: string, env = process.env) {
  const origin = headers.get("origin");
  if (origin === null) return method === "GET" || method === "HEAD";
  if (origin === OWNER_ORIGIN) return true;
  if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test") return false;

  const configured = env.QUANTSELF_PUBLIC_ORIGIN;
  if (!configured || !URL.canParse(configured)) return false;
  const local = new URL(configured);
  return local.protocol === "http:" &&
    (local.hostname === "localhost" || local.hostname === "127.0.0.1") &&
    origin === local.origin;
}
