import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@quantself/db/generated/prisma/client";
import { ANTHROPIC_API_VERSION, ANTHROPIC_MESSAGES_URL, buildScreenRequest, MODEL } from "../../../automation/n8n/jobs-feed/screening/screening.mjs";
import { fingerprintIdempotentRequest } from "./idempotency";
import { dispatchJobsPilotScreen } from "./jobs-pilot-anthropic-transport";

const workspaceId = "wrkspc_Fixture";
const apiKey = "offline-fixture";
const output = '{"decision":"keep","category":"web","fitNote":"Édits product pages."}';
const body = {
  id: "msg_Fixture", type: "message", role: "assistant", model: MODEL, stop_reason: "end_turn",
  content: [{ type: "text", text: output }],
  usage: { input_tokens: 100, output_tokens: 20, service_tier: "standard", speed: "standard", inference_geo: "global" },
};
type Grant = { resultId: string; body: Buffer; expiresAt: Date };
type Transport = Parameters<typeof dispatchJobsPilotScreen>[3];

function pilot({ description = "Résumé fixture", criteria = "Canadian web publishing", afterReserve }: {
  description?: string; criteria?: string; afterReserve?: (grant: Grant) => void;
} = {}) {
  const posting = { sourceIdentity: "greenhouse:global:fixture:197", sourceUrl: "https://job-boards.greenhouse.io/fixture/jobs/197",
    company: "Fixture", role: "Editor", description };
  const target = { ownerId: "fixture-owner", permitId: randomUUID(), sourceIdentity: posting.sourceIdentity };
  const bytes = Buffer.from(JSON.stringify(buildScreenRequest(posting, criteria)));
  const input = { posting, criteria, approval: {
    workspaceId, requestDigest: createHash("sha256").update(bytes).digest("hex"), postingDigest: fingerprintIdempotentRequest({ posting }),
    maxInputTokens: 128, inputNanoUsdPerToken: 100_000n, outputNanoUsdPerToken: 110_000n,
  } };
  const permit = { applicationId: null, revision: null, revokedAt: null, expiresAt: new Date(Date.now() + 5_000),
    settledKeepResultId: null, screenedPostingDigest: null, allowanceId: randomUUID() };
  let attempt: Record<string, unknown> | undefined;
  const tx = {
    $queryRaw: async ([query]: TemplateStringsArray) => query.includes("SELECT EXISTS") ? [{ imported: false }] : [permit],
    $executeRaw: async () => 1,
    jobPilotScreenAttempt: {
      async createMany({ data }: { data: Record<string, unknown> }) {
        if (attempt) return { count: 0 };
        attempt = { ...data, chargedNanoUsd: null };
        return { count: 1 };
      },
      async findUnique() { return attempt; },
      async update({ data }: { data: Record<string, unknown> }) { Object.assign(attempt!, data); },
    },
    jobPilotPermit: { async update({ data }: { data: Record<string, unknown> }) { Object.assign(permit, data); } },
  };
  const db = { async $transaction<T>(work: (transaction: typeof tx) => Promise<T>) {
    const value = await work(tx);
    if (value && typeof value === "object" && "body" in value && Buffer.isBuffer(value.body) &&
        "resultId" in value && typeof value.resultId === "string" && "expiresAt" in value && value.expiresAt instanceof Date) {
      afterReserve?.(value as unknown as Grant);
    }
    return value;
  } } as unknown as PrismaClient;
  return { bytes, dispatch: (network: Transport, now?: () => Date) => dispatchJobsPilotScreen(db, target, input, network, now) };
}
const firstParty = (payload: ConstructorParameters<typeof Response>[0] = JSON.stringify(body),
  init: { status?: number; headers?: Record<string, string> } = {}, url: string = ANTHROPIC_MESSAGES_URL, redirected = false) => {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8", "anthropic-workspace-id": workspaceId, "request-id": "req_Fixture",
  });
  for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value);
  const response = new Response(payload, { ...init, headers });
  Object.defineProperties(response, { url: { value: url }, redirected: { value: redirected } });
  return response;
};
const transport = (fake: (input: string | URL | Request, options?: BunFetchRequestInit) => Promise<Response>, timeoutMs?: number) =>
  ({ apiKey, workspaceId, request: fake as typeof fetch, timeoutMs });

test("sends a private copy of the reserved bytes once to the fixed Anthropic TLS endpoint", async () => {
  let grant: Grant | undefined;
  const approved = pilot({ afterReserve: value => { grant = value; } });
  const original = Uint8Array.from(approved.bytes);
  let sends = 0;
  const settlement = await approved.dispatch(transport(async (url, options) => {
    sends++;
    expect(url).toBe(ANTHROPIC_MESSAGES_URL);
    expect(options).toMatchObject({ method: "POST", redirect: "error", keepalive: false, credentials: "omit", decompress: false,
      tls: { rejectUnauthorized: true, serverName: "api.anthropic.com" } });
    expect(new Headers(options?.headers).get("x-api-key")).toBe(apiKey);
    expect(new Headers(options?.headers).get("anthropic-version")).toBe(ANTHROPIC_API_VERSION);
    expect(new Headers(options?.headers).get("content-type")).toBe("application/json");
    expect(new Headers(options?.headers).get("accept-encoding")).toBe("identity");
    expect(options?.tls?.checkServerIdentity).toBeUndefined();
    grant!.body.fill(32);
    await Promise.resolve();
    expect(options?.body).toEqual(original);
    const encoded = new TextEncoder().encode(JSON.stringify(body));
    const split = encoded.indexOf(0xc3) + 1;
    return firstParty(new ReadableStream({
      start(controller) {
        controller.enqueue(encoded.slice(0, split));
        controller.enqueue(encoded.slice(split));
        controller.close();
      },
    }));
  }));
  expect(sends).toBe(1);
  expect(settlement).toMatchObject({
    resultId: grant?.resultId, chargeNanoUsd: 12_200_000n,
    posting: { postingText: "Fit note (web): Édits product pages.\n\nRésumé fixture" },
  });
});

test("rejects wrong workspace, attempt, bytes, expiry and oversized requests before sending", async () => {
  let sends = 0;
  const network = transport(async () => { sends++; throw new Error("Unexpected transport"); });
  expect(await pilot().dispatch({ ...network, workspaceId: "wrkspc_Other" })).toBeNull();
  expect(await pilot({ afterReserve: grant => { grant.resultId = randomUUID(); } }).dispatch(network)).toBeNull();
  expect(await pilot({ afterReserve: grant => { grant.body = Buffer.from("{}"); } }).dispatch(network)).toBeNull();
  expect(await pilot({ afterReserve: grant => { grant.expiresAt = new Date(0); } }).dispatch(network)).toBeNull();
  const oversized = pilot({ description: "\0".repeat(12_000), criteria: "\0".repeat(8_000) });
  expect(oversized.bytes.byteLength).toBeGreaterThan(128 * 1024);
  expect(await oversized.dispatch(network)).toBeNull();
  let reads = 0;
  expect(await pilot().dispatch(network, () => ++reads <= 4 ? new Date(0) : new Date("2100-01-01"))).toBeNull();
  expect(sends).toBe(0);
});

test("returns ambiguity after TLS failure, redirects, non-first-party responses or invalid receipts", async () => {
  for (const fake of [
    async () => { throw new Error("Fixture certificate verification failed"); },
    async () => firstParty("", { status: 302, headers: { location: "https://other.example.test/" } }),
    async () => firstParty(undefined, {}, ANTHROPIC_MESSAGES_URL, true),
    async () => firstParty(undefined, {}, "https://other.example.test/v1/messages"),
    async () => firstParty(undefined, { status: 429 }),
    async () => firstParty(undefined, { headers: { "content-type": "text/plain" } }),
    async () => firstParty(undefined, { headers: { "content-encoding": "gzip" } }),
    async () => firstParty(undefined, { headers: { "anthropic-workspace-id": "wrkspc_Other" } }),
    async () => firstParty(JSON.stringify({ ...body, request_id: "req_BodyOnly" }), { headers: { "request-id": "" } }),
    async () => firstParty("{bad-json"),
    async () => firstParty(new Uint8Array([0xc3, 0x28])),
  ]) {
    let sends = 0;
    expect(await pilot().dispatch(transport(async () => { sends++; return fake(); }))).toBeNull();
    expect(sends).toBe(1);
  }
});

test("bounds response bytes and aborts while awaiting headers or body", async () => {
  expect(await pilot().dispatch(transport(async () =>
    firstParty(undefined, { headers: { "content-length": String(64 * 1024 + 1) } })))).toBeNull();
  let discarded = false;
  expect(await pilot().dispatch(transport(async () => firstParty(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("é".repeat(32 * 1024 + 1))); },
    cancel() { discarded = true; },
  }))))).toBeNull();
  expect(discarded).toBe(true);

  let headerSignal: AbortSignal | null | undefined;
  expect(await pilot().dispatch(transport((_, options) => {
    headerSignal = options?.signal;
    return new Promise<Response>(() => {});
  }, 15))).toBeNull();
  expect(headerSignal?.aborted).toBe(true);
  let cancelled = false;
  const stalled = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  expect(await pilot().dispatch(transport(async () => firstParty(stalled), 15))).toBeNull();
  expect(cancelled).toBe(true);
});
