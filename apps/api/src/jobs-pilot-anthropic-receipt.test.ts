import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readAnthropicPilotReceipt } from "./jobs-pilot-anthropic-receipt";

const output = '{"doing":"Maintain product pages."}';
const sent = {
  body: new TextEncoder().encode('{"model":"claude-haiku-5-5","service_tier":"standard_only","max_tokens":384,"messages":[{"role":"user","content":"Résumé fixture"}]}'),
  resultId: "f1ddcb33-5455-4ced-a5a4-6ed217cb3c5f",
};
const approval = {
  workspaceId: "wrkspc_ApprovedFixture", model: "claude-haiku-5-5",
  requestDigest: createHash("sha256").update(sent.body).digest("hex"), resultId: sent.resultId,
  maxInputTokens: 128, maxOutputTokens: 384,
};
const usage = { input_tokens: 100, output_tokens: 20, service_tier: "standard", speed: "standard", inference_geo: "global" };
const body = {
  id: "msg_Fixture", type: "message", role: "assistant", model: approval.model,
  content: [{ type: "text", text: output }], stop_reason: "end_turn", usage,
};
const headers = new Headers({ "anthropic-workspace-id": approval.workspaceId, "request-id": "req_TrustedFixture" });
const receipt = { status: 200, headers, body, sent };
const expected = { requestId: "req_TrustedFixture", output, usage: {
  model: approval.model, requestDigest: approval.requestDigest, resultId: approval.resultId, inputTokens: 100, outputTokens: 20,
} };

test("maps an approved Messages receipt to the pilot ledger format", () => {
  expect(readAnthropicPilotReceipt(approval, receipt)).toEqual(expected);
  expect(readAnthropicPilotReceipt(approval, { ...receipt, body: {
    ...body, container: null, diagnostics: null, stop_sequence: null, stop_details: null,
    content: [{ type: "text", text: output, citations: null }],
    usage: {
      ...usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      output_tokens_details: { thinking_tokens: 0 },
    },
  } })).toEqual(expected);
});

test("requires the original workspace, response request ID and local request binding", () => {
  const otherWorkspace = new Headers(headers);
  otherWorkspace.set("anthropic-workspace-id", "wrkspc_OtherFixture");
  const missingRequest = new Headers(headers);
  missingRequest.delete("request-id");
  const duplicateRequest = new Headers(headers);
  duplicateRequest.append("request-id", "req_AnotherFixture");
  const changedBody = new Uint8Array([...sent.body, 32]);
  for (const response of [
    { ...receipt, status: 429 },
    { ...receipt, headers: otherWorkspace },
    { ...receipt, headers: missingRequest, body: { ...body, request_id: "req_BodyOnly" } },
    { ...receipt, headers: duplicateRequest },
    { ...receipt, sent: { ...sent, body: changedBody } },
    { ...receipt, sent: { ...sent, resultId: "77aa7942-ea91-4d89-8bab-9320a7b0adde" } },
    { ...receipt, body: { ...body, model: "claude-other" } },
    { ...receipt, body: { ...body, stop_reason: "max_tokens" } },
    { ...receipt, body: { ...body, content: [{ type: "tool_use", id: "toolu_Fixture", name: "search", input: {} }] } },
    { ...receipt, body: { ...body, content: [...body.content, { type: "thinking", thinking: "fixture" }] } },
    { ...receipt, body: { ...body, unexpected_charge: 0 } },
  ]) expect(readAnthropicPilotReceipt(approval, response)).toBeNull();
  expect(readAnthropicPilotReceipt({ ...approval, maxInputTokens: Number.NaN }, receipt)).toBeNull();
});

test.each([
  ["wrong tier", { service_tier: "priority" }],
  ["missing tier", { service_tier: undefined }],
  ["premium speed", { speed: "fast" }],
  ["regional inference", { inference_geo: "us" }],
  ["cache read", { cache_read_input_tokens: 1 }],
  ["cache write", { cache_creation_input_tokens: 1 }],
  ["cache breakdown", { cache_creation: { ephemeral_1h_input_tokens: 1 } }],
  ["unknown cache breakdown", { cache_creation: { other_input_tokens: 0 } }],
  ["server search", { server_tool_use: { web_search_requests: 1 } }],
  ["server fetch", { server_tool_use: { web_fetch_requests: 1 } }],
  ["unknown server tool", { server_tool_use: { code_execution_requests: 0 } }],
  ["thinking", { output_tokens_details: { thinking_tokens: 1 } }],
  ["unknown token category", { output_tokens_details: { audio_tokens: 0 } }],
  ["unknown usage category", { additional_units: 0 }],
  ["fractional input", { input_tokens: 1.5 }],
  ["over approved input", { input_tokens: 129 }],
  ["over approved output", { output_tokens: 385 }],
])("rejects %s usage", (_, patch) => {
  expect(readAnthropicPilotReceipt(approval, { ...receipt, body: { ...body, usage: { ...usage, ...patch } } })).toBeNull();
});
