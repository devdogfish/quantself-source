import { createPrivateKey, sign } from "node:crypto";
import { isDevelopmentOrigin } from "./dev-tunnel";

type Environment = Record<string, string | undefined>;

/** Update only callback transport fields; leave activation, events and TLS policy intact. */
export async function configureDevWebhook(env: Environment = process.env, request: typeof fetch = fetch, now = Date.now) {
  if (env.QUANTSELF_DEV_GITHUB_WEBHOOK !== "1") return;
  const secret = env.QUANTSELF_GITHUB_WEBHOOK_SECRET;
  const appId = env.QUANTSELF_GITHUB_APP_ID;
  const privateKey = env.QUANTSELF_GITHUB_PRIVATE_KEY;
  if (!secret || !/^\d+$/.test(appId ?? "") || !privateKey) throw Error("GitHub development webhook needs App ID, private key and QUANTSELF_GITHUB_WEBHOOK_SECRET.");
  let origin: URL;
  try { origin = new URL(env.QUANTSELF_JARVIS_TOOL_ORIGIN!); } catch { throw Error("GitHub webhook needs the current development tunnel."); }
  if (!isDevelopmentOrigin(origin.href, env.QUANTSELF_DEV_TUNNEL_ORIGIN)) throw Error("Expected a HTTPS development tunnel origin.");
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: Math.floor(now() / 1000) - 60, exp: Math.floor(now() / 1000) + 540, iss: appId })}`;
  let token: string;
  try { token = `${payload}.${sign("RSA-SHA256", Buffer.from(payload), createPrivateKey(privateKey)).toString("base64url")}`; } catch { throw Error("GitHub App private key is invalid."); }
  const body = { url: `${origin.origin}/api/todo-webhooks/github`, secret, content_type: "json" };
  async function call(method: string) {
    let response: Response;
    try {
      response = await request("https://api.github.com/app/hook/config", { method, redirect: "error", headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2026-03-10", "Content-Type": "application/json" }, ...(method === "PATCH" ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    } catch { throw Error("GitHub webhook configuration could not reach GitHub."); }
    if (response.status === 404) {
      console.warn("GitHub App webhook is not available yet. Enable its webhook URL and Active setting in GitHub, then rerun scripts/dev-webhook.ts with this tunnel environment.");
      return undefined;
    }
    if (!response.ok) throw Error(`GitHub webhook configuration failed: HTTP ${response.status}.`);
    return response.json() as Promise<{ url: string; content_type: string; insecure_ssl: string | number }>;
  }
  const before = await call("GET");
  if (!before) return;
  if (!isDevelopmentOrigin(new URL(before.url).origin, env.QUANTSELF_DEV_TUNNEL_ORIGIN)) throw Error("Refusing to overwrite a production GitHub webhook. Use a dedicated development App.");
  if (!await call("PATCH")) return;
  const after = await call("GET");
  if (!after) return;
  if (after.url !== body.url || after.content_type !== "json" || String(after.insecure_ssl) !== String(before.insecure_ssl)) throw Error("GitHub webhook configuration verification failed.");
  console.log("GitHub development webhook callback verified.");
}

if (import.meta.main) {
  try { await configureDevWebhook(); } catch (error) { console.error(error instanceof Error ? error.message : "GitHub webhook configuration failed."); process.exitCode = 1; }
}
