# To-do caching and live freshness

Researched 2026-10-27. Research and proposed design only; no infrastructure, credentials, GitHub subscriptions, database, or runtime settings changed. Intended as an offline implementation reference.

## Recommendation

Put the rebuildable task read cache in the **Quantself API**, persist it in the existing Docker PostgreSQL, and send authenticated **Server-Sent Events (SSE)** to the existing Web Client task store. Keep GitHub authoritative. Cache publication is a verified projection of GitHub state, never an alternate write path. Use the same cache for browser, Jarvis, and other authorized Clients.

This is a design recommendation, not a framework requirement. It fits ADR 0012's API boundary and avoids a second cache in Next.js. The Owner explicitly requested task caching, reversing the earlier no-task-cache policy; implementation must reconcile that policy in ordinary repo documentation/ADRs. Do not edit protected GitHub systems documentation without explicit approval.

## Verified local baseline

- Next.js **16.2.9**, React 19.2.4, Hono **4.12.32**, Docker Bun **1.3.4**. Next configuration does not enable `cacheComponents`.
- Caddy routes `/api/*` directly to the API; browser task fetches bypass Next.js. The Next development rewrite also forwards to the API. See [Caddyfile](../../Caddyfile), [Next configuration](../../apps/web/next.config.ts), [web dependencies](../../apps/web/package.json), [API dependencies](../../apps/api/package.json), and [Docker image](../../Dockerfile).
- [API startup](../../apps/api/src/index.ts) already sets `idleTimeout: 120`.
- The [shared task store](../../apps/web/app/todo/todo-live.ts) already merges optimistic changes, retains stale data, and reads with browser `cache: no-store`. Keep these conflict/intent protections.
- Existing [GitHub adapter tests](../../apps/api/src/todos-github.test.ts) demonstrate one batched GraphQL list request for 32 fixture tasks and two concurrent queries for normal detail after setup. Those are test expectations, not live latency measurements.

## Next.js 16.2.9 findings

The table links **version-pinned upstream documentation**, because the live site currently documents a newer release. No Next upgrade is required for the recommended design.

| Facility | Verified behavior | Fit here |
| --- | --- | --- |
| `use cache` | Requires `cacheComponents`; generated keys include build/function identity and arguments. Read cookies/headers outside the cached scope. [16.2.9 source](https://raw.githubusercontent.com/vercel/next.js/v16.2.9/docs/01-app/03-api-reference/01-directives/use-cache.mdx) | Useful for Next-rendered output; does not cache Hono requests automatically. |
| `cacheLife` | `stale` controls client reuse, `revalidate` controls request-triggered background refresh, `expire` controls blocking freshness. Time-based client stale minimum is 30 seconds. [16.2.9 source](https://raw.githubusercontent.com/vercel/next.js/v16.2.9/docs/01-app/03-api-reference/04-functions/cacheLife.mdx) | Timers are not a push transport or a guarantee of immediate freshness. |
| `cacheTag` | Associates cached output with invalidation tags. [16.2.9 source](https://raw.githubusercontent.com/vercel/next.js/v16.2.9/docs/01-app/03-api-reference/04-functions/cacheTag.mdx) | Tagging would help only if a Next cache is deliberately introduced. |
| `revalidateTag` | Server Functions/Route Handlers only. `"max"` marks stale; the next visit triggers refresh. `{ expire: 0 }` expires immediately for webhook-style use; one-argument form is deprecated. [16.2.9 source](https://raw.githubusercontent.com/vercel/next.js/v16.2.9/docs/01-app/03-api-reference/04-functions/revalidateTag.mdx) | Neither eagerly refreshes the API cache nor broadcasts updated task data to open browsers. |
| `updateTag` | Server Actions only; expires data so next read waits for fresh results. [16.2.9 source](https://raw.githubusercontent.com/vercel/next.js/v16.2.9/docs/01-app/03-api-reference/04-functions/updateTag.mdx) | Cannot be invoked from Hono or a webhook Route Handler. |
| `use cache: remote` | Uses a configured remote cache handler for persistent/shared data; adds storage and network cost. [16.2.9 source](https://raw.githubusercontent.com/vercel/next.js/v16.2.9/docs/01-app/03-api-reference/01-directives/use-cache-remote.mdx) | Redundant if the API already owns the shared cache. |
| `use cache: private` | Experimental in this version; results live only in browser memory, disappear on reload, and cannot use custom cache handlers or Route Handlers. [16.2.9 source](https://raw.githubusercontent.com/vercel/next.js/v16.2.9/docs/01-app/03-api-reference/01-directives/use-cache-private.mdx) | Does not provide durable task caching. |

`router.refresh()` refreshes Server Component output without invalidating server caches; it is not a subscription to GitHub or the browser's custom task store. [Next router reference](https://nextjs.org/docs/app/api-reference/functions/use-router)

If a future feature adds a Next cache, keep it a disposable presentation layer and explicitly invalidate it. Self-hosted caches require storage/tag coordination across instances; local defaults should not be assumed durable across container replacement. [Next self-hosting](https://nextjs.org/docs/app/guides/self-hosting)

## Proposed API cache contract

The following are implementation decisions recommended by this research, not claims about current code.

1. Persist normalized task projections keyed by Owner, configured repository identity, task identity, and schema version. Store category metadata separately. Keep collection completeness, generation, last successful GitHub verification time, and refresh status. Derive list/calendar filters from indexed projections; load full detail separately when needed. Never label a partial pagination result as a complete snapshot.
2. Authenticate and authorize every read before consulting the cache. Do not cache permission decisions. Use private/no-store HTTP responses while still caching internally: these control different layers. On denied access, clear Web Client data and stop the stream; a GitHub outage may retain a visibly stale snapshot, but known installation revocation must not.
3. Return the last complete snapshot promptly, including `readAt`, generation, and stale/refreshing state. A first-ever cold cache must show explicit loading and populate through the existing paginated bulk reader. An empty cache is not evidence of an empty task collection.
4. Coalesce overlapping refresh requests by repository/query scope. Fetch a known changed issue using the smallest existing complete detail read; batch bursts and refresh dependent readiness where needed. A small set of issue changes must not trigger a collection reread per issue or browser.
5. Mutations retain fresh GitHub validation, before-values/revisions, prerequisite checks, and existing idempotency receipts. Do not authorize a write from stale cached state. After verified success, update projections from returned records and publish changes; partial/uncertain outcomes remain pending and reconcile normally.
6. Serialize publication with monotonic cache generations. A refresh started before a write cannot replace that newer write. Retain per-issue dirty generations so a second invalidation arriving during refresh forces another pass. Do not rely only on timestamps: independent reads and same-second changes can race.
7. Store webhook work and publication events durably. Atomically commit a verified projection with its event/outbox record; fan out after commit. On restart, resume dirty work and pending events. A deleted projection can be rebuilt; idempotency/capture evidence must not be treated as evictable cache data.
8. Keep a single API process initially. If replicas are introduced, use a database lease for refresh ownership and a durable event cursor shared by subscribers. PostgreSQL `NOTIFY` may wake consumers after commit, but is not a replay log; readers must recover from durable rows. [PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)

Persisting a read projection in PostgreSQL explicitly revises the old prohibition on storing task data there; GitHub authority remains unchanged. No cache write may create an Owner task decision.

## GitHub webhook contract and repair

Subscribe to relevant `issues` activity, including closure/reopen, body/title edits, creation/deletion/transfer, label assignment, and native Issue Field changes. **`field_added` means either setting or updating a value; `field_removed` means clearing it.** These belong to `issues`, not Project custom-field events. [GitHub Issue Fields](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-and-managing-issue-fields)

Label-definition changes use `label`; assignment/removal uses `issues` actions `labeled`/`unlabeled`. Include `issue_comment`, `issue_dependencies`, and `sub_issues` when their data participates in displayed detail/readiness. Handle installation/repository-access changes to invalidate access. [Webhook catalog](https://docs.github.com/en/webhooks/webhook-events-and-payloads)

Verify the raw-body HMAC SHA-256 against `X-Hub-Signature-256` with constant-time comparison before processing. Keep the secret server-side; also enforce the configured installation/repository allowlist. [GitHub signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)

Accept a valid delivery into durable work, deduplicate by `X-GitHub-Delivery`, then acknowledge within GitHub's 10-second limit. Do not wait for a GitHub refetch before replying. Handle unknown actions without crashing or silently treating them as task edits. [Webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)

Use payloads as invalidation hints, then read canonical GitHub state. This prevents delayed/out-of-order payloads from reverting the projection. Tombstone deleted/transferred issues only after validated event semantics or verified absence; distinguish absence from access loss.

**GitHub does not automatically retry failed deliveries.** Retain open/refocus repair and a bounded periodic reconciliation while active; optionally add delivery-log redelivery using approved App permissions. [Failure handling](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)

Proposed initial repair policy: coalesce open/refocus refreshes; retain the existing roughly 60-second visible safety check until live webhook coverage is verified. Afterwards tune based on measured traffic. Reconcile periodically even with a connected SSE stream, because transport health does not prove all GitHub events arrived. Category definition/option changes need a live isolated test: this research confirmed value events, not exhaustive metadata event coverage. Refresh category metadata in the repair cycle.

## SSE transport and browser behavior

SSE fits one-way updates; writes remain ordinary authorized HTTP commands. The standard supports event IDs, automatic reconnect and `Last-Event-ID`. Native `EventSource` does not expose arbitrary authorization headers; use same-origin Owner Session authentication for the Web Client, not a secret in the URL. [HTML SSE standard](https://html.spec.whatwg.org/multipage/server-sent-events.html)

Hono 4.12.32 already supplies `streamSSE`, `writeSSE`, event IDs/retry fields, and streaming cleanup. Authenticate before streaming starts; errors after headers cannot become an ordinary HTTP error response. [Pinned Hono implementation](https://raw.githubusercontent.com/honojs/hono/v4.12.32/src/helper/streaming/sse.ts), [streaming helper](https://hono.dev/docs/helpers/streaming)

Recommended endpoint behavior:

- Send bounded `task-upsert`, `task-remove`, `categories-changed`, freshness, and `resync-required` events. Include ordered event IDs/cache generations; exclude secrets and unnecessary full comments/audio.
- Replay retained events after the supplied cursor. If the cursor expired or schema changed, send `resync-required`; fetch one authenticated snapshot and resume without a snapshot/subscription race. Snapshot generation and event cursor must refer to the same publication boundary.
- Integrate deltas under existing optimistic overlays. Older events must not erase newer intent, Undo/Redo, selection, or unsaved text. Do not refetch all tasks for each event or per tab.
- Send a heartbeat about every 20 seconds; clean up on abort, bound queues, and disconnect slow consumers so reconnect/resync repairs them. Recheck permission during stream life and stop publishing when revoked. Close hidden-page streams when appropriate and always repair on foregrounding.

Caddy immediately flushes `text/event-stream` responses. Do not blindly add `flush_interval -1`: that mode also changes upstream cancellation behavior. Test through the actual proxy and compression path. [Caddy streaming](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming)

Bun streaming is subject to idle timeouts. The repository's 120-second setting exceeds the proposed heartbeat interval. Current Bun docs also describe per-request timeout control, but verify availability against pinned Bun 1.3.4 before using it. [Bun HTTP server](https://bun.sh/docs/runtime/http/server#idletimeout)

## Validation and limits

Extend the approved API, rendered workspace, and Jarvis seams. Test delayed refresh/write races, duplicate/out-of-order webhooks, partial pagination, reconnect cursor gaps, restart recovery, revoked access, GitHub outage, deleted tasks, and optimistic Undo/Redo under pushed changes. Test a fresh snapshot followed by a concurrent event with no missed or duplicated state.

Measure, separately: initial cold setup, warm cache response/render, underlying refresh, webhook-to-visible latency, SSE reconnect, request counts, payload bytes, and behavior at increasing record counts. Targets: warm cache delivery waits for zero GitHub requests; a local successful single-task write causes no extra collection reread; one changed issue refresh is shared across all connected dashboards. Preserve normal detail's at-most-two GitHub-request target after authentication, with explicit pagination exceptions. These are acceptance targets, not measured results.

The API cache improves first load by removing GitHub latency, but still needs the Owner's server. Instant rendering after a full browser reload while disconnected requires a separate persistent browser read cache and application shell strategy; in-memory state alone does not satisfy it. Treat that as an explicit extension, with permission/logout clearing, not an accidental promise. Read caching also does not implement offline capture or an offline mutation queue.

No implementation benchmark, deployed SSE check, or live webhook delivery was performed. Required host checks: webhook subscriptions/secret and permissions, issue-field/category event coverage, HTTPS/proxy streaming on desktop and phone, and Docker restart recovery. The design and pinned documentation above are sufficient for offline coding; these checks still require the real integration environment.
