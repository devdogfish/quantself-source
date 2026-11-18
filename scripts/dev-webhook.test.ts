import { expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { configureDevWebhook } from "./dev-webhook";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = { QUANTSELF_DEV_GITHUB_WEBHOOK: "1", QUANTSELF_GITHUB_APP_ID: "42", QUANTSELF_GITHUB_PRIVATE_KEY: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), QUANTSELF_GITHUB_WEBHOOK_SECRET: "test-secret", QUANTSELF_JARVIS_TOOL_ORIGIN: "https://new-tunnel.trycloudflare.com" };
test("opt-in sync uses App JWT and only patches URL, JSON content type and secret", async () => {
  const calls: RequestInit[] = [];
  let current = { url: "https://previous.trycloudflare.com/hook", content_type: "form", insecure_ssl: "0" };
  await configureDevWebhook(env, (async (url, options) => {
    expect(url).toBe("https://api.github.com/app/hook/config"); calls.push(options!);
    const jwt = new Headers(options!.headers).get("authorization")!.slice(7);
    const [head, body, signature] = jwt.split(".");
    expect(verify("RSA-SHA256", Buffer.from(`${head}.${body}`), keys.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(body, "base64url").toString()).iss).toBe("42");
    if (options!.method === "PATCH") {
      const patch = JSON.parse(options!.body as string);
      expect(Object.keys(patch).sort()).toEqual(["content_type", "secret", "url"]);
      expect(patch.secret).toBe("test-secret"); current = { ...current, ...patch };
    }
    return Response.json(current);
  }) as typeof fetch);
  expect(calls.map(call => call.method)).toEqual(["GET", "PATCH", "GET"]);
  expect(current).toMatchObject({ url: "https://new-tunnel.trycloudflare.com/api/todo-webhooks/github", insecure_ssl: "0" });
});
test("disabled or incomplete configuration cannot update remote webhook", async () => {
  let count = 0; const request = (async () => { count++; return new Response(); }) as typeof fetch;
  await configureDevWebhook({}, request);
  await expect(configureDevWebhook({ ...env, QUANTSELF_GITHUB_WEBHOOK_SECRET: undefined }, request)).rejects.toThrow("WEBHOOK_SECRET");
  await expect(configureDevWebhook({ ...env, QUANTSELF_JARVIS_TOOL_ORIGIN: "https://elsewhere.example" }, request)).rejects.toThrow("tunnel");
  expect(count).toBe(0);
});
test("remote error reports status without leaking response, secret or JWT", async () => {
  await expect(configureDevWebhook(env, (async () => new Response("sensitive body", { status: 403 })) as typeof fetch)).rejects.toThrow("HTTP 403");
});

test("an unconfigured inactive App webhook leaves native development running", async () => {
  let calls = 0;
  await configureDevWebhook(env, (async () => { calls++; return new Response("", { status: 404 }); }) as typeof fetch);
  expect(calls).toBe(1);
});

test("stable development callback migrates once and rejects production sources", async () => {
  const stable = "https://quantself-local.girke.dev";
  const configured = { ...env, QUANTSELF_DEV_TUNNEL_ORIGIN: stable, QUANTSELF_JARVIS_TOOL_ORIGIN: stable };
  let current = { url: "https://previous.trycloudflare.com/api/todo-webhooks/github", content_type: "json", insecure_ssl: "0" };
  const methods: string[] = [];
  const request = (async (_url, options) => {
    methods.push(options!.method!);
    if (options!.method === "PATCH") current = { ...current, ...JSON.parse(options!.body as string) };
    return Response.json(current);
  }) as typeof fetch;
  await configureDevWebhook(configured, request);
  expect(current.url).toBe(`${stable}/api/todo-webhooks/github`);
  expect(methods).toEqual(["GET", "PATCH", "GET"]);
  current.url = "https://dashboard.girke.dev/api/todo-webhooks/github";
  methods.length = 0;
  await expect(configureDevWebhook(configured, request)).rejects.toThrow("production GitHub webhook");
  expect(methods).toEqual(["GET"]);
});
