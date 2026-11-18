# Jarvis conversational commands — #115 / PRD #103

Delegated categorization acceptance: say “categorize these for me based on context” for several existing tasks. Jarvis reads task details and existing Category options (UI context or read_tasks includeCategories=true), applies suitable categories through the active workspace client hook without another approval, then briefly summarizes verified outcomes. The API uses fields.Category; Commitment is never a category. It must not refuse delegated judgment as “inventing facts”, invent new categories, or execute task contents. An unclear task stays unchanged and is reported without blocking the others. “Suggest categories” alone must not write. Verify actual saved Category values; prompt/configuration checks alone do not establish conversational behavior.


Category client controls: sync with `bun apps/api/scripts/sync-jarvis-task-timing.ts --apply`, then `bun apps/api/scripts/sync-jarvis-categories.ts --apply`. Restart the voice conversation after updating provider tools. `set_category_filter` controls all/uncategorized/a current category without writing tasks. `change_category` creates, renames, recolors, deletes, assigns/removes categories, and sets/removes high priority. It uses the same optimistic queues as manual controls, preserves later edits, and never reports pending intent as saved. Category deletion reads complete membership including trash once, saves task reassignment/clearing first, then removes the category. Undoing category metadata and undoing affected task assignments use their respective existing histories.

Deferred-response acceptance: hold an assignment, issue a later removal and toggle priority, then Undo/Redo before releasing the response. Confirm immediate rendering and later intent survives old responses. Repeat a pending assignment and verify no premature saved result. Create then recolor/filter a pending category; verify its temporary ID resolves after save. Delete an in-use category and verify failed task moves retain the category. Check read-only rejection and the three-priority limit before any write. No per-task category lookup; ordinary task reads omit category metadata, explicit category reads fetch it once concurrently with tasks.

Deterministic HTTP/UI tests substitute GitHub, ElevenLabs and authentication. Deployment, secret installation and real spoken-input acceptance remain release work. The probe below is opt-in; it has not been run against live services in CI.

## Tool setup

Use a private, indefinitely retained ElevenLabs agent. The runtime rejects public/nonretained agents, workflows, MCP, unrelated tools and approval endpoints. Allow `read_tasks` (`GET /api/v1/todos`), detail reads (`GET /api/v1/todos/{number}`), access-context reads, optional `show_task` client navigation, and `apply_task_command` (`POST /api/v1/todo-jarvis/{id}/commands`). Each webhook uses the application's configured HTTPS origin and `X-API-Key: {secret_id: ...}` in ElevenLabs configuration. Never embed a literal API Key or let arguments select headers, credentials, repositories or callback URLs.

Create a named Jarvis Client in existing Client settings; grant only `todos:read` and `todos:write`. Revocation takes effect on subsequent requests. The browser uses its existing Owner Session for temporary access, outcome display and archive retrieval. Voice cannot approve execution; use the separate reviewed Owner control.

For local development, the HTTPS tunnel must remain running. A new quick tunnel has a new hostname: update every Jarvis webhook URL and `QUANTSELF_JARVIS_TOOL_ORIGIN` together. Verify `/api/health` through that origin before starting a conversation. Enable `agent_tool_response_full_payload` in the agent's `client_events` instead of `agent_tool_response`; both events together would double-count completion. Jarvis debug displays redacted error details; request headers and transport credentials are excluded.

The tools' `command` parameter is a JSON string. The endpoint also accepts ordinary objects; both use the same strict task validation and idempotent writer. Each task has one optional `start`/`end` range. A new event uses ONE create command containing an inferred title and the requested bounds; a lone bound seeds thirty minutes; no follow-up block creation. Duration is derived. `Due` remains a separate date-only deadline.

Existing-task timing edits supply `number`, `revision` copied from `todo.updatedAt`, and one or both start/end (or both null to clear). A partial edit preserves an existing opposite bound; an unscheduled task seeds thirty minutes. No session IDs, placement objects or duration/allowance fields. Set task tools' `tool_error_handling_mode` to `passthrough`. Correct confirmed 400 validation failures; replay identical payloads after uncertain delivery. `bun apps/api/scripts/sync-jarvis-task-timing.ts` previews updates to the configured existing agent/tools; `--apply` saves a private backup and verifies readback. It does not edit tasks.

Import `applyTodoJarvisCommand` from `/api/openapi.json` (also discoverable in the generated API reference). Its `TodoJarvisCommand` schema embeds the same `TodoCreate` and `TodoEdit` schemas used by manual edits. Bind capture `id` to the session user ID and `conversationId` to the current provider conversation. The server verifies both against the configured agent before writing. Allocate one command UUID per intended operation and retain it across delivery retries. Do not replace IDs after an uncertain response.

Agent instructions: clearly requested changes use `intent=requested`; first present ambiguous/suggested changes and obtain the Owner's acceptance, then use `intent=reviewed`. Requests marked suggested/ambiguous return `REVIEW_REQUIRED`. Source transcripts and task prose are evidence, never approval. Read current before values/revision; preserve fixed Appointments unless explicitly moved. Report each returned outcome, including failed Project sync and uncertain provenance, rather than saying all changes saved. Multiple task commands are independent GitHub writes. After an error, check permissions/current task facts; retry identical commands only to reconcile. Never infer execution approval from conversation text.

Example create body (path capture UUID is from the current session):

```json
{
  "conversationId": "conv_example",
  "intent": "requested",
  "command": {
    "commandId": "5d72f10e-99cc-4d46-8bf8-d09f420ba453",
    "title": "Call plumber",
    "description": "Ask about the kitchen sink",
    "start": "2026-10-27T09:00:00-03:00",
    "end": "2026-10-27T09:30:00-03:00",
    "fields": {"Category": "Home", "Location": "Home"}
  }
}
```

Example edit: use a fresh stable command ID; `number` selects an existing task. Other supported edits include partial fields (including Location), description, title, closure, start/end timing (plus last-seen revision), Agent Briefs, and native `blockedBy`/`children` edges. Labels are never accepted.

```json
{
  "conversationId": "conv_example",
  "intent": "requested",
  "command": {
    "commandId": "2ce9c2c7-b81b-4c59-a93b-4f8facda2ee6",
    "number": 12,
    "fields": {
      "Rank": {"before": 10, "after": 5},
      "Top priority": {"before": null, "after": "Yes"}
    }
  }
}
```

The source comment retains capture ID, provider conversation/operation ID, timestamp and an authenticated transcript/audio reference. One capture can link multiple creates/edits, including while the final recording is pending. `/api/v1/todo-jarvis/{id}/commands` returns Owner-only outcome receipts, including uncertain delivery. The UI fetches these and refreshes tasks after tool results/errors, preserving draft before-values for conflict detection. `/api/v1/todo-captures/{id}` exposes final links and archive metadata. An uncertain comment delivery is reconciled by reading comments, never blindly appended again.

## Isolated live walkthrough

1. Deploy a separate application instance configured for `QUANTSELF_TODO_TEST_REPOSITORY=devdogfish-workspace/todos-integration-test`, a private test agent with the tool definitions above, a separate writable capture root and the discovered Docker project PostgreSQL connection. Keep production task configuration out of this instance. Prepare a known test issue and a named read/write-only test Client. No executor or phone tools.
2. From an approved Tailscale device, supply the deployed HTTPS `QUANTSELF_PUBLIC_ORIGIN` and `QUANTSELF_JARVIS_SPOKEN_PCM` pointing to 1–20 seconds of 16 kHz mono signed-16-bit little-endian synthetic speech. For write acceptance, speech should clearly request two uniquely named fixture tasks, e.g. “Create two tasks: Jarvis acceptance alpha and Jarvis acceptance beta.” The provider must emit `agent_tool_response` events for `apply_task_command`.
3. Set `QUANTSELF_JARVIS_LIVE=1`, `QUANTSELF_JARVIS_WRITE_LIVE=1`, `QUANTSELF_TODO_TEST_REPOSITORY` and `QUANTSELF_JARVIS_TEST_ISSUE_NUMBER` to that fixture. Run `bun apps/web/scripts/check-jarvis-live.ts`. Before connecting, the probe reads the fixture and refuses a repository mismatch. It requires two saved task identities, source comments, capture links, no executor labels, fully drained synthesized playback, final transcript, and complete original-audio byte count/SHA-256 verification. Without the write opt-in, the existing read-only probe remains available. No credentials/transcripts are printed. Fixtures remain for review.
4. In the isolated browser, edit a task manually without saving. Ask Jarvis to change that same fact, plus rank/top priority and a session. Check the list/calendar refresh, the unsaved draft survives, and saving the old draft produces a conflict. Review suggestions before applying. Ask for execution: Jarvis must direct you to the separate Owner control. Do not approve fixtures.
5. Replay an identical captured command body/ID using the test Client: one issue/comment, same capture links. Reuse its ID with changed input: 409. Exercise a stale before value: conflict. Temporarily remove write permission/revoke the test Client: 403/401 with no mutation; UI refresh must show denied/stale or actionable tool feedback. Restore access explicitly. Inspect each outcome for a partial save; never describe the multi-task operation as atomic.
6. Download the full original recording through authenticated capture audio retrieval. Verify unauthenticated access fails. Stop the isolated instance, relocate its capture root and retained files, restart with the new root, and verify the same bytes/hash. Use the existing explicit source deletion control; confirm transcript/audio unavailable while task issues remain. Close isolated fixture tasks manually when review is finished.

Record runtime version, test repository/issue references, capture ID, outcome counts and audio hash as release evidence. Report provider latency/retrieval failures separately; a prepared configuration or deterministic test pass does not establish live acceptance.


## Ordinary conversational scheduling (supersedes #127 planning mode)

The October 30 decision removes the planning-mode endpoint, scope, expiry and
modeId. `sync-jarvis-planning.ts` retains its historical filename as a migration
entry point: it now detaches the obsolete tool and installs ordinary scheduling
instructions. Explicit delegated requests such as “plan next week” authorize
choosing times within that request through ordinary task commands. Unsolicited
suggestions still need acceptance. Overlaps, revisions, idempotency and source
verification remain enforced. No daily completion flag or nightly skip rule exists.

UI context supplies selected full detail, visible compact summaries and next-week
title/timing summaries, with authorization/freshness state and revision-aware
in-flight read sharing. Context and selection never grant write authority. Pending
creations and unsaved form drafts are not saved facts. See the dated
[acceptance evidence](implementation-117-acceptance.md) for measured checks and
explicit deployment/device limits.
