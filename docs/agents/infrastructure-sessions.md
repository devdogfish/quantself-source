# Infrastructure session workflow

Required for infrastructure setup, recovery testing and deployment/cutover, especially [#209](https://github.com/devdogfish/quantself/issues/209). Learned from the roughly nine-hour [#254](https://github.com/devdogfish/quantself/issues/254) session on 2026-11-14: repeated credential handoffs, untested helper assumptions, browser changes and one-off retry scripts added avoidable work. Preserve independent restore, authorization and media checks; reduce the work surrounding them.

## Prepare before involving the Owner

1. Read the task, [#217](https://github.com/devdogfish/quantself/issues/217), relevant ADRs and existing handoff evidence. Keep one acceptance ledger in the task's runbook or issue. For each requirement record: status, responsible operator, exact target/revision, evidence, applicable approval and next action. Record identifiers and approval scope, never secret values. A completed check is reopened only when its inputs changed, evidence is missing or a new failure contradicts it; record that reason.
2. Preflight the actual environment read-only: container/runtime versions, DNS and TLS from the executing machine/container, free capacity, browser profile, password-manager availability and existing credentials' presence/expiry without revealing values. Default to the Owner's existing Brave profile for interactive steps. Use another profile only when the requirement warrants the extra login/trust work.
3. Prepare the whole next phase: reviewed commands/helpers, expected results, failure recovery, rollback and exact disposable resources to remove. Test helper parsing and retry behavior with representative sanitized fixtures before asking the Owner to run it. Include the failures seen in #254 where relevant: credentials containing spaces, omitted output on successful commands, delayed guest readiness, trust-store differences and interrupted dispatch. Syntax checks alone are insufficient for a helper that orchestrates live changes.

Preparation is complete when the phase can run to a checkable result, with only genuinely Owner-only actions left for the Owner.

## Credentials and approvals

- Separate permanent setup/recovery credentials from disposable test credentials. The Owner saves permanent credentials and recovery material through the approved handoff. For tests, prepare a scoped lifecycle: isolated targets, minimum permissions, expiry, private temporary storage for retries, revocation and cleanup. Do not ask the Owner to save disposable credentials in their password manager.
- Follow #217's credential boundary unless the Owner explicitly authorizes an exception for the named test environment. Once authorized, automate that temporary lifecycle and reuse the private handoff on retries. #254's exception for restore VMs 2542/2543 does not authorize production credential handling or new #209 targets. Browser-mandated login, credential-entry and trust handoffs still apply.
- Request approvals against the prepared phase, naming its hosts, actions, data/resources, exposure, cleanup and rollback. Group related actions when the applicable policy permits. Reuse existing approval while its scope remains valid; ask again only for a changed scope or a policy that requires confirmation at action time. Phase approval is not blanket permission for later cutover or deletion of rollback data.
- Give each Owner handoff one exact location/command and one visible success condition. Finish the agent-owned preparation first. If it fails, inspect and repair the cause before asking the Owner to repeat it.

## Execute and resume

- Use one durable operation journal and a resumable helper for a workflow. Persist intent and exact target/operation identity before dispatch, then record the returned task ID immediately. After a timeout or lost reply, reconcile the original operation against the target and durable task records. Verify current identity and state before continuing. A missing response does not authorize another restore, upload, credential creation or deletion.
- Preserve failed evidence. Continue from the failed step after reconciliation rather than building a fresh workflow for each retry. Keep temporary secrets in protected storage, out of logs and the acceptance ledger; expire/revoke them and remove approved scratch material when finished.
- After a repeat failure, stop cycling Owner prompts or creating replacement credentials. Capture a narrow, agent-runnable failure signal; fix and regression-test that cause, then resume the recorded operation. Ask the Owner only when a missing decision, authorization or Owner-only action actually blocks progress.
- When delegation is authorized, use up to three independent workstreams: implementation, verification/recovery, and evidence/runbooks. Assign explicit file ownership, outputs and mutation boundaries. Keep one operator responsible for live changes; parallelize independent local/read-only work. Do not have several agents operate the same browser, VM or acceptance test.
- Record phase duration, Owner handoffs and repeated attempts in the session closeout. Separate execution time from waiting for human input or external jobs. During long work, report the remaining acceptance gates and current blocker rather than speculative percentages. Update the same ledger across handoffs/context recovery.

## Apply this to #209

Start with the [#254 handoff](../infra/keep-storage/README.md), [deployed bundle](../infra/keep-storage/deployment.md), [recovery runbook](../infra/keep-storage/restore-runbook.md) and [nightly evidence](../infra/keep-storage/nightly-proof.json). Read #253's conversion contract and #209's current issue requirements. Reinspect mutable live state, but reuse the completed proofs whose inputs still match.

Prepare these phases before requesting the corresponding live action:

| Phase | Prepared result and completion criterion |
| --- | --- |
| Deployment and routing | Configurable deployment, ephemeral CI access and route allowlist are reviewed and locally tested. Name the remaining live CI/iPhone tests: #254's evidence for those sources was policy-only. |
| Private migration rehearsal | Inventory every authoritative database/volume, including capture audio and auth state. Exercise #253's resumable conversion with count/hash/reference manifests, app/media acceptance and coordinated recovery. Record the exact versions and rollback inputs. |
| Owner cutover window | Prepare final write pause/copy, DNS and webhook changes, passkey identity preservation, verification commands, rollback trigger and rollback steps. Obtain the required scoped approval only after this plan is reviewable. Preserve rollback copies. |
| Acceptance and closeout | Verify real CI deployment, private/public route boundaries, passkey sign-in, receipts, recordings/playback/seeking, other #209 integrations and production database-plus-originals recovery. Record timings and scope limitations, clean up only approved test resources and hand off #226. |

These are preparation phases, not additional approvals or replacement acceptance criteria. #209 remains authoritative. VPS cancellation, original deletion and rollback-copy removal retain their separate authorization requirements. A completed #254 synthetic restore does not substitute for #209's production recovery proof.
