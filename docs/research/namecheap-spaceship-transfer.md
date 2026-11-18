# Namecheap to Spaceship transfers

Verified 2026-11-08. Operational research; no transfer has been performed by this document. Private domain inventories, authorization codes, contacts and invoice contents do not belong here.

## Price and retained term

Spaceship advertises a standard `.com` transfer at USD10.18 plus the mandatory USD0.20 ICANN fee: USD10.38 before any applicable tax. Its current annual renewal is USD10.68 plus USD0.20. Treat these as dated estimates until the account-specific checkout confirms the total. [Spaceship .com pricing](https://www.spaceship.com/domains/gtld/com/)

A normal `.com` transfer adds one year to the existing expiry, preserving prepaid time. A separate exception applies when a domain was renewed **after expiring**: transferring within 45 days of that previous expiry can revoke the old registrar's renewal year. A routine renewal before expiry is not that exception. [Namecheap's Spaceship transfer guide](https://www.namecheap.com/support/knowledgebase/article.aspx/10692/84/how-do-i-transfer-a-domain-from-namecheap-to-spaceship/)

## Eligibility and private authorization

Check that registration and the last registrar transfer were more than 60 days ago, and inspect any other account-specific transfer restriction. Namecheap's Sharing & Transfer tab provides the registrar lock control and requests an authorization code delivered to the registrant email. Do not change contacts merely to perform a transfer. [Namecheap transfer-out requirements](https://www.namecheap.com/support/knowledgebase/article.aspx/258/84/what-should-i-do-to-transfer-a-domain-from-namecheap/)

Owner enters the authorization code directly into Spaceship. Do not read it from mail, print it, store it in Quantself, or include it in screenshots. Prepare the exact cart total before approval; do not assume a general transfer request supplies an unlimited spending authorization.

## DNS continuity is the critical dependency

Namecheap BasicDNS is a registrar-provided service: preserving its nameserver names is insufficient after moving the registration. Spaceship explicitly warns that old registrar default DNS stops working after transfer. Its Transfer Manager offers importing existing host records, or changing nameservers without importing; choose import, not an empty DNS setup. [Spaceship transfer guide](https://www.spaceship.com/knowledgebase/transfer-domain-guide/), [Spaceship transfer disclaimers](https://www.spaceship.com/domains/transfer/)

Before releasing or expediting the transfer, verify the imported zone against the existing zone, including web records, aliases, subdomains, MX priorities, SPF, DKIM, DMARC, verification TXT, CAA and any redirects. An automated import is not proof of completeness. DNSSEC status requires a deliberate migration plan; do not blindly carry stale signing records or disable protection without the required approval. Namecheap BasicDNS manages DNSSEC values automatically. [Namecheap host record types](https://www.namecheap.com/support/knowledgebase/article.aspx/434/2237/how-do-i-set-up-host-records-for-a-domain/), [Namecheap DNSSEC](https://www.namecheap.com/support/knowledgebase/article.aspx/9723/2232/managing-dnssec-for-domains-pointed-to-premium-or-basicdns/)

Transfers normally complete within approximately five days; the owner can expedite using Namecheap's emailed approval. Expedite only after DNS preparation is verified. After completion, verify registrar, expiry, lock, privacy, auto-renew, public DNS, website and mail routing. [Spaceship transfer guide](https://www.spaceship.com/knowledgebase/transfer-domain-guide/)

## Quantself reconciliation

Record the actual transfer payment once, retaining its original currency and actual CAD settlement. Once transfer completion is verified, retire the old registrar's future renewal commitment and record the new registrar, verified new expiry, next billing date, native renewal estimate and management link. Preserve historical payments and source evidence. Do not prematurely remove an existing renewal while a transfer is pending or create overlapping future renewals. Do not add optional hosting/email trials to the transfer.

## Temporary timing note

Namecheap scheduled DNS/forwarding maintenance for November 9, 2026, 08:00–17:05 UTC (04:00–13:05 America/Halifax), which may delay record updates. Account for propagation rather than treating delayed changes as failed writes. [Namecheap status notice](https://www.namecheap.com/status-updates/planned-scheduled-maintenance-of-withheld-for-privacy-email-forwarding-free-email-forwarding-url-forwarding-alias-and-other-dns-records-and-safeserve-dns-on-the-namecheap-product/)
