# Native Jobs interview Appointment contract

The backend slice is based on `b83eedec6184be9e2e5a3e6834472c7a993dd43a`. It supports linked interview Appointments for #182 and #196. Their full acceptance also needs mixed-source Calendar and To-do views and synthetic alert delivery.

## Identity and commands

- Lifecycle `appointments` and the Owner scheduling response discriminate on `source`. A `github` Appointment has the JobInterview UUID `id` and positive `todoNumber`. A `native` Appointment uses the same UUID as its canonical Appointment identity, with `revision` and nullable `cancelledAt`. Both carry normalized UTC `start` and `end`. Route native detail via `/todo?appointment=<id>` when its view is ready. Legacy links use `/todo?task=<todoNumber>`.
- Agent CLI operation `scheduleJobInterview` posts to `/api/v1/jobs/applications/{id}/interviews/native` with the explicit `jobs:schedule-interview` grant, `Idempotency-Key`, `start`, `end` and `expectedRevision` from `getJobLifecycle`. The result is `{appointment, auditId?}`. Owner Undo uses the existing same-origin audit route and the native Appointment revision. Active lifecycle results omit cancelled Appointments.
- The original Owner endpoint keeps its session, grants and start/end input. For any existing slot, its stored source wins. The normalized application/start slot remains reserved even after Undo. An equivalent offset uses the same slot. A changed end conflicts. A legacy slot pending GitHub acknowledgement stays on the original Owner reconciliation path. The Agent never dispatches it. A retry with the same command key returns its stored receipt. A fresh key for a reserved slot returns the current identity and state. Audit attribution follows the original Agent Client.

## Activation

With `QUANTSELF_NATIVE_JOB_INTERVIEWS` unset, new Owner requests retain the legacy writer and the Agent reservation route responds 503. Apply the additive migration, deploy source-aware code and drain every old interview writer before enabling native scheduling. The former writer treats null `todoNumber` as an unresolved GitHub write. After native reservations exist, rollback must stay on a source-aware build or disable the interview write routes. Existing rows, including pending rows with null `todoNumber`, receive the GitHub discriminator.

Enable native scheduling only once the UUID detail view and alert wiring are ready for release.

## Acceptance

Use real scoped fixture keys through the generated CLI with disposable PostgreSQL. Check explicit grant and Owner isolation, current Job revision and three-minute window, concurrent equivalent starts, a lost acknowledgement and exact retries, pending and confirmed legacy slots, and conditional Owner Undo after a competing edit. Exercise the existing Owner route with a synthetic writer. Follow with mixed-source views and fake push sender checks before closing either issue.

## Owner read boundary

- `GET /api/v1/jobs/interview-appointments?from=<instant>&to=<instant>` uses offset-aware instants and an exclusive end. It accepts an ordered interval up to 370 elapsed days. Intersections include preparation and travel. The response is `{ appointments, nextCursor }`. The default limit is 100 and the maximum is 200. Supply `afterStart` and `afterId` together from `nextCursor` for subsequent pages, ordered by current start and UUID. Cancelled rows are excluded. Restart pagination after edits.
- `GET /api/v1/jobs/interview-appointments/{id}` uses the native UUID and returns its current row, including its cancellation timestamp when cancelled. It returns 404 outside the authenticated Owner's scope. Both routes require an Owner session and Jobs Read and work with creation disabled.
- Each row contains `source: "native"`, `id`, `applicationId`, `title`, UTC `start` and `end`, `fixed: true`, `allDay: false`, `category: "Job search"`, `beforeMinutes`, `afterMinutes`, `alertMinutes`, `revision` and `cancelledAt`. Buffers are 0–1440 minutes. `alertMinutes` defaults to 10, accepts 1–10080, and null disables alerts. The worker can reuse this record shape with its internal Owner-scoped database read. Recheck the current revision and cancellation state before using a planned alert. Native mutation revisions advance monotonically.

## Owner edit and cancellation

- `PATCH /api/v1/jobs/interview-appointments/{id}` requires a same-origin Owner session, Jobs Write and `Idempotency-Key`. It returns the current `NativeJobInterviewAppointment` shape from the detail route. It works with native creation disabled.
- Send `{ "action": "update", "expectedRevision": 1, "beforeMinutes": 15 }` to change one or more fields. Supported fields are the paired offset-aware `start` and `end`, `beforeMinutes`, `afterMinutes` and `alertMinutes`. The end must follow the start. Omitted fields keep their value. Set `alertMinutes` to null to disable alerts.
- Send `{ "action": "cancel", "expectedRevision": 1 }` to cancel. The response includes the new revision and `cancelledAt`. Detail reads still return the tombstone and range reads omit it.
- Accepted commands advance the native Appointment revision and invalidate its creation Undo. The alert worker rejects an earlier plan when its pre-send read sees a new revision or cancellation. The original application/start reservation stays bound to the same Appointment UUID. Moving to another occupied start for the same application returns 409, including pending GitHub reservations. Creating at a moved Appointment's current start also returns 409.
- Another Owner's UUID, an unknown UUID or a legacy Appointment returns 404. A stale revision or a new command against a cancelled Appointment returns 409. Retrying the same key and command returns its original response.

## Reproduce the backend fixture

Create disposable Docker databases named `native_interview_fixture` and `jobs_lifecycle_fixture`. In the first, apply migrations from `b83eedec`, apply [the legacy fixture](../../apps/api/src/fixtures/native-job-interview-legacy.sql), then run `bun run --cwd packages/db migrate:deploy-only` on this branch. In the second, apply this branch's migrations from empty. Generate Prisma and the mounted CLI before running the tests. Run `QUANTSELF_NATIVE_INTERVIEW_FIXTURE=1 bun run test apps/api/src/jobs-native-interview-docker.test.ts` with a synthetic auth secret and localhost auth origin. Run `QUANTSELF_JOBS_LIFECYCLE_FIXTURE=1 bun run test apps/api/src/jobs-lifecycle-docker.test.ts` against the second database with auth origin `https://quantself.example.test`. Both suites use synthetic task writers.

The Owner range and detail each use one PostgreSQL source query. Pagination never invokes the legacy reader. The native detail/calendar and alert handlers can share the source shape without using the numeric GitHub key.
