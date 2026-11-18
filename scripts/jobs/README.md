# Local job application runner

Quantself Jobs tracks postings, proposed résumé summaries, exact-revision approvals and submission receipts. The Codex worker prepares summaries. The Mac runner renders PDFs and submits through supported employer forms.

## Prepare the Mac

```sh
uv venv --python 3.12 ~/.local/share/quantself/jobs/runtime
uv pip install --python ~/.local/share/quantself/jobs/runtime/bin/python -r scripts/jobs/requirements.txt
uv tool install --python 3.12 'browser-use==1.0.0rc5'
```

Keep `private.json` with mode `0600` in the Jobs home. It contains local résumé paths, optional renderer paths and reviewed browser mappings. On a fresh Mac, set `resumePaths` for `engineering`, `web` and `admin` to the local base Markdown files. Use Jobs Profile to save current contact details and private answers. Set `QUANTSELF_JOBS_HOME`, `QUANTSELF_JOBS_PYTHON` or `QUANTSELF_JOBS_CHROME` to override local paths.

## Listing intake

The Owner API adds a listing at `POST /api/v1/jobs/applications`. Workbook and command-line intake use `POST /api/v1/jobs/applications/import`. Store the API origin and `jobs:write` key as `apiBaseUrl` and `apiKey` in a private `intake.json` with mode `0600`. Requirement discovery also needs `jobs:read`. Existing installs can reuse those two fields from `draft.json`.

Set `QUANTSELF_JOBS_RESUME_TEMPLATES_SOURCE` to the private host directory containing `engineering.md`, `web.md` and `admin.md` when running Compose. For a standalone API set `QUANTSELF_JOBS_RESUME_TEMPLATES_DIR`. Use portable Markdown with a Summary and the contact placeholders. Intake copies the selected template into the draft work. Historical workbook outcomes do not queue new work.

```sh
bun run jobs:add --url https://example.com/jobs/123 --company 'Example' --role 'Web Editor' --track web
bun run jobs:add --help
bun run jobs:import
```

Workbook import reads `~/dev/Excel` in batches of 100. Override the source directory with `QUANTSELF_JOBS_SOURCE`. Stable import identity preserves existing decisions and historical outcomes.

## Private workers for #293

On Keep, use the [production batch launcher](../../docs/home-production-deploy.md#stage-the-private-mac-jobs-runner) so a batch cannot overlap backup or deploy. Other Compose environments can run a batch with `docker compose -f compose.yaml -f compose.prod.yaml --profile jobs-worker run --rm jobs-codex-worker`. Supply `JOBS_WORKER_SECRET` and use the existing ChatGPT login in the shared Codex volume. Each run handles at most 20 claims and stops when rate-limited. Retain the result volume between runs.

On the Mac, set `JOBS_RUNNER_BASE_URL` to the privately reachable API origin, `JOBS_RUNNER_SECRET` to the Mac credential, and `JOBS_RUNNER_CDP_URL` to the dedicated loopback Chrome endpoint. Run `bun scripts/jobs/run-jobs-mac-worker.ts --once` for one claim or omit `--once` to poll. Keep the existing local renderer configuration and retain `worker-v2/outbox/` under the Jobs home. `QUANTSELF_JOBS_SUBMIT_DISABLED=1` keeps PDF rendering available while pausing new submit claims.

In **Jobs → Submissions → Pair Mac runner**, generate a key for a new Mac. Save it in the Mac's existing private environment as `JOBS_RUNNER_SECRET` and start the runner against the private origin. The dialog shows the key once. Generating another replaces the previous key issued here. The API continues accepting its configured environment runner credential. The runner's heartbeat appears in Submissions.

For Keep, the Mac runner requires the private tailnet origin that forwards `/api/internal/jobs/*`. The dashboard gateway returns 404 for those internal paths. Use the runner credential there and the separate Codex worker credential inside Compose.

The Mac attaches the approved PDF only after verifying its SHA-256. Supported browser forms wait for the API to acknowledge `submit_started` before the final click. A lost receipt response replays the saved result. An uncertain submission goes to manual resolution.

Configured email routes use manual handling by default. After the SES and inbound checks below, set `QUANTSELF_JOBS_MAC_SES=1` in the Mac runner environment to enable SES for its reviewed email routes. The runner sends the approved PDF from the claim's Application Address and saves the SES Message-ID with the receipt. Retain both `applications/` and `worker-v2/outbox/` so a restart can report a confirmed acceptance. A pending send requires Owner reconciliation before any resend.

A definitive SES refusal is eligible for **Requeue now**. If the result is uncertain, inspect delivery evidence before choosing **Mark not sent → Resubmit**. The API binds the decision and its timestamp to the previous SES claim and the approved PDF. The runner records that claim as SES before creating its local reservation. The authorization survives pre-send failures and ends when a replacement claim records a send start. For an expired claim that started sending, the API waits 30 seconds after expiry before authorizing a resend. An accepted receipt or older journal without matching attempt details stays on hold for manual reconciliation. Temporary journal read failures retry. The runner keeps SES reports rejected with HTTP 409 as `*.conflict` files in the outbox for review.

The integration rehearsal uses a fresh Docker PostgreSQL database named `jobs_worker_integration`, published on loopback. Point `DATABASE_URL` at it, set `QUANTSELF_PUBLIC_ORIGIN=http://127.0.0.1`, and run `bun run --cwd packages/db generate` and `bun run --cwd packages/db migrate:deploy-only`. On the Mac, run `QUANTSELF_JOBS_INTEGRATION_FIXTURE=1 QS_JOBS_TEST_BROWSER_USE="$(command -v browser-use)" bun run test scripts/jobs/jobs-worker-integration.test.ts`. The fixture uses the pinned Browser Use executable, a temporary Chrome profile, and a loopback-only synthetic application and PDF store.

## Preserve legacy submission evidence before cutover

1. Stop the legacy supervisor and both legacy workers gracefully. Let active browser or email actions settle and keep the prior checkout and Jobs home available.
2. Run `bun run jobs:archive-legacy` on the Mac against that Jobs home. The command checks legacy worker locks, copies the original result, requirement and submission journal bytes, and publishes a private archive with a SHA-256 manifest. It reports the file count and directory. Keep that archive private because the raw journals contain lease credentials. Keep `applications/`, the original legacy outboxes and `worker-v2/outbox/` through cutover and rollback.
3. While the matching legacy API is available, retry acknowledgements from the pinned prior checkout with the command below. Use the archived copy to reconcile conflicts, lost replies and uncertain browser or email actions against the application record and receipt evidence before resuming submission.
4. Keep legacy journals in their original format for reconciliation. The new Mac runner drains only `worker-v2/outbox/`. Start it with `QUANTSELF_JOBS_SUBMIT_DISABLED=1` while verifying the private API and rendering setup. Resume submissions after reconciling the legacy work.

```sh
# Run from the prior checkout, with QUANTSELF_JOBS_HOME pointing to the original Jobs home.
bun -e '
  import { drainOutbox } from "./scripts/jobs/cli.ts";
  import { readLocal } from "./scripts/jobs/config.ts";
  import { drainRequirementOutbox } from "./scripts/jobs/requirement-outbox.ts";
  await drainOutbox(await readLocal("submit.json"), "submit");
  const draft = await readLocal("draft.json");
  await drainOutbox(draft, "revise");
  await drainRequirementOutbox(draft);
'
```

The requirement drain processes up to 25 journal files per call. Check remaining entries after each run.

## Private posting configuration

Store these files outside the checkout, under `QUANTSELF_JOBS_HOME`. Keep file permissions at `0600`.

- `public-posting-hosts.json` contains a JSON array of reviewed public hostnames, for example `["careers.example.test"]`. Include each allowed hostname in a redirect chain. Standard job boards are built in.
- `email-routes.json` contains the exact rules for email listings. The Mac runner uses these rules for opt-in SES sending and otherwise marks those listings for manual handling. On the API, set `QUANTSELF_JOBS_EMAIL_ROUTES` to the mounted private file path.
- `candidate-rules.json` contains a JSON array of posting rules keyed by exact `sourceUrl`, `company`, and `role`. Give the runner and web server the same file under their Jobs home. Candidate context and Reusable details use it for their listing-specific presentation.
- `smartrecruiters-target.json` holds the runner's reviewed SmartRecruiters listing. Set `sourceUrl`, `url` (the exact apply URL), `company`, `role`, `listingTitle`, and `applicationTitle`. Without valid config, the runner skips this adapter before connecting to the browser.
- `direct-browser-targets.json` contains an array of reviewed embedded Greenhouse, Rippling, custom careers, Taleo, JazzHR, Workable, and Manatal profiles. Each entry binds the exact source URL aliases, employer, role, listing URL, and form URL. Some portals also bind form selectors, page titles, or consent text. See `browser-direct.fixture.ts` for synthetic examples. A missing or invalid registry disables these profiles before browser connection.
- `multistep-targets.json` holds reviewed Breezy and Google Forms listings. Each entry binds its listing URL, identity, respondent and apply URLs, page title, and form fields. Breezy entries include consent, history and conditional steps. A Google Form entry identifies the public résumé link field that the runner verifies against the approved PDF. Use the synthetic profiles in `browser-multistep.fixture.ts` to review the shape.
- `account-targets.json` holds reviewed account routes and their listing aliases. Workday entries also bind the first-step fields, stage count, sign-in control, and privacy URL. A Workday review step includes the exact reviewed notice, checkbox, and verification-file metadata. See `browser-accounts.fixture.ts` for synthetic profiles.
- `indeed-target.json` binds a reviewed listing, its local application ID, the exact form stages and controls, and the screening and disclosure text. Keep the selection record and approval evidence in the existing private Jobs home. See `browser-indeed.fixture.ts` for a synthetic profile.
- Enter a verified board-specific name or title under `pageIdentity` in `candidate-rules.json`. It applies to the exact listing, company, and role in that entry.

```json
[
  {
    "sourceUrls": ["https://careers.example.test/jobs/42", "https://careers.example.test/jobs/42/"],
    "company": "Example Studio",
    "role": "Web Editor",
    "recipient": "jobs@example.test",
    "subjectNamePrefix": "Web Editor",
    "questions": ["Why are you interested in this role?"]
  }
]
```

A route matches the exact posting URL, employer, and role. The configuration rejects overlapping exact matches. With `subjectNamePrefix`, the subject appends the applicant's saved name. Omit the prefix to use the role as the subject. Use an empty `questions` list for a résumé-only introduction.

Each candidate rule entry has a `rules` array. A rule has the exact field `id`, `label`, and `type`, the Candidate context `key`, and a display `title`. Optional `format` values are `count`, `integer`, `salary`, `yes-no`, and `notice`. Optional `resumeOnlyValue` applies only when Candidate context opts into résumé-only experience. An entry can also set `phoneCountry` for a verified calling-code widget, `pageIdentity` for an exact alternate company and role shown on the portal, `residence` for an exact field and country, and `referral` for an exact question and name field with a display title. Keep existing context keys and exact labels when migrating.

### Stage and roll back

1. Retain the prior runner checkout and API/web image. Pause submissions, let active work settle, and retain the Jobs home and archive.
2. Generate the inventory once from the reviewed source bundle. Point `QUANTSELF_JOBS_HOME` at that bundle, ensure `QUANTSELF_JOBS_EMAIL_ROUTES` resolves to its email routes or is unset, and run `bun scripts/jobs/check-posting-config.ts inventory /private/path/posting-inventory.json`. Keep the inventory private.
3. Stage the reviewed files outside the checkout. The runner needs all three files in its Jobs home. Mount only `email-routes.json` on the API and only `candidate-rules.json` in the web server's Jobs home. Set `QUANTSELF_JOBS_EMAIL_ROUTES` on the API and `QUANTSELF_JOBS_HOME` on the web server to the corresponding paths. Use regular, non-symlink files readable by the runtime user, with mode `0600`. Read-only mounts work. Run `bun scripts/jobs/check-posting-config.ts <runner|api|web> /private/path/posting-inventory.json` under each runtime identity, making the original inventory available for the check. The checker compares the validated entries to the reviewed inventory and prints only counts.
4. Deploy the API/web image and runner together after all three checks pass. Keep submission paused until the signed-in Candidate context view and an approved PDF pass verification.

If staging or a post-deploy check fails, keep submissions paused. Restore the previous API/web image, matching runner checkout, and runtime mounts and environment. Keep the database and Jobs home, including new journals and outbox entries. Reconcile outstanding work before resuming.

## Review and private details

In Jobs Review, edit the résumé Summary or full Markdown and approve the saved revision. An edit clears its previous approval. Codex receives the scoped posting, résumé and Candidate context needed for its claim.

Save shared contact details in **Jobs → Profile**. Application-specific questions can be answered inline in Submissions. Quantself encrypts saved private answers and resolves only the fields scoped to the active Mac claim. Each application’s Application Address is used in its résumé and employer form.

## Discover available application links

Run `bun run jobs:links` when choosing portfolio projects, public profiles or a presentation variant. It fetches the current `project`, `profile` and `variant` key/description choices from the local `private.json` application's `applicationTracking.url` (default `https://girke.dev/api/links`). Set `QUANTSELF_JOBS_HOME` to select the paired runner configuration. The request is a public GET with a five-second timeout and a bounded, validated response.

Fetch choices when needed and keep employment facts in Candidate context. The discovery command outputs public metadata only.

## Render and submit

Jobs Review renders a draft PDF from the saved résumé in the browser. After approval the Mac invokes the submission renderer with the approved revision and its scoped contact details. The runner uploads the PDF and its checksum, then verifies that checksum again before attaching the download.

Browser Use CLI fills supported forms after checking the exact employer and role. The runner verifies field values and required fields before attaching the PDF and submitting once. Coverage includes standard Lever, Greenhouse and Ashby forms plus listing-specific adapters. Live forms can change. Missing facts, changed forms, unsupported widgets, account or consent gates, and human verification can stop a run. For a verified pause requesting shared contact values, save them in **Reusable details**; eligible pauses resume with the same approved summary and PDF. Missing Candidate context facts require updating that context, reopening review, and approving again. Old listing-specific contact or phone questions are not another place to maintain those values. Changed summaries, unverified page states, account or consent gates, and uncertain submissions require separate resolution; saving a fact never retries them. The runner's private diagnostics use safe field descriptors and status codes.

When the browser verifies a missing required answer before submission, it reports scoped field metadata with the work result. Saving the answer in Submissions can resume the same approved PDF. For an uncertain submission, reconcile the portal receipt before resolving the record.

**Queued** means the worker has work to do. **Sent** reflects a confirmed browser submission, SES acceptance for delivery, or explicit Owner receipt reconciliation. The local journal reserves each approved email before calling SES. The outbox retries the Quantself acknowledgment only. Uncertain submissions require receipt reconciliation in Records before proceeding. Keep the runner's `applications/` journal directories, including historical `smtp-result.json` files, when upgrading or moving the runner so they continue to guard against duplicate sends.

## Historical SES setup and reconciliation

The Mac runner uses these SES and inbound settings when `QUANTSELF_JOBS_MAC_SES=1`. Without the flag, email listings go to manual handling.

Complete [Owner setup in #208](https://github.com/devdogfish/quantself/issues/208) before the January 2027 cutover. In SES Canada (Central), the `luigigirke.com` domain and Easy DKIM must be verified. Confirm that `bounce.luigigirke.com` shows a successful custom MAIL FROM configuration with **Reject message** on MX failure. The identity can leave its default configuration set unset. If one is assigned, keep open and click tracking off. [SES identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html), [Custom MAIL FROM](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html)

Route `dmarc@luigigirke.com` to the exact inbox the Owner specifies. Once delivery is verified, append `rua=mailto:dmarc@luigigirke.com` to the existing `_dmarc.luigigirke.com` TXT value `v=DMARC1; p=none; adkim=r; aspf=r`. Move to `p=quarantine` after clean reports. [SES DMARC alignment](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html)

### Request production access

1. Open the [Canada (Central) SES production access form](https://ca-central-1.console.aws.amazon.com/ses/home?region=ca-central-1#/account/request-production-access) from **Account dashboard → View Get set up page → Request production access**.
2. Choose **Transactional** for individual, Owner-approved replies to job postings that request email applications. Use `https://girke.dev/` for the portfolio URL and **English** for contact language. Additional contacts are optional.
3. Complete the feedback checks below. Then the Owner can check the acknowledgement and submit the request. Wait for **Production access** and sending enabled in Canada (Central). [SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)

If AWS Support asks for more detail, use this description. The runner sends individual job applications only where the posting requests email submissions. The Owner reviews and approves each application and its attachment before sending. The recipient comes from the posting. Each application has a separate reply address on `luigigirke.com`. The Owner monitors feedback at those addresses and stops sending to recipients who hard-bounce or complain. SES suppression is enabled for both. Open and click tracking are disabled.

### Verify bounce and complaint handling

The runner sets `FeedbackForwardingEmailAddress` to the approved Application Address. SES forwards the feedback to the same inbox that receives application replies. **Sent** records SES acceptance. The Owner handles later delivery failures from the mailbox.

1. In Canada (Central), open **Identities → luigigirke.com → Notifications** and confirm **Email feedback forwarding** is **Enabled**. Under **Configuration → Suppression list → Account-level settings**, enable both **Bounces** and **Complaints**. If the identity has a default configuration set, inherit account-level suppression and keep open and click tracking off. [Email feedback forwarding](https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-activity-using-notifications-email.html), [SES account-level suppression](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html)
2. During the separately authorized acceptance check, choose a test Application Address with verified inbound delivery. From **Identities → luigigirke.com → Send test email**, use that address as From and run the **Bounce** and **Complaint** simulator scenarios with a distinct synthetic subject for each. Confirm both reports arrive in the monitored mailbox. Record the time, outcome and correlating address in #208. Sandbox permits these scenarios. The simulator verifies notification delivery and leaves real-recipient suppression untested. [SES mailbox simulator](https://docs.aws.amazon.com/ses/latest/dg/send-an-email-from-console.html)
3. On real feedback, the Owner looks up the affected Job Application in Records by its Application Address and checks the original recipient. On a hard bounce or complaint, stop sending to that recipient and confirm it is in the regional suppression list. Once production access is active, add a confirmed address manually if needed, such as for a complaint received directly. Review queued jobs for the same recipient before resuming submissions. Leave the original acceptance receipt and journal intact. For temporary bounces, review the report and let SES manage delivery retries. The runner never resends the application on feedback. [SES bounces and complaints](https://docs.aws.amazon.com/ses/latest/dg/send-email-concepts-deliverability.html)

### Configure the runner's AWS profile

In **IAM → Policies → Create policy → JSON**, use this policy, substituting the account ID from the verified identity ARN. Attach it as the sole sending policy of the dedicated `quantself-jobs` principal. [SES IAM permissions](https://docs.aws.amazon.com/ses/latest/dg/control-user-access.html), [SES v2 actions and resources](https://docs.aws.amazon.com/service-authorization/latest/reference/list_sesv2.html)

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "ses:SendEmail",
    "Resource": "arn:aws:ses:ca-central-1:<account-id>:identity/luigigirke.com",
    "Condition": { "StringLike": { "ses:FromAddress": "luigi.????@luigigirke.com" } }
  }]
}
```

- With IAM Identity Center, give the runner operator a dedicated permission set with this policy in the SES account. On the Mac, run `aws configure sso --profile quantself-jobs`, select that permission set and set the default client region to `ca-central-1`. Run `aws sso login --profile quantself-jobs` to refresh the session when needed. [AWS CLI IAM Identity Center setup](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html)
- For a local workload that requires an access key, use **IAM → Users → Create user** with console access off. Attach the dedicated policy directly. Under **Security credentials → Create access key**, choose the local workload use case, then run `aws configure --profile quantself-jobs` as the Mac user that runs Jobs. Enter the key at the prompts and set `ca-central-1`. [AWS workload credentials](https://docs.aws.amazon.com/IAM/latest/UserGuide/getting-started-workloads.html)
- Verify the principal with `aws sts get-caller-identity --profile quantself-jobs`. In the [IAM policy simulator](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_testing-policies.html), check that `ses:SendEmail` allows `luigi.k7mq@luigigirke.com` on the identity ARN and denies `job@luigigirke.com`, foreign domains, and `ses:SendRawEmail`. The simulator sends no mail.

The Owner provisions the profile on the Jobs runner host and keeps any credential material in the AWS credential store. Report the profile name and the caller ARN for the handoff. The scoped policy uses the existing Canada Central domain identity and requires no account-management permissions.

Save `mail-ses.json` in `QUANTSELF_JOBS_HOME` (default `~/.local/share/quantself/jobs`) with mode `0600`. AWS credentials stay in the named profile's credential store.

```json
{
  "region": "ca-central-1",
  "profile": "quantself-jobs"
}
```

### Inbound cutover and deployment

1. Keep new submissions paused. Let in-flight work settle and reconcile uncertain sends. Preserve the Jobs home, journals, outbox and old forwarding configuration for rollback.
2. Confirm [#278](https://github.com/devdogfish/quantself/issues/278) verifies direct delivery at Purelymail. Two valid Application Addresses without individual mail-host rules must reach the same mailbox with the full recipient preserved, including a Bcc delivery. Verify rejection outside the configured routes and any prior résumé address still in use.
3. The Mac runner uses direct inbound routing for Application Addresses. It does not provision per-address aliases or read `application-forwarding.json`. The claim, private snapshot and approved PDF still bind the exact address; the SES journal still protects accepted and uncertain sends across restarts.
4. Before rollout, verify the matching and mismatched address cases for both submission paths and the SES journal recovery tests. Follow the [Keep release runbook](../../docs/home-production-deploy.md) for exact revision and image approval, backup and promotion.
5. Verify the production backup, then use the approved signed Atlas-to-Keep slot promotion to deploy the API and web app. Confirm the promotion’s Compose migrator applied or found `20261114183000_job_application_addresses` already applied before starting the candidate API. The new API only gives submission claims to workers advertising Application Address support.
6. In a separate Owner-controlled check, send from a test Application Address through SES to an Owner-controlled Gmail inbox. Use a test send because the Jobs routes target employers. In Gmail, open **More → Show original** and confirm `dkim=pass` and `dmarc=pass` for `luigigirke.com` and `spf=pass` for `bounce.luigigirke.com`. Verify that replying reaches the dedicated job mailbox and that both SES simulator notices arrive on the active route. Record results in #187. Review queued work and preview new PDFs for approvals that predate the cutover. Start the runner from the same release with submissions still paused. Lift the pause only after both devices show the reply and the release orchestrator gives the go-ahead. Retire ImprovMX after #278 confirms the new route and mail recovery are complete. [Gmail message headers](https://support.google.com/mail/answer/29436)
7. If direct routing regresses, pause again and reconcile outstanding sends. Resume the ImprovMX-dependent worker only after restoring and re-verifying that inbound route and its local config. An older worker also needs its matching API contract. Preserve the journals through rollback.

SES assigns the Message-ID. Quantself records its accepted message ID on the Job Application. Records search accepts the exact Application Address or the SES message ID from an `In-Reply-To` header. [SES header fields](https://docs.aws.amazon.com/ses/latest/dg/header-fields.html)

For Workday and Djinni accounts, prepare a separate account for the Application Address. The local account helpers use `application-identities.json` keyed by address with `email`, `vaultShareId`, `vaultItemId`, and `verifiedDelivery`. Easy Apply requires manual handling.

## Verify

```sh
bun run typecheck
bun run test
QS_JOBS_TEST_BROWSER_USE="$(command -v browser-use)" bun test --isolate scripts/jobs/browser.test.ts
```

Tests use synthetic data and local fixtures. Follow the repository's Docker-only database rule.
