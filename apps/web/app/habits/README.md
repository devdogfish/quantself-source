# Habits

`/habits` opens Today. Habits, Summary, Ask and System share the PR #241 page frame. `/habits/overview` redirects to `/habits/summary`; the old Overview and its contribution graph have been removed. Calendar quick-log provides dated check-ins.

## Catalog

PostgreSQL owns Habit definitions. Read the current projection and revision at `GET /api/v1/habits/definitions` and page past changes at `GET /api/v1/habits/definitions/history`. Apply changes at `POST /api/v1/habits/definitions/changes` with a UUID `commandId`, `expectedRevision`, a reason, and an ordered list of typed changes. Upserts replace the complete definition, including its display-only text details. An identical command retries safely. A stale revision or changed command ID reuse returns 409.

Definitions use stable lowercase IDs. Habit schedules inherit stack days unless overridden. Use `daily`, `weekdays`, or an array of lowercase weekday names. Cue-only stacks need no anchor or duration. Gates default to 10 of 14 for daily habits and 3 of 4 for one-day-per-week habits. Catalog and per-habit overrides are available. Pending habits never activate automatically.

Apply the PostgreSQL migration through the normal Docker deployment process. The one-time `apps/api/scripts/import-habit-catalog.ts` script imports the private `habits.yaml` as revision 1. Existing observations retain their definition SHA. New observations record the Catalog revision.

## Logging and reminders

`GET /api/v1/habits/day?date=YYYY-MM-DD` reads daily observations. `POST /api/v1/habits/commands` applies one status or note correction with a UUID command ID, habit/date, revision, and before/after values. Refresh after a 409. Retry the same payload after an uncertain save. The browser serializes dependent commands per occurrence and keeps Undo and Redo available while writes save.

Calendar quick-log stays on its selected date. Notes remain local while typing and enter the shared save queue as one edit on blur or Enter; Escape cancels the draft.

The minute worker and lazy daily read insert today's eligible observations in bulk. Stored open observations become missed after Halifax midnight. Absent historical dates remain unknown. A past done/minimum correction or future skip may create a row when that date is eligible. The slips API records independent resisted/slipped outcomes without changing build occurrences.

Day and week views at `/calendar` request a buffered range of up to 31 dates from `/api/v1/habits/calendar`. The read-only Habit lane opens the dated stack quick-log and stays independent of task timing and capacity. Set `alert: true` on a stack or eligible tracked habit to opt in at its Halifax anchor. A habit's `fallbackAt` can send one plan-B reminder. Logged habits suppress reminders.

## Overview and review

`GET /api/v1/habits/overview?weeks=4` returns the Fabric, Chains, Gate results, momentum, upcoming habits, neutral observations with AI prompts, and this week's review status. The default Fabric spans 28 local dates. Weekly habits use Sunday labels. Chains count done and minimum, survive one miss, and reset on two consecutive misses. Skips are transparent. Gates need their full eligible window before pass or fail.

`GET /api/v1/habits/summary` serves the complete Summary in one request. Four bulk database reads provide Catalog, revision history, bounded observation history and aggregated lifetime reps. Health uses five weighted parts; Minimum counts equally with Done. Sunday review completion comes from the `weekly-review` habit check-ins (`review` in the preview). Load uses recorded established transitions. Missing historical observations stay unknown; skipped occurrences remain transparent. Summary revalidates on navigation and once pending commands drain. Activity modes are local and make no requests.

`bun run preview:habits` uses samples. `--live` reads production with the existing `QUANTSELF_API_KEY`; `--snapshot /absolute/path.json` uses dated API responses captured from an authorized Owner session. Both run on loopback and reject writes. The header identifies samples, live production, or the snapshot timestamp. Snapshot files stay outside the repository; unavailable views fail explicitly instead of substituting sample records.

`bun run preview:habits --live-write` enables production check-ins, note corrections, and review creation. It uses `QUANTSELF_HABITS_PREVIEW_API_KEY` (or `QUANTSELF_API_KEY`) with explicit `habits:read` and `habits:write`. Without an authorized key, connect at `/api/v1/habits/preview-setup`; the setup form keeps its key only in the running process. The local relay preserves command IDs, revisions and conflict responses, requires same-origin JSON writes, and blocks permanent deletion and catalog edits. The header confirms that changes save to Quantself.

`POST /api/v1/habits/review` creates or reopens Sunday's review for the supplied Halifax date. A repository-scoped Contents-write token creates the review if absent. Concurrent requests preserve existing answers. The read-only Markdown viewer links to GitHub editing. `GET /api/v1/habits/context` exports the current Catalog, system and playbook, latest four reviews, and recent observations and urges. The UI copies only a complete bundle.

Review status distinguishes missing, existing, and unavailable documents. An existing document may still be a blank draft; it does not establish completion. Existing reviews open with a document read, and an unavailable archive no longer prevents practice analytics from loading.

Set the server-only `QUANTSELF_HABITS_REPOSITORY`, `QUANTSELF_HABITS_GITHUB_APP_ID`, `QUANTSELF_HABITS_GITHUB_INSTALLATION_ID`, and `QUANTSELF_HABITS_GITHUB_PRIVATE_KEY` separately from the task App. GitHub remains the source for System, playbook, and review documents. The overview checks one complete cached review index without reading review bodies. A failed or truncated index makes review status unavailable.

Habit reads require `habits:read`, writes require `habits:write`, and permanent urge deletion requires `habits:delete`. API Keys need explicit grants. Owner writes require a same-origin Origin header.


## Ask

`POST /api/v1/habits/ask` accepts `{ habitId, text }`. Read access is required for context; asking also requires `habits:write`. The browser allocates one `Idempotency-Key` UUID per intent, retains it across uncertain delivery, and replays the saved answer without another model call. Failed generation retains the ask and may retry the same ID. A live pending claim returns 409; an abandoned claim can retry after 60 seconds. Different input or another Client reusing an ID conflicts.

Ask narrows the existing `/habits/context` sources to the selected Catalog entry, its last 28 days of observations, and System/playbook. It does not fetch unrelated reviews, urges or the full history. Context/model work has a 20-second deadline, a 32KB context limit, a 64KB response limit, and bounded answer fields. The model infers the feeling. Answers await authoritative generation because their content cannot be predicted; drafts, habit selection and navigation remain usable. Log minimum uses the existing optimistic command queue, including Undo/Redo and conflict handling.

`GET /api/v1/habits/asks` returns the last 14 Halifax dates, 100 asks per page with an opaque cursor. The provider follows all pages. Each page uses one owner-scoped SQL join to that habit/day's current check-in. Outcomes and their revisions remain derived; Undo, Redo and corrections do not leave stale stored outcome labels. Analytics update from returned asks and optimistic check-ins without collection rereads.

The provider uses the existing `QUANTSELF_ELEVENLABS_AGENT_ID` and `QUANTSELF_ELEVENLABS_API_KEY`, with Jarvis's configured model. `bun --env-file=.env apps/api/scripts/sync-habit-ask.ts` previews the required conversation override configuration; `--apply` backs up, checks for drift, applies and verifies it. Only per-conversation text-only/empty greeting/strict tool/MCP restrictions become available; defaults, model, prompt, attached tools and access grants stay intact. Ask uses a private signed URL and a text-only WebSocket with an empty greeting, empty strict tool list and empty MCP list. The newer Agent Messages REST API is unavailable in this workspace and is not used.

Apply `20261113190000_habit_asks` through Docker migration deployment. No existing source data is rewritten. The approved live footer is “Jarvis uses this habit’s system and recent history.” Preview retains the original simulated-answer copy and components.
