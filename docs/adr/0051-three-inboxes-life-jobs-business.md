# Three inboxes: life, job applications and business, hosted on Purelymail and read in Roundcube

Status: accepted, 2026-11-14. Amended 2026-11-15 by [#361](https://github.com/devdogfish/quantself/issues/361) (outreach mail). Amends ADR 0040, ADR 0049 and ADR 0050.

Mail for different purposes goes to different inboxes, so each Agent sees only what its role needs. Quantself receives and shows no email and builds no email client (ADR 0040, ADR 0046). The budget for mail hosting is about US$10 a year, on top of SES. Research: [email-hosting-provider.md](../research/email-hosting-provider.md).

## Decision

| Inbox | Where | Access |
| --- | --- | --- |
| **Life** (people, banks, government, receipts, accounts) | The Owner's Gmail | The Owner and the Personal Assistant (ADR 0049) |
| **Job applications** | The user `luigi` on `luigigirke.com`, at Purelymail | The Owner. Sam handles replies within the Jobs mailbox and its Application Addresses. |
| **Business** | Users on `dawnshiftagency.com`, at Purelymail | The Owner's own `luigi@` user, and one user per Agent. Role aliases (`hello@`, `ops@`, `billing@`) route to the Owner and the Agent holding the role |

**Mail host:** one Purelymail account holds both domains. MX points straight at Purelymail, with no forwarding. ImprovMX forwarding to Proton is replaced, and Proton is not used for mail. SES stays the only sender (ADR 0040), from a MAIL FROM subdomain on each domain. Copy every existing DNS record before moving MX.

**Job applications**
- Purelymail ignores the text after the first non-letter symbol in an address. Every `luigi.<code>@luigigirke.com` (ADR 0050) therefore reaches the `luigi` user, with no alias to create. Test this with a message before relying on it.
- The host accepts every code, including ones Quantself never created. Quantself keeps the list of created codes, and Sam ignores mail to any other code. This replaces ADR 0050's rule that unregistered addresses are rejected.
- A code that attracts spam is retired in Quantself. A Sieve filter on the mailbox can discard mail sent to it.
- Sam uses the Jobs mailbox service on his VM when he works on replies. The service holds the Purelymail credential under a separate OS account. Sam can read, mark and organize this mailbox through the local tool. The Owner can disable the socket or revoke the app password. The tool does not delete mail.
- Sam checks the current message for an exact Application Address and looks it up in Quantself. Message-ID references and company and role help with candidates. Ask the Owner in Bot HQ if the association is ambiguous. Sam checks mail during his Jobs work without a separate watcher.
- Sam handles employer replies from the matched Application Address through SES. Record all writes and delivery receipts. Reversible mailbox and Quantself changes support Undo. Delivery cannot be recalled.

**Business:** clients see the Owner's `dawnshiftagency.com` address, never Gmail. Each Agent reads only its own user.

**Outreach:** `getdawnshift.com` and the second outreach `.com` use Purelymail sender mailboxes for inbound replies and SES for outbound mail. The Owner approved ordinary-volume, handwritten business mail, with no warming or bulk lists. Follow [Purelymail's terms](https://purelymail.com/termsofservice), including its limits on unsolicited mail and advertising. Redirect-only domains have no mailboxes (ADR 0049).

**Reading mail (Roundcube)**
- Roundcube 1.7 reads the Purelymail mailboxes over IMAP. It runs on the home network and is reachable only over Tailscale, because it needs frequent security patches.
- It opens a message by its folder and UID, not by Message-ID. A small lookup in Quantself finds the message by recipient address or Message-ID and builds the link.
- Each Job Application page in Quantself lists its replies with an "Open original" link into Roundcube. Bot HQ cards carry the same link. "View source" in Roundcube shows the full headers.
- This is a link, not a client. Quantself stores no email.

## Considered

- **Migadu:** the best fit for creating and rejecting addresses (US$90/yr), but over budget. Its terms ban "automation of any kind", and its alias ceiling is unpublished.
- **AgentMail:** built for agents, but not researched, and over budget. ADR 0040 rejected its free tier, which adds a footer to mail.
- **Fastmail, Google Workspace, Zoho:** alias caps (600, 30 per user, 30 per mailbox) rule them out.
- **SES inbound:** raw files in S3 with no mailbox view. ADR 0046 dropped it.
- **Forwarding (ImprovMX, Cloudflare Email Routing):** an extra hop, and it doesn't fix the mailbox host.
- **Cypht:** the fallback web client, with a combined inbox across accounts. SnappyMail, Nextcloud Mail, SOGo and Afterlogic were rejected or skipped.
- **Forward everything into Gmail:** Sam, Tyler and the Personal Assistant would all need access to personal mail.

## Open

- Purelymail's terms don't mention bots or AI. Agents reading mailboxes over IMAP is a gray area.
- The Personal Assistant's delegated access to Gmail includes bank alerts, password resets and 2FA codes. If that matters, move banks and recovery email to a separate address the assistant can't open.
- Purelymail's price may rise (its roadmap mentions planned increases). Migadu is the next step up.
