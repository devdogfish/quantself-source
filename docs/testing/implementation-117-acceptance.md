# Implementation #117 acceptance — 2026-10-27 (Halifax)

Historical acceptance record: the October 30 Phone Jarvis decision supersedes the
formal planning-mode behavior below. Its tool and endpoint are removed; ordinary
authorized task CRUD applies across dates. This record does not establish Phone
Jarvis deployment or real-call acceptance.

Owner scope: conversational capture only; no new capture UI, iPhone shortcut,
widget, enrichment worker or notification delivery. #130 remains needs-info.
One active task range remains the ADR0028 model.

## Timing, deadlines and Trash (#121)

Actual GitHub App writer exercised isolated `devdogfish-workspace/todos-integration-test`
fixture [#8](https://github.com/devdogfish-workspace/todos-integration-test/issues/8).
Fixtures #7 and #8 were closed afterward. No personal tasks or Project membership
changed. The fixture used an in-memory command journal; durable journal behavior
has separate regression coverage.

Passed: lone-start 30-minute seeding; partial-bound edit preserves the opposite
bound; independent Due/deadline metadata and extension preservation; identical
retry performs zero writes; Trash/Restore; marker-free native closure restoration.
Cold detail including authentication/setup: 7 requests, 1276 ms. Warm detail:
2 requests, 499 ms. Partial edit: 4 requests, 2054 ms, 1 write. Deadline change:
7 requests, 3872 ms, 2 writes. Identical retry: 3 reads, 1048 ms, zero writes.
These are individual measurements, not latency guarantees.

Deferred-response UI coverage includes Trash → Restore → Undo while the first
write is pending, with newest intent preserved across all responses. Three writes,
one collection read. Existing optimistic drag measurements: 14.7/23.5 ms; three
moves produce three PATCH requests and no collection reread.

## Provider configuration and behavior (#118, #127)

Existing private ElevenLabs agent retained. Configuration scripts default to a
pure dry run; apply writes private local backups, checks concurrent changes, and
verifies full readback, including expanded tool configurations. Voice, privacy,
authentication and unrelated controls preserved. Existing command tools updated;
one narrow `set_planning_mode` tool added. No notification or phone tools added.

Live provider simulations use synthetic text and mocked tool results, never
personal task writes. These verify model decisions; they do not establish microphone,
ASR, audio playback or actual write delivery. Existing HTTP command tests and the
live GitHub writer check those separate seams. Initial capture trace immediately
called the existing create tool with an inferred title and original description,
without asking for title/category/date. Exact-time trace supplied the correct
Halifax interval with 30-minute default. Stop trace immediately invoked `end_call`
with one “As you wish, sir.”

## Diagnostics access audit (#127)

- Coding-agent host access: `ssh -o BatchMode=yes -o ConnectTimeout=8 root@hostinger-vps`
  failed authentication (`Permission denied`). Existing configured production
  target `/root/quantself` is documented in `scripts/ops.ts`. Production logs were
  not read; no permission change attempted. Exact missing capability: authorized
  SSH identity for that target. After access is restored, use existing compose
  service logs with bounded `--since`/`--tail`, never environment dumps.
- Local API: existing stdout access logs verified. Records contain route, status,
  latency and authenticated Client metadata; avoid publishing identity fields.
  Current development output is ephemeral process output, not a new log pipeline.
- ElevenLabs: configured server credential successfully listed one recent
  conversation and read its detail (HTTP 200; transcript and audio present).
  Only sanitized counts/status were inspected in output. No raw conversation,
  recording or credentials copied into issues or this document. Agent retention
  remains indefinite with voice recording enabled, as required by existing runtime.
- Application capture archive: existing authenticated
  `GET /api/v1/todo-captures/{id}` and audio route remain the Owner-controlled
  retrieval/deletion interface. API authorization and source ownership still apply.
  This audit did not delete sources or change retention.
- Jarvis Client: existing task read/write grant; provider tool allowlist exposes
  task reads, task commands, scoped planning and UI controls. It does not expose
  arbitrary server logs, provider administration or transcript search. Coding-agent
  host/provider access does not imply the voice Client has those capabilities.

Redact keys, cookies, headers, raw prompts/transcripts, task descriptions and
recording URLs. Share request counts, statuses, event types, timestamps and fixture
identifiers only. Review evidence in the original authorized source when needed.

## Cache and live freshness (#124)

Actual signed GitHub deliveries verified against isolated fixture
[#9](https://github.com/devdogfish-workspace/todos-integration-test/issues/9),
closed after testing. Create to SSE: 1959 ms; edit to SSE: 1347 ms. Both measured
from starting the GitHub mutation through observing the pushed update, including
GitHub write latency; each required two targeted canonical requests. Actual GitHub
redelivery returned 202 and caused zero upstream requests. Cold setup: seven
requests, 1786 ms. Twenty warm cache reads: zero upstream requests, 0.87 ms total
(in-process fixture). Durable Docker checks separately cover restart, second
coordinator freshness/revocation, ordering and replay.

Temporary fixture database scope, server and tunnel removed; original development
webhook URL, signing secret and TLS policy restored and verified. Existing App
subscriptions now include issues, issue comments, labels, dependencies and sub-issues,
without expanding repository permissions. Development startup refreshes the callback.

Next's streaming compression bug was reproduced and fixed with a preserved
`Cache-Control: private, no-store, no-transform` after Hono creates the SSE response.
First snapshot: direct API 28 ms; local Next proxy 40 ms, 9637 bytes. This verifies
local dashboard delivery. Cloudflare explicitly does not support SSE on quick
tunnels; a named tunnel or production reverse proxy is required for a remote
dashboard. Quick tunnels continue to serve Jarvis callbacks and signed webhooks.
[Cloudflare limitation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## Final behavioral checks

Provider simulations also verified all-day day-only capture followed by one timing
question; ambiguous “8 tomorrow” asks AM/PM without a timing mutation; declined
scheduling and unaccepted thoughts cause no write; planning opens scope, performs
an existing-task timing edit, then ends scope; stop immediately calls end_call.
Mocked planning outcomes are static, so they verify control flow rather than
runtime state transitions. HTTP tests cover real scope expiration/end, revoked
access, overlap acceptance, independent outcomes and reconciliation.

The existing provider's `pre_tool_speech=auto` setting explained narration despite
prompt instructions. Use `off` for routine tools; retain system hangup behavior.
[ElevenLabs setting](https://elevenlabs.io/docs/changelog/2026/4/27).

No physical iPhone/widget test or microphone/audio roundtrip was performed; these
are not evidence of device delivery. Production SSH/log access remains unavailable
as documented above. Local API, browser, provider configuration and isolated GitHub
checks are distinct from production deployment.

Final full suite: `bun run test` — 1030 passed, 2 optional integration tests
skipped, zero failed. The cache Docker integration was also explicitly run and
passed separately. `bun run typecheck` passed; final provider transformation API
and web typechecks also passed. Final exact-time simulation contained no optional
tool speech parameter, but the model still produced one free-text preamble before
the create call. This is a remaining delivery-style limitation; do not claim
perfectly silent model turns. Task identity/time, stop, and authorization behavior
were verified separately.

## Continuation audit

A real signed ElevenLabs text websocket called `read_task` for an intentionally
nonexistent issue. The provider recorded the actual API 404 response in 575 ms
and replied “Not found.” No mocked tool response or personal task write was used.
This establishes provider-to-development-API transport, not successful capture,
microphone/ASR/playback or recording reconciliation. Direct API, local Next proxy
and public callback health checks returned 200; all five provider callbacks
matched the current development origin and credential.

Production Compose now forwards `QUANTSELF_GITHUB_WEBHOOK_SECRET` to the API.
Previously the container omitted it even when the VPS environment defined it.
Merged production Compose was checked with synthetic values; five deployment
tests passed. GitHub Actions has its own configured SSH credentials, so local SSH
authentication failure does not establish that Actions deployment is blocked.
The current provider and App callbacks target development; production deployment and callback cutover have
not occurred.

Subsequent [read-only Actions preflight](https://github.com/devdogfish/quantself/actions/runs/40619681687)
successfully authenticated to the VPS: all six existing services healthy,
39 applied migrations, zero unfinished migrations. Production is missing task/test
repository settings, GitHub App ID/installation/private key/webhook secret, and
ElevenLabs key/agent ID. The preflight therefore failed as intended. It skipped
all build, transfer, migration and deployment steps. Production task/Jarvis setup
is absent, rather than blocked by Actions SSH authentication. Current development
callbacks must not be cut over blindly: production needs an explicit environment
arrangement to preserve the active local voice setup.

The Owner subsequently chose “Finish current local setup; deploy later.”
Production configuration/cutover is therefore explicitly deferred.

Jarvis success/error task toasts were removed. Connection and delivery failures
remain inline in the sidebar with a review action; resolved delivery clears the
notice. Rendered tests cover denial, partial save, resolution and no toasts.

All-day/month events now share unfinished styling and accessible labels with
timed events, plus direct event links. Rendered regression checks cover compact
links and selection/edit separation; existing drag/context checks pass. Brave
month view visually verified, then restored to Day; no personal tasks mutated.

HTTP list responses now include the generation belonging to their returned rows.
A deferred API regression publishes a newer snapshot between list retrieval and
metadata retrieval, verifying that old rows retain their old generation and the
next read gets the new one. This avoids labeling stale rows with a newer cursor.

The Owner's deferred discussion topics are saved in
[Work to implement together](../implementation-together.md).

Final continuation verification: `bun run typecheck` passed on the committed
runtime; `bun run test` passed **1038 tests, 2 optional skips, zero failures**
on a clean source export through `e876d39`, with `--isolate` retained. This export
excluded concurrent, unfinished categorization edits in the shared checkout.
One earlier failure exposed random UUID ordering in a test fixture; deterministic
IDs now exercise the existing stable-identity ordering without changing behavior.
The cache Docker integration remains separately verified as above.

[Scaling measurements](todo-cache-scaling.md) cover 100/1,000/10,000 synthetic tasks,
including payload size and cold/warm request counts. Warm reads make zero GitHub
requests; 10,000-task full responses remain large (15.4 MB uncompressed), and
range filtering still processes the full projection. These are explicit scaling
limits, not claims of indexed server-side filtering or network latency.
