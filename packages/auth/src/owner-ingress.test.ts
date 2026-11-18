import { expect, test } from "bun:test";
import { ownerIngressAllowsOrigin } from "./owner-ingress";

const headers = (origin: string) => new Headers({ origin });

test("production Owner mutations require the Keep origin even with stale origin configuration", () => {
  const legacy = "https://dashboard.girke.dev";
  const env = { NODE_ENV: "production", QUANTSELF_PUBLIC_ORIGIN: legacy, BETTER_AUTH_URL: legacy };
  expect(ownerIngressAllowsOrigin(headers(legacy), "POST", env)).toBe(false);
  expect(ownerIngressAllowsOrigin(headers("https://qs.girke.dev"), "POST", env)).toBe(true);
  expect(ownerIngressAllowsOrigin(new Headers(), "POST", env)).toBe(false);
  expect(ownerIngressAllowsOrigin(new Headers(), "GET", env)).toBe(true);
});

test("a configured loopback origin works in development and tests", () => {
  const loopback = "http://127.0.0.1:3110";
  const env = { NODE_ENV: "development", QUANTSELF_PUBLIC_ORIGIN: loopback };
  expect(ownerIngressAllowsOrigin(headers(loopback), "POST", env)).toBe(true);
  expect(ownerIngressAllowsOrigin(headers(loopback), "POST", { ...env, NODE_ENV: "test" })).toBe(true);
  expect(ownerIngressAllowsOrigin(headers(loopback), "POST", { ...env, NODE_ENV: "production" })).toBe(false);
  expect(ownerIngressAllowsOrigin(headers(loopback), "POST", { ...env, NODE_ENV: undefined })).toBe(false);
  const remote = "http://localhost.example.test:3110";
  expect(ownerIngressAllowsOrigin(headers(remote), "POST", { ...env, QUANTSELF_PUBLIC_ORIGIN: remote })).toBe(false);
});
