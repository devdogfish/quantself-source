# Dawnshift mail acceptance

[#361](https://github.com/devdogfish/quantself/issues/361) (outreach and redirects) and [#382](https://github.com/devdogfish/quantself/issues/382) (iPhone sending) can proceed independently. Follow the [infrastructure workflow](../agents/infrastructure-sessions.md) for approvals, credential entry and rollback.

| Scope | Evidence on November 17, 2026 | Still required |
| --- | --- | --- |
| Main business mail | [#360](https://github.com/devdogfish/quantself/issues/360) records verified Canada Central Easy DKIM, seven inbound deliveries (ten copies), SES API and Mac Apple Mail deliveries with Gmail SPF/DKIM/DMARC passing, and one iPhone inbound sync. Google and Cloudflare still return the Purelymail MX, the SES `bounce` MX/SPF and DMARC `p=none` with reporting. Current DKIM selectors were unavailable for the public check. | #382 needs an iPhone SES SMTP send and a fresh inbound sync. No reason to repeat the Mac send. |
| Outreach | Spaceship Domain Manager lists `getdawnshift.com` and `dawnshifts.com`. Both authoritative servers show `getdawnshift.com` parked, apex MX/TXT absent and `_dmarc` and `bounce` NXDOMAIN. | Owner's trademark searches, second domain decision and sender roster. Then check Purelymail and SES, and run an approved test per sender. |
| Redirects | Spaceship Domain Manager lists `dawnshift.agency`, `dawnshift.ai` and `dawnshift.llc`. Both authoritative servers show apex MX/TXT absent and `_dmarc` NXDOMAIN. `dawnshift.services` and `dawnshift.studio` are absent from the account, return registry RDAP 404 and have no parent delegation. | Apply the draft below to the three owned redirect-only domains. Owner decides whether to retain the two unregistered names in the ADR. |

## #361: outreach and redirects

1. **Owner:** Run the [CIPO](https://ised-isde.canada.ca/cipo/trademark-search/srch?lang=eng&text=dawnshift) and [USPTO](https://tmsearch.uspto.gov/) searches. Confirm whether the already owned `dawnshifts.com` is the second outreach domain. Register a different name only if chosen. Confirm the exact sender addresses and decide whether to retain `.services` and `.studio` in the ADR.
2. **Operator after approval:** In the registrar, save the full before snapshots privately and review the exact additions. In Purelymail, add the two outreach domains and the approved sender mailboxes; use the DNS values shown for each domain and verify delivery mode. In SES **Canada Central → Verified identities**, configure each identity with Easy DKIM and custom MAIL FROM `bounce.<domain>`. Publish the three SES-provided DKIM CNAMEs, one `bounce` MX (`10 feedback-smtp.ca-central-1.amazonses.com.`), the [SES MAIL FROM SPF TXT](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html), and DMARC with an approved policy and report destination. Use a credential scoped to the approved sender through the private handoff. Check each identity is verified, DKIM and MAIL FROM are successful, and no warming or list tool is connected. Check public DNS against both authoritative servers and a recursive resolver.
3. **Operator after approval:** Once `https://dawnshiftagency.com/` serves the site, make both outreach roots and every retained redirect-only root redirect there over HTTP and HTTPS. Redirect-only domains must have sole MX `0 .`, SPF `v=spf1 -all`, and DMARC `v=DMARC1; p=reject`. Keep these mail-denial records off the two outreach domains. Verify the redirect target and all mail records; if unexpected changes appear, reconcile against the snapshots and restore only edited records within the agreed rollback scope.
4. **Owner approval for the exact test:** Confirm one plain synthetic SES message per configured sender to the Owner's Gmail (subject `#361 outreach acceptance — <sender domain>`, body `Synthetic Dawnshift delivery test.`). Send after the mail checks pass for that sender; web redirects can finish separately. In [Gmail → More → Show original](https://support.google.com/mail/answer/29436?hl=en), require SES delivery, `spf=pass` at `bounce.<domain>`, `dkim=pass` for the sender domain and `dmarc=pass` for the visible From domain. Reply from Gmail once and verify arrival in the matching Purelymail mailbox. If delivery is unclear, check the original message status before retrying.

### #361 record diff and rollback draft

Registry parent NS queries confirmed delegation to `launch1.spaceship.net` and `launch2.spaceship.net` for the four domains below. Both servers returned authoritative answers. The four apexes had the same two parking A records, `34.216.117.25` and `54.149.79.189`, TTL 300. Apex AAAA/CAA were absent and `www` returned NXDOMAIN. Requests pinned to each parking IP got HTTP 200 Parking Page. Port 443 timed out before TLS on both IPs. The destination `dawnshiftagency.com` has no apex A/AAAA and its `www` is NXDOMAIN.

| Domains | Before | Proposed diff | Rollback |
| --- | --- | --- | --- |
| `dawnshift.agency`, `dawnshift.ai`, `dawnshift.llc` | No apex MX/TXT or DMARC | The public API supports the two TXT records below. The sole apex MX `0 .` requires a separately verified save and rollback path. | Remove only the exact TXT additions. An MX published through Advanced DNS would need to be removed there because the public DELETE schema also excludes `.`. |
| The three above plus `getdawnshift.com` | Apex parking, no working TLS or redirect | In Domain Manager → URL redirect, set an SSL-protected apex 301 to `https://dawnshiftagency.com/` after that destination serves successfully. Let Spaceship manage forwarding records. | Remove the forwarding rule. Restore the saved parking setting and reconcile the apex records against the snapshot. Verify the two parking A records and HTTP 200 again. Previously cached 301s may persist on clients. |
| `getdawnshift.com` mail | No apex MX/TXT, DMARC or MAIL FROM records | Separate change when the sender roster and provider values are ready. Add Purelymail verification TXT and apex MX, SES Easy DKIM CNAMEs, `bounce` MX and SPF TXT, and the approved DMARC TXT. | Remove only records added by that phase from its private snapshot. |

1. Before execution, save each full zone and its parking/forwarding state privately in Spaceship. Review the exact changes against those snapshots.
2. The TXT phase can land before the destination site is live. Start with `dawnshift.agency`, then apply to `.ai` and `.llc` after both authorities return exactly one SPF and DMARC policy with the values below. Check that parking still works and confirm through a recursive resolver after negative caches expire. The mail criterion remains open until both authorities serve the sole `0 .` MX for each domain.
3. Once the destination answers over trusted HTTPS, apply the web change to `.agency` first. Review the forwarding scope for wildcard or subdomain changes before saving. Require a trusted source TLS certificate and HTTP/HTTPS redirect to the exact destination, which must load. Confirm mail records still match on both authorities before repeating for `.ai`, `.llc` and `getdawnshift.com`. On unexpected records, certificate failure past the provider's provisioning window, or incorrect destination, reconcile before retrying and roll back the affected domain only. [Spaceship HTTPS forwarding](https://www.spaceship.com/blog/domain-updates/#https-url-redirect-is-now-available)

Keep `dawnshifts.com` out of the change set pending the Owner's decision. `.services` and `.studio` have no zones to change. The destination domain is a verification target only, including its existing Purelymail MX and SES MAIL FROM.

#### Spaceship null MX capability

The [Spaceship public OpenAPI schema](https://docs.spaceship.dev/#tag/DNS-records) allows MX `preference: 0`. Both save and delete reference `hostNameValue` for `exchange`; its pattern starts with `^(?!\.)` and rejects the literal root label required by [RFC 7505](https://www.rfc-editor.org/rfc/rfc7505.html). In Advanced DNS for `dawnshift.agency`, an unsaved row with host `@`, value `.`, priority 0 and TTL 30 min showed no error on blur. Undo returned the zone to zero custom records. Whether the UI can save and serve that value remains unverified. A future authorized one-domain UI pilot must confirm the exact wire answer on both authorities and verify removal through the same UI before expanding. Keep MX out of the API batch and avoid substituting a hostname for the root label.

The schema-valid TXT batch is one `PUT /v1/dns/records/{domain}` per redirect-only domain, with conflicts checked. For rollback, `DELETE` on the same path takes the two `items` as a bare array with `ttl` omitted. Match the exact case and values. These payloads were checked against the published schema without submitting them.

```json
{
  "force": false,
  "items": [
    {"type": "TXT", "name": "@", "value": "v=spf1 -all", "ttl": 1800},
    {"type": "TXT", "name": "_dmarc", "value": "v=DMARC1; p=reject", "ttl": 1800}
  ]
}
```

#### HTTPS destination prerequisite

ADR 0049, the [website domain research](../research/dawnshift-website-domain.md), and [#208](https://github.com/devdogfish/quantself/issues/208) select `dawnshiftagency.com`. They do not identify a site repository, hosting project, or deployment. The connected Vercel team has no matching project and its domain lookup returned 404. The available Sites inventory also had no matching site. Both Spaceship authorities still show no apex web address.

Identify the intended hosting project and a working production deployment URL. Attach the apex to that project and use its exact recommended web DNS records in Spaceship, scoped to the apex and any provider verification record. Keep the existing mail records intact. Require a public GET of `https://dawnshiftagency.com/` to show the intended page over a trusted certificate before enabling any redirects. The exact web DNS values depend on the selected project.

## #382: iPhone Apple Mail after Bot HQ

The Mac verified TLS certificates on both SES ports without authentication. The previous iPhone attempt timed out on 465 and reached SES on 587 with an authentication error.

1. **Owner:** Settings → Apps → Mail → Mail Accounts → Dawnshift → Account → SMTP. Set the primary server to `email-smtp.ca-central-1.amazonaws.com`, **Use SSL on**, **Password** authentication, **587 (STARTTLS)**. Enter the existing Canada Central **SES SMTP username and password** directly from the password manager, then tap Done. Leave Purelymail IMAP unchanged. If verification reports incorrect credentials again, cancel the edit and confirm the existing SES credential and scope privately before retrying. Port **465 (implicit TLS)** is the Mac-proven alternative if 587 fails to establish TLS. [AWS port and TLS reference](https://docs.aws.amazon.com/ses/latest/dg/smtp-connect.html)
2. **Owner after approval:** From iPhone Apple Mail, send one plain message from `luigi@dawnshiftagency.com` to the Owner's Gmail, subject `#382 iPhone SES acceptance`, body `Synthetic Dawnshift delivery test.` In Gmail **Show original**, require SES delivery and aligned SPF (`bounce.dawnshiftagency.com`), DKIM and DMARC passes. Reply once from Gmail; confirm the reply in the iPhone **Dawnshift Inbox**.
3. **Operator:** Record date, target, approved test scope, authentication results and reply arrival in the respective issue after acceptance. No credentials or complete mail headers in the ledger.
