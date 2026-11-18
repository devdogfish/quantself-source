# #197 Anthropic billed-input preflight

[Feed pilot #197](https://github.com/devdogfish/quantself/issues/197) · [Merged pilot #435](https://github.com/devdogfish/quantself/pull/435) · [Replacement admission #486](https://github.com/devdogfish/quantself/pull/486)

Public contract checked November 17, 2026 for the first-party Messages API, `claude-haiku-5-5`, API version `2026-10-21`. The paid pilot stays closed. The n8n Assistant remains enabled under its separate Owner decision.

## Enforceable limits

| Limit | What it establishes |
| --- | --- |
| `max_tokens: 384` | Hard cap on generated tokens. Thinking is explicitly disabled in the canonical screen. [Messages API](https://platform.claude.com/docs/en/api/messages/create) · [Haiku 5.5 migration](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide) |
| 1M model context | Anthropic rejects a prompt larger than the context window. An accepted prompt near the ceiling can use less output than requested. Allowing the full context and all 384 output tokens at the higher global rates gives a conservative **$0.500960** per screen. [Context overflow](https://platform.claude.com/docs/en/build-with-claude/context-windows#context-window-overflow-behavior) · [Model rates](https://platform.claude.com/docs/en/models/haiku-5-5/overview#specifications) |
| 20,000 input tokens and 128 KiB | Quantself checks the exact serialized UTF-8 byte count before reserving and checks billed usage at settlement. The Messages contract exposes an output cap and no per-request billed-input setting. Token counting estimates input. Structured outputs add a billable system prompt. [Messages parameters](https://platform.claude.com/docs/en/api/messages/create) · [Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting) · [Structured output overhead](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#prompt-modification-and-token-costs) |
| Workspace spend and rate limits | Spend limits are monthly. Input rate limits estimate work at admission and adjust against actual use. Neither establishes the maximum charge of an exact request. [Workspace limits](https://platform.claude.com/docs/en/manage-claude/workspaces#setting-workspace-limits) · [Rate limits](https://platform.claude.com/docs/en/api/rate-limits#cache-aware-itpm) |

Global standard Messages prices per million tokens are $0.10 input and $0.50 output through 100,000 prompt tokens, then $0.50 and $2.50. The threshold counts uncached input, cache creation and cache reads together. The 5-minute and 1-hour cache writes and cache reads have separate rates. The current request omits `cache_control`, tools and fallback. Haiku 5.5 is ineligible for Priority Tier. The receipt must show standard tier, standard speed, global inference and zero cache or server-tool use. With no explicit `inference_geo` in the frozen request, the workspace default applies. US-only inference adds 10%, including long-context rates. [Haiku pricing](https://platform.claude.com/docs/en/models/haiku-5-5/overview#specifications) · [Pricing modifiers](https://platform.claude.com/docs/en/about-claude/pricing) · [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) · [Service tiers](https://platform.claude.com/docs/en/api/service-tiers#supported-models) · [Messages geography](https://platform.claude.com/docs/en/api/messages/create)

If Anthropic supplies an enforceable bound of 20,000 billed input tokens or less for these exact bytes, one uncached global screen would reserve at most **$0.002192** at the short-context rates. Two would reserve **$0.004384**, leaving **$0.095616** under the shared $0.10 cap for the two model phases. Enrichment and tailoring each still need their own provider-backed usage and price bound. Keep the full reservation after a client timeout. A call can still be billed after disconnect. Retry settlement with the original verified receipt when available. Reconcile before any further screening, including under a replacement permit. [#197 budget](https://github.com/devdogfish/quantself/issues/197) · [Timeout billing](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage)

## Run offline

```sh
bun --no-env-file scripts/jobs/preflight-pilot-billing.ts --fixture
bun --no-env-file scripts/jobs/preflight-pilot-billing.ts < approved-screen.json
```

For a candidate, use a local JSON file with `sourceIdentity`, the normalized `posting`, and `criteria` from the approved snapshot. Optionally include `estimatedInputTokens` and `previousScreen` (`none`, `uncertain`, `settled`, or `unknown`). Use `unknown` until the applicable posting and shared-allowance ledgers are checked. The status is supplied by the operator. The command shares the reservation's serializer and prints the byte count, request SHA-256, normalized `postingDigest`, conditional budget and refusal. Use both digests when preparing the server-side approval. Exit `2` means a valid report with the paid gate closed. Exit `1` means invalid input. The command reads no provider credentials and prints no request body.

The built-in fixture produced 1,552 bytes with SHA-256 `e2510d342dfe5bcb14b65050e29aa0151c89a22fd24f14866637de4fedecf61f`, matching the pinned n8n/TLS rehearsal. In disposable PostgreSQL the public model bound was refused before reservation and fake dispatch, even with a small token estimate. A synthetic bound exercised one fake transport call and one settlement. A separate synthetic timeout retained 52,240,000 nano-USD and its replay made zero further sends. The database fixture passed 108 assertions. No Anthropic API, Console, credential or production configuration was accessed.

## Admission recheck

On November 18, 2026 UTC, this change was tested on main base `b2574006289b135f0121ed8b9d667665ae36a0d5` with Bun 1.3.14, Prisma 7.4.2 and disposable Docker PostgreSQL 16.13. The fixture CLI exited 2 in 0.13 s with the same 1,552 request bytes and a separate posting digest `4c8fe494145c34cc76e80f650f955b353e4b6472ef0f92a24c75b0f249d55e51`. A posting metadata change preserved the request hash and changed the posting digest. The reservation fixture accepted both reported digests under the synthetic pricing and usage policy.

| Screening control | Observed result |
| --- | --- |
| Public context bound with a small token estimate | Zero reservations and zero transport calls. |
| Uncertain original, then replacement on the same posting or shared allowance | One synthetic send retained a 2,020,000 nano-USD hold. Three concurrent replacements returned 409 in 34 ms total with zero new attempt rows and zero additional sends. |
| Verified settlement, then concurrent reservations for the same posting on separate allowances | Two reservation attempts in 38 ms total. One reservation and one 409, with zero transport calls in this reserve-only probe. |
| Exact gateway replay while a different attempt on the allowance was unresolved | HTTP 409 in 8 ms with zero sends. The original verified settlement receipt still replayed unchanged. |

The screening, permit, allowance and lease fixtures passed 489 assertions in 1.17, 0.80, 0.59 and 1.65 s wall respectively. Migrations took 1.22–1.70 s per database. The CLI, receipt and transport tests passed 25 cases and 91 assertions in 0.31 s. The inactive export passed parity. Provider calls were zero. [#486 merged proof](https://github.com/devdogfish/quantself/pull/486) · [Pinned n8n/TLS workflow proof](jobs-198-acceptance.md#197-importable-one-posting-pilot-and-same-draft-handoff)

## Evidence still needed

The next offline step is for the Owner to select one eligible, previously unimported public Greenhouse posting and freeze its normalized snapshot and approved Career criteria. Run the stdin command above on that local snapshot and retain the two hashes. Keep the report with the pinned posting for billing verification. [One-posting workflow setup](../../automation/n8n/jobs-feed/README.md#pin-one-posting-for-the-197-pilot)

Obtain a provider-backed upper bound on billed input of at most 20,000 tokens for that exact screen, including prompt transformation and structured-output overhead. Tie it to the request digest, model, API version and applicable global standard rates. A token estimate or one usage receipt leaves the gate unresolved. Verify the approved workspace scope and keep the combined screening, enrichment and tailoring reserves within $0.10 before requesting live activation. The default API has no pilot gateway registration. Wiring the scoped gateway and running the inactive workflow manually belong to the approved live window. [#197](https://github.com/devdogfish/quantself/issues/197) · [Workspace key scope and response attribution](https://platform.claude.com/docs/en/manage-claude/workspaces)
