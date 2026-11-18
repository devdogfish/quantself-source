# Quantself Jobs feed

[Issue #197](https://github.com/devdogfish/quantself/issues/197) · [Importable workflow](workflow.json) · [Jobs API contract and résumé handoff](quantself/README.md)

The workflow fetches public postings, screens them with Claude Haiku, and imports matches as Jobs drafts. It records source counts, estimated model spend, import results, and any Owner résumé handoff in **Record run**. Portal submission remains with Sam.

## Configure an inactive copy

1. In n8n on `keep`, choose **Import from File** and load `workflow.json`. It ships inactive with blank configuration and unbound credentials.
2. Edit **Feed configuration**. Set `quantselfBaseUrl` to the Jobs API HTTPS origin and `careerCriteria` to the Owner's actual Career requirements, including geography, remote eligibility, and any hard exclusions. Supply only text approved for the Anthropic API and n8n execution history. Choose the boards and screening limit. Example board entries:

   ```js
   boards: [
     { provider: 'greenhouse', board: 'harborglobal', company: 'Harbor' },
     { provider: 'lever', board: 'daniels-sharpsmart', company: 'Daniels Health' },
     { provider: 'ashby', board: 'felix', company: 'Felix' },
     { provider: 'wwr', board: 'remote-jobs' },
   ]
   ```

3. Bind two separate n8n Header Auth credentials. In **Screen with Anthropic**, use `x-api-key` and a workspace-scoped Anthropic Console key. In **Import Jobs drafts** and **Retry Jobs drafts**, select the same credential with `X-API-Key` and Quantself `jobs:import-tailored` only. Keep keys in the credential store. There is no subscription login or local runner credential involved.
4. Review the schedule, board list, criteria, and API origin before publishing. Schedule defaults to 08:00 America/Halifax. Running the configured Manual Trigger sends paid model requests and writes real drafts. Use the offline checks below for a dry run.

## Pin one posting for the #197 pilot

Import [pilot-workflow.json](pilot-workflow.json) for the #197 pilot. It ships inactive with a manual trigger, blank configuration and unbound credentials. The pilot workflow calls only its permit gateway. The default Quantself API leaves the gateway unregistered.

1. Use the existing Greenhouse preflight to select one hosted HTTPS listing from a complete board response. The numeric board total must match the row count, and one raw row must uniquely claim the approved numeric ID and hosted path. Pin that normalized posting snapshot, approved Career criteria, provider workspace, exact request and posting digests, and verified billed-input and pricing policy in the gateway. The gateway's server-side target binds one Owner, permit and `greenhouse:global:<board>:<posting-id>` identity to the shared allowance.
2. In **Pilot configuration**, set `gatewayOrigin` to the private HTTPS origin, `permitId` to the scoped permit UUID and `sourceIdentity` to the same Greenhouse identity. The loopback HTTP form is for the disposable fixture. Attach the same n8n Header Auth credential to all three HTTP nodes, with `X-Jobs-Pilot-Key` as the header name. The gateway owns the provider key, posting text, criteria, and pricing. The workflow sends the posting identity and permit.
3. **Screen permitted posting** attempts screening once. The gateway reserves and settles through the fixed TLS transport. Only a settled keep can reach **Import held draft**. A lost intake response retries once with the same permit-scoped key and bytes. **Record run** shows the held application ID and import revision on success. Capture that receipt from the manual run. The artifact disables retained execution data by default. Reconcile the permit ledger after uncertain screening before issuing any further command.
4. Run only the disposable rehearsal while the live gates are open. A later approved pilot needs the billed-input ceiling and Owner gates. The held draft goes through the existing gated worker and exact Owner PDF release flow. [Pilot and Owner release acceptance](../../../docs/testing/jobs-198-acceptance.md#197198-owner-release-for-one-approved-pilot-pdf)

```sh
bun automation/n8n/jobs-feed/build-pilot-workflow.mjs --check
python3 automation/n8n/jobs-feed/smoke/run-isolated.py --native-n8n \
  --handoff-db /tmp/jobs-pilot-review.dump <commit> /tmp/jobs-pilot-evidence.json
```

## Operations

- Greenhouse, Ashby and We Work Remotely each use one request per board. Lever requests up to 100 rows per page and follows the offset until a short page, up to ten pages. A full final page at the ceiling or any failed page leaves that board out of the run and records the reason. Start with a small allowlist. We Work Remotely coverage is limited to its published RSS window.
- The workflow deduplicates provider posting identities before screening, then caps calls at 50 per run by default with at most four in flight. If capped, the selected window rotates by UTC day. Screenings can repeat on later runs. The Jobs API deduplicates Greenhouse by board and posting ID at import. Other sources use canonical URLs.
- Model pricing is estimated from returned usage at standard global Haiku 5.5 rates. Paid skips and malformed results with usage still count. `unpricedRequests` counts requests without usable usage. Check the Anthropic Console for the bill after an ambiguous transport failure. Model calls have no automatic retry.
- Import requests carry up to 100 rows and stay below the Jobs body limit. Transport and transient server/write failures retry once with the original key and payload. A later execution uses a fresh key and the API skips previously imported canonical URLs. Different source URLs that resolve to different canonical identities can still represent the same job.
- Open **Executions → Record run** for the dated report and `completed_with_errors` status. That status is in the output of a completed n8n execution. Inspect failed batches and any Owner handoff there. The export saves full execution history under the instance's retention policy, including board payloads and model prompts. Restrict access to the workflow and its executions. Keep reports needed beyond pruning outside n8n.
- For confirmed additions, use the [Owner résumé handoff](quantself/README.md#full-résumé-tailoring-requires-the-owner). The API returns aggregate counts, so a mixed batch lists candidate URLs to look up in Jobs. A failed or unknown import is not counted as confirmed.

## Coverage and verification

| Item | Evidence or remaining handoff |
| --- | --- |
| Public sources | Greenhouse, Lever, Ashby and the We Work Remotely RSS feed tested with public responses. Jobs.ca, Indeed, SimplyHired, Workopolis, SaskJobs and other standalone career sites remain outside the allowlist adapters. Add coverage when a public, authorized posting feed is available. |
| Drafts and duplicates | Fixture replay after a committed request loses its response keeps the same key and body. The repeat feed run yields three duplicates and zero new drafts. API contract checked against current Jobs routes and persistence code. |
| Model work and spend | Five model fixture responses across two loop batches produce an estimated USD $0.000625. The truncated result contributes usage and creates no draft. |
| Full résumé tailoring | **Open.** Owner can edit the chosen variant on the imported draft. A scoped key cannot read and save the full résumé, the Owner-only `revise` endpoint queues summary work, and the worker result contract accepts a summary only. |
| n8n on `keep` | **Open.** The export and Code nodes were verified offline with fixture HTTP responses. Actual import and execution on `keep`, credential validation, paid calls, and real Jobs imports were outside this change. |

```sh
bun test --isolate automation/n8n/jobs-feed
bun automation/n8n/jobs-feed/build-workflow.mjs --check
```

Edit the modules and `build-workflow.mjs`, then run `bun automation/n8n/jobs-feed/build-workflow.mjs` to regenerate the JSON. The export's Code steps run without extra n8n task-runner modules.

Provider and platform contracts: [Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html), [Lever Postings API](https://github.com/lever/postings-api), [Ashby Job Postings API](https://developers.ashbyhq.com/docs/public-job-posting-api), [We Work Remotely RSS](https://weworkremotely.com/remote-job-rss-feed), [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [n8n import](https://docs.n8n.io/workflows/export-import/), [n8n HTTP Request](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/).
