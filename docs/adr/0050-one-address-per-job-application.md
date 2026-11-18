# Each Job Application gets its own Application Address

Status: accepted, 2026-11-14. Supersedes ADR 0040's single Job Search Address. Amends ADR 0049. Inbox layout in ADR 0051.

Replies must map to the exact Job Application that caused them. Sender addresses can't do that: portal mail comes from the ATS, and recruiters write from addresses never seen before. So the address the reply was sent **to** carries the mapping.

## Decision

Every Job Application gets one **Application Address**, `luigi.<code>@luigigirke.com`.

- **Code:** 4 characters from an alphabet without look-alikes (no `0 o 1 l i`), e.g. `luigi.k7mq@`. No `+`, because many forms reject it.
- **Created** automatically with the Job Application and stored on it. Never reused.
- **Used everywhere for that application:** form fields, the portal account, the tailored résumé PDF, and the sender of any email about it.
- **Inbound:**
  - The mail host (Purelymail, ADR 0051) accepts every `luigi.<code>` address and delivers it to one mailbox. It can't reject codes Quantself never created, so Quantself keeps the list and Sam ignores any other code.
  - Everything lands in one inbox.
  - The reply's recipient address identifies the Job Application. Its `resumeTrack` follows from the application.
- **Sending:** mail about an application goes out through SES from its Application Address. The `luigigirke.com` domain identity covers every local part. The Message-ID encodes the application, and `In-Reply-To` is checked as a second signal.
- **Portals with one account per company (e.g. Workday):** create a new account with the new Application Address for each application, never reuse one.
- **Easy Apply** (LinkedIn, Indeed) can't carry an Application Address, so avoid it. When it can't be avoided, replies to the profile email, and recruiters who reach out on their own, are matched by company and role; the Owner is asked when that's ambiguous.
- **Suppression:** an Application Address that starts receiving spam is retired in Quantself, and a Sieve filter on the mailbox can discard mail sent to it. The spam also shows which company leaked it.

## Considered

- **One plain address** (ADR 0040): readable, but only fuzzy company-and-role matching.
- **One address per company** (`luigi.shopify@`): readable and unambiguous per company, but two applications to the same company collide.
- **`+` tags:** rejected by many forms and stripped by some systems.
- **Random subdomain per application:** needs MX records for each one and looks like phishing.
- **Code only** (`k7mq@`): looks like a throwaway address.
- **Plain Gmail:** no mapping at all.

Cost: the address looks generated, and a mistyped code from a printed résumé is lost. The short alphabet without look-alikes limits mistyping.
