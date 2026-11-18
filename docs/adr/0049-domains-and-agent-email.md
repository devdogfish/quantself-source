# Each domain has one job, and every Agent has its own mailbox on dawnshiftagency.com

Status: accepted, 2026-11-14. Amended 2026-11-14 by ADR 0050 (one Application Address per Job Application) and ADR 0051 (three inboxes), and 2026-11-15 by [#361](https://github.com/devdogfish/quantself/issues/361) (outreach mail). Amends ADR 0040, ADR 0041 and ADR 0046. Research: [dawnshift-website-domain.md](../research/dawnshift-website-domain.md).

## Decision

| Domain | Job |
| --- | --- |
| `luigigirke.com` | Owner's personal brand: résumé, Application Addresses (ADR 0050), SES identity with MAIL FROM `bounce.luigigirke.com` |
| `girke.dev` | Developer portfolio and infrastructure: dashboard, hooks, demos, résumé redirects. Never printed on a résumé |
| `dawnshiftagency.com` | Dawnshift's website, brand and client email. SES identity with MAIL FROM `bounce.dawnshiftagency.com` |
| `getdawnshift.com` and one more `.com` | One-to-one outreach only. Web root redirects to `dawnshiftagency.com` |
| `dawnshift.agency`, `dawnshift.ai`, `dawnshift.llc`, `dawnshift.services`, `dawnshift.studio` | Redirect to `dawnshiftagency.com`. They send no mail: null MX, `v=spf1 -all`, DMARC `p=reject` |

**Why `dawnshiftagency.com`:**
- Dawnshift sells outcomes, not processes, so the address must not lead with "AI".
- People default to `.com`, and `dawnshift.com` is an unrelated site that isn't for sale.
- `.com` has the lowest price and registry risk.

**Agent email:**
- Every Agent has its own real mailbox on `dawnshiftagency.com` (`sam@`, `stacy@`, `tyler@`, …), not an alias into the Owner's inbox. Its accounts, 2FA and password resets belong to the Agent.
- Role addresses (`hello@`, `ops@`, `billing@`) are aliases to whichever Agent holds the role.
- Outreach uses addresses on the outreach domains. The Owner approved ordinary-volume, handwritten business mail, with no domain warming or bulk lists ([#361](https://github.com/devdogfish/quantself/issues/361)).
  - Replies arrive in the sender's outreach mailbox at Purelymail.
  - No link tracking.
- Redirects and tracked links use subdomains (`go.<domain>`), never a separate domain.
- Purelymail hosts business and outreach mailboxes for inbound mail; SES sends (ADR 0051).

**AI disclosure:** Agents email under their persona names. They say they are AI when asked, and never deny it. Every commercial email still names Dawnshift and includes a mailing address and an unsubscribe link (CASL). Cold email to Canadian recipients needs implied consent.

**Personal assistant exception to ADR 0041:**
- Tyler is the only Agent with the Personal Assistant role and access to the Owner's personal Gmail.
- Tyler drafts routine replies such as scheduling, confirmations, and acknowledgements. Every email Tyler sends needs the Owner's explicit approval for that exact message.
- Tyler can add personal Appointments and To-Dos within the approved Hermes spec.
- Bot HQ uses Owner-consented Gmail OAuth with separate unread inbox, mailbox action, and approval-gated send tools. Permanent deletion needs its own authenticated Owner approval.
- Other Agents never send as the Owner.

## Considered

- **`dawnshift.ai`:** leads with the method. "AI" lowers buyer trust. It has no ICANN price cap, and Anguilla can revoke registrations.
- **`dawnshift.agency`:** shorter, but `.agency` is rarely recognized, and typing `.com` out of habit reaches the unrelated `dawnshift.com`.
- **Agent aliases on the business domain:** would route Agents' accounts and 2FA through the Owner's inbox and tangle reputations.
