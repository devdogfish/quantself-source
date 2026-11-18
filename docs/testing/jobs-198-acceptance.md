# Jobs end-to-end acceptance (#198)

[Acceptance issue](https://github.com/devdogfish/quantself/issues/198) · [Jobs operating spec](https://github.com/devdogfish/quantself/issues/183)

## Acceptance checklist

- [x] Synthetic evidence recorded with measured latency and request counts. The inactive n8n pilot carried the same held draft through Owner PDF release, Chrome receipt, verified mailbox match, audited outcome, native Appointment and inert reply. See [the combined rehearsal](#197-importable-one-posting-pilot-and-same-draft-handoff) and [merged PR #435](https://github.com/devdogfish/quantself/pull/435).
- [x] Synthetic restarts and duplicates exercised across intake, Chrome submission and reconciliation, outcome and Undo, Appointment creation and alerts, and reply dispatch. The table links the measured proofs.
- [ ] Run the combined live sequence after #197 verifies a provider-backed billed-input ceiling within the $0.10 pilot budget and the Owner approves activation. Record the same application's live portal receipt, mailbox match, Undo, Appointment and alert, Owner-sent reply, and aligned SES authentication. [#197](https://github.com/devdogfish/quantself/issues/197) · [Remaining live gates](#remaining-live-gates)

| Boundary | Measured requests and elapsed | Restart or duplicate result |
| --- | --- | --- |
| n8n held intake and approved PDF | The active pilot execution took 8.54 s. One gateway screen in 195 ms produced one native TLS screening POST. Two intake attempts took 197 and 18 ms. | Lost response replay reused the exact key and bytes. One held draft, one Review revision and one approved PDF handoff. Fresh-key feed dedup in [#336](https://github.com/devdogfish/quantself/pull/336) returned three duplicates and queued zero work. PDF identity was also verified in [#339](https://github.com/devdogfish/quantself/pull/339). [#435](https://github.com/devdogfish/quantself/pull/435) |
| Chrome and durable receipt | The same-draft phase made 11 Jobs calls, one portal GET and one portal POST in 2.28 s. Restart made three Jobs calls in 143 ms. | The same receipt survived with zero repeated portal requests. A separate crash before receipt capture required Owner reconciliation, with zero repeat submits. [#435](https://github.com/devdogfish/quantself/pull/435) · [#343](https://github.com/devdogfish/quantself/pull/343) · [#340](https://github.com/devdogfish/quantself/pull/340) |
| Mailbox match, outcome and Owner Undo | Three messages used 18 IMAP commands. One verified match used one Jobs lookup in 193 ms. Outcome, Undo and reapply used nine Jobs requests in 242 ms. In the API restart proof, the three Undo calls took 171, 172 and 201 ms. | Forged alias and conflicting references made zero Jobs requests. One Undo event survived restart. A late Undo replay preserved the reapplied outcome, Appointment and original submission receipt. [#435](https://github.com/devdogfish/quantself/pull/435) · [#490](https://github.com/devdogfish/quantself/pull/490) |
| Native Appointment and alert | Scheduling made two POSTs in 211 and 168 ms after separate 596 and 584 ms API startups. Four alert workers made 1/0/1/0 loopback push POSTs in 165/158/181/158 ms total per worker. | One Appointment and one creation audit across API restart. Alert lease expiry allowed one retry with the same topic and tag. One confirmed alert receipt prevented later sends. [#429](https://github.com/devdogfish/quantself/pull/429) · [#491](https://github.com/devdogfish/quantself/pull/491) |
| Threaded reply | Exact synthetic draft used five IMAP commands, two Jobs requests and one inert SES request in 71 ms. Receipt replay took 1 ms with zero requests. | The recovered receipt suppressed repeat dispatch. A fresh command for the same inbound message also made zero sends. The harness used a simulated review gate and inert SES. [#435](https://github.com/devdogfish/quantself/pull/435) |

The table combines measured fixture runs at the linked revisions. Stage times overlap where one boundary calls another. They cannot be summed into a single run time.

## Main recheck on November 18, 2026

At 01:38 UTC, main `2122f1c7847ddc3bc389ffe7ac8b696993a01bcd` passed the focused checks below on macOS arm64 with Bun 1.3.14 and Prisma 7.4.2. PostgreSQL 16.13 ran in an arm64 Docker container with tmpfs data and a loopback port. The cached image had config digest `sha256:0f7a666480d0a8efb29f3c7876fc612147be6a37f071b74a3131248d3818ae3e`. Chrome 157.0.8103.79 used a temporary profile with Browser Use 1.0.0rc5.

| Check | Requests and measured latency | Result |
| --- | --- | --- |
| Chrome receipt and outcome | Three import requests in 74 ms. Submit used 11 Jobs calls in 1,634 ms. Fresh worker used three Jobs calls in 141 ms. Outcome and Undo used ten Jobs calls in 319 ms. | Two portal GETs and one POST across the case, zero portal traffic on restart. Two receipt attempts returned 200 and retained one receipt. [#343](https://github.com/devdogfish/quantself/pull/343) |
| Chrome crash before receipt | Submit phase used eight Jobs calls in 889 ms. Restart used three Jobs calls in 170 ms. The Owner reconciliation GET took 47 ms. | One portal POST before the crash, zero portal requests on restart and zero receipts. The Owner queue showed `submission_uncertain`. Both Chrome cases passed 177 assertions in 8.79 s wall. [#340](https://github.com/devdogfish/quantself/pull/340) |
| Appointment and Undo across API restarts | Two schedule POSTs took 150 and 121 ms after 738 and 683 ms startups. Three Undo POSTs took 103, 88 and 87 ms after 685, 672 and 655 ms startups. | Both schedule responses returned the same UUID and receipt. Undo returned synthetic 503, 200 and 200 with one persisted Undo event and the reapplied outcome intact. The 16-request reply chain took 4.44 s. The fixture passed 123 assertions in 7.12 s wall. [#429](https://github.com/devdogfish/quantself/pull/429) · [#490](https://github.com/devdogfish/quantself/pull/490) |
| Native Appointment alert | Four fresh workers made 1/0/1/0 loopback push POSTs. Startup took 75/78/72/73 ms and total worker time was 164/165/168/159 ms. | One confirmed receipt and the original Appointment remained. The alert checks passed 138 assertions in 1.35 s wall. [#491](https://github.com/devdogfish/quantself/pull/491) |
| n8n export and retry tests | Both export parity checks passed. The lost-response workflow test took 7.20 ms. | 52 tests and 225 assertions passed in 0.10 s wall with stub endpoints. The inactive pilot export still matched SHA-256 `cccc8ddea6c14bd5836cd2c3d4b10b60f832095c5969cd6cbe1147541305d774`. [#435](https://github.com/devdogfish/quantself/pull/435) |

Fixture wall times exclude dependency install, Prisma generation (0.93 s) and migrations. The interview database used the historical migrations (1.92 s), the legacy seed, then the current upgrade (0.72 s). The empty alert and Chrome databases took 1.38 and 1.32 s to migrate. Use the [Chrome command](#reproduce-the-slices), [legacy seed and upgrade](native-interview-appointment-contract.md#reproduce-the-backend-fixture), and [alert command](#native-appointment-alert-across-worker-restarts) to reproduce. The recheck used zero external portal, push, mail or model requests.

## Release and evidence

These historical rows pin independently tested sources. Before the [combined live run](#remaining-live-gates), record the full Git SHA, workflow export SHA-256, API/web image digests, runner SHA, and Bun, n8n, PostgreSQL, Chrome and Browser Use versions. Keep offline rehearsals on disposable Docker PostgreSQL with synthetic sources, model responses, portal and mailbox messages, and an inert SES adapter.

| Slice and exact source | Observed evidence | Measured time |
| --- | --- | --- |
| Real n8n 2.43.7 with the legacy export at [`4e480d0768290e95950300e66472a4537619b01d`](https://github.com/devdogfish/quantself/pull/286) | Two separate n8n CLI executions share the isolated stub store. First run uses 3 board GETs, 5 mock model POSTs and 2 import attempts. The lost commit response replays the same key and body. Next run uses 3 board GETs, 5 mock model POSTs and 1 import attempt with a fresh key. First run creates 3 drafts and queues 3 summaries. Second returns 3 duplicates and queues zero. Each run reports USD 0.000625 estimated fixture spend. The import and model endpoints are stubs. | Historical wall time unavailable. |
| Redesigned feed export at [`c277b30a633db9ebcde4031eec7ee7f064e494f1`](https://github.com/devdogfish/quantself/actions/runs/43664421388) | Offline Code-node run uses 1 stub board response and 5 model fixture calls per execution. First run attempts import twice, keeping the key and payload after the lost response. Second uses 1 attempt and reports 3 duplicates and zero new drafts. Fit notes appear in `postingText`. The new route is `POST /api/v1/jobs/applications/import` with `jobs:write`. | Rerun with Bun 1.3.14. Export check 0.02 s wall. 24 tests, 127 assertions, 0.05 s wall. Lost-response workflow test 6.77 ms. |
| Real Chrome, Jobs API and Docker PostgreSQL at `e511336f84d4781a15b1cf8ee15510aa3bac8ee1` | 2 synthetic model results, 1 PDF and 1 private-answer resume. Stale approval returns 409. Approval pins revision 2 and its PDF digest. Zero clicks before the durable `submit_started` acknowledgement. 1 guarded click, 2 byte-identical receipt requests after a dropped commit response, 1 stored receipt. The runner is reinvoked with the same outbox. A corrupt approved PDF yields zero clicks. | Recorded locally before the current run. 4,803.41 ms for the fixture, 75 assertions. Browser binary version and total HTTP count were not recorded. |
| Jobs lifecycle at [`6e6308535dbad26593f800ee1d6b745ab0008065`](https://github.com/devdogfish/quantself/pull/315) | Recorded 30 real PostgreSQL/API assertions. Agent writes twice with the same key and gets one audit ID. Equivalent Appointment requests return 200 and 503, then replay returns the original To-Do. Two identical calls cross the synthetic To-Do writer boundary and produce one logical Appointment. Two Owner Undo requests restore the prior status and retain the receipt and Appointment. Chrome listing triggers zero lifecycle reads. The selected drawer issues 2 reads under dev Strict Mode. | Historical wall time unavailable. [Integrated Linux run](https://github.com/devdogfish/quantself/actions/runs/43668155792) passed eight test shards and three typechecks. The Docker fixture is opt-in. |
| Legacy SES at [`300193f12341a5385231be92c09286714cf2ae01`](https://github.com/devdogfish/quantself/actions/runs/43643857699) | Stub provider sees 1 send for concurrent contenders. Reloading an uncertain journal preserves the hold even for a later revision. Accepted outcomes retain the SES Message-ID. Provider refusals and ambiguous failures follow different retry paths. | Rerun with Bun 1.3.14. 23 tests, 67 assertions, 0.16 s wall. Concurrent send fixture 3.93 ms. Uncertain journal replay 1.37 ms. |

## Reproduce the slices

Use the exact source in each row in a disposable checkout. The commands assume that checkout's root and locked dependencies. Offline SES fixtures override the provider send, alias provisioning and PDF rendering.

```sh
# c277b30 — offline feed
/usr/bin/time -p bun automation/n8n/jobs-feed/build-workflow.mjs --check
/usr/bin/time -p bun test --isolate automation/n8n/jobs-feed

# 300193f — offline legacy SES
/usr/bin/time -p bun test --isolate scripts/jobs/email-ses.test.ts scripts/jobs/ses-transport.test.ts

# 4e480d0 — real n8n, throwaway SQLite and loopback stubs
# Preload this n8n 2.43.7 image when preparing the hosted environment.
n8n_image='docker.n8n.io/n8nio/n8n@sha256:3db21366be1d3c77c1708963129c051948573019659e8873e0294be035ffc1b2'
/usr/bin/time -p docker run --pull=never --rm --network none --memory 768m --cpus 1 \
  --mount "type=bind,source=$PWD/automation/n8n/jobs-feed,target=/fixture,readonly" \
  --entrypoint node "$n8n_image" /fixture/smoke/n8n-smoke.mjs
```

On a dedicated host, use a disposable Docker PostgreSQL at `127.0.0.1:<published-port>`. A PostgreSQL 18 Alpine image is available for pinning at `sha256:b0ba6f2b6290ae40c9aacf6cc72849a2954778fef88774e122131d4b3c3b5e5b`. Check the host architecture and record the resolved digest. Set the process's `DATABASE_URL` to the matching fixture database only. Generate the client and deploy that checkout's migrations with `bun run --cwd packages/db generate` and `bun run --cwd packages/db migrate:deploy-only`. Set `BETTER_AUTH_URL=http://localhost:3000`.

```sh
# Acceptance checkout — database jobs_worker_integration, Browser Use 1.0.0rc5, temporary Chrome profile
QUANTSELF_JOBS_INTEGRATION_FIXTURE=1 QS_JOBS_TEST_BROWSER_USE="$(command -v browser-use)" \
  /usr/bin/time -p bun run test scripts/jobs/jobs-worker-integration.test.ts

# 6e63085 — separate database jobs_lifecycle_fixture; synthetic To-Do writer
QUANTSELF_JOBS_LIFECYCLE_FIXTURE=1 \
  /usr/bin/time -p bun run test apps/api/src/jobs-lifecycle-docker.test.ts
```

### Combined disconnected rehearsal

**Import through restart passed on #316** at `c6f0f4183469036db9bb908c6f870779421a6e79` using only fixture changes. The same draft created by the scoped HTTP batch import went through enrichment, tailoring, Owner approval, private-answer pause, and real headless Chrome against a loopback Greenhouse form. Exact-key import replay and a fresh-key import at a changed URL retained one provider binding, one application and one queued enrichment. The #316 concurrent-import proof is recorded in [PR #316](https://github.com/devdogfish/quantself/pull/316).

The first `run-jobs-mac-worker.ts --once` process received a simulated response loss after the real API committed the receipt. It exited with its outbox file intact. A fresh PID reused that directory, sent the byte-identical receipt, and exited cleanly with an empty outbox. Both receipt requests returned 200 at the API. The database contained one receipt before and after replay. Chrome made two form GETs and one valid submit POST, with zero portal requests during restart.

| Stage | Real Jobs API calls | Elapsed |
| --- | ---: | ---: |
| Batch import, exact replay, changed URL duplicate | 3 | 65 ms |
| Model fixtures, approval, PDF, private answer and Chrome startup | 28 | 2,113 ms |
| First worker process, guarded click and lost receipt response | 11 | 1,684 ms |
| Fresh worker process | 3 (heartbeat → receipt → empty claim) | 115 ms |
| Corrupt PDF refusal, separate application | 5 | Included below |

The #316 run used macOS arm64, Bun 1.3.14, Chrome 157.0.8103.79, Browser Use 1.0.0rc5, and Docker PostgreSQL 18.3. Total 50 Jobs API calls and 5.12 s wall for 78 assertions. The total includes fixture setup and cleanup and excludes migration. Calls include invalid-request probes and exclude SQL, Chrome debugger, and stubbed model and alias work. Reproduce with the Chrome command above on the #316-based acceptance checkout. The fixture prints route counts and phase durations without request bodies.

#### Import-only credential on #317

On `codex/jobs-acceptance-198-scope-verification`, the same opt-in Chrome command passed with [#317](https://github.com/devdogfish/quantself/pull/317) at `7df98d8aa41742cdaae8d630e543f7bbb4999321` and the [#319](https://github.com/devdogfish/quantself/pull/319) fixture at `4988d42576630f63d5359486c9ff6005a21be4a4` applied. Quantself issued a Better Auth key with exactly `jobs:import-tailored` in the disposable database. The default API authorization validated it through `X-API-Key`. The three import calls retained one draft, one provider binding and one queued enrichment.

The feed key got 401 on enrichment claims via both `X-API-Key` and Bearer, and on a submit claim as Bearer after the draft was queued. Its edit and approval requests returned 403. A signed Owner session and separate Codex and Mac runner secrets completed review, approval and submission.

The real API committed one receipt before the first process lost its response. A fresh worker replayed the identical body in 130 ms with zero portal requests. The fixture saw two 200 receipt responses, one valid portal submission and one persisted receipt. Total 55 Jobs API calls, 81 assertions and 9.43 s wall, excluding migration. The 55 includes the five denied feed requests.

#### Real n8n feed to Jobs API and PostgreSQL

Passed at 06:08 UTC on 2026-11-15 on `44e97baa98712b46aa93a9b89cf2cd76be806eb6`. The input workflow SHA-256 was `516c959f2ce5272fc7741443a8ac2b46a065f1f1e08da911aad74a10e8b716d7`. Docker Linux arm64 ran n8n 2.43.7, Bun 1.3.14, Prisma 7.4.2 and PostgreSQL 18.3. The fixture copy wired loopback board and model stubs and an internal import proxy. The exported schedule stayed inactive. The API issued a temporary Better Auth key with exactly `jobs:import-tailored`.

| Stage | HTTP requests | Elapsed |
| --- | --- | ---: |
| API startup, including PostgreSQL and migrations | Fixture readiness only | 16.04 s |
| n8n CLI import of fixture workflow and credentials | 0 product requests | 8.19 s |
| n8n execution 1 | 3 board GETs, 5 model stub POSTs, 2 real import POSTs | 7.73 s |
| n8n execution 2 | 3 board GETs, 5 model stub POSTs, 1 real import POST | 4.81 s |
| Worker and Owner review | 4 enrichment claims (1 empty), 3 enrichment completions, 1 tailoring claim, 1 tailoring completion, 1 review GET | 227 ms |
| Import-only scope probes | 6 requests returned 403 and 1 worker claim returned 401 | Included below |

The proxy verified three drafts and the idempotency record in PostgreSQL before dropping the first response. Real import latencies were 294 ms on commit, 40 ms on identical-key and byte-identical-body replay, and 102 ms in the fresh execution. The fresh key and changed hosted URL yielded zero imports, three duplicates and no new work. The provider bindings for `greenhouse:global:fixture:1`, `:2` and `:4` retained their application UUIDs across both runs. Each retained one enrichment item and then one tailoring item. One draft reached Owner review at revision 1 with the fit note and synthetic summary, and queued one render. Every permission probe left the snapshot unchanged. Both executions reported a simulated spend of USD 0.000625 and the expected truncated model result. The 20 product HTTP calls include imports, scope probes, worker calls and Owner review. Runtime through assertions was 38.18 s with preloaded images and dependencies. The separate locked dependency install took 100.26 s.

Preload the three image digests in [the isolated runner](../../automation/n8n/jobs-feed/smoke/run-isolated.py). Run from the repository root with Docker and Python 3.12 or later. The optional fixture typecheck uses Node and the pinned TypeScript compiler.

```sh
python3 automation/n8n/jobs-feed/smoke/run-isolated.py --typecheck \
  e16ea4e64c79e945ecc569f4be48f04607f2a08f /tmp/quantself-jobs-feed-evidence.json
```

The documented command reproduced the result in a fresh scratch database. Dependency and engine setup took 157.98 s. The isolated rehearsal then took 50.75 s through assertions.

The relocated fixture passed on `e16ea4e64c79e945ecc569f4be48f04607f2a08f` at 2026-11-15 06:22:01 UTC with the same export digest. Dependency and engine setup took 66.17 s and scoped typecheck took 25.39 s under Node v22.20.0. The isolated run took 28.57 s through assertions, including 9.33 s for API readiness. The two n8n executions took 6.86 s and 3.51 s. Real import calls took 146 ms, 27 ms and 17 ms for commit, replay and fresh-key deduplication. The request and result counts reproduced.

- [x] Rehearse real n8n import, lost-response replay, fresh-run deduplication and scoped tailoring on the same scratch database.
- [x] Render and inspect the same n8n draft, then verify its PDF bytes against the Owner-approved application ID, revision and digest.
- [x] Use the same direct-import draft and approved PDF for the Chrome fixture. Verify zero clicks while the `submit_started` acknowledgement is held, then one click and receipt-only replay through a new OS process with the same scratch Jobs home.
- [x] Interrupt the worker after the durable start and before receipt capture. Restart against the same API and scratch DB and confirm the submission goes to Owner reconciliation with zero repeat clicks. See [worker crash evidence](#worker-crash-before-receipt-capture).
- [x] Match the Chrome-submitted synthetic draft by its exact Application Address through the reply CLI. Verify the recent Owner edit hold, one audited interview outcome despite replay, stale revision rejection, idempotent Owner Undo and reapplication. Preserve the original submission receipt. See [same-draft reply evidence](#same-chrome-draft-reply-and-receipt).
- [x] Replay native Appointment creation after restarting the API against the same scratch database. Both processes returned the same Appointment UUID and PostgreSQL retained one Appointment. See [API restart evidence](#native-appointment-replay-after-api-restart). Verify the original Roundcube link and Appointment alert during live acceptance.

For each run, record UTC time, pinned versions, command/run link, stage and whole-run wall times, request counts by method and boundary, statuses, and stable fixture IDs. Count failed and retried attempts separately from committed drafts, events, provider sends and Appointments. Measure cold setup separately from warm reads. Collect the same measurements for the combined live acceptance run.

#### Same-draft PDF

Passed at 06:35 UTC on 2026-11-15 on `e26499cfb390f76cf88b156e7caa45acd3800f89` with the same n8n export. The render-only worker used the configured renderer and compiler on Linux arm64 with Chromium 156.0.8078.79, Python 3.13.5, Markdown 3.11.3 and pypdf 7.0.0. Only renderer code and the Geist font were mounted. The fixture wrote its own résumé template and contact data. The renderer retained its built-in masthead.

The PDF for n8n draft `c38d52a8-069e-4a48-873c-ce6691991efe` was 29,816 bytes and one Letter page. Poppler and visual inspection confirmed the tailored Summary and the scratch-issued listing Application Address. The synthetic global email and template placeholder were absent. The Owner PDF route rejected revision 0 with 409, served revision 1, and returned identical bytes after approval. The served SHA-256 `c9bddb00dc91a8a1448743ac2283ed802eb95b4c41a061ff7c88e52c4c9eb89a` matched both the revision record and the Owner approval digest. The submit item stayed queued and no receipt existed.

Render and upload took 1.281 s across three worker requests. The PDF phase took 1.424 s including five Owner requests. The closed rehearsal took 26.54 s through assertions. Dependency preparation took 64.01 s and the standalone fixture typecheck took 18.76 s.

The local render image was `sha256:b2a47be74527ea3655040b2f815c9f5c7fa5fac5fc0a5b2844bd82fd8df95927`. The fixture checks the three input paths and records their digests in the evidence JSON.

| Renderer input | SHA-256 |
| --- | --- |
| `render_resumes.py` | `0b0199096cb734c474552184ee1b2c4eace10f5a561fa6366907cd6b4a21b28b` |
| `md_to_pdf.py` | `deb604c2eeddbcfe5ac4ce25180b1c21de9de9e15ec9b328ce90deeca5fb4081` |
| `geist-latin.woff2` | `9b6f5ff45b278c744b5f379a2c4ecbaf858a842b8eaf82ac8d21b699ca16c608` |

Stage only those three files in a separate directory. Build the fixture image before starting the internal Docker network. The runner writes the inspected PDF and PNG beside the evidence JSON.

```sh
docker build -t qs-feed-render-fixture \
  -f automation/n8n/jobs-feed/smoke/Dockerfile.pdf-fixture automation/n8n/jobs-feed/smoke
python3 automation/n8n/jobs-feed/smoke/run-isolated.py --typecheck \
  --renderer-bundle "$renderer_bundle" --render-image qs-feed-render-fixture \
  bc35362cee0c9ebe69f9dca7b5632115ce0cf4dd /tmp/quantself-jobs-feed-pdf.json
```

The same check passed on `bc35362cee0c9ebe69f9dca7b5632115ce0cf4dd` at 2026-11-15 06:39:41 UTC. Draft `a6b9b071-d06c-4cda-9972-8d9372c0eec7` revision 1 served 29,375 bytes after approval with SHA-256 `230a2cbaf7d72b837d880e1fa053f940b5e8969f0dbd2e80f0461fea20a4365c`. Render and upload took 1.566 s and the PDF phase took 1.703 s. The closed rehearsal took 27.07 s through assertions, with 75.41 s of dependency setup and 18.82 s of standalone typecheck. The pinned recipe built image `sha256:6909ce1d31f0cf843e6785d3be9d3c57d8500ce83afbf4f27b94b551c6061557`.

## Offline reply, status and native Appointment

The hosted [fixture run](https://github.com/devdogfish/quantself/actions/runs/43686048430/job/132726632028) passed on 2026-11-15 at 06:35 UTC. Test source `77d569eb8616ccaf5f0e4e5a98a5b7c8caaa8c47` extends merged main `2f9a27a4a6843bfec14ca42658ca0a6cdab5f31a` with the existing native interview fixture. It used Bun 1.3.14 and PostgreSQL 18.7. All 118 fixture assertions and the API typecheck passed. The reply chain took 862 ms after seeding. The fixture took 3.52 s and Bun reported 4.97 s total, excluding dependency setup and migrations.

The synthetic applied application `c59894f1-0ca9-4db2-90f1-351ae026a196` went through all five steps. The status audit was `44af0476-d19d-4bd1-bf55-d298daa6006f`. The native Appointment was `254d07ce-2c44-4d39-8cbf-643d644cfb45`.

| Step | Loopback requests | Observed |
| --- | --- | --- |
| Resolve and read | POST 404, 200. GET 200. | Two registered signals pointing to different applications returned no ID and left both candidates, audits, lifecycle events and Appointments unchanged. Agreeing signals returned the fixture ID. Its starting lifecycle was `applied@0`. |
| Record interview outcome | PATCH 503, 200, 409. | The fixture dropped the first response after commit. A fresh CLI process replayed the identical body and key and got `interviewing@1`, the source reply link and one status audit. A fresh key with revision 0 got 409. |
| Schedule | POST 403, 200, 200. | The reply key could edit status. The separate scheduling grant created one native Appointment at revision 1. The same key with equivalent local and UTC times returned the same Appointment and creation audit. |
| Owner Undo | POST 200, 200. GET 200. | Both signed Owner requests returned the same receipt. The lifecycle became `applied@2` and the source reply link was removed. The Appointment was still active. |
| Recent edit and reapply | PATCH 409, 200. GET 200. | Undo triggered the three-minute Owner hold. A current-revision Agent write during it changed nothing. After backdating the synthetic timestamp, a new command restored `interviewing@3`. The approval, submission receipt and SES ID survived, and Owner detail returned the same active Appointment. |

There were 15 HTTP requests, including 12 from separate generated CLI processes and three with the Owner session. The dropped response and replays used one running API and database. Final Jobs evidence contained two committed lifecycle changes, one lifecycle Undo and one Appointment. The fixture used a separate synthetic application from the feed and browser rehearsals.

Reproduce using the [native interview Docker seed and command](native-interview-appointment-contract.md#reproduce-the-backend-fixture). This run covers the offline Quantself CLI segment of #196 and #198. The later [mailbox rehearsal](#198-same-receipt-through-the-jobs-mailbox-matcher) exercised matching through the Sam plugin with loopback TLS IMAP.

### Native Appointment replay after API restart

Passed on November 17, 2026 using this fixture on base `b18464f1`, Bun 1.3.14, Prisma 7.4.2 and disposable Docker PostgreSQL 18.7. Apply the [existing legacy seed and upgrade](native-interview-appointment-contract.md#reproduce-the-backend-fixture) and run `QUANTSELF_NATIVE_INTERVIEW_FIXTURE=1 bun run test ./apps/api/src/jobs-native-interview-docker.test.ts`.

The real Jobs API in PID 98599 created Appointment `4e92eec0-4b6b-4395-94be-aebea4866eb5` for synthetic application `c59894f1-0ca9-4db2-90f1-351ae026a196`. The fixture terminated that process and awaited its exit. PID 98600 used the same database and returned the identical receipt, including the audit ID, for the same key and equivalent time offset. The database contained one interview and one native Appointment for the application. The existing status Undo still retained the Appointment.

| API process | Cold startup | Scheduling HTTP |
| --- | ---: | ---: |
| Create | 596 ms | One 200 in 211 ms |
| Replay | 584 ms | One 200 in 168 ms |

The full 15-request reply chain took 1.938 s. The fixture passed 122 assertions in 4.06 s wall, excluding database setup and migration. Both scheduling requests went to loopback. No provider calls were involved.

### Owner lifecycle Undo after API restart

Passed at 00:35 UTC on November 18, 2026 using the extended native interview fixture on base `b40004b7`, Bun 1.3.14, Prisma 7.4.2 and disposable PostgreSQL 16.13. Use the legacy seed and focused fixture command above. The API and database connections used loopback only.

| Owner Undo POST for the same audit ID | API PID | Cold startup | HTTP time and result |
| --- | ---: | ---: | --- |
| Commit with the fixture dropping the success response | 87118 | 1,430 ms | 260 ms, synthetic 503 |
| Replay after API restart | 87125 | 1,252 ms | 233 ms, 200 |
| Replay after the Agent reapplied the outcome | 87129 | 1,281 ms | 158 ms, 200 |

The database recorded `undoneAt` before the first API exited. Both restarted APIs returned the same audit receipt for `092b06aa-bb64-4db2-8bac-1a68e1f5ada9`. Application `c59894f1-0ca9-4db2-90f1-351ae026a196` advanced from `interviewing@1` to `applied@2` on Undo, then to `interviewing@3` on reapply. The late replay preserved revision 3, the source reply link, and the original submission receipt. PostgreSQL retained one Undo event and one active native Appointment `21b25fba-d45a-4d96-8906-2b4686cb2286`.

The reply chain took 9.36 s across 16 requests. The fixture passed 123 assertions in 11.37 s, excluding migration and setup. Provider requests were zero.

### Native Appointment alert across worker restarts

Passed at 00:40 UTC on November 18, 2026 on base `677fca75` with Bun 1.3.14, Prisma 7.4.2 and disposable PostgreSQL 16.13. Apply the migrations to a loopback database named `native_reminders_fixture` and run `QUANTSELF_NATIVE_REMINDERS_FIXTURE=1 bun run test ./apps/api/src/notifications-native-docker.test.ts ./apps/api/src/notifications-native.test.ts`.

The real notification worker read Appointment `4292fc02-4215-4f57-a921-4aa60131e26b` and sent to a loopback transport stub. The fixture killed the worker after the stub's 201 and before the worker could record `sentAt`. Each later process used the same database.

| Worker process | Loopback push POSTs | Startup / total |
| --- | ---: | ---: |
| 91529, killed after synthetic acceptance | 1 | 75 / 165 ms |
| 91530, restart after 30 seconds of simulated lease time | 0 | 77 / 158 ms |
| 91531, restart after 61 seconds of simulated lease time | 1 | 76 / 181 ms |
| 91532, restart with a confirmed receipt | 0 | 75 / 158 ms |

The retry used the same push topic, browser tag and Appointment URL with `renotify: false`. PostgreSQL retained one confirmed receipt and the same Appointment row. The run measured two stub requests and zero external push requests. The focused tests passed 138 assertions across 13 tests in 1.32 s, excluding setup.

## Same Chrome draft reply and receipt

The [hosted fixture](https://github.com/devdogfish/quantself/actions/runs/43724398311/job/132843075329) passed on 2026-11-15 at 14:28 UTC. It checked out test commit `ca1a2b3adb606ac6d2783f8f5f32208895f86d21` on main `1350301b12fa3600720bb8f81181715e2ea7659a` using wrapper `37cb6d6ab4c88f3f828b93d871466b9160b5e6b5`. Ubuntu 24.04 ran Bun 1.3.14, Chrome 157.0.8103.50, Browser Use 1.0.0rc5 and disposable Docker PostgreSQL 18.3 at the digest above. Reproduce with the Chrome command above on the pinned checkout.

Chrome submitted synthetic application `dc121c6d-abb5-4f64-80b7-081d8568aead` with two form GETs and one valid POST. The original and restarted workers each sent the same receipt body and got 200 at the API, leaving one `receipt_recorded` event `c746f9f7-aabf-4557-a4a4-92df6772864b`. Then the generated reply CLI resolved that row using the exact Application Address assigned on import. The temporary Agent grant had `jobs:read` and `jobs:write`.

| Step | Loopback requests | Observed |
| --- | --- | --- |
| Match and read | POST 200, GET 200 | Exact draft matched at `applied@0`. |
| Record and replay | PATCH 409, 200, 200, 409 | Recent Owner edit blocked the first write. After backdating the scratch timestamp, the write and same-key replay returned `interviewing@1`, the synthetic reply link and one audit `d8fd89e8-6841-420e-9d29-d4f496dbede3`. A fresh key with revision 0 got 409. |
| Owner Undo and replay | POST 200, POST 200, GET 200 | Both Undo requests returned identical results. Status became `applied@2` and the reply link cleared. |
| Reapply | PATCH 200 | The fixture backdated the scratch timestamp again to clear the hold. The outcome restored `interviewing@3` and the link with audit `328bbe48-0c19-42ec-9f9d-0d3a4232183e`. |

Reply checks took 501 ms across ten requests and caused zero portal requests. The original receipt event, receipt payload, applied timestamp and approved résumé revision and digest survived the updates. The Chrome/reply case took 13.87 s. Both cases passed 177 assertions in 18.83 s, including the crash case. Tool installation took 46 s, Prisma generation took 2.052 s, migrations took 1.963 s, and the Jobs runner and fixture typecheck passed in 30 s. Mailbox delivery and Sam's handoff remain live acceptance gates.

## Worker crash before receipt capture

The [hosted fixture](https://github.com/devdogfish/quantself/actions/runs/43686993831/job/132729443940) ran on 2026-11-15 at 06:48 UTC. It checked out `570deda28f714883b77a143d9325f2606b0d2338` on product base `bc35362cee0c9ebe69f9dca7b5632115ce0cf4dd` using hosted wrapper `be6f8a9f3cfc50eda4b350a7397b9233c2fc5ebf`. Ubuntu 24.04 ran Bun 1.3.14, Chrome 157.0.8103.50, Browser Use 1.0.0rc5 and disposable PostgreSQL 18.3. The fixture polls Chrome's `/json/version` for the expected debugger WebSocket before handing it to the worker. The first hosted receipt-replay attempt failed before submission. Both cases passed with the readiness probe.

The real Jobs API recorded `submit_started` event `1639631d-f1a4-412f-8e3d-445e562587f7` at `2026-11-15T06:48:22.377Z` for application `a6ad861e-8259-4dc1-bbf0-908e6131f7d9`, work item `3e8c9982-5ea1-4957-bf2d-ce098c3ad96f`, and approved revision 2. The synthetic portal accepted one valid POST and withheld confirmation. PID 3177 received `SIGKILL` while its outbox still held the failure intent. PID 3235 restarted with the same Jobs home, API and database. The Owner submissions route showed `needs_attention` with `submission_uncertain`. The submission had no receipt or applied timestamp.

| Stage | Jobs API calls | Elapsed |
| --- | ---: | ---: |
| Draft import and deduplication | 3 | 80 ms |
| Model fixtures, approval, PDF, private answer and Chrome preparation | 33 | 2,138 ms |
| Durable start, accepted portal POST and process exit | 8 | 1,305 ms |
| Fresh worker heartbeat, failure report and empty claim | 3 | 239 ms |
| Owner reconciliation read and database assertions | 1 | 20 ms |

The portal saw two form GETs and one valid POST. Restart caused zero portal requests, zero receipt requests and zero receipt events. The crash case took 4.465 s with setup and cleanup. Both cases passed 160 assertions in 19.02 s. Fixture tool installation took 37 s, Prisma generation took 2.084 s, and applying 87 migrations took 1.588 s. Reuse the Chrome command above on the pinned fixture checkout.

## #197 one-posting preflight

Run `bun run test ./automation/n8n/jobs-feed` and `bun automation/n8n/jobs-feed/build-workflow.mjs --check`. The [fixture](../../automation/n8n/jobs-feed/workflow.test.mjs) runs the exported Code nodes with stubbed HTTP. In the [inactive copy](../../automation/n8n/jobs-feed/README.md#pin-one-posting-for-the-197-pilot), set `preflight` to the approved Greenhouse board token and decimal posting ID string. The Greenhouse-hosted HTTPS posting URL must identify that same board and posting.

On either side of UTC midnight, the selected listing makes one board request, one screening request and one import request in the fixture. Absent, duplicate, incomplete or mismatched targets stop before screening and import. The default export rotates when no target is configured. The live pilot still requires enforceable budget and exact-draft worker admission. [Offline allowance evidence](https://github.com/devdogfish/quantself/issues/197#issuecomment-6900943232)

### #197 held-draft and allowance canary

The prototype from `5e972983` and `1bac62dd` passed on base `7e1c2534` with Bun 1.3.14, Prisma 7.4.2 and disposable Docker PostgreSQL 18.7. Both scratch databases first applied the complete base migration ledger, then the one-column pilot hold migration. The normal claim query excludes held applications. Exact held enrichment uses the existing work key and lease writer. The fixture supplies the Owner permit and ledger and calls the dispatcher with a fake provider.

| Fixture | Verified result | Wall time |
| --- | --- | ---: |
| Held intake and lease | 23 in-process API requests. A 93 ms race issued one exact lease. The ordinary worker reclaimed expired ordinary work and skipped held work even after expiry. Two failure reports returned one recorded event. | 1.16 s |
| Durable allowance | Eight denied runs, one reservation among competing transactions, and zero fake calls after expired authority or a lost commit response and replay. The lost provider reply made one fake call and retained the full synthetic 6¢ reservation. | 0.59 s |
| Ordinary worker, contract and route regressions | 10 passed, with fake responses only. | 0.12 s |

The two Docker fixtures passed 123 assertions. The regression checks passed 89 assertions. Times exclude dependency setup and migrations. Real provider requests were zero.

Apply the migrations to disposable loopback databases named `jobs_pilot_lease_fixture` and `jobs_pilot_allowance_fixture` before running the corresponding commands. Use synthetic local auth configuration.

```sh
QUANTSELF_JOBS_PILOT_LEASE_FIXTURE=1 bun run test ./apps/api/src/jobs-pilot-lease-docker.test.ts
QUANTSELF_JOBS_PILOT_ALLOWANCE_FIXTURE=1 bun run test ./apps/api/src/jobs-pilot-allowance-docker.test.ts
```

The reporting follow-up on `9cad9cf1` passed 93 assertions in 0.76 s wall on the same disposable fixture. Before reporting, the stored reply left enrichment claimed. After a committed report lost its acknowledgement, two replays returned the same result ID. PostgreSQL kept one enrichment event, one held tailoring item, and the full synthetic 6¢ reservation. The report checks took 75 ms with zero fake-provider calls.

The synthetic settlement follow-up on `a4441ca9` passed 161 assertions in 0.93 s wall. A policy approved the request digest, exact input count, output ceiling and per-token prices. The provider stub returned a matching usage receipt for 100 input and 20 output tokens. The report committed a $0.0122 charge and released the $0.06 hold in the same transaction. Two replays after a lost acknowledgement returned the same result ID and left the charge intact. Eight missing, malformed or mismatched usage receipts kept the full hold and charged zero. Real provider calls were zero.

The offline Messages adapter maps a trusted text-only receipt to the ledger's existing usage shape. It checks the workspace and request headers, hashes the exact sent bytes, and matches the local result ID and approved model. It requires standard tier, standard speed, global inference and independently approved token bounds. Nonzero cache, tool and thinking usage or unknown fields are rejected. [Messages response schema](https://platform.claude.com/docs/en/api/messages/create) · [Response identifiers](https://platform.claude.com/docs/en/api/errors#request-id)

The shared allowance follow-up on `8a3bd1da` used one $0.10 synthetic permit for screening, exact held enrichment, and exact held tailoring. Each downstream phase was denied before the previous settlement. Three fake calls settled $0.0366 total. A lost tailoring report acknowledgement replayed the same result ID and left one Review revision and one tailoring event. The fixture seeded the held draft and used a stub screening response. The three phases took 76 ms and the full Docker canary passed 187 assertions in 0.96 s wall.

The intake follow-up on `27f0f750` ran the same synthetic posting through held intake. Replay after a lost intake commit acknowledgement recovered the draft and its one enrichment item. Replaying intake after tailoring preserved both IDs, one imported event, one Review revision, and exactly three settled charges totaling $0.0366. The fixture still creates the held draft before screening because its permit requires a draft ID. The chain took 87 ms and the Docker canary passed 195 assertions in 0.87 s wall.

The screening-first follow-up on `ad7a40ae` uses the same $0.10 permit. It binds the approved Owner and Greenhouse identity while the draft ID and revision are empty. Intake is denied until the screening receipt settles with a keep decision. A lost intake acknowledgement leaves one draft and an unbound permit. Replay recovers that draft and binds its ID and revision once. Subsequent replay leaves one enrichment item, one Review revision, and three settled charges totaling $0.0366. The synthetic chain took 135 ms and the Docker canary passed 206 assertions in 1.27 s wall.

### #197 real n8n to held intake

The pinned export at `3a7eca5a` sends Messages directly to Anthropic and passes kept postings to ordinary Jobs import. The earlier real n8n smoke replaces Anthropic with a stub and exercises ordinary import. This run uses the same n8n smoke harness and a loopback gateway backed by the existing allowance fixture in disposable PostgreSQL. The input export SHA-256 is `3dbb7e1de3cb7a0c7147ebfa11b7ae7041ce19c12ee7ce9f99bc747a06758326`.

```sh
python3 automation/n8n/jobs-feed/smoke/run-isolated.py --pilot \
  e86ef861 /tmp/quantself-jobs-pilot-evidence.json
```

One Greenhouse board GET, one Messages POST, and two held import POSTs ran in real n8n. The fixture credentials carry the same permit to the model and import nodes. The gateway binds the permit to the exact Messages request and import body. It validated and settled a synthetic Anthropic keep receipt before admitting the draft. Wrong permits, changed request bodies, early import, and screening replay were denied. The proxy dropped the first import response after commit. n8n retried with the same import key and bytes. PostgreSQL retained one draft, one enrichment item, one Review revision, three synthetic charges totaling $0.0366, and zero held balance. Real provider calls were zero.

The runtime uses an internal Docker network with the gateway, board and model fixture endpoints bound to loopback. The committed export, schedule and production credentials are untouched.

Passed on `e86ef861` with n8n 2.43.7, Bun 1.3.14, Prisma 7.4.2 and PostgreSQL 18.3. Locked dependency setup took 98.83 s. The isolated rehearsal took 27.44 s, including 10.53 s for API readiness and migrations and 9.24 s to import the fixture workflow and credentials. The workflow executed in 6.91 s. The board response took 2 ms, screening took 56 ms, and the successful import replay took 25 ms.

### #197 Owner permit and revocation

The same-origin Owner can issue a time-limited permit for one unimported Greenhouse identity and revoke it. Issuance reuses Jobs idempotency. Revoke retries return the original timestamp. Authorization locks the permit, checks expiry and revocation, and checks either the unimported posting or the bound held draft and its current revision. An issuance replay returns its original receipt. Revocation preserves the draft hold.

Run `QUANTSELF_JOBS_PILOT_PERMIT_FIXTURE=1 bun run test ./apps/api/src/jobs-pilot-permit-docker.test.ts` against a migrated disposable loopback database named `jobs_pilot_permit_fixture`. On PostgreSQL 18.7, 50 assertions passed in 1.32 s wall. The fixture observed authorization blocked on the in-flight revoke before confirming denial. It used the existing offline held intake and exercised binding separately. The ordinary provider-import fixture passed in 3.29 s wall. Its warm 100-row duplicate batch used two bulk lookups and took 96.3 ms.

### #197 authenticated held intake

The same Docker permit test mounts a held intake route for the existing `jobs:import-tailored` API-key grant. Fresh intake locks the Owner permit and requires a settled keep result ID tied to the digest of the validated posting. One transaction records the held revision-0 draft, provider identity, enrichment item, import event, permit binding, and idempotency receipt. Repeating the same authenticated request with its original key reads that receipt, including after revocation or a revision change.

The test passed 97 assertions in 1.04 s on PostgreSQL 18.7. It injects rollback before commit and a lost acknowledgement after commit. Same-key requests returned one receipt, distinct keys produced one winner, and concurrent ordinary import and held intake produced one draft and one enrichment item. Wrong grants, altered postings, expired permits, and intake behind an in-flight revocation were denied.

The test supplies the settled result directly in disposable PostgreSQL. Production registration stays closed pending an approved provider transport and allowance policy.

### #197 durable screening settlement

The screening fixture builds the same Messages request as n8n and commits one reservation per Owner permit before returning the exact bytes and attempt ID. The reservation pins the workspace, approved request digest, token bounds, and pricing. An ambiguous receipt or lost reservation acknowledgement retains the full hold. Reservation replay yields no dispatch bytes.

The trusted receipt adapter binds the response to the stored workspace, attempt ID and sent bytes. Settlement records token usage and charge once. A keep also writes the exact normalized intake posting and attaches its digest to the active permit in the same transaction. Receipt replay returns the stored posting. Revocation or expiry blocks new dispatch and keep attachment. Verifiable in-flight usage still settles.

The initial screening-only test passed 50 assertions in 0.58 s with synthetic transport receipts and prices.

### #197 shared durable allowance

One allowance row covers screening and exact held enrichment and tailoring across its attached permits. The cap is 100,000,000 nano-USD ($0.10), with up to two screens, one enrichment and one tailoring call. Screening is capped at 20,000 input and 384 output tokens. Held model work uses a conservative ceiling of 30,000 input and 1,200 output tokens per call. The database checks the aggregate cap and atomically moves a verified charge from held funds to spend. A missing or ambiguous receipt retains the full hold. A late verified charge can reconcile after revocation. Applying the result still requires an active permit and current lease.

Run `QUANTSELF_JOBS_PILOT_SCREEN_FIXTURE=1 bun run test ./apps/api/src/jobs-pilot-screening-docker.test.ts` against a migrated disposable loopback database named `jobs_pilot_screen_fixture`. The fixture passed 88 assertions in 1.40 s. The synthetic three-stage path charged 35,600,000 nano-USD and reached one Review revision. Fresh Bun processes recovered a committed enrichment receipt and replayed a committed tailoring report. Cross-permit contention and late receipt replay preserved the cap and charged once. The fixture provisions the allowance and permit bindings. Older offline screening records can reconcile their original receipt independently.

### #197 Anthropic transport qualification

The offline transport reserves once before sending the exact approved bytes to the fixed Anthropic HTTPS Messages endpoint. It requires certificate verification for that host, rejects redirects, and accepts a direct JSON response from the approved workspace. The request cap is 128 KiB. The uncompressed response cap is 64 KiB, and the 45-second timeout covers headers and body. The receipt adapter checks the provider request ID, exact sent bytes, attempt ID and approved usage.

Fetch and TLS doubles verified request settings and hostname checks. The disposable PostgreSQL fixture passed 103 assertions in 1.28 s. A timeout retained the full reservation and a replay sent nothing. After a lost settlement acknowledgement, the transport retried settlement once with the captured receipt. The simulated provider call and charge each occurred once.

### #197 native Bun TLS rehearsal

The runtime shares a Docker `--network none` namespace with disposable PostgreSQL. Only loopback interfaces are available, and `api.anthropic.com` resolves to loopback. Fresh test certificates and the test root are scoped to the fixture. The runner sets `NODE_EXTRA_CA_CERTS` only for the fixture Bun process.

The first rehearsal of `65571373` exposed a POST to the wrong-host peer even though the custom callback made the client reject the request. The fixture retains that callback as a negative control. The transport now uses Bun's built-in hostname verification with strict certificate checks. Bun 1.3.14 also ignored `proxy: false` in a loopback probe, so the transport denies dispatch when proxy environment variables are present. The runtime and provider URL remain pinned. [Bun TLS release notes](https://bun.com/blog/bun-v1.4#checkserveridentity-runs-before-fetch-sends-the-request-v140)

```sh
python3 automation/n8n/jobs-feed/smoke/run-isolated.py --native-tls \
  1fcbc549 /tmp/quantself-jobs-native-tls-evidence.json
```

Passed 153 assertions on Bun 1.3.14 and PostgreSQL 18.3. Dependency setup took 149.55 s. The isolated run took 8.20 s, including migrations.

| Case | Loopback evidence |
| --- | --- |
| Trusted root, intermediate and matching hostname | One POST with the exact 1,571-byte reserved body. One synthetic charge of 11,200,000 nano-USD settled. |
| Wrong hostname | `ERR_TLS_CERT_ALTNAME_INVALID` and zero decrypted HTTP bytes at the peer. The full hold remained. |
| Untrusted chain | `UNABLE_TO_VERIFY_LEAF_SIGNATURE` and zero decrypted HTTP bytes at the peer. The full hold remained. |
| 307 redirect | One POST reached `/v1/messages`. The redirect target received zero requests. The full hold remained. |
| Legacy custom callback, wrong hostname | The client returned `ERR_TLS_CERT_ALTNAME_INVALID` after the peer received 1,816 decrypted HTTP bytes, including the synthetic key header and the complete 1,571-byte request body. |
| Configured proxy | Zero fetch calls and zero sentinel connections. No reservation was made. |

Production registration still requires an explicit Owner policy, one approved allowance for the run, and an independently verified billed-input ceiling. Token counts are estimates, and workspace limits apply monthly. [Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting) · [Workspace limits](https://platform.claude.com/docs/en/manage-claude/workspaces)

For global, standard-tier, uncached Haiku 5.5 screening without tools, the documented context and the long-context rates give a conservative ceiling of $0.50096 per call with 384 output tokens. That is already over the whole pilot allowance. The paid gate needs a lower independently verified billed-input ceiling for the exact request, including structured-output overhead, with every attempt reserved before dispatch. Keep the full reservation on a timeout because the request can still be billed. [Context window](https://platform.claude.com/docs/en/build-with-claude/context-windows#context-window-overflow-behavior) · [Haiku pricing](https://platform.claude.com/docs/en/models/haiku-5-5/overview#specifications) · [Structured output overhead](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#prompt-modification-and-token-costs) · [Timeout billing](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage)

### #197/#198 pinned n8n through native TLS and Review

The combined rehearsal at `1ac4a92ee3b816d3fc7bc9d44a7beefd58a0bdc4` used n8n 2.43.7, Bun 1.3.14 and PostgreSQL 18.3 in a single loopback-only Docker namespace. The inactive export SHA-256 was `3dbb7e1de3cb7a0c7147ebfa11b7ae7041ce19c12ee7ce9f99bc747a06758326`. The fixture passed a real n8n request through the fixed native TLS transport, mounted the held intake handler with synthetic authorization, and ran real durable work dispatch and reporting with synthetic model replies.

```sh
python3 automation/n8n/jobs-feed/smoke/run-isolated.py --native-n8n \
  1ac4a92e /tmp/quantself-jobs-native-n8n-evidence.json
```

| Boundary | Count | Measured elapsed |
| --- | ---: | ---: |
| Board stub | 1 GET | 3 ms |
| n8n screening proxy | 1 POST | 147 ms |
| Native TLS provider fixture | 1 POST | 19 ms to headers, 135 ms for reservation through settlement |
| Held intake proxy | 2 identical POSTs | 75 ms first response dropped, 30 ms replay |
| Jobs held intake handler | 2 requests | 68 ms first commit, 13 ms replay |
| Enrichment and tailoring | 1 synthetic model call each | 353 ms and 316 ms with reporting |

n8n recovered the original receipt using byte-identical import content and the same idempotency key. The replay made zero additional TLS POSTs. PostgreSQL retained one import command, one held application at Review revision 1, one revision row, and one completed work item each for enrichment and tailoring. The import, enrichment and tailoring events each occurred once. The allowance row ended with one call per phase, a 100,000,000 nano-USD cap, zero held and 35,600,000 nano-USD spent. The screening attempt settled 11,200,000 nano-USD from a 52,240,000 hold. Enrichment and tailoring each recorded 12,200,000 nano-USD from a 60,000,000 hold.

Locked dependency setup took 209.10 s. The isolated run took 56.75 s, including migrations, n8n setup at 28.52 s, and n8n execution at 8.78 s. The fixture passed 30 recorded Bun assertions alongside the n8n runner checks. External provider requests were zero.

### #198 same n8n draft through Chrome and native Appointment

The November 17, 2026 rehearsal exported the held Review database at `55ea63d8` and restored it into fresh loopback Docker PostgreSQL 18.3. The Chrome fixture at `1cead498` passed 93 assertions using Bun 1.3.14, Chrome 157.0.8103.79 and Browser Use 1.0.0rc5. Application `7f496ab7-391a-4687-bc6c-0522823a74cb` kept Review revision 1 through synthetic Owner approval, verified PDF upload and download, one Chrome confirmation, the audited interview outcome and one linked native Appointment.

```sh
chain=$(mktemp -d)
python3 automation/n8n/jobs-feed/smoke/run-isolated.py --native-n8n \
  --handoff-db "$chain/review.dump" 55ea63d8 "$chain/n8n.json"
```

Match `sha256sum "$chain/review.dump"` to `handoffDumpSha256` in `n8n.json`. Start an empty disposable Docker database named `jobs_worker_integration` with the `postgresImage` recorded in that evidence, published only on loopback. Restore via `docker exec -i <fixture-container> pg_restore --exit-on-error --single-transaction --no-owner --no-privileges -U fixture -d jobs_worker_integration < "$chain/review.dump"`. Set `DATABASE_URL` to that published port, `BETTER_AUTH_URL` to a loopback URL and `BETTER_AUTH_SECRET` to a synthetic secret. Generate Prisma against the checkout and run:

```sh
QUANTSELF_JOBS_INTEGRATION_FIXTURE=1 QS_JOBS_TEST_N8N_HANDOFF="$chain/n8n.json" \
  QS_JOBS_TEST_BROWSER_USE="$(command -v browser-use)" \
  bun run test ./scripts/jobs/jobs-worker-integration.test.ts
```

Stop the fixture container and remove the temporary directory when finished. The fixture checks stale approval and proves ordinary render and submit claims cannot select the held draft. After synthetic Owner approval, a direct fixture-only SQL update releases the hold on that one restored row. The synthetic PDF digest was `ab5f87bb0fec6b92ab404202ac7216927d96cd6b3fe49af11d4324ceda3f43ab`. Chrome used a temporary profile and the synthetic Greenhouse page on loopback.

| Boundary | Requests | Measured elapsed |
| --- | --- | --- |
| n8n execution | 1 board GET, 1 screening POST, 2 identical intake POSTs | 6.45 s, including the lost response and retry |
| Native TLS and Jobs intake | 1 TLS POST, 2 intake requests, 1 synthetic model call each for enrichment and tailoring | 16 ms to TLS headers, 112 ms screening, 90/10 ms intake, 107/39 ms worker calls |
| Approval, rendering and private-answer pause | 26 API requests including rejected controls, 1 portal GET | 5.35 s |
| Guarded submission with lost receipt response | 11 API requests, 1 portal GET, 1 portal POST | 2.28 s |
| Mac worker restart | 3 API requests, 0 portal requests | 143 ms |
| Reply match, outcome, Undo and reapply | 10 API requests, 0 portal requests | 326 ms |
| Native Appointment and replay after API restart | 2 schedule POSTs, both HTTP 200 | 145/172 ms requests, 860/995 ms API startup |

The portal received zero POSTs before the durable submit acknowledgement. Dropping the committed receipt response produced a byte-identical replay and one receipt event, `2827c410-9d4e-4f5a-8e6c-a5532382fdc6`. Reply matching used the same Application Address and a synthetic message reference. Outcome replay and Owner Undo preserved the receipt. Appointment `0dc2bf37-931c-43eb-9fe6-ca62ac7d9289` kept the same UUID and audit across fresh API processes using the same key and equivalent UTC and offset timestamps. The rehearsal made zero real portal, mail or paid provider requests. Clearing the live pilot hold still requires an authorized production path.

### #198 same receipt through the Jobs mailbox matcher

The handoff command above at `e342c509` passed 97 assertions from the original n8n dump. Python 3.15.0 ran the real Jobs mail service handler, bounded IMAP/MIME reader, Sam plugin matcher and Quantself CLI against loopback fixtures. The harness passed the request directly to the service handler in place of the installed Unix socket. The verified reply linked `INBOX` UID `102`, UIDVALIDITY `345`, to application `7f496ab7-391a-4687-bc6c-0522823a74cb` and the run's Chrome receipt event `d2023d0d-2cb3-4e63-90f7-27f18defa246`.

| Inbox message | Result | IMAP commands | Jobs API requests | Elapsed |
| --- | --- | ---: | ---: | ---: |
| UID 100, same sender and subject with a forged Application Address on bare mailbox delivery | `needs_review`, `no_verified_match` | 6 | 0 | 11 ms |
| UID 101, verified recipient with two conflicting thread references | `needs_review`, `conflicting_match` | 6 | 0 | 3 ms |
| UID 102, matching SMTP recipient and alias | `matched`, `smtp_recipient` | 6 | 1 resolve POST, HTTP 200 | 193 ms |

Each read issued two `CAPABILITY` commands, one `LOGIN`, one `EXAMINE` and two read-only `UID FETCH` commands. Total mailbox harness time was 374 ms, including startup. All matching reads left the application row and receipt unchanged, with zero write audits. The confirmed UID then went through two lifecycle GETs, five outcome PATCHes and two Undo POSTs in 242 ms. The test exercised the Owner edit hold, stale revision, exact outcome replay and exact Undo replay. Status moved from applied → interviewing → applied → interviewing. Initial outcome audit `1792e9fc-060a-4778-91ef-33d398d3ce5e` was undone, and reapply audit `a3ad761a-dd21-4d8d-a1d6-446db5b31aa2` linked the same inbox UID. The original Chrome receipt persisted, and Appointment `0d640544-801d-4444-bfb7-40a15f04f364` replayed after API restart. External mail and SES requests were zero.

### #198 threaded reply and durable send receipt

The handoff command at `f1b0eb9a` passed 107 assertions. The fixture reopened `INBOX` UID `102` with UIDVALIDITY `345` through the real reply-header reader over loopback TLS. The real reply lookup used the matched Application Address to resolve `7f496ab7-391a-4687-bc6c-0522823a74cb` and verified it had been submitted. The fixture backdated the disposable application timestamp past the three-minute hold. The run retained Chrome receipt event `55387182-8307-4768-8bd9-267a09278eb1` and the linked Appointment.

The inert sender inspected the real SES `SendEmailCommand` after the mailbox service committed its SQLite reservation. The command carried the matched Application Address as sender and feedback address, `hiring@recruiter.example` as the sole recipient, the exact reviewed subject and UTF-8 text, and `<synthetic-editor-102@recruiter.example>` in both `In-Reply-To` and `References`. The draft SHA-256 was `99baf7cce6fd5f419c5632443124de5e906adcf258352705caff7377b398c635`. Command `ab80ad1f-e694-4fa2-b5cf-8d7a183ea952` committed one synthetic send receipt, `fixture-jobs-reply-102`. The harness discarded the response after that commit and recovered the receipt in a fresh process.

| Case | IMAP commands | Jobs API requests | Inert SES calls | Result and elapsed |
| --- | ---: | ---: | ---: | --- |
| No review | 5 | 2 | 0 | Fixture rejected at transport boundary, 29 ms |
| Draft edited before dispatch | 5 | 2 | 0 | Fixture rejected at transport boundary, 21 ms |
| Exact reviewed draft | 5 | 2 | 1 | Journaled, 71 ms including IMAP and API, 1 ms in SES adapter |
| Identical replay after restart | 0 | 0 | 0 | Original receipt, 1 ms |
| Edited replay with same command | 0 | 0 | 0 | `conflict`, less than 1 ms |
| Fresh command for the same inbound message | 5 | 0 | 0 | `already_sent`, 7 ms |

The six Jobs requests were three resolve POSTs and three lifecycle GETs, all HTTP 200. Dispatch and restart processes took 260 ms and 161 ms, including startup. The reply journal preserved the original application, Chrome receipt and audited outcome. External mail, SES and provider-authentication requests were zero.

#### Manual Owner send and live authentication

The on-demand service accepts a reply body from its authorized caller without a per-draft Owner approval. The two pre-send refusals above came from the fixture review gate. The existing journal enforces conflicts after reservation and deduplication by inbound message. Sam's documented draft handoff is to present the draft in Bot HQ. The local rehearsal exercised preparation and dispatch checks with the synthetic draft.

For #198, Sam hands the draft to the Owner with the application and submission receipt reference, the original inbox message and its `Message-ID`, the issued Application Address, the verified recipient, subject, and exact reply text. The Owner checks the original, reviews those values, and sends the reviewed draft in that thread from the issued Application Address. Re-review any changes before sending. Record a redacted sent reference, the linked application and thread, and an approved draft version or digest. Reconcile the sent mailbox before retrying an uncertain send.

Live acceptance for the relevant send path needs the recipient's received headers and their link to the sent receipt. Verify SPF for `bounce.luigigirke.com`, DKIM for `luigigirke.com`, and aligned DMARC for `luigigirke.com`. Reuse prior evidence only for the same deployed sender and mail configuration. If fresh authentication evidence is needed, use a separately approved live run to an Owner-controlled recipient.

### #197/#198 Owner release for one approved pilot PDF

The handoff command at `06e7f903` passed 125 assertions. The fixture opted in to the Owner preview and release route and matching runner admission. The default application returned 404 for that route, and its runner could not claim the tagged render. The fixture refreshed the archived permit's short expiry and restored the permit between revocation controls. No writes changed the application's pilot hold.

The Owner used the existing Jobs approval for Review revision 1, then requested `prepare` at `POST /api/v1/jobs/pilot/permits/{id}/review` to authorize only its render. The Owner retrieved the exact PDF through the existing Owner PDF route and supplied its SHA-256 in a `release` request. The transaction bound the existing submit work to the same owner's active permit, posting, application, approved revision and stored PDF digest. An idempotent replay returned the original authorization. A later approval must authorize its own work. The submit-start check also requires an active permit before recording a new dispatch.

| Boundary | Result |
| --- | --- |
| Owner preview and submit eligibility | Approval alone exposed neither held render nor submit. After `prepare`, the runner rendered one PDF. Submit stayed unclaimable until `release`. |
| Rejected release | Wrong Owner and unknown permit returned 404. Feed credential returned 403. Missing PDF, mismatched revision, digest or application, unbound permit, and revoked permit returned 409. |
| Concurrent release and worker | 16 pilot review requests across the rehearsal. One authorization won among competing keys. Exact replay returned the same work ID. The worker's overlapping claim returned empty, and the next claim got the one submit work item. The release checks including the private-answer pause took 1.57 s. |
| Revoked after claim | Five API requests in 57 ms. The new `submit_started` request returned 409, with zero start events and zero portal POSTs. After fixture permit restoration, ordinary Owner resolution requeued the same work item. |
| Same application through reply | One valid synthetic Chrome POST in the 1.93 s submit phase, 11 Jobs requests. Mac restart replayed the exact receipt with three requests in 142 ms and zero repeated portal requests. The linked mailbox reply, audited outcome, native Appointment and inert threaded reply receipt passed. |

Application `7f496ab7-391a-4687-bc6c-0522823a74cb`, permit `cc9f6957-1499-4b81-93e0-8c7cf8a669e6`, and submit work `ef85ee42-9d24-4fae-9520-1969988bca3a` shared approved revision 1 and PDF digest `ab5f87bb0fec6b92ab404202ac7216927d96cd6b3fe49af11d4324ceda3f43ab`. Chrome receipt event `c5f28e0c-4a7e-4602-8f1d-56aa0ee33c45` survived lifecycle and Appointment writes. Production activation remains gated. Provider, paid model and external mail requests were zero.

### #197 importable one-posting pilot and same-draft handoff

Pinned n8n 2.43.7 imported [pilot-workflow.json](../../automation/n8n/jobs-feed/pilot-workflow.json) from `90c0592e` with only the documented gateway origin, one permit, one source identity and disposable credential supplied. Export SHA-256 was `cccc8ddea6c14bd5836cd2c3d4b10b60f832095c5969cd6cbe1147541305d774`. The export ships inactive with a manual trigger. The gateway owns the preflighted posting snapshot, exact screening digests and approved policy. The default API leaves the gateway unregistered. [Configuration and rehearsal command](../../automation/n8n/jobs-feed/README.md#pin-one-posting-for-the-197-pilot)

| Execution | Gateway requests | Native TLS POSTs | n8n elapsed |
| --- | --- | ---: | ---: |
| Permit header removed at the fixture relay | 1 screen, HTTP 403 in 20 ms | 0 | 3.61 s |
| Exact permit expired in PostgreSQL | 1 screen, HTTP 409 in 200 ms | 0 | 4.60 s |
| Exact active permit | 1 screen at 195 ms and 2 intake POSTs at 197/18 ms | 1 | 8.54 s |

The active run lost its first response after durable intake. The retry sent identical bytes and the same permit-scoped key and returned application `759ec05a-f562-4036-b671-781bbbfc2126` at import revision 0. PostgreSQL retained one intake command and one held Review revision. The isolated run took 35.75 s with 9.04 s n8n import setup and 260.17 s separate dependency installation. The n8n/TLS fixture passed 24 assertions and the CLI checks. Its exported database passed 123 further assertions through Owner release, one Chrome POST, receipt replay, mailbox match, outcome, native Appointment and inert reply. Release work `e5693838-951a-4397-aae3-fe4ff013b2f3` and Chrome receipt event `818c357f-3175-4180-a628-98a57a8f11fc` stayed on the same application.

External screening, mail and paid calls were zero. Live gateway registration and credential provisioning still require the independently verified billed-input ceiling and Owner gates.

## Remaining live gates

Readiness reviewed November 17, 2026 at `f19a6511a5203525087e3c3fbef07e3c56b792d7`. Keep cutover passed. Keep n8n hosting and restore passed. Sam's on-demand mailbox tool and scoped Jobs grants have live synthetic evidence, and both PRs merged. The Mac SES rollout passed aligned SPF, DKIM and DMARC. These proofs use separate runs and releases. Record the exact deployed web, API, export and runner versions before the combined run. [#209 cutover](https://github.com/devdogfish/quantself/issues/209#issuecomment-6898976262) · [#197 hosting](https://github.com/devdogfish/quantself/issues/197#issuecomment-6904884711) · [#196 rollout](https://github.com/devdogfish/quantself/issues/196) · [#416](https://github.com/devdogfish/quantself/pull/416) · [#418](https://github.com/devdogfish/quantself/pull/418) · [#187 SES rollout](https://github.com/devdogfish/quantself/issues/187)

1. **Feed.** Clear #197 before proceeding. The Owner approves one eligible, previously unimported public Greenhouse board and posting ID, criteria, résumé template, provider workspace and spend. Verify exact target selection, exact-draft worker admission and enforceable spend before any paid call. Keep the workflow inactive. Record imported and duplicate counts, worker items, returned usage and one draft's summary and PDF.
2. **Portal.** Owner approves that posting and the exact PDF revision and digest. Sam makes one guarded submission. Record the approved revision, submission event and receipt against the same application. If the result is uncertain, reconcile with the portal before any retry. Reuse the disconnected restart and duplicate-click proof.
3. **Reply and Appointment.** Sam opens the reply during Jobs work and matches it to that application by verified recipient or recorded SES thread reference. Match portal replies by company and role only when unambiguous. Route ambiguous matches and the three-minute Owner edit hold to Bot HQ. Record the outcome, audit ID, Owner Undo and preserved submission receipt. For a fixed interview, Sam uses the scheduling grant with the agreed time and timezone. Owner verifies the linked native Appointment and alert. Verify the original through the gated Roundcube Open original flow. [#359](https://github.com/devdogfish/quantself/issues/359)
4. **Owner reply and runner SES.** Follow the [manual Owner send and live authentication checks](#manual-owner-send-and-live-authentication). [Production mail evidence](https://github.com/devdogfish/quantself/issues/365#issuecomment-6907337599)

Record elapsed times, boundary request counts, statuses and stable redacted IDs as described above. Keep credentials, résumé content and reply bodies out of the evidence.
