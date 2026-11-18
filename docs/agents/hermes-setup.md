# Hermes setup spec

**Approved.** This spec governs [#195](https://github.com/devdogfish/quantself/issues/195), [#354](https://github.com/devdogfish/quantself/issues/354), [#355](https://github.com/devdogfish/quantself/issues/355) and [#356](https://github.com/devdogfish/quantself/issues/356). Vaultwarden is a rollout prerequisite. [#366 setup discussion](https://github.com/devdogfish/quantself/issues/366#issuecomment-6908222087) · [#376](https://github.com/devdogfish/quantself/issues/376)

Decisions build on ADRs [0041](../adr/0041-agents-are-coworkers-outside-quantself.md), [0042](../adr/0042-memory-layers.md), [0045](../adr/0045-self-hosted-home-infrastructure.md), [0046](../adr/0046-agents-own-their-tasks-and-sandcastle-is-engineering-only.md) and [0047](../adr/0047-agents-help-with-owner-to-dos-through-delegation.md).

Rule: anything not listed here is not installed. Workers (AI sessions) may not add modules, skills, plugins or change settings outside this spec. A change goes through a spec PR the Owner approves first.

## 1. Version and install

- Pin stable **v0.23.1** at commit `3b421578588243f920886e6fe79a6faa87ea026e`. Use stable releases only.
- Run the official `scripts/install.sh --commit <sha> --non-interactive` from that commit under the locked `hermes` user on each machine.
- Repo-owned `hermes-gateway.service` and `hermes-screen.service` run the stock gateway and screen as `hermes`. The installer loads the units and enables the gateway at boot. The gateway starts the screen, and systemd restarts both after a crash.
- Update only by a spec PR that bumps the SHA. Then run `hermes doctor` and the Agent's verification list (section 9). Hermes has no setting that disables `hermes update` or `/update`, so the rule is enforced by this spec, and the verification list checks the version.
- Settings that workers and Agents must not change are pinned in Hermes Managed Scope: root-owned `/etc/hermes/config.yaml` wins per key and `hermes config set` refuses to change them.
- Each Agent has an `install.sh` in [`agents/<name>/`](../../agents/README.md).

## 2. Model, provider and approvals

Same for Sam, Stacy and Tyler (decided 2026-11-15, per #195):

| Setting | Value |
| --- | --- |
| Reasoning and tools | Codex subscription (`openai-codex`, `gpt-6.1-sol`). Use subscription credentials for Codex only. Moves to Anthropic API keys when the Owner switches (ADR 0041) |
| Written drafts | Sonnet 5.5 (`claude-sonnet-5-5`) via Anthropic API key through the draft helper |
| Approvals | `smart` |
| Starting autonomy | Agents draft outbound work for the Owner to send. Bot HQ may send email from an Agent to the Owner under section 5. Sam may send employer replies through the Jobs workflow below. Never send in the Owner's name |

Starting autonomy (default 2026-11-16; the Owner adjusts it by telling the Agent, ADR 0041):

| | Sam | Stacy, Tyler |
| --- | --- | --- |
| Alone, with Undo | Link messages, update Job Applications, create an interview Appointment, and mark or organize mail in the dedicated Jobs mailbox ([#196](https://github.com/devdogfish/quantself/issues/196)) | Read Quantself; update own Bot HQ tasks; write notes and drafts in the brain inbox and the Work file space |
| Ask first | Anything unsure | Anything on the Owner's calendar or to-dos; anything unsure |
| Never | Send as the Owner; delete | Send as the Owner; delete |

Pin `approvals.mode: smart` and keep `cron_mode`, `single_query_mode` and `unattended_mode` at `deny`. Bot HQ unattended routines deny prompts that need a human decision and notify the Owner.

## 3. Modules, plugins, skills, tools per Agent

Common to all three (from #195, #214, ADR 0042):

| Item | Reason |
| --- | --- |
| `quantself` CLI skill | Quantself access through the scoped API key (ADR 0041) |
| `obsidian` and `llm-wiki` skills | Read the brain, append suggestions (ADR 0042) |
| Honcho memory provider plugin | Owner memory plus the Agent's peer (ADR 0042) |
| Per-Agent Vaultwarden service and repo-owned Hermes tools | Protected website sign-in, reading and approved form submissions (#376), plus read-only access to the Agent's own business inbox (#360) |
| Gateway and screen | Bot HQ chat and live screen (ADR 0046) |

Hermes toolsets for all three (default 2026-11-16; tightened per Agent later by spec PR):

| Toolsets | Status | Reason |
| --- | --- | --- |
| `file`, `terminal`, `web`, `browser`, `computer_use`, `vision`, `memory`, `skills`, `session_search`, `todo`, `clarify`, `delegation`, `code_execution` | On | General coworker work: research, browser and screen tasks |
| `cronjob`, `catalog`, `connections`, `desktop_ui`, `project`, `kanban`, `image_gen`, `video_gen`, `video`, `tts`, `x_search`, `discord`, `discord_admin`, `feishu_doc`, `feishu_drive` | Off, pinned in `agent.disabled_toolsets` | Bot HQ owns routines; the rest are not needed yet; `catalog` and `connections` would let an Agent install things |

- Agents may write their own skills as role memory (ADR 0042). Allowlist Honcho and the repo-owned sign-in, protected reader, configured form submitter and business mail reader in Managed Scope. Disable Hermes's built-in `browser_vault` Bitwarden integration for Agent website logins. Opt out of bundled skills. Upstream still seeds its essential `hermes-agent` skill.
- Each Agent has its own read-only business mailbox access at Purelymail (ADR 0049, 0051). See the #360 handoff in section 6.

| Agent | Machine | Role-specific extras |
| --- | --- | --- |
| Tyler Scott | `tyler` (M710q) | Operations and Sales Assistant and the Owner's Personal Assistant. Personal Gmail, Appointments, and To-Dos as specified below. Client data and CRM await the ADR 0046 decision |
| Stacy Ross | `stacy` (M710q) | None yet |
| Sam Lee | `vm sam` on `atlas`, 8 GB, growable to 16 GB | Jobs mail plugin and local service for the separate job-applications mailbox. Sam alone runs job applications (ADR 0046, 0051) |

Tyler is the sole Agent with the Personal Assistant role under ADR 0049.

Sam's repo-owned `quantself-jobs-mail` plugin exposes `quantself_jobs_mail` through the revocable local Jobs mail service. Sam checks replies on demand and asks the Owner in Bot HQ when the match is ambiguous. His Quantself Jobs permissions are `jobs:read`, `jobs:write` and `jobs:schedule-interview`. The service can send a threaded SES reply from the registered Application Address for a submitted Job Application, using the matched inbound message to bind the sender, recipient and thread. Record writes and delivery receipts. Reversible changes support Undo. [Owner-approved scope and deployed verification](https://github.com/devdogfish/quantself/issues/196) · [ADR 0051](../adr/0051-three-inboxes-life-jobs-business.md)

## 4. Memory (Honcho)

Self-hosted Honcho on `keep` (ADR 0045), Hermes `memory.provider: honcho`. One fleet-wide Honcho endpoint and workspace, with one shared Owner peer (`peerName`) and one AI peer per Agent (`aiPeer`). `pinUserPeer` keeps the Owner identity consistent. `sessionAiPeerPrefix` keeps sessions distinct between Agents. Conversations are saved to Honcho. Secrets and encrypted fields never enter Honcho (ADR 0042). The Honcho token lives in the Agent's Vaultwarden vault.

Hermes v0.23.1 selects plugin dependencies before applying Managed Scope, so the installer renders `memory.provider` in both Managed Scope and the gateway's read-only profile.

## 5. Gateway, screen and Bot HQ registration

Each Agent exposes a Hermes gateway and a screen reachable only by Bot HQ's Tailscale tag (ADR 0047).

How Bot HQ talks to Hermes

- Create turns with `POST /v1/runs` and stream events from `/v1/runs/{id}/events`. Health and models come from `/health` and `/v1/models`.
- Stop posts to `/v1/runs/{id}/stop`. Bot HQ waits for Hermes to confirm cancellation. A `smart` escalation emits an `approval.request` event. Bot HQ renders an approval card and returns the decision to `/v1/runs/{id}/approval`.
- Bot HQ PR #1 verified both paths against stock Hermes at the pinned commit. Stop cancelled a running terminal command. Deny preserved the test file, Allow once permitted the command, and an unattended routine denied the escalation and posted a notice. [Bot HQ PR #1](https://github.com/devdogfish/bot-hq/pull/1)
- Enable the API server on the Agent's Tailscale address with `API_SERVER_ENABLED`, `API_SERVER_HOST`, `API_SERVER_PORT` and `API_SERVER_KEY`. Give Bot HQ the gateway key from the Agent's Vaultwarden vault.
- Pin `hq` as the sole MCP server and select it explicitly in the CLI and API server toolsets. The service binds a read-only profile that supplies `secrets.command` before Hermes applies Managed Scope. The gateway discovers MCP servers from Managed Scope. Use the per-Agent MCP URL from Bot HQ registration. Load its bearer token from the Agent's Vaultwarden vault as `BOT_HQ_MCP_TOKEN`.
- The gateway binds the managed host environment over the raw profile `.env`. Provider credentials come from the vault helper and Codex device sign-in. The host environment contains only configuration.
- Bot HQ owns routines and approval cards. Hermes runs on the Agent machine under the repo-owned systemd unit.

Registration contract for each Agent

- Bot HQ's own record: name, label, description, instructions, avatar, voice, model, provider. Persona (`SOUL.md`) and memories stay in the Agent's Hermes home.
- In Bot HQ Engine, save the Agent's virtual model alias from `/v1/models` (`tyler`, `stacy` or `sam`). The alias selects the Agent's Managed Scope default for Runs.
- Added for remote Agents: the Agent's API server URL on Tailscale and its `API_SERVER_KEY`, its noVNC/websockify URL and VNC password, and its Chrome DevTools port.
- Save the connection and get the per-Agent MCP settings before the first gateway start. Store the MCP token in the Agent's vault and its HTTPS URL in the fleet file. Verify Chrome and screen control after startup. [Agent rollout runbook](../../agents/README.md#register-in-bot-hq-before-the-first-gateway-start)

Screen on each Agent machine (replaces Orgo):

- Run the browser on X display `:99`. The VNC server and Chromium's DevTools listener bind to loopback. Websockify and the DevTools relay bind to the Agent's Tailscale address. Bot HQ relays the live view and takeover.
- The VNC password lives in the Agent's Vaultwarden vault. Chrome runs on that display with its DevTools port open to Bot HQ only.

Network, adding to ADR 0045:

- Bot HQ reaches each Agent's API server, websockify and DevTools ports.
- Each Agent also reaches Bot HQ's `hq` MCP server (port `8787`). This is the one Agent → Bot HQ path, and Bot HQ-to-bot messages, hand-backs and approvals need it. The Tailscale policy change needs the Owner's yes (#217 rule 4).

Bot HQ's outside services:

- xAI for voice: allowed (ADR 0046).
- Orgo: removed.
- Composio (connected apps, triggers): off until a spec PR approves it, because it routes app access through a third party.

Live validation still covers the approved Tailscale policy, the registered Agents, and each Agent's introduction, Stop, approvals and pause.

### Email the Owner from Bot HQ chat

- A clear request in authenticated Owner chat, such as “email me the status,” authorizes one email in that turn for Stacy or Sam. Tyler always requires a card. Send one message addressed to all three Owner inboxes in `To` (`luigigirke@gmail.com`, `devdogfish@proton.me` and `devdogfish@pm.me`). If the Owner asks for fewer recipients, explain the three-address scope and require explicit approval of the exact distribution before sending to all three.
- Use a Bot HQ smart approval card when an Owner chat request to send needs confirmation. Show the exact sender, all recipients, subject and plain-text body. Approval permits that message once in the same turn. Routine, bot, system and external turns may prepare drafts.
- Stage the message through the existing `hq` MCP connection and a public turn reference. Bot HQ binds the staged message to the exact authenticated Owner chat row, registered Agent and proposal receipt from the matching tool completion in a successful Hermes run. When Hermes omits the receipt from the event, Bot HQ reads the matching transcript row through the Agent gateway. Bot HQ reports the SES result in chat. Expire unsent authorization when the Bot HQ turn ends, stops, is paused or is reset. Reject replays.
- Bot HQ sends through Amazon SES using the registered Agent's own address at `dawnshiftagency.com`. Pin `tyler@dawnshiftagency.com`, `stacy@dawnshiftagency.com` and `sam@dawnshiftagency.com` to their exact Bot HQ bot IDs on the server. Limit SES to those senders and the three Owner addresses. Keep exact envelope configuration and SES credentials on Bot HQ. Reserve the send before calling SES. Record confirmed acceptance and hold further sends from that Agent while a submission remains unconfirmed. Business inbox reading and the Jobs mail workflow remain governed by section 6 and ADR 0051.
- Before live rollout, exercise synthetic Bot HQ chats with fake SES credentials. Verify a clear request to Stacy or Sam sends once to all three addresses without a card, Tyler always requires a card, approval authorizes only the exact displayed message, and denial preserves the draft. Verify rejection of altered senders or recipients, forged or out-of-turn requests, unattended turns, replays, and stale approvals after Stop or Pause. Verify an uncertain SES result causes no duplicate attempt. Get the Owner's named yes for each machine or Tailscale change and the scoped live test. After activation, verify a harmless email from each enabled Agent reaches the three Owner inboxes and record delivery evidence without secrets.

### Tyler's Personal Assistant role

- Bind personal Gmail access to a private Bot HQ conversation paired with Tyler's existing identity. Use a separate Hermes profile and gateway under a separate locked service user on Tyler. The personal profile uses only the private Bot HQ tools. It has no shared Honcho, Brain, Work, or Agent messaging access. Start personal turns from authenticated Owner chat. The Owner consents privately to Gmail OAuth. The read/send grant supports bounded inbox and thread reads, including an unread-only inbox filter and Gmail’s unread flag on each returned message. The mailbox-management grant uses the full Gmail scope required for permanent deletion. Bot HQ holds either grant server-side. Pin Gmail to the Owner's approved address. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- With the mailbox-management grant, Tyler can archive or trash one message at a time and apply or remove an existing user label. Require an explicit Owner command in the private chat, use a message read in that turn, and keep inbox state unchanged during read-only triage. Permanent deletion of a message read in the turn requires a separate authenticated Owner approval card showing its exact message ID, sender, subject, and date. Bot HQ sends one delete request only after approval, checks that the turn remains eligible, and requires reconciliation after an uncertain result.
- Tyler triages incoming mail and drafts routine replies, including scheduling, confirmations, and acknowledgements. Every email Tyler sends requires an authenticated Owner approval card, including replies from Gmail and sends through the existing Dawnshift route. The card shows the final sender, all recipients, subject, and body. Reserve the exact send once on approval. Edits require a new approval. Denial, expiration, replay, and an uncertain provider result follow the existing send safeguards. A future Owner-approved spec change may relax this policy.
- Let Tyler add a Quantself Appointment or To-Do when personal mail establishes a clear commitment or action. Use a Tyler-only create path with source provenance, deduplication, and Undo. Check for conflicts and ask when an action, time, or time zone is ambiguous. Keep personal records Owner-only or available to Tyler under his scoped access. Calendar entries created by Tyler send no invitations. Edits and cancellations retain their existing authorization rules.
- Before activation, use fake Gmail and Quantself data to verify Tyler-only mail reads and record creation, duplicate handling, Undo, and denial for Stacy and Sam. Verify unread filtering, scoped inbox changes, and refusal of permanent deletion before approval. Verify every Tyler send needs a card, including when the Owner directly asks him to email. Test that changes after approval, replay, and escalation from mail content cannot send or change permissions. Apply with the Owner's named rollout approvals, then verify one scoped inbox read, one approval-gated test reply, and disposable Appointment and To-Do creation and Undo.

## 6. Secrets and rebuild

Secret storage and handoff

| Where | What |
| --- | --- |
| On the machine, as one systemd encrypted credential (`systemd-creds`, tied to that machine) | The Agent's Vaultwarden unlock secret only |
| The Agent's Vaultwarden vault | Website logins and TOTP (#214), Anthropic key, Quantself API key, Honcho token, gateway and Bot HQ MCP tokens, VNC password and mailbox credentials |
| The Agent's Hermes home (`auth.json`) | Codex sign-in token only. It renews itself, so a stored copy would go stale. Re-sign-in: `hermes auth add openai-codex` shows a device code; the Owner approves it on their own device, and no password is typed on the Agent machine. If renewal fails, Hermes stops using the token until the Owner signs in again |

- Pin `secrets.command.helper_timeout_seconds: 15`. The non-interactive startup helper asks the login service for allowlisted API keys and emits `KEY=VALUE` lines to Hermes. Disable the built-in Bitwarden Secrets Manager (`bws`) source. Website login values stay outside startup output and model context.
- `bw` keeps an encrypted local copy of the vault, so a short Vaultwarden outage does not stop an Agent from starting.
- Sharing (decided 2026-11-15): Agents and the Owner work as a team and share logins with each other, like coworkers. Shared logins live in collections of the Owner's Vaultwarden organization (#214). An Agent may share a login with the Owner or another Agent by putting it in a shared collection and granting access. Shared items become organization-owned, so the Owner always sees and controls them. Private items stay in each Agent's own vault. To revoke, remove the grant and sync. For a hard cutoff, also rotate the password, because a cached copy or a signed-in website session can still work. Sharing is also subject to the ADR 0041 rule: no Agent sends as the Owner, whatever logins it can see.
- The Owner is the admin of the Vaultwarden organization. To rotate a startup key, change it in Vaultwarden, refresh the Agent's Vaultwarden cache, then restart the Agent. The Owner's own keys stay in the Owner's own password manager.
- Rule: no secret in git, in logs or in the issue tracker.
- Rebuild from repo plus secrets: clone the repo, run the Agent's installer with the common fleet settings file, and have the Owner restore the machine credential with `systemd-creds encrypt` and complete Codex device sign-in. Verify by rebuilding a disposable `hermes` home in #356.
- Prerequisite: Vaultwarden is installed, backed up and restore-tested before any Agent goes live (#214 rollout checks).

### Agent business mailbox handoff (#360)

- Use implicit TLS with certificate and hostname verification at `imap.purelymail.com:993`. Pin the corresponding `sam@dawnshiftagency.com`, `stacy@dawnshiftagency.com` or `tyler@dawnshiftagency.com` username and one Vaultwarden login item ID in root-owned configuration. Leave the reader disabled until configured. [Purelymail server settings](https://support.purelymail.com/support/solutions/articles/159000430778-server-settings-imap-smtp-pop3-and-managesieve-protocols)
- The Owner creates a dedicated Purelymail app password with only IMAP enabled and enters it directly into the Agent's vault or an Owner collection shared solely with that Agent. The app password scopes protocols. The service enforces read-only access. Revoke the app password at Purelymail for immediate cutoff. Sam's Jobs mailbox is outside this reader's scope. [Purelymail app password scopes](https://support.purelymail.com/support/solutions/articles/159000412945-how-to-create-and-scope-app-passwords-imap-smtp-only-dav-)
- Run IMAP under the existing per-Agent Vaultwarden service user, through the existing local socket. Sync before retrieving the pinned item and require the exact configured username. Deny on failed sync, lost grant, missing item or explicit Owner lock. Close the IMAP connection on completion, cancellation or timeout. Keep the credential out of Hermes environment variables, tool output and operational logs.
- Expose one repo-owned Hermes tool to list recent `INBOX` headers and read one message by UID and `UIDVALIDITY`. The Agent may supply only list limits and a message identifier. Open the inbox with `EXAMINE`, batch header fetches and use `BODY.PEEK` with size limits. Return bounded headers and plain-text content. Reject stale `UIDVALIDITY`. No attachments, HTML rendering, arbitrary IMAP commands, flag changes, moves, deletions or sending. The credential has SMTP disabled and the tool has no SMTP transport. [IMAP read semantics](https://www.rfc-editor.org/rfc/rfc9051.html#name-fetch-command)
- Before rollout, use fake credentials and a TLS IMAP fixture to verify allowed reads, unchanged flags, blocked writes and cross-mailbox requests, wrong username, revoked access, lock and TLS failure. Check that no credential appears in Hermes, Bot HQ, Honcho or logs. Through pinned Hermes and Bot HQ, verify each Agent can read its own existing #360 test message while requests targeting the other two mailboxes are refused. Record status only.

### Website sign-in service (#376)

- Give each Agent's login service its own locked Linux user, separate from `hermes`. Run `bw` with a private profile and run a private browser under that service user. The service alone reads the machine-bound systemd unlock credential and holds the `bw` session key. Keep the browser's controls, profile and display inaccessible to Hermes and the normal Bot HQ screen.
- The repo-owned Hermes tool requests a login by vault item and returns status only. The service checks the page and credential submission target against the exact saved HTTPS origin (scheme, host and port) before entering a credential. Check the origin again before handing off the session. Refuse a mismatch, including after a redirect. For shared items, require a successful Vaultwarden sync and a current grant before starting a fresh login.
- After sign-in, transfer only the saved origin's cookies needed for the authenticated session. A cookie must be `Secure` and either host-only for the exact saved host or scoped to that host's own registrable domain, as determined by the [Public Suffix List](https://publicsuffix.org/learn/). For example, `www.linkedin.com` may use `Domain=.linkedin.com`. Refuse all other scopes, including public suffixes and unrelated domains. Preserve each accepted cookie's scope, security attributes and path. Refuse transfer if those cannot be maintained. Confirm that the service-owned Agent context is signed in before returning success. Chromium uses a private DevTools pipe. The Agent's regular screen and raw browser tools use a separate browser profile. The protected reader returns visible text on the saved origin, with session values masked. Keep passwords, TOTP, raw cookie values and private browser output out of login tool responses, Bot HQ handoff messages, transcripts and logs.
- Allow protected form submissions only from an Owner-reviewed site recipe. Pin the form page, exact same-origin HTTPS POST target, writable fields, submit control and success marker. Refuse credential fields and extra POSTs, including POST redirects. The service requires a one-use approval from the Owner's private admin console for the exact item, form and field values, except for recipes that explicitly grant the Agent autonomy for the action. Keep Owner-only actions out of Agent recipes. If the result is uncertain, inspect the site before retrying. [Approval procedure](../../agents/vaultwarden/README.md#prepare-the-agents-vault)
- Agents own 2FA for their accounts. Use an Owner-reviewed TOTP recipe for native code entry. Read the current code from the approved Vaultwarden item only when its pinned challenge appears. Submit it once on the same private page to the reviewed action and verify sign-in. Mask the code and password in protected reader output. [#376 clarification](https://github.com/devdogfish/quantself/issues/376#issuecomment-6924887196)

| Condition | Behavior |
| --- | --- |
| Missing, unusable or rejected vault code | Close the attempted login context and return `sign_in_blocked`. The Agent reports the block in its Bot HQ reply. |
| Unsupported 2FA or device challenge | Close the attempted login context and return `sign_in_blocked`. The Agent reports the block in its Bot HQ reply. Protected visual takeover for other same-browser challenges remains a rollout check. |
| Site rejects cookie transfer | Report failure in Bot HQ and clear cookies imported by that attempt. Offer protected takeover when available. |
| Idle timeout | Drop the `bw` session key and close the private login browser. Unlock on the next permitted request using the same machine credential. |
| Owner explicitly locks the service | End active requests, drop the vault key and close the protected browser. Refuse new unlocks, including after service restart, until the Owner explicitly unlocks it. Use the website's session controls to revoke the session on the site itself. |

Use fake credentials and test sites for all #376 service verification. Exercise the login tool through stock pinned Hermes and Bot HQ.

- Prove that Agent tools and shell cannot access the protected DevTools pipe or retrieve a cookie through the regular screen's CDP. Prove authenticated handoff, refusal of a wrong origin or cross-origin redirect, cleanup after a rejected cookie transfer, and status reporting for blocked sign-ins.
- On the fake HTTPS site `www.login.example.com`, verify that a `Secure` session cookie with `Domain=.example.com` transfers with its scope intact and the Agent's browser can use the authenticated session. Feed fake cookie candidates with `Domain=.example.org` and `Domain=.com` to the transfer check and verify both are refused and neither is imported.
- Verify first use after reboot, idle relock and on-demand unlock, explicit lock across service restart, and concurrent unlock requests.
- Verify sharing and revocation after sync, refusal after a failed sync for a shared login, startup from the encrypted cache during a short Vaultwarden outage, and an upgrade.
- Use canaries to check Agent tools, Bot HQ, transcripts, Honcho and logs for leaks of the unlock credential, `bw` session key, website credentials or private browser controls. Verify the startup helper stays within 15 seconds using fake startup keys.
- On a fake TOTP page, prove the vault code uses the original challenge session and is submitted once. Verify that a missing, unusable or rejected code closes the login context, and that the service refuses a different destination, a revoked vault grant and console code requests.
- Verify that a same-origin redirect can set a cookie and the final page can echo and clear it without exposing its value. Verify the Agent socket cannot approve forms and that one Owner approval allows one attempt for the exact reviewed values.

#### Self-service for Agent-owned website accounts (#376)

- Start with Tyler. Keep credential generation, Vaultwarden item creation, form detection, submission, and session handling inside the existing `quantself-vaultwarden` service and its private Chromium. Use the repo-owned tool only to send the service a request and relay its status. Pass item writes to `bw` over private stdin and capture stdout inside the service. Website passwords, TOTP seeds, and cookie values stay outside Hermes, its browser and tools, Bot HQ, transcripts, Honcho, and logs. The separate service UID, private profile and pipe enforce this boundary. Treat redaction as a backup.
- Let the Agent request an account using the public HTTPS site and a username. Use only the Agent's pinned business address when the form needs email. Generate the password privately and save one private Login in a dedicated folder in that Agent's existing Vaultwarden account, with an exact saved origin. Store it before a signup POST so an ambiguous response cannot strand a created account. Keep the item pending until authenticated verification. Track service-created items by item ID, origin, and username. Folder membership alone grants no authority. Refuse an existing unmanaged account or duplicate request. Reconcile pending attempts against the site before another submission.
- Detect native sign-in and signup forms for service-managed accounts, using standard autocomplete hints and unambiguous field and submit control structure. Allow a same-origin login or signup page and a single exact-target credential POST per step. Perform origin checks before filling and across navigations, redirects, and submission. Refuse unknown or ambiguous forms, unsafe targets, and unverified success. Block private, loopback, link-local, and tailnet targets and DNS rebinding for automatic discovery. Use the existing reviewed recipe path as fallback for forms automatic detection cannot handle. Owner-shared, important, and other unmanaged items use reviewed recipes and existing Owner approval.
- Let the Agent read a site verification code through its existing read-only business mail tool. The service accepts a code only for the matching live, same-origin enrollment challenge. Submit it once and report status. For supported TOTP enrollment on the verified site, capture the seed in the private browser, save it on the same Vaultwarden Login, and verify setup using one current code. Keep the seed and generated TOTP codes in the service. Return a blocked status for unsupported challenges or passkeys.
- Verify authenticated use within the service-owned browser. Apply the existing cookie scope and isolation rules. Support site sign-out through the observed same-origin logout control. Verify that the session is signed out after closing and reopening the private browser, sign out first if it persisted, and perform a fresh sign-in with the saved item. Use existing Agent tools for public downloads, including the Hacker News RSS file in Tyler's pilot.

Use fake credentials and TLS fixtures first. Cover new account creation and saved-item sign-in without site recipes, a supported email challenge and TOTP enrollment, ambiguous and wrong-origin forms, shared-item refusal, and interrupted signup or vault writes without duplicate accounts. Check both exact and encoded canaries and verify that the Agent cannot open the service's browser controls or read the credential files. After the Owner approves the spec and names the rollout, run the Hacker News lifecycle on Tyler through Bot HQ and record status-only evidence in #376.

#### JavaScript for Agent-owned website accounts (#376)

- Enable site JavaScript in the service-owned Chromium for Agent-owned accounts. Support login forms created by first-party scripts and a same-origin challenge that completes in the same browser context. Preserve the browser's private control channel and the normal Agent browser's separate profile.
- Enforce the saved HTTPS origin across the browser context, including redirects and the first request of any new window. Limit browser connections to the validated public address and saved port. Block additional windows, off-origin requests, service workers, WebSockets and direct UDP paths in the protected context. Keep the existing exact-target approval rules for credential posts and configured forms.
- Detect and recheck the native form with browser-side code isolated from site scripts. Put placeholders for passwords and secret codes in the page. Substitute the real values at the single checked HTTPS POST so page scripts and Hermes never receive them from the tool. Validate the request fields and action at substitution and refuse extra credential posts. Verify the result in the same protected context and report status. Disable page scripts during protected text reads to prevent scripts from encoding raw session cookies into the output. Apply the existing cookie scope and redaction rules before returning text.
- Before live use, verify with fake credentials that a same-origin script renders the login form and the approved endpoint receives one correct POST. Attempt to capture canaries with form listeners and to reach foreign origins, alternate ports, private IP literals, popups and WebSockets. Check the fixture's network receipts, Agent results and logs. Preserve coverage for the non-scripted lifecycle, lock, relock and revocation. Unsupported challenges return a blocked status. [Cloudflare browser support](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/)
- Use the existing installer and named rollout approval. Verify the scripted login and credential isolation through Tyler's Bot HQ record before enabling the capability for Stacy, then Sam.

## 7. Running around the clock

systemd restarts a crashed gateway. Uptime Kuma on `atlas` checks each Agent's `/health` every minute and alerts the Owner. Hermes updates: a spec PR once a month, sooner for security fixes, rolled out Tyler, then Stacy, then Sam.

Agents run the pinned upstream Hermes commit. Bot HQ's remote Agent transport uses the stock Hermes API. [Bot HQ PR #1](https://github.com/devdogfish/bot-hq/pull/1)

## 8. Change control

Workers never edit config on a machine by hand. Config lives in `agents/<name>/` (#195). A change = spec PR, Owner approval, then apply. Drift found on a machine is reported, not kept. [ADR 0054](../adr/0054-hermes-setup-uses-an-allowlist.md)

## 9. Setup order and verification

After #195 config-as-code, deploy Vaultwarden and verify its restore (#376), then deploy Bot HQ on `atlas` (#354), then Honcho (#357). Verify Tyler (#356), Stacy (#356) and Sam (#355) in that order. Complete the #376 fake-credential login checks before bringing any Agent live.

Per Agent verification, all must pass before the next Agent starts:

- [ ] `hermes --version` equals the pinned tag; `hermes doctor` clean
- [ ] Service restarts on boot and after a crash
- [ ] Only the listed modules, skills and plugins are present (diff against this spec)
- [ ] Gateway and screen reachable from Bot HQ's tag only; unreachable from any other tag
- [ ] Reaches the Quantself API with its scoped key and nothing else it should not
- [ ] Honcho peer works; no secret in Honcho or logs
- [ ] Introduces itself in Bot HQ and can be paused there
- [ ] Stop cancels an active run and `smart` escalations show Bot HQ approval cards
- [ ] Rebuild test: wipe the `hermes` home, rebuild from repo plus secrets, same result

For a private deployment, use its reviewed host-bound smart approval fixture to verify the live Bot HQ card.
