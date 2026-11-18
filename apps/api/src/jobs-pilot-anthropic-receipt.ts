import { createHash } from "node:crypto";
import { z } from "zod";
import { jobsPilotTokenCount, type JobsPilotReceipt } from "./jobs-pilot-usage";

export const jobsPilotAnthropicRequestLimit = 128 * 1024;

export const jobsPilotAnthropicApproval = z.strictObject({
  workspaceId: z.string().regex(/^wrkspc_[A-Za-z0-9]+$/),
  model: z.string().regex(/^claude-[a-z0-9-]+$/),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  resultId: z.uuid(),
  maxInputTokens: jobsPilotTokenCount,
  maxOutputTokens: jobsPilotTokenCount,
});
type Approval = z.output<typeof jobsPilotAnthropicApproval>;

const textBlock = z.strictObject({
  type: z.literal("text"),
  text: z.string().refine(text => text.trim().length > 0),
  citations: z.null().optional(),
});
const message = z.strictObject({
  id: z.string().min(1),
  type: z.literal("message"),
  role: z.literal("assistant"),
  model: z.string(),
  content: z.tuple([textBlock]),
  stop_reason: z.literal("end_turn"),
  stop_sequence: z.null().optional(),
  stop_details: z.null().optional(),
  container: z.null().optional(),
  diagnostics: z.null().optional(),
  usage: z.strictObject({
    input_tokens: jobsPilotTokenCount,
    output_tokens: jobsPilotTokenCount,
    service_tier: z.literal("standard"),
    speed: z.literal("standard"),
    inference_geo: z.literal("global"),
    cache_creation_input_tokens: z.literal(0).optional(),
    cache_read_input_tokens: z.literal(0).optional(),
    cache_creation: z.strictObject({
      ephemeral_5m_input_tokens: z.literal(0).optional(),
      ephemeral_1h_input_tokens: z.literal(0).optional(),
    }).nullish(),
    server_tool_use: z.strictObject({
      web_search_requests: z.literal(0).optional(),
      web_fetch_requests: z.literal(0).optional(),
    }).nullish(),
    output_tokens_details: z.strictObject({ thinking_tokens: z.literal(0).optional() }).nullish(),
  }),
});

type TransportReceipt = {
  status: number;
  headers: Pick<Headers, "get">;
  body: unknown;
  sent: { body: Uint8Array; resultId: string };
};

// The caller must supply the first-party response headers and the exact bytes and
// local result ID captured by the same trusted transport attempt.
export function readAnthropicPilotReceipt(approval: Approval, response: TransportReceipt): JobsPilotReceipt | null {
  if (!jobsPilotAnthropicApproval.safeParse(approval).success || response.status !== 200 ||
      response.sent.resultId !== approval.resultId) return null;

  const workspaceId = response.headers.get("anthropic-workspace-id");
  const requestId = response.headers.get("request-id");
  if (workspaceId !== approval.workspaceId || !requestId || !/^req_[A-Za-z0-9]+$/.test(requestId)) return null;

  const requestDigest = createHash("sha256").update(response.sent.body).digest("hex");
  if (requestDigest !== approval.requestDigest) return null;

  const parsed = message.safeParse(response.body);
  if (!parsed.success) return null;
  const { model, content: [block], usage } = parsed.data;
  if (model !== approval.model || usage.input_tokens > approval.maxInputTokens ||
      usage.output_tokens > approval.maxOutputTokens) return null;

  return {
    requestId, output: block.text,
    usage: { model, requestDigest, resultId: response.sent.resultId, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
  };
}
