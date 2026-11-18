# Mail host for luigigirke.com and dawnshiftagency.com

Researched 2026-11-14 by five agents, one per provider, from each provider's own pages. Every claim below was reported with a source URL by an agent running on a small model, so spot-check the claims that decide the choice. "Not found" means the page didn't say, not that the feature is missing.

## Requirements

- Several domains and mailboxes at a flat price.
- Hundreds to thousands of aliases, created through an API, one per Job Application (ADR 0050), all delivering to one mailbox.
- Unknown addresses rejected, with no catch-all.
- A read-only IMAP login for Sam.
- MX straight to the host, with Amazon SES sending separately from a MAIL FROM subdomain.

## Comparison

| | Alias count | Create aliases by API | Unknown addresses | Read-only IMAP | Price | Terms |
| --- | --- | --- | --- | --- | --- | --- |
| **Migadu** | "Unlimited mailboxes and addresses" (pricing page). Per-domain cap not found | Yes: `POST /domains/{d}/aliases` ([API](https://www.migadu.com/api/)), marked "early beta" | Catch-all is optional and mistyped addresses "should bounce" ([guide](https://migadu.com/guides/catchall/)) | Identities can be limited to IMAP. Read-only not documented | Mini US$90/yr, Standard US$290/yr ([pricing](https://www.migadu.com/pricing/)) | Bans "automation of any kind" and transactional email ([use](https://www.migadu.com/use/)) |
| **Purelymail** | No limit ([help](https://support.purelymail.com/support/solutions/articles/159000359456-how-to-create-an-alias)) | Not found for aliases. The user API exists | Text after the first non-letter in an address is ignored, so any `luigi.<code>` reaches `luigi` ([features](https://purelymail.com/docs/features)). Unknown codes can't be rejected | App passwords can be read-only (2026-11-07 update) | US$10/yr ([pricing](https://purelymail.com/pricing)) | Bans mailing-list mail and domain warming ([terms](https://purelymail.com/termsofservice)) |
| **Fastmail** | 600 aliases plus 15 per user. A separate masked-email API has no documented count | Masked emails only, via JMAP ([dev](https://www.fastmail.com/dev/)). Whether it supports `luigi.<code>` on a custom domain: not found | Rejected with 550 ([help](https://www.fastmail.help/hc/en-us/articles/7010500320655-Why-messages-bounce-back)) | Not found for IMAP. Only API tokens can be read-only | US$5/user/month billed yearly ([pricing](https://www.fastmail.com/pricing/us/)) | "Not designed for automated or transactional emails" ([terms](https://www.fastmail.com/policies/terms-of-service/)) |
| **Google Workspace** | 30 per user ([limits](https://developers.google.com/workspace/admin/directory/v1/limits)) | Yes | Reject rule applies to all unrecognized addresses, not an allowlist | Gmail API with a read-only scope, not IMAP | US$7–8.40/user/month | Agent actions are the customer's responsibility |
| **Zoho Mail** | 30 per mailbox ([limits](https://www.zoho.com/mail/help/adminconsole/rates-and-limits.html)) | Yes | Catch-all accepts everything. Reject is not documented | Not found | From US$1/user/month | Bans "Automated Emails" ([policy](https://www.zoho.com/mail/help/usage-policy.html)) |

## Decision

Purelymail, because the budget is about US$10 a year (ADR 0051). Migadu was the better fit on features but costs US$90/yr.

## Result

- **Out:** Google Workspace and Zoho (30 aliases per mailbox), and Fastmail (600 aliases and no documented way to create custom-domain addresses by API).
- **Migadu is the only one that fits the model.** It has an alias API, unlimited addresses on paper, and optional catch-all.
- **Purelymail is the fallback.** It's the cheapest and has a documented read-only IMAP password. But it can't reject unknown codes, so Quantself would have to discard unregistered ones.

## Verify with Migadu before paying (14-day refund)

1. **The alias ceiling.** Ask for a per-domain or per-account limit. It wasn't published.
2. **The "no automation" clause.** Ask whether alias creation through your own API calls, and an agent reading a mailbox by IMAP, are allowed. Stated policy bans "automation of any kind".
3. **Read-only IMAP.** Ask whether an IMAP-only identity can be read-only.

## Not covered

Cold-outreach mailboxes (ADR 0049) can't live on Migadu: its terms ban bulk mail. They need a different sending setup. Neither Migadu nor Purelymail documents Amazon SES compatibility. The usual MAIL FROM subdomain (`bounce.<domain>`) should avoid conflicts, but check it in the provider's DNS diagnostics.

## Webmail clients

Sources are review and directory sites, not project documentation. Looks were not judged.

- **Roundcube** is the most used and the most mature. 1.7.0 shipped in May 2026 ([news](https://roundcube.net/news/2026/03/29/security-updates-1.7-rc6-1.6.15-1.5.15)). It has frequent security patches, including 20 flaws fixed in October ([report](https://webhosting.today/2026/10/19/roundcube-fixes-20-security-flaws-its-largest-batch-since-1-7-0/)), so keep it off the open internet. It opens messages by folder and UID, not Message-ID, and no plugin for Message-ID links turned up ([forum](https://www.roundcubeforum.net/index.php/topic,25470.0.html)).
- **Cypht** combines several accounts in one inbox ([features](https://demo.cypht.lab15.evoludata.com/features)). It is the fallback.
- **Rejected or skipped:** SnappyMail (the Owner dislikes it), Nextcloud Mail (needs Nextcloud and users report it slow), SOGo (groupware), Afterlogic (combined inbox is paid), Rav and Opterius (too new), Bulwark (JMAP only, and Purelymail has no JMAP).
