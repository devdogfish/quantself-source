import { isAbsolute } from "node:path";

type Environment = Record<string, string | undefined>;
const quickHost = /^[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/;

/** Only origin URLs are configuration, never credentials, paths or production. */
export function developmentOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname.endsWith(".") || url.hostname === "dashboard.girke.dev" ||
      url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash)
    throw Error("Expected a dedicated HTTPS development tunnel origin, never production.");
  return url;
}

export function isDevelopmentOrigin(candidate: string, configuredOrigin?: string): boolean {
  try {
    const url = developmentOrigin(candidate);
    return quickHost.test(url.hostname) || Boolean(configuredOrigin && url.origin === developmentOrigin(configuredOrigin).origin);
  } catch { return false; }
}

/** A stable ingress targets a fixed loopback port; never silently route elsewhere. */
export function namedDevelopmentTunnel(env: Environment, webPort: number): { origin: string; args: string[] } | undefined {
  const origin = env.QUANTSELF_DEV_TUNNEL_ORIGIN;
  const config = env.QUANTSELF_DEV_TUNNEL_CONFIG;
  if (!origin && !config) return;
  if (!origin || !config || !isAbsolute(config)) throw Error("Named development tunnel requires an HTTPS origin and an absolute QUANTSELF_DEV_TUNNEL_CONFIG path.");
  if (!env.QUANTSELF_DEV_ELEVENLABS_AGENT_ID) throw Error("Named development tunnel requires a dedicated QUANTSELF_DEV_ELEVENLABS_AGENT_ID.");
  if (webPort !== 3000) throw Error("Named development tunnel requires localhost:3000; stop the existing development instance first.");
  return { origin: developmentOrigin(origin).origin, args: ["tunnel", "--config", config, "--protocol", "http2", "--no-autoupdate", "run"] };
}
