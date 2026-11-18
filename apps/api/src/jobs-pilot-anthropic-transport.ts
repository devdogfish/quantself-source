import { createHash } from "node:crypto";
import type { PrismaClient } from "@quantself/db/generated/prisma/client";
import { ANTHROPIC_API_VERSION, ANTHROPIC_MESSAGES_URL } from "../../../automation/n8n/jobs-feed/screening/screening.mjs";
import { jobsPilotAnthropicApproval, jobsPilotAnthropicRequestLimit, readAnthropicPilotReceipt } from "./jobs-pilot-anthropic-receipt";
import { reserveJobsPilotScreen, settleJobsPilotScreen } from "./jobs-pilot-screening";

const host = new URL(ANTHROPIC_MESSAGES_URL).hostname;
const responseLimit = 64 * 1024;
const timeoutLimit = 45_000;
type Reservation = NonNullable<Awaited<ReturnType<typeof reserveJobsPilotScreen>>>;
type Receipt = Parameters<typeof readAnthropicPilotReceipt>[1];
type Transport = { workspaceId: string; apiKey: string; request: typeof fetch; timeoutMs?: number };

function proxyConfigured() {
  return ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]
    .some(name => Boolean(process.env[name]));
}

async function readAnthropicJson(stream: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<unknown> {
  const reader = stream.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "", finished = false;
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > responseLimit) throw new Error("Anthropic response exceeded limit.");
      text += decoder.decode(chunk.value, { stream: true });
    }
    finished = true;
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}

async function captureAnthropicPilotReceipt(reservation: Reservation, transport: Transport, timeoutMs: number, now: () => Date): Promise<Receipt | null> {
  const approved = jobsPilotAnthropicApproval.safeParse(reservation.receiptApproval);
  if (!approved.success || reservation.resultId !== approved.data.resultId || reservation.expiresAt <= now() ||
      transport.workspaceId !== approved.data.workspaceId ||
      reservation.body.byteLength === 0 || reservation.body.byteLength > jobsPilotAnthropicRequestLimit) return null;
  const sent = { body: Uint8Array.from(reservation.body), resultId: reservation.resultId };
  if (createHash("sha256").update(sent.body).digest("hex") !== approved.data.requestDigest) return null;

  const signal = AbortSignal.timeout(timeoutMs);
  const capture = async () => {
    if (reservation.expiresAt <= now() || proxyConfigured()) return null;
    const response = await transport.request(ANTHROPIC_MESSAGES_URL, {
      method: "POST", redirect: "error", signal, keepalive: false, credentials: "omit", decompress: false,
      // Bun 1.3 can write the request before invoking a custom checkServerIdentity.
      tls: { serverName: host, rejectUnauthorized: true },
      headers: {
        "x-api-key": transport.apiKey, "anthropic-version": ANTHROPIC_API_VERSION,
        accept: "application/json", "content-type": "application/json", "accept-encoding": "identity",
      },
      body: sent.body.slice(),
    });
    const length = response.headers.get("content-length");
    const encoding = response.headers.get("content-encoding");
    if (signal.aborted || response.url !== ANTHROPIC_MESSAGES_URL || response.redirected || response.status !== 200 ||
        response.headers.get("anthropic-workspace-id") !== approved.data.workspaceId ||
        !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") ||
        (length !== null && (!/^\d+$/.test(length) || Number(length) > responseLimit)) ||
        (encoding !== null && encoding.toLowerCase() !== "identity") || !response.body) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    const body = await readAnthropicJson(response.body, signal);
    const headers = new Headers();
    for (const name of ["anthropic-workspace-id", "request-id"]) {
      const value = response.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const receipt = { status: response.status, headers, body, sent };
    return readAnthropicPilotReceipt(approved.data, receipt) ? receipt : null;
  };

  const timeout = Promise.withResolvers<null>();
  const onTimeout = () => timeout.resolve(null);
  signal.addEventListener("abort", onTimeout, { once: true });
  try {
    return await Promise.race([capture().catch(() => null), timeout.promise]);
  } finally {
    signal.removeEventListener("abort", onTimeout);
  }
}

// Internal only. Trusted key provisioning, the billed-input ceiling and Owner policy precede runtime registration.
export async function dispatchJobsPilotScreen(db: PrismaClient, target: Parameters<typeof reserveJobsPilotScreen>[1],
  input: Parameters<typeof reserveJobsPilotScreen>[2], transport: Transport, now = () => new Date()) {
  const timeoutMs = transport.timeoutMs ?? timeoutLimit;
  if (proxyConfigured() || transport.workspaceId !== input.approval.workspaceId || !transport.apiKey.trim() ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > timeoutLimit) return null;
  const reservation = await reserveJobsPilotScreen(db, target, input, now);
  if (!reservation) return null;
  const receipt = await captureAnthropicPilotReceipt(reservation, transport, timeoutMs, now);
  if (!receipt) return null;
  try {
    return await settleJobsPilotScreen(db, target, receipt, now);
  } catch {
    // The exact receipt can reconcile once more after an ambiguous database acknowledgement.
    return settleJobsPilotScreen(db, target, receipt, now);
  }
}
