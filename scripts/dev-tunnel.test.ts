import { expect, test } from "bun:test";
import { developmentOrigin, isDevelopmentOrigin, namedDevelopmentTunnel } from "./dev-tunnel";

test("development origins reject production, credentials and non-origin URLs", () => {
  for (const value of ["http://quantself-local.girke.dev", "https://dashboard.girke.dev", "https://user:secret@quantself-local.girke.dev", "https://quantself-local.girke.dev/path", "https://quantself-local.girke.dev?x=1", "https://quantself-local.girke.dev#x", "https://quantself-local.girke.dev:444"])
    expect(() => developmentOrigin(value)).toThrow();
  expect(isDevelopmentOrigin("https://new-quick.trycloudflare.com")).toBe(true);
  expect(isDevelopmentOrigin("https://nested.new.trycloudflare.com")).toBe(false);
  expect(isDevelopmentOrigin("https://other.girke.dev", "https://quantself-local.girke.dev")).toBe(false);
  expect(isDevelopmentOrigin("https://dashboard.girke.dev.", "https://dashboard.girke.dev.")).toBe(false);
  expect(isDevelopmentOrigin("https://quantself-local.girke.dev", "https://quantself-local.girke.dev")).toBe(true);
});

test("named tunnel never requests a quick URL or follows a silently changed web port", () => {
  const env = { QUANTSELF_DEV_TUNNEL_ORIGIN: "https://quantself-local.girke.dev", QUANTSELF_DEV_TUNNEL_CONFIG: "/private/dev tunnel.yml", QUANTSELF_DEV_ELEVENLABS_AGENT_ID: "development-agent" };
  expect(namedDevelopmentTunnel(env, 3000)).toEqual({ origin: env.QUANTSELF_DEV_TUNNEL_ORIGIN, args: ["tunnel", "--config", env.QUANTSELF_DEV_TUNNEL_CONFIG, "--protocol", "http2", "--no-autoupdate", "run"] });
  expect(() => namedDevelopmentTunnel(env, 3001)).toThrow("localhost:3000");
  expect(() => namedDevelopmentTunnel({ ...env, QUANTSELF_DEV_ELEVENLABS_AGENT_ID: undefined }, 3000)).toThrow("dedicated");
  expect(() => namedDevelopmentTunnel({ ...env, QUANTSELF_DEV_TUNNEL_CONFIG: undefined }, 3000)).toThrow();
  expect(namedDevelopmentTunnel({}, 3000)).toBeUndefined();
});
