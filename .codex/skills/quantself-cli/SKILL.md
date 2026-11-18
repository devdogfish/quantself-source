---
name: quantself-cli
description: Use when the Owner requests Quantself Job Applications, to-dos, Appointments, or Calendar through the quantself CLI, or when a task depends on those Quantself records. Read by default and write only on explicit request.
---

# Quantself CLI

1. Run `quantself --help` to see the available operation IDs. From a prepared Quantself checkout, replace `quantself` with `bun run --silent quantself` to keep Bun's runner diagnostics out of the JSON streams. For installation and credential setup, see [setup](references/setup.md).
2. Run `quantself <operationId> --help` to check the operation's required permissions and inputs. Pass JSON objects to `--path` and `--query`, and pass the operation's JSON request to `--body`. Send `--idempotency-key` when the operation declares that header. Use IDs and revisions from server results.
3. Read the JSON result on stdout or the JSON error on stderr and check the exit status. Follow pagination when the request needs every match. Confirm a write from the returned result or a fresh read if its outcome is uncertain. Keep Agent-owned tasks in Bot HQ.

## Jobs

- Use `listJobApplications` and `getJobApplication` with `jobs:read`. Set `view` to `records` to include records outside the default review view. For more pages, pass `nextCursor` back as `cursor`, keeping the filters. Read `status` and `sourceUrl` for the application state and posting link. `getJobCandidateContext` reads the non-sensitive candidate context with the same permission.
- `importJobApplications` needs a separate regular API Client key with `jobs:write`. Import up to 100 public postings per call and check `imported` and `duplicates`. Reuse the same key and payload for an uncertain retry. Use a new idempotency key for a new batch.
- For `patchJobApplication`, use an Agent Client key with `jobs:write` to get audited Undo. Fetch the draft immediately before writing. Supply its current `revision` as `expectedRevision` with the requested `summary` or `resumeTrack`. The application must be in draft or review, with no approval, pending work or issues. The Owner's edits start a three-minute hands-off window. When it blocks a write, wait out the window, reread and reconcile the requested change. Editing the full résumé or changing the summary when a full résumé is already saved requires the Owner. Save the returned `auditId` for the Owner's Undo.
- Approval, submission and application decisions are Owner controls. Share posting links or drafts with the Owner for review. Use Bot HQ for conversation and hand-back. Quantself has no Messages operations.

## To-Dos, Appointments and Calendar

- Create an Owner-requested Quantself To-do in the Owner's Inbox with `quantself createAgentInboxTodo --idempotency-key <fresh-uuid> --body '{"title":"Call the plumber"}'`. Use an Agent key with `todos:write`. Keep the returned `auditId` for Owner Undo. Retry uncertain writes with the original key and body. Keep Agent-owned work in Bot HQ Tasks.
- Verify a To-do you added with `quantself getCreatedInboxTodoStatus --path '{"id":"<todo.id from creation receipt>"}'` and `todos:read`. `inbox` means it is in the Owner's Inbox. The other results are `completed` and `undone`.
- Use `listTodos` and `getTodo` with `todos:read`. `getTodo` takes the issue `number`. Use the returned `url` when linking a to-do. For Calendar task reads, supply inclusive local dates as `from` and `through`, plus the viewing IANA `timeZone`. Appointments are tasks with `fixed: true`. Keep their timing intact when planning around them. If the list says `stale: true`, surface that before relying on the schedule.
- Use `reviewTodoSuggestion` with `todos:read` to validate planning advice using the current task `updatedAt` and exact before values. For timing advice, include the same revision in the command. If the result says `stale: true`, reread and review again. Present the validated advice for Owner review. Agent keys cannot create, edit, or approve GitHub-backed to-dos.
- For habit blocks displayed in Calendar, use `getHabitCalendar` with `habits:read`. It takes inclusive Halifax dates `from` and `to` for up to 31 days. Check `stale`. Read task and habit Calendar sources separately. Subscription payments, scheduled bills and income require the Owner's session. There is no aggregate Calendar endpoint.

## Errors and retries

- Invalid arguments or HTTP 400/422: check operation help and fix the named field or header. HTTP 413: shrink the request.
- HTTP 401: check the configured origin and whether the key is active. HTTP 403: check the required permission and credential type. An Agent key's write restrictions still apply when it has the grant.
- HTTP 404: verify the record identifier and the selected deployment. HTTP 409: read the message and resolve the specific conflict. Reread stale revisions and compare current state with the Owner's intent. An idempotency conflict means the key already identifies different input.
- Transport failure or HTTP 429/5xx: retry reads with backoff and honor `Retry-After` when supplied. For writes, follow the operation's retry contract. After an uncertain draft patch, reread and check the revision and saved fields before deciding on a new write.

## Examples

Use real returned IDs and current revisions for live work. These commands use example records and dates.

```sh
quantself listJobApplications --query '{"view":"records","status":"applied","limit":10}'
quantself getJobApplication --path '{"id":"49db114d-041b-4e68-a82c-2050a3a47ac5"}'
quantself listTodos --query '{"from":"2026-11-16","through":"2026-11-22","timeZone":"America/Halifax"}'
quantself getHabitCalendar --query '{"from":"2026-11-16","to":"2026-11-22"}'
quantself getTodo --path '{"number":"42"}'
```

This explicitly requested draft edit assumes you just read revision 3.

```sh
quantself patchJobApplication --path '{"id":"49db114d-041b-4e68-a82c-2050a3a47ac5"}' --body '{"expectedRevision":3,"summary":"Built internal web tools and maintained their public APIs."}'
```

Use a regular scoped API Client credential for this explicitly requested import.

```sh
quantself importJobApplications --idempotency-key d01aeb43-f10c-40f5-a1b4-303790588bee --body '{"applications":[{"company":"Example Studio","role":"Web Engineer","sourceUrl":"https://example.com/jobs/123","resumeTrack":"web"}]}'
```
