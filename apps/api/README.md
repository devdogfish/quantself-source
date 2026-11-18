# QuantSelf API

Bun/Hono entry adapter for public QuantSelf HTTP contracts.

Baseline routes:

- `/api/health` — container health
- `/api/v1/access-context` — authenticated Owner, Client, and Permission Set
- `/api/openapi.json` — live OpenAPI 3.1 document
- `/api/reference` — self-hosted Scalar
- `/api/reference.md` — generated Markdown reference
- `/llms.txt` — agent discovery

Add application operations under `/api/v1` through `OpenAPIHono` contract
registration. Private Inventory worker protocols live under
`/api/internal/inventory/*`; they are API-owned internal routes, not public
OpenAPI contracts.

```bash
bun run dev:api
bun test apps/api/src
bun run build:api
```

Task facts use `POST /api/v1/todos` and `PATCH /api/v1/todos/{number}` with
`todos:write`. Only a title is required for capture; every command also supplies a
stable UUID `commandId`. Edits supply before/after values for each target. Context
edits replace one unique prose fragment, preserving outside text and metadata.
The generated contract documents fields and per-operation outcomes. Inspect those
outcomes even for HTTP 200; task save and Project synchronization are independent.

Command receipts use the existing `api_idempotency_key` table; they contain no
second task store. Keep receipts indefinitely for retry safety. A reservation
commits before creating on GitHub. Lost responses reconcile by a body command
marker against all current issues, including closed issues. An absent ambiguous
create is never re-posted, including after restart; inspect GitHub before explicitly
capturing again with a new ID. Identical retries resume unfinished operations;
incompatible command reuse returns 409. Successfully verified operations are not
reapplied over later external changes. Writes serialize within one API instance.
GitHub provides no verified atomic body compare-and-swap: a final direct-edit race
remains possible, and readback reports divergence as uncertain.

Read tokens remain read-only. Write tokens request Issues write, Issue Fields read,
Metadata read, and organization Projects write, restricted to the configured task
repository. `QUANTSELF_TODO_PROJECT_NUMBER` selects the private organization `Me`
Project. Membership addition is idempotent; readback reconciles up to three times,
and a command attempts Project sync at most three times. Exhaustion requires manual
membership reconciliation. Missing Project configuration does not undo task saves.
Application-host acceptance with isolated live records remains release work.

Capture originals are retained indefinitely. After creating a capture with
conversational `transcript` text and source/provider IDs, upload received or
downloaded original bytes using `PUT /api/v1/todo-captures/{id}/audio`
(`todos:write`, `Content-Type: application/octet-stream`, `X-Audio-Mime: audio/ogg`,
optional `X-Audio-Duration` in seconds; maximum 50 MiB). Never transcode first.
Alternatively submit `conversation: [{role: "user", text: "Call plumber"}]`
instead of `transcript`; only user/assistant text is normalized and stored.
Provider adapters must extract only conversation text; tool traces, transport
headers and credentials are not transcript content. The strict capture contract
rejects extra transport fields and authentication-header text; request bodies and
headers must never be logged by provider adapters.

`GET /api/v1/todo-captures/{id}` returns transcript, links, deletion state and
relative-key/SHA-256/size/MIME/duration metadata. `GET .../{id}/audio` verifies size
and hash before authenticated playback; `?download=1` downloads the same bytes.
Both require `todos:read`, never public storage URLs. Source review in the task
interface includes playback, download, retention information and explicit deletion.
`DELETE .../{id}` requires `todos:delete`, distinct from ordinary writes. Durable
deletion intent revokes transcript/media access first; retries finish removing
original/temporary files and redacting PostgreSQL transcript/source metadata.
Task issues and link receipts remain intact (including any prose already copied
to GitHub). Deleted capture IDs cannot be reused. No automatic expiry.

Set `QUANTSELF_TODO_CAPTURE_ROOT` for direct API execution. Compose supplies a
persistent volume, configurable through `QUANTSELF_TODO_CAPTURE_VOLUME` (an
absolute host directory can select another disk). To relocate: stop API writers,
move all archive files preserving names, change root and/or volume configuration,
then restart. Do not change database relative keys. Back up metadata and files
together. A missing file returns 503; identical original-byte upload repairs it.
A corrupt existing file fails verification and is never silently overwritten;
restore the verified original from backup. Retry partial deletion until successful.
Docker DB/live application-host acceptance remains required before release.

Optional persistent archive HTTP fixture:
`QUANTSELF_TODO_ARCHIVE_DB_TEST=1 bun test --isolate apps/api/src/todos-audio-docker.test.ts`.
First discover the existing project database with `docker compose ps`, `docker ps`
and `docker compose port postgres 5432`; set `DATABASE_URL` from project credentials
and that published port. The fixture checks Docker/port before connecting, uses
unique capture IDs and an isolated temporary audio root, then removes only its
own metadata. No Docker runtime is started by the fixture.

`GET/POST /api/v1/todo-categories` reads/manages the Category field's options. Category
management uses a separate repository-restricted installation token requesting
Issues read, Metadata read, and organization Issue Fields **write**. Configure
that permission on the GitHub App and approve its installation update before
using category creation/rename/color/deletion. Normal task write permissions are
unchanged. Category commands use the existing durable receipt journal, validate
fresh option revisions, preserve existing IDs/descriptions/order, and reconcile
lost responses after restart. GitHub's replacement-options API has no verified
atomic compare-and-swap; simultaneous direct GitHub edits remain a race, detected
where possible through fresh reads and readback. Deletion checks the entire
configured task repository, including closed and trashed issues, not other
repositories in the organization.

Category writes check the installed GitHub App’s organization Issue Fields permission before requesting a write token. Read-only installations receive `403 TODO_CATEGORY_PERMISSION` before any option mutation; metadata reads remain available. This definite refusal must not be treated as an uncertain save.

Task deadline/time contract (#121): a lone non-null `start` or `end` seeds the other bound thirty elapsed minutes away on create/unscheduled tasks; a partial edit preserves the existing opposite bound. Omitted bounds remain unchanged, paired nulls clear, and single nulls are rejected. `deadlineAt` is an optional offset ISO instant (create value; edit `{before,after}` plus `revision`) whose Halifax date must match native `fields.Due`. Its managed `quantself:deadline` body comment is independent of scheduling. External Due edits retain the comment and expose `deadlineError` until explicitly repaired/cleared. Edits preserve unrelated prose/extensions. Native closed/not_planned issues without a duplicate target normalize as Trash and can be restored without requiring a marker.

### Optional task URL field

`fields.URL` stores newline-separated text (up to 2,000 characters), including
incomplete links. The native organization `URL` field must have type `text`.
Provision it before using URL edits with
`bun --env-file=.env apps/api/scripts/ensure-todo-url-field.ts` (dry run), then
repeat with `--apply`. The script uses the existing Issue Fields write permission,
creates only an absent field, and verifies readback; reruns are no-ops. It does not
edit tasks. Missing URL configuration must not block reads or unrelated writes;
URL writes fail explicitly until provisioned. Existing fields still validate type
and uniqueness.

### Task cache and live freshness

The authorized API keeps a rebuildable PostgreSQL read projection; GitHub remains
canonical. Normal list reads return the last complete projection immediately and
schedule a coalesced refresh when older than 60 seconds. `readAt` is the last
verified upstream read and `stale` reports a failed refresh. Write/precondition
scans and task details still read GitHub directly. Verified write results carry a
`cacheGeneration` so older SSE events cannot revert an acknowledged edit.

`GET /api/v1/todos/live` uses the same Owner ingress or API key authorization and streams
`snapshot`, `changes`, `heartbeat`, `resync-required`, and `access-denied` events.
Browser EventSource uses the same-origin session, never a credential URL. Events
replay with `Last-Event-ID` (or an initial `after` query); missing/expired cursors
receive a fresh snapshot. Access is rechecked per delivery/heartbeat, normally at
most 20 seconds apart. Slow readers disconnect after 10 seconds of blocked output.
`Cache-Control: private, no-store, no-transform` is applied after Hono creates the
stream response; this prevents Next compression from buffering events. Caddy
already flushes `text/event-stream`; no flush override is necessary.

Configure the GitHub App webhook URL as
`https://<public-api-host>/api/todo-webhooks/github` and set the identical random
secret in `QUANTSELF_GITHUB_WEBHOOK_SECRET` on the API. The handler verifies raw
HMAC SHA-256, the configured installation, and `QUANTSELF_TODO_REPOSITORY`, then
persists delivery identity/dirty work before replying. Subscribe to `issues`,
`issue_comment`, `issue_dependencies`, `sub_issues`, and `label`, plus installation
access events GitHub delivers to Apps. Native issue-field value changes arrive as
`issues.field_added` (set/update) and `issues.field_removed` (clear). Verify actual
App event availability; category option definitions retain periodic repair.

The API restarts outstanding dirty work. Webhook duplicate receipts persist for
30 days; publication events retain seven days (cleanup every 100 publications).
The initial coordinator is single-process; do not run multiple API replicas until
refresh ownership/lease coordination is introduced. A revoked installation clears
its protected projection; trusted unsuspend/re-add/permission-acceptance events permit rebuilding.
GitHub does not automatically retry webhook delivery, so browser foreground and
60-second visible polling remain repair mechanisms even while SSE is healthy.

Apply the task-cache migration on the existing Docker PostgreSQL. For the opt-in
persistence check set `TODO_CACHE_DOCKER_TEST=1` with the discovered project Docker
connection, then run `bun test --isolate apps/api/src/todos-freshness-docker.test.ts`.
This test uses a synthetic scoped projection and removes only that fixture data.
Fixture evidence: 64 records, one initial upstream list, one targeted read after
coordinator restart; 20 warm reads required zero further upstream requests.
Physical proxy, App delivery and authorization checks remain separate from fixtures.

For native development, set `QUANTSELF_DEV_GITHUB_WEBHOOK=1` and the webhook secret
in `.env`. `bun run dev` shares the current Cloudflare tunnel with Jarvis and uses
an App JWT to update and verify only webhook URL, JSON content type and secret.
Existing TLS verification policy, activation and subscribed events stay intact;
enable those in the GitHub App settings. The opt-in also works with
`QUANTSELF_DEV_JARVIS=0`. No credentials are logged. Next proxies the signed webhook
path to the API; the production Caddy `/api/*` route already covers it.

Cloudflare [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
explicitly do not support SSE: their edge buffers event streams even when the API
and Next forward frames immediately. Use the localhost dashboard for native
development; the quick tunnel still handles GitHub and Jarvis HTTP callbacks.
Public dashboard SSE requires a named tunnel or another streaming-capable proxy.
Live verification: API first snapshot 28 ms; Next localhost first snapshot 40 ms.
An isolated test-repository GitHub edit reached a loopback SSE subscriber in
1,347 ms with two canonical requests; delivery redelivery issued zero requests.

## Budgeting

Use a custom API key with `budgeting:read` and `budgeting:write` in your Codex session. Read `GET /api/v1/budgeting/plan`, then send explicit changes and the current revision to `PUT /api/v1/budgeting/proposal`. Reuse an entry's ID when updating it. The Owner reviews and applies the proposal in Budgeting. Keep the key out of the Budget Note.

Receipt extraction runs locally through Tesseract with English language data. The Docker images include it. For a bare API process, install Tesseract and English data on that host. The original JPEG, PNG, or WebP is saved before extraction. If extraction fails, the receipt remains available for retry and manual confirmation.
