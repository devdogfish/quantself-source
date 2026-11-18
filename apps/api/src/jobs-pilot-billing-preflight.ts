import { z } from "zod";
import { ANTHROPIC_API_VERSION } from "../../../automation/n8n/jobs-feed/screening/screening.mjs";
import { jobsPilotMoneyCap, jobsPilotScreenCallCap } from "./jobs-pilot-allowance";
import { jobsPilotAnthropicRequestLimit } from "./jobs-pilot-anthropic-receipt";
import { jobsPilotScreenInputCap, prepareJobsPilotScreenRequest } from "./jobs-pilot-screen-request";

// Public Haiku 5.5, first-party standard speed/tier, global, uncached. USD / MTok × 1,000 gives nano-USD / token.
const contextInputTokens = 1_000_000;
const shortRates = { input: 100n, output: 500n };
const longRates = { input: 500n, output: 2_500n };
const preflightInput = z.strictObject({
  sourceIdentity: z.string(), posting: z.unknown(), criteria: z.string(),
  estimatedInputTokens: z.number().int().nonnegative().optional(),
  previousScreen: z.enum(["unknown", "none", "uncertain", "settled"]).default("unknown"),
});

const price = (input: number, output: number, rate: typeof shortRates) => BigInt(input) * rate.input + BigInt(output) * rate.output;

/** Inspect only. Provider estimates and past receipts never authorize a new request. */
export function inspectJobsPilotBilling(input: unknown) {
  const { sourceIdentity, posting, criteria, estimatedInputTokens, previousScreen } = preflightInput.parse(input);
  const { request, body, requestDigest, postingDigest } = prepareJobsPilotScreenRequest(sourceIdentity, posting, criteria);
  const publicBound = price(contextInputTokens, request.max_tokens, longRates);
  const conditionalReserve = price(jobsPilotScreenInputCap, request.max_tokens, shortRates);
  const maxScreensReserve = conditionalReserve * BigInt(jobsPilotScreenCallCap);
  return {
    decision: "blocked",
    reasons: [
      "verified_billed_input_bound_required", "public_model_bound_exceeds_run_allowance",
      ...(body.byteLength > jobsPilotAnthropicRequestLimit ? ["canonical_request_exceeds_local_byte_limit"] : []),
      ...(previousScreen === "unknown" ? ["screen_ledger_status_unknown"] : []),
      ...(previousScreen === "uncertain" ? ["unresolved_charge_keep_full_hold_no_retry"] : []),
      ...(previousScreen === "settled" ? ["screen_already_settled_do_not_resend"] : []),
    ],
    sourceIdentity,
    postingDigest,
    request: { model: request.model, apiVersion: ANTHROPIC_API_VERSION, sha256: requestDigest, bytes: body.byteLength,
      maxBytes: jobsPilotAnthropicRequestLimit, maxOutputTokens: request.max_tokens },
    previousScreen,
    estimatedInputTokens: estimatedInputTokens ?? null,
    publicModelBound: { basis: "global_standard_uncached", inputTokens: contextInputTokens,
      inputNanoUsdPerToken: Number(longRates.input), outputNanoUsdPerToken: Number(longRates.output), maxNanoUsd: Number(publicBound) },
    conditionalOnProviderProof: { inputTokensPerScreen: jobsPilotScreenInputCap,
      inputNanoUsdPerToken: Number(shortRates.input), outputNanoUsdPerToken: Number(shortRates.output),
      maxNanoUsdPerScreen: Number(conditionalReserve), maxScreens: jobsPilotScreenCallCap, maxScreensNanoUsd: Number(maxScreensReserve),
      remainingRunNanoUsdForBothModelPhases: Number(jobsPilotMoneyCap - maxScreensReserve) },
    runAllowanceNanoUsd: Number(jobsPilotMoneyCap),
  };
}
