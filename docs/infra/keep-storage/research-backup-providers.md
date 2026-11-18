# Offsite backup provider research

Checked 2026-11-13 against provider pricing pages and documentation. Scope: a Debian 13 VM at Keep, nightly client-encrypted PostgreSQL dump plus original attachments, with a PBS service present at another home server. New VM backup jobs are not configured yet. Measured source data is about 3 GB; use 10 GB as an initial repository target and model 25/50/100 GB repository totals. The actual encrypted/deduplicated repository size is not measured; totals include backup metadata and retained history, not merely current source data.

## Recommendation

Use **Backblaze B2 Standard with restic** if the requirement stays S3-compatible. It gives a Canada East (Toronto) region, first 10 GB free every month, no storage-duration fee, no minimum file size, no account storage minimum, free egress up to 3x average stored data, and a published $6.95/TB-month rate above the free allowance. Restic supports arbitrary S3-compatible endpoints and encrypts repository data using a locally held password. It is a straightforward low-cost S3 backend, including for the current 3 GB and likely 10 GB initial repository. [B2 pricing](https://www.backblaze.com/cloud-storage/pricing), [B2 regions](https://www.backblaze.com/docs/en/cloud-storage-data-regions), [restic S3 backend and repository password](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html).

If minimizing recurring cost matters more than S3, **BorgBase** is the best small-repository fit: 10 GB and two repositories free forever. Above 10 GB, its Small plan is $30/year and includes 250 GB. It supports client-encrypted Borg/Restic, monitoring, append-only mode and EU/US placement. [BorgBase plans and features](https://www.borgbase.com/).

If the owner prefers a simple remote filesystem and snapshots, **Hetzner Storage Box** is also economical at €3.20/month for a 1 TB BX11. Its built-in snapshots and SFTP/Borg support are useful but count against the same quota and are not a second independent copy. It is not an S3 service. [Hetzner Storage Box](https://www.hetzner.com/storage/storage-box/), [snapshot behavior](https://docs.hetzner.com/storage/storage-box/snapshots/).

Do not select Wasabi, IDrive e2, Hetzner Object Storage, DigitalOcean Spaces, Akamai/Linode Object Storage or Vultr Standard for a 3–100 GB repository on price alone: minimums dominate actual use. Storj’s $5 monthly invoice floor also overwhelms its low unit rate. Scaleway, Cloudflare R2, Bunny S3 and OVHcloud remain S3-compatible alternatives; Bunny is still public preview.

## Storage-only estimates

USD unless noted. These are steady-state monthly storage charges, not prices for a particular backup client. No VAT/sales tax, retrieval, request, paid support or FX included. Capacities are decimal GB; per-GiB rates are converted to decimal-GB equivalents, with billing-unit rounding ignored in approximate rows. Cloudflare R2 and Backblaze include 10 GB recurring free; exact 10 GB may be exceeded by metadata/history, so leave headroom. Monthly amount for BorgBase is the annual $30 plan divided by 12; BorgBase bills it annually. The rsync.net Borg column is the discounted annual plan with a 100 GB minimum.

| Provider / plan | 3 GB stored | 10 GB target | 25 GB | 50 GB | 100 GB | Billing floor and key assumption |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Cloudflare R2 Standard | $0 | $0 | ~$0.23 | ~$0.60 | ~$1.35 | First 10 GB-month free recurring; then $0.015/GB-month. Request charges may apply. |
| Backblaze B2 | $0 | $0 | ~$0.10 | ~$0.28 | ~$0.63 | First 10 GB free recurring; then $6.95/TB-month. No minimum storage/duration. |
| Bunny Storage S3, one region | $1 | $1 | $1 | $1 | $1 | $0.01/GB-month; $1 invoice minimum. Public preview; no S3 versioning/Object Lock. |
| BorgBase Free / Small | $0 | $0 | $2.50* | $2.50* | $2.50* | 10 GB free forever. Small paid tier $30/year includes 250 GB. *Annual prepaid. |
| rsync.net Borg account | $1.50* | $1.50* | $1.50* | $1.50* | $1.50* | 100 GB minimum, annual billing at $0.015/GB-month. *$18/year paid annually. |
| remote-backups.com PBS prepaid | €1.70* | €1.70* | €1.70* | €1.70* | €1.70* | Free tier currently unavailable; paid prepaid minimum 200 GB. *Minimum €1.70/month equivalent, prepaid. |
| Tuxis hosted PBS, paid | €21 | €21 | €21 | €21 | €21 | 1 TB paid increment. Optional provider-managed sync adds €10/month; free home/testing capacity unconfirmed. |
| Hetzner Storage Box BX11 | €3.20 | €3.20 | €3.20 | €3.20 | €3.20 | 1 TB fixed-capacity monthly plan; listed price excludes VAT. |
| Scaleway One Zone Standard | ~€0.02 | ~€0.08 | ~€0.20 | ~€0.40 | ~€0.80 | About €0.00803/GB-month, hourly billed; no recurring free storage. 75 GB/month free egress. |
| OVHcloud Local Zone Standard | ~$0.02 | ~$0.08 | ~$0.19 | ~$0.38 | ~$0.76 | Approx. $0.00756/decimal-GB-month converted from $0.0081103/GiB-month; region-specific, hourly billed. |
| Hetzner Object Storage | $7.99 | $7.99 | $7.99 | $7.99 | $7.99 | Current monthly base includes 1 TB storage and 1 TB egress; usage billed hourly. |
| DigitalOcean Spaces Standard | $5 | $5 | $5 | $5 | $5 | $5/month includes 250 GiB and 1,024 GiB egress; hourly proration if all buckets deleted. |
| Akamai/Linode Object Storage | $5 | $5 | $5 | $5 | $5 | $5/month includes 250 GB; then $0.02/GB overage; 1 TB transfer allowance. |
| Vultr Object Storage Standard | $18 | $18 | $18 | $18 | $18 | $18/month includes 1,000 GB storage and 1,000 GB outbound; archive product excluded. |
| IDrive e2 pay-as-you-go | $6 | $6 | $6 | $6 | $6 | $6 minimum associated with 1 TB; no additional charges within free-egress policy. |
| Wasabi Pay-Go | $7.99 | $7.99 | $7.99 | $7.99 | $7.99 | Minimum monthly charge based on 1 TB active storage; 90-day minimum duration. |
| Storj Standard | $5 | $5 | $5 | $5 | $5 | $5 invoice floor (not a usage credit); 50 KB minimum/object and 30-day minimum object retention. |

The Storj table shows the invoice floor at each modeled size: storage at $7/TB-month stays below $5 even at 100 GB. **remote-backups.com's 100 GB free plan exists in the pricing terms but is marked “Currently Unavailable,” so it is not a dependable cost assumption.** Tuxis advertises free home/testing service but does not publish a current capacity limit. Rates and minimums are from live provider pages checked on the date above. [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [B2 pricing](https://www.backblaze.com/cloud-storage/pricing), [Bunny Storage pricing](https://bunny.net/pricing/storage/), [BorgBase pricing](https://www.borgbase.com/), [rsync.net Borg pricing](https://www.rsync.net/products/attic.html), [remote-backups.com pricing](https://remote-backups.com/pricing), [Tuxis PBS pricing](https://www.tuxis.nl/en/proxmox-backup-server/), [Hetzner Box pricing](https://www.hetzner.com/storage/storage-box/), [Scaleway pricing](https://www.scaleway.com/en/pricing/storage/), [OVHcloud Local Zone pricing](https://www.ovhcloud.com/en/public-cloud/prices/), [Hetzner Object Storage pricing](https://www.hetzner.com/storage/object-storage/), [DigitalOcean Spaces pricing](https://docs.digitalocean.com/products/spaces/details/pricing/), [Akamai/Linode pricing](https://techdocs.akamai.com/cloud-computing/docs/object-storage-pricing), [Vultr pricing](https://docs.vultr.com/support/platform/billing/how-is-object-storage-billed), [IDrive e2 pricing](https://www.idrive.com/s3-storage-e2/pricing), [Wasabi pricing](https://wasabi.com/pricing), [Storj pricing FAQ](https://www.storj.io/pricing/change-FAQs/).

## Provider comparison

### Backblaze B2 and Cloudflare R2 — S3 options

B2 is the recommended S3 fit: Canada East is Toronto, restic supports its S3 API, and the first 10 GB is a recurring free allowance. No minimum file-size or storage-duration fees; egress is free up to 3x average stored data. [B2 pricing](https://www.backblaze.com/cloud-storage/pricing), [regions](https://www.backblaze.com/docs/en/cloud-storage-data-regions), [restic S3 backend](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html).

R2 also has recurring 10 GB free storage and free egress; beyond that, Standard is $0.015/GB-month plus request charges. Its S3 API does not implement S3 Object Lock operations, though Cloudflare has separate bucket-lock rules. Location hints are best-effort. [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [API compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [data location](https://developers.cloudflare.com/r2/reference/data-location/).

Bunny Storage S3 costs $0.01/GB-month in one region, with a $1 monthly minimum, no API fee and free API egress. S3 compatibility is public preview and only enabled when creating a new storage zone; current docs list New York as a region, but no Canada region. Versioning, Object Lock, lifecycle, and server-side encryption are unsupported. Client-encrypted restic may work through its S3 API, but preview status and these gaps make it a test candidate, not the conservative pick. [Pricing](https://bunny.net/pricing/storage/), [S3 docs and limits](https://bunny.net/docs/storage/s3).

### BorgBase — best turnkey encrypted backup service at current size

- Free plan: 10 GB and two repositories permanently, no API/data-transfer fees. Paid Small plan is $30/year, 250 GB included, $0.015/GB-month flexible overage; USD, VAT added for EU customers. Billing is annual, with 30-day refund on annual plans. [Plans](https://www.borgbase.com/), [billing details](https://docs.borgbase.com/pricing).
- Explicitly supports Linux-hosted Borg and Restic repositories; setup docs describe Restic via BorgBase’s REST endpoint. Monitoring/stale-backup alerts, per-repository isolation, append-only mode, 2FA, client-side encryption and EU/US location choice. [Restic setup](https://docs.borgbase.com/setup/restic/), [features](https://www.borgbase.com/).
- 10 GB free plan is genuinely ongoing, not a trial. The $30/year Small plan is more than enough for modeled 25–100 GB total. It is a specialized managed backup service, not raw S3.
- Main caveat: while provider advertises append-only and delayed deletion, the owner should validate the exact Borg/Restic retention and compromise recovery flow; keep independent recovery keys. A free/cheap account still depends on the provider service and account access.

### rsync.net — economical if using Borg over SSH

- The discounted account marketed for Borg requires annual payment and starts at 100 GB for $18/year ($0.015/GB-month), without transfer charges. Its documentation explicitly permits other tools running over SSH; it is not a Borg-only protocol restriction. [Discounted account terms](https://www.rsync.net/products/attic.html).
- This package omits rsync.net’s ZFS snapshots, subaccounts/additional logins and Borg-specific support. Provider describes the backed-up data as Borg encrypted; BorgBase remains simpler and includes support/monitoring. [Borg package](https://www.rsync.net/products/attic.html).
- Standard filesystem accounts have a different and much higher minimum: published simple pricing lists 800 GB minimum at $0.015/GB/month ($12/month); the standard platform supports SSH/SFTP, rclone, restic, rsync and Borg and includes configurable ZFS snapshots. [Standard pricing](https://www.rsync.net/pricing.html), [protocols and features](https://www.rsync.net/resources/faq.html).
- Selectable locations include US, Zurich and Hong Kong; the order flow also offers geo-redundant storage at a higher rate. Confirm location/geo-redundant rate at checkout. No usage contract; Borg discount is annual-prepaid. [Order details](https://rsync.net/signup/order.html), [locations/FAQ](https://www.rsync.net/resources/faq.html).

### Hetzner Storage Box — fixed 1 TB capacity and snapshots

- BX11 is 1 TB for €3.20/month, excluding VAT; traffic is unlimited, no minimum contract, immediate cancellation. Larger plans are 5/10/20 TB. Pricing is fixed-capacity, not per-GB. [Pricing](https://www.hetzner.com/storage/storage-box/).
- Official product supports SFTP/SCP, rsync over SSH, BorgBackup, Restic, and rclone. Port 22 is SFTP/SCP only, no interactive shell; key authentication is supported. Storage location can be Germany or Finland. [Product/features](https://www.hetzner.com/storage/storage-box/), [protocol docs](https://docs.hetzner.com/storage/storage-box/general/).
- BX11 includes up to 10 automatic and 10 manual snapshot slots. Snapshots are on the same storage allocation, save changed/deleted data, and are not an independent backup or new-box restore. [Snapshot docs](https://docs.hetzner.com/storage/storage-box/snapshots/).
- Economical and straightforward, but a single provider filesystem is less portable than S3 and snapshots share the same service boundary. No S3 bucket/object-lock model.

### Hetzner Object Storage — S3, but $7.99/month floor

- Current base is $7.99/month (or €6.49/month) including 1 TB stored and 1 TB egress; extra storage is about $0.00886/GB-month and extra egress $1.20/TB. Ingress, internal EU traffic and S3 API calls are free. Base charged hourly for any hour with an active bucket, capped monthly; no carryover. VAT excluded from published price. [Current pricing](https://www.hetzner.com/storage/object-storage/), [service FAQ](https://docs.hetzner.com/storage/object-storage/faq/general/).
- S3-compatible; standard HDD storage. Data stored in one selected EU data center: Falkenstein, Nuremberg or Helsinki; no built-in cross-location replication. Supports object locking and lifecycle. Minimum object size for billing is 64 KB, which may inflate many tiny repository objects. [Product overview](https://www.hetzner.com/storage/object-storage/overview/), [general FAQ](https://docs.hetzner.com/storage/object-storage/faq/general/).
- Monthly minimum overwhelms 3–100 GB workloads. No free tier stated.

### Other fixed-price S3 options

- **DigitalOcean Spaces Standard:** $5/month includes 250 GiB and 1,024 GiB outbound; extra storage costs $0.02/GiB-month and extra egress $0.01/GiB. Billing is prorated hourly if all buckets are deleted. Toronto is available. Use Standard rather than Cold Storage for an active backup repo; cold storage has retrieval and 30-day early-delete/update fees. [Pricing](https://docs.digitalocean.com/products/spaces/details/pricing/).
- **Akamai/Linode Object Storage:** $5/month includes 250 GB; overage is $0.02/GB in most regions, plus a pooled 1 TB transfer allowance. The endpoint is S3-compatible and offered in 20+ regions. Class A/B request billing began no earlier than Oct. 1, 2026 for E2/E3 endpoints, with 1M/12.5M monthly free request quotas. [Pricing](https://techdocs.akamai.com/cloud-computing/docs/object-storage-pricing), [product docs](https://techdocs.akamai.com/cloud-computing/docs/object-storage).
- **Vultr Standard Object Storage:** $18/month includes 1,000 GB and 1,000 GB outbound, with unlimited ingress. The $6 Archive plan includes 100 GB unarchived and 1,000 GB archive; archives need restore before access, so it is not the simplest live restic target. [Billing](https://docs.vultr.com/support/platform/billing/how-is-object-storage-billed), [current tier/limits](https://docs.vultr.com/products/storage/object-storage/limits).

### IDrive e2 — low unit price, $6 minimum

- $0.006/GB-month ($6/TB-month), but PAYG has a $6 minimum associated with 1 TB. No ingress, deletion or API fee; egress is free up to 3x storage, with $0.01/GB over the policy. No minimum retention period. Excess account limit may cost $0.006/GB-month. [Pricing and FAQ](https://www.idrive.com/s3-storage-e2/pricing), [egress details](https://www.bmv.idrive.com/s3-storage-e2/faq-pricing).
- “Try with 10 GB free” is on the pricing page, but page does not establish it as recurring. Treat as trial/promotional until terms show otherwise; exclude from recurring estimates.
- S3-compatible endpoint and Linux-capable S3 clients; confirm exact restic compatibility at setup. Product docs list supported S3 integrations broadly. [S3 integrations](https://help.idrive.com/s3-storage-e2/s3-clients).

### Wasabi — predictable for large active datasets, oversized minimum here

- Since July 1, 2026, Pay-Go is $7.99/TB-month across regions, billed on actual use but with a minimum monthly charge tied to 1 TB active storage ($7.99/month). No egress or API fees. 90-day minimum storage duration: deleted objects before day 90 continue accruing storage charges for the remaining retention days. [Pricing FAQ](https://wasabi.com/pricing/faq), [2026 price notice](https://docs.wasabi.com/docs/may-2026-wasabi-pricing).
- Pay-Go is card/monthly; RCS requires buying a 25 TB+ capacity block for a fixed 1, 3 or 5-year term and auto-renews annually unless cancelled with 30+ days’ notice. No independent RCS monthly minimum, but capacity/term is far beyond this need. [Pricing page](https://wasabi.com/pricing).
- Region selection is bucket-based and includes Canada Central (Toronto), multiple US and European regions. [Region list](https://docs.wasabi.com/docs/where-is-my-data-stored-and-how-are-wasabis-storage-regions-secured), [service URLs](https://docs.wasabi.com/v1/docs/what-are-the-service-urls-for-wasabi-s-different-storage-regions/).
- Restic supports Wasabi via the S3 backend. [Restic Wasabi setup](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html).
- Free egress has a usage policy: monthly downloads should not exceed active stored data. Repeated full verification/restore reads can exceed that ratio; do not interpret the advertised zero egress fee as unrestricted download volume. [Wasabi product terms](https://wasabi.com/product-terms).

### Storj — current small-account invoice floor is $5

- Current Standard rate is $7/TB-month stored and $7/TB egress; Advanced is $10/TB storage, same egress. A $5 monthly invoice floor applies below $5 of usage, and is not a storage credit. 30-day object retention fee on early deletion; 50 KB minimum billed size per object. Free trial excludes the floor, but does not recur. USDC payments are exempt from the floor. [Current pricing FAQ](https://www.storj.io/pricing/change-FAQs/).
- S3-compatible distributed object storage; nightly transfer will work only after checking client compatibility and current endpoint/key setup. At these repository sizes the minimum bill and many-object rounding erase the per-GB advantage.
- Note: an earlier Storj announcement said $50 minimum; its July 2026 definitive FAQ now states $5. Use the current FAQ value, not the superseded announcement. [Current FAQ](https://www.storj.io/pricing/change-FAQs/).

### Hosted Proxmox Backup Server — compatible alternative, not S3

- **remote-backups.com:** its current pricing page advertises 100 GB free, but marks that tier “Currently Unavailable.” Paid prepaid storage starts at 200 GB for €1.70/month equivalent; subscription begins at 500 GB/€4.25 monthly, prices net of tax. It supports PBS, Borg, rsync and SFTP sync, client-side encryption, prune jobs, alerts and optional geo-replication. The free tier is a test offer with automatic deletion after 14 days without a new backup and 3 days’ warning; free ingress is capped at 100 Mbit/s. Therefore use paid 200 GB for a dependable comparison, not the free tier. [Pricing](https://remote-backups.com/pricing), [free-tier limits](https://remote-backups.com/docs/datastore/free-tier).
- **Tuxis:** paid PBS is €21/TB/month, rounded up to full 1 TB usage increments, excluding VAT; managed PBS sync to another Tuxis data center adds €10/month. Free home/testing account is advertised, but page does not publish its capacity limit. Data centers listed: Ede, Amsterdam and Düsseldorf. [Pricing/product page](https://www.tuxis.nl/en/proxmox-backup-server/).
- PBS is a closer match if the backup is a PBS datastore/VM backup: native remotes/sync jobs can push encrypted snapshots, and PBS supports client-side encryption (not enabled by default). It does not provide an S3 bucket for a separate restic pipeline, so treat it as an alternative backup architecture. Remote sync uses separate permissions/credentials; constrain them to a dedicated datastore/namespace and test restore. [PBS remote sync and encryption](https://pbs.proxmox.com/docs/managing-remotes.html), [PBS client encryption FAQ](https://pbs.proxmox.com/docs/faq.html).
- The remote-backups free tier’s pause/deletion policy makes it unsuitable as the sole offsite copy; paid capacity is more predictable but still differs from the already-selected nightly S3 design. Tuxis free terms need quota confirmation before relying on them for production.

### Scaleway — low European one-zone price; retrieval/network detail matters

- Standard One Zone is €0.00803/GB-month; Multi-AZ is €0.01606/GB-month. Requests and ingress included; 75 GB/month egress free, then €0.01/GB. Prices before tax and charged hourly; no storage free allowance. [Pricing](https://www.scaleway.com/en/pricing/storage/).
- S3-compatible, regions Paris/Amsterdam/Warsaw/Milan, supports object lock and versioning; Standard Multi-AZ availability is stated as 99.9%. [Product page](https://www.scaleway.com/en/object-storage/).
- Glacier is much cheaper but restores cost €0.009/GB; nightly backup with routine pruning/restore test should use Standard, not Glacier. The 750 GB-hours of free capacity is a 90-day trial offer, not recurring free storage. [Pricing](https://www.scaleway.com/en/pricing/storage/), [trial offer](https://www.scaleway.com/en/object-storage/).

### OVHcloud — low-cost S3 option, regional/deployment tariff varies

- Public price list includes a Local Zone Standard class around $0.0081103/GiB-month, no-cost requests/transfer shown for that price row; usage is hourly and rounded to GiB. The table converts this to about $0.00756 per decimal GB-month and ignores GiB rounding. This is region/deployment-specific, so quote the intended Canada/Europe region before comparing. [Pricing](https://www.ovhcloud.com/en/public-cloud/prices/), [billing FAQ](https://help.ovhcloud.com/csm/en-ca-public-cloud-storage-s3-faq?id=kb_article_view&sysparm_article=KB0059673).
- Standard is explicitly positioned for backups; S3-compatible clients are broadly supported. OVHcloud also documents Restic as a compatible tool and Object Lock/WORM, versioning and asynchronous replication. [S3 overview](https://docs.ovhcloud.com/en/guides/storage-and-backup/object-storage/landing-page-object-storage), [backup guidance](https://www.ovhcloud.com/en/public-cloud/uc-protect-backups-ransomware-immutable-object-storage/).
- Local Zone low price should not be mistaken for general 3-AZ price; select location/deployment and confirm egress, API and recovery fees in the account calculator. 3-AZ has a higher staircase tariff.

## Exclusions / caution

- **pCloud:** not an S3-compatible object-storage provider. A separate review documents pCloud's official rsync/SSH guidance for recurring server/NAS transfers; see [consumer storage research](research-consumer-storage.md). Evaluate that consumer route separately; its presence does not establish a purpose-built S3 service or make desktop-only backup offers applicable to a Linux VM.
- **Wasabi / IDrive e2 / Hetzner Object Storage / Storj:** all offer S3-style object APIs, but their minimum bills/retention make them uneconomic at 3–100 GB.
- Free allowances are provider account/product terms, not guaranteed to be permanent forever. “Free” in the cost model means the live product page identifies an ongoing monthly allowance/free plan; trials and first-year sales excluded.

## Operational fit and guardrails

- Use one consistent restore point: pause/drain app writers and uploads/deletes per the existing Keep plan; produce database dump and attachment inventory together, hash/checksum them, then upload. Never treat independently timed DB and files as a valid paired recovery.
- Restic’s repository password is required for recovery and for unattended backup execution. Keep an independent recovery copy away from Keep; protect the operational copy on Keep separately from the cloud access credential. Test an isolated full restore with the off-host recovery material. [Restic repository docs](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html).
- S3 client encryption is provided by restic, independent of each provider’s server-side encryption. In the restic model the destination sees encrypted repository objects; loss of the repository password makes recovery impossible. Keep the password in independent recovery storage.
- Start with standard/hot storage class so retention and repair uploads do not encounter archive retrieval delay/fees. Avoid provider-side immutable locking until it is proven to coexist with the backup tool’s compaction/prune behavior. Use least-privilege daily credentials and a separate retention/admin path where possible.
- If the backup repository itself fits 3 GB or 10 GB, recurring-free storage from Backblaze B2 or BorgBase covers it. The 10 GB target leaves little retention headroom; alert on measured repository usage and define a cap/retention plan. At 25 GB, Backblaze remains about $0.10/month storage-only versus fixed-fee providers at $2.50–$8/month.

## Source list

All links above are to official provider documentation/pricing, backup-tool documentation, or first-party public product notices. Pricing is a snapshot, not a quote; final checkout can add applicable tax and account-specific currency/region changes.
