# Job-search email is sent through Amazon SES on the Owner's domain

Status: accepted, 2026-11-11. Narrowed 2026-11-12 to sending only (ADR 0046). Amended 2026-11-14 by ADR 0049: the Job Search Address is on `luigigirke.com`, with MAIL FROM `bounce.luigigirke.com`. The single Job Search Address is superseded by ADR 0050: one Application Address per Job Application.

The Jobs runner sends mail through the SES API from the Owner's domain, with aligned DKIM, SPF and DMARC. Open and click tracking stay off. DMARC starts at `p=none` with reporting and moves to `quarantine` after clean reports.

The Jobs runner's email routes move off Gmail SMTP to this path. Gmail's legacy third-party "Send mail as" ends in January 2027, and Gmail-sent mail is DKIM-signed by gmail.com rather than the Owner's domain.

_Superseded by ADR 0050._ All job-search mail uses one plain Job Search Address. Recruiters see a single normal address with no category aliases. The previous per-track aliases are retired with no backwards compatibility. The résumé track belongs to the Job Application (`resumeTrack`), not to the address.

Inbound mail does not go through SES: the domain's MX points at the mail host, and replies are read there (the mailbox layout and host are in ADR 0051). Quantself does not receive, store or display email. The earlier plan for SES inbound, S3 storage, SNS notifications and Quantself as the email client was dropped with the custom Messages app (ADR 0046).

Considered:

- **Cloudflare Email Routing plus Resend:** free, but needed a DNS move and two vendors.
- **AgentMail:** its free tier adds a footer to sent mail.
- **Postmark:** inbound requires a paid plan.
- **Proton:** has no API.

SES costs pennies at this volume.
