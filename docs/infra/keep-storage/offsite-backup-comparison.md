# Offsite backup comparison for Quantself

Research date: 2026-11-13 (Halifax). Three research agents used `gpt-6-luna` with high reasoning, followed by primary-source review and corrections. Research is not deployment evidence. On 2026-11-14 the Owner selected B2 Canada East (Toronto), encrypted nightly backups, starting at 10 GB with modest growth. Account setup and restore verification remain pending.

**Recommendation: Backblaze B2 in Toronto with restic encryption, native Linux metadata backup, narrowly scoped upload credentials and a 30-day hidden-version recovery window requiring live verification. This best fits 10 GB initially and modest low-cost growth. BorgBase+Borg is the simpler hosted alternative if its larger paid step is acceptable.**

The research covers major object-storage clouds, specialist backup hosts, consumer drives, hosted Proxmox Backup Server, and physical offsite alternatives. It is a broad market comparison, not a claim to enumerate every storage vendor. Provider facts are linked below and in the three detailed reports. Recommendations and cost calculations are our analysis.

Research record:

- [Large clouds, regions, archive tiers and request/download charges](research-object-storage.md).
- [Specialist providers, Borg hosting, minimum charges and hosted PBS](research-backup-providers.md).
- [Consumer drives, existing subscriptions and physical offsite alternatives](research-consumer-storage.md).
- [Measured backup metadata/restoration and storage-growth evidence](backup-metadata-proof.json), with [reproducible synthetic scripts](../../../scripts/integration/backup-metadata/README.md).
- [Selected policy and remaining live acceptance checks](offsite.md).

## Reassessment: choose on merit, allow a tooling rewrite

The Owner removed stack-preservation constraints. Three Luna/high researchers
reassessed recovery, cost and operational burden. Metadata restoration and measured
storage growth then changed the initial Kopia recommendation to **restic + B2**.

Vault PosixFS depends on Linux extended attributes. Restic preserves these directly;
Kopia 0.23.1 requires an additional metadata-preserving payload, such as GNU tar.
Both restored the synthetic fixture successfully. On the same 16 MiB random file,
64 MiB sparse file and link/metadata fixture:

| Repository bytes | restic 0.19.1 native | Kopia 0.23.1 + GNU tar |
| --- | ---: | ---: |
| Initial | 16,783,233 | 16,803,221 |
| Extra for unchanged snapshot | 1,308 | 1,132,426 |
| Extra after a 64 KiB edit | 2,260,876 | 12,716,105 |

This is a small local comparison of these two approaches, not a universal benchmark
or a prediction of production retention. GNU sparse headers caused archive churn;
Kopia also must reread the archive. [Measured evidence](backup-metadata-proof.json).
[Restic metadata restoration](https://restic.readthedocs.io/en/stable/050_restore.html#restoring-extended-file-attributes).

Kopia remains a strong alternative when provider compliance locks are a requirement:
it documents lock renewal and point-in-time recovery. The Owner did not require
that extra mechanism. Adding archive staging and lock maintenance to obtain it is
not the best default here. [Kopia design](https://kopia.io/docs/advanced/ransomware-protection/).

For restic, B2's name-based S3 deletion uses `writeFiles` (a hide marker); permanent
version deletion needs `deleteFiles`. A bucket/prefix-scoped key excluding
`deleteFiles` and bucket administration should therefore support normal lock cleanup
and maintenance while preventing immediate permanent version deletion. This is
inferred from official API behavior and still requires live verification. A 30-day
hidden-version lifecycle provides a recovery window; it is not WORM protection.
Owner/admin compromise can remove history. Recovery after hostile hides requires a
tested version-recovery procedure, not merely `restic restore latest`.
[B2 capability mapping](https://www.backblaze.com/docs/cloud-storage-s3-compatible-app-keys),
[Restic B2 guidance](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html#backblaze-b2).

BorgBase+Borg has native metadata support and built-in stale-backup alerts, with
10 GB free then $30/year for 250 GB. Append-only transaction rollback is useful,
but full-access compaction removes that history; it is not provider WORM either.
R2's free egress matters more for frequent bulk downloads than this backup workload.
[BorgBase](https://www.borgbase.com/), [FAQ](https://docs.borgbase.com/faq/).

## Why B2 over Cloudflare R2

Both give the first 10 GB of Standard storage free. At this initial size neither
wins on storage price. B2 is the recommendation for modest growth and infrequent
restores, rather than heavy download traffic:

| Total stored, including history | B2 monthly storage | R2 Standard monthly storage |
| --- | ---: | ---: |
| 10 GB | $0 | $0 |
| 25 GB | $0.10 | $0.23 |
| 50 GB | $0.28 | $0.60 |
| 100 GB | $0.63 | $1.35 |

USD before tax; storage only, constant decimal GB over a month, rounded to cents.
Formula: B2 `max(GB - 10, 0) × 0.00695`; R2 `max(GB - 10, 0) × 0.015`.
R2 rounds usage to billing units; ordinary request allowances and any excess
bandwidth charges must be considered separately. Published prices rechecked
2026-11-14 UTC. [B2 pricing](https://www.backblaze.com/cloud-storage/pricing),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/).

“Downloads” means retrieving data from cloud storage, including restores and full
integrity reads. Uploading the nightly backup is free with both. B2 includes
monthly download bandwidth up to three times average stored data, then charges
$0.01/GB; R2 charges no download bandwidth. With a steady 10 GB stored, B2 includes
about 30 GB downloaded per month—approximately three complete restores if nothing
else consumes that allowance. Normal Quantself usage reads Keep, not the backup.

R2 can be cheaper with frequent full verification/restoration or public file
serving. At 100 GB steady stored and 400 GB downloaded in a month, B2 is about
$0.63 storage + $1 excess bandwidth = $1.63; R2 is $1.35 storage plus any request
charges. It is wrong to call either provider universally cheaper.

B2 also offers an explicit Toronto region. R2 location hints are not a Canadian
residency guarantee. Canada placement is an additional fit, not an Owner-imposed
legal requirement. Both would still receive only locally encrypted backups.
[B2 regions](https://www.backblaze.com/docs/cloud-storage-data-regions),
[R2 data location](https://developers.cloudflare.com/r2/reference/data-location/).

## What would be backed up?

The scoped data is private Quantself information: database records, receipt images, inventory photos, audio, and original capture/attachment files, together with the OpenCloud configuration and metadata needed to restore them. Treat the complete backup as sensitive. Encrypt it locally before uploading.

The existing aggregate measurement is about **2.92 GB of database logical size plus original attachment bytes**, dominated by approximately 2.83 GB of inventory images. This is source sizing, not a measured backup archive. Database dumps, compression, OpenCloud metadata and retained history change the stored total. Receipt image bytes already inside the database must not be counted twice. See the [dated local measurement](README.md#measured-preflight--2026-11-13-halifax).

This estimate does not include all home computers, full VM disks, the shared Work space, unrelated media, or a future personal-document collection. Those need separate sizing and scope. [Issue #254](https://github.com/devdogfish/quantself/issues/254) requires a coordinated database/originals recovery point and an explicit offsite policy.

Keep and the existing PBS service are at home. An offsite copy covers loss of both to the same physical incident. PBS infrastructure exists; the new VMs' coordinated encrypted backups and full recovery proof are still pending. Neither this research nor the existence of PBS establishes that those backups already work.

## Costs for the leading choices

Monthly **storage-only**, USD before tax, at a constant total stored backup size in decimal GB. AWS's binary billing units are converted for comparison. Free allowances assumed unused by other workloads. Retained versions and provider-hidden objects count toward storage. Rounded figures; requests, download limits and billing commitments follow the table.

| Destination | 10 GB | 25 GB | 50 GB | 100 GB | Main reason to choose |
| --- | ---: | ---: | ---: | ---: | --- |
| Backblaze B2 | $0 | $0.10 | $0.28 | $0.63 | Low growth cost; Toronto region; supported backup integration |
| Cloudflare R2 Standard | $0 | $0.23 | $0.60 | $1.35 | No download-bandwidth charge; useful if already using Cloudflare |
| AWS S3 Standard, Canada Central | $0.23 | $0.58 | $1.16 | $2.33 | Reuse existing AWS account; extensive access controls |
| BorgBase | $0 | $2.50 equivalent | $2.50 equivalent | $2.50 equivalent | Managed backup hosting and monitoring; paid tier is $30/year for 250 GB |
| Existing paid Proton Drive | $0 extra* | $0 extra* | $0 extra* | $0 extra* | Reuse storage already paid for; official Linux CLI now available |

*Proton only if the existing plan has sufficient unused quota; plan and free space have not been checked. Purchasing Proton solely for this backup has a different cost. Sources: [B2 rates](https://www.backblaze.com/pricing.md), [R2 rates](https://developers.cloudflare.com/r2/pricing/), [AWS Canada offer catalog](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/ca-central-1/index.json), [BorgBase plans](https://www.borgbase.com/), [Proton CLI](https://proton.me/support/drive-cli).

B2's Toronto region has the same storage pricing as its other listed regions. [Region documentation](https://www.backblaze.com/docs/cloud-storage-data-regions). At 100 GB the storage estimate is about $7.51/year. AWS at 10 GB is about $2.79/year before requests, so avoiding another account may be worth more than that saving. Earlier $0.25/month estimates used 10 AWS billing GB (10 GiB); 10 decimal GB is approximately $0.23. [AWS unit definition](https://aws.amazon.com/s3/pricing/).

## Why the cheapest bill is not the whole comparison

**Downloads and verification:** B2 includes downloads up to three times average monthly storage; excess is $0.01/GB. R2 Standard has free Internet egress, but request charges can still apply. [B2 pricing](https://www.backblaze.com/cloud-storage/pricing), [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

Our steady-state example at 100 GB: one full integrity read plus one full restore in a month downloads about 200 GB, within B2's 300 GB allowance if nothing else consumes it. Four full reads download 400 GB, adding about $1 and taking B2 to roughly $1.63, versus R2's $1.35 storage plus applicable requests. New uploads late in a month produce a smaller monthly-average allowance. Restic's ordinary structural check does not read every data pack; full data checks do. [Restic integrity checks](https://restic.readthedocs.io/en/stable/045_working_with_repos.html).

**Retention:** 10 GB of current files is different from 10 GB of stored backups. Restic reuses unchanged data, but old versions, new media and database changes consume space. A 30-day history is not automatically 30 complete copies, nor is it free. [Restic backup behavior](https://restic.readthedocs.io/en/stable/040_backup.html). Treat 10 GB as an initial storage target with monitored growth, not a reason to silently drop backups once full.

**Recovery after failure:** provider-side encryption alone is insufficient for the chosen privacy requirement. Use backup-side encryption and retain recovery material away from Keep. Encryption does not prevent deletion by compromised credentials; separate retention authority or tested append-only protection is a separate concern. [Restic threat model](https://restic.readthedocs.io/en/stable/100_references.html#threat-model).

**API behavior:** restic recommends B2's S3 endpoint and documents cleanup of hidden old B2 object versions. Normal backup-tool snapshots supply history; leaving every obsolete cloud object version forever adds another billable layer. Retention/object-lock settings need a tested design, not automatic enabling of every protection feature. [Restic backend guidance](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html#backblaze-b2).

**Spending controls:** B2 offers daily caps/alerts, with delayed changes and exceptions; this is not a universal instant monthly hard cap. A cap that blocks an upload also blocks a new recovery point. Budget and backup-failure alerts must therefore be considered together. [B2 caps](https://www.backblaze.com/docs/cloud-storage-data-caps-and-alerts), [cap changes](https://www.backblaze.com/docs/cloud-storage-create-and-manage-caps-and-alerts).

## Other options and why they do or do not lead

| Family | Options investigated | Decision for this workload |
| --- | --- | --- |
| Other large clouds | Google Cloud Storage, Azure Blob, Oracle OCI, IBM Cloud Object Storage | Technically viable. OCI has a useful recurring free allowance; Google free storage is US-region restricted; IBM legacy Lite is not a standing new-account equivalent. Extra account setup offers little advantage over the shortlist. |
| Small S3 services | Scaleway, OVHcloud, Wasabi, IDrive e2, Hetzner Object Storage, Storj, Bunny, DigitalOcean Spaces, Akamai/Linode, Vultr | Some low unit rates, but billing floors, location/redundancy differences, retention charges or API maturity change the comparison. See current exact terms in the specialist report. |
| Managed backup/filesystem hosts | BorgBase, rsync.net, Hetzner Storage Box | Useful backup features and predictable plans. BorgBase is free at 10 GB; the others have minimum purchased capacity. B2 costs less as this small repository grows. |
| Existing subscription or consumer drive | Proton, Google Drive/One, OneDrive, Dropbox, iCloud, MEGA, pCloud, Koofr, Filen, Icedrive, Internxt, Tresorit, Sync.com | Spare paid storage can have zero incremental subscription cost. Actual Linux automation, session expiry, shared quotas, backup history and API support matter more than the desktop app. |
| Hosted PBS | Tuxis, remote-backups.com | Could reuse the Proxmox backup format instead of adding a restic destination. Free-plan eligibility/availability and retention must be confirmed; changes the backup architecture. |
| Physical or privately hosted | Encrypted USB rotated elsewhere; friend/family server | Valid offsite copies, but rely on transport or another person's server, power and Internet. No automatic zero-cost reliability advantage. |

Detailed pricing and primary links: [object storage](research-object-storage.md), [specialist providers and hosted PBS](research-backup-providers.md), [consumer drives and physical alternatives](research-consumer-storage.md).

Specific alternatives worth understanding:

- **Proton:** earlier manual-only guidance is outdated. Proton now publishes a Linux CLI with scheduled-transfer use cases. Its authenticated session and backup publication/recovery behavior must work on the headless VM. It is not a documented drop-in restic backend; the official CLI and unofficial rclone Proton connector are different options. [Official announcement](https://proton.me/blog/proton-drive-cli), [rclone Proton limitations](https://rclone.org/protondrive/).
- **Filen/Koofr/MEGA:** credible free-capacity alternatives rather than automatically inferior services. Filen and Koofr offer a 10 GB starting allowance; MEGA advertises 20 GB. Growth tiers, transfer limits and client behavior differ. Their details and unresolved local prices are in the consumer report; free source capacity still must accommodate backup history.
- **BorgBase:** stronger turnkey backup focus than a generic cloud drive. Its paid step is larger than needed, but monitoring and append-only workflows may justify paying for convenience. [Product features](https://www.borgbase.com/).
- **Archive tiers:** genuinely lower storage rates, but restore delays, retrieval fees and minimum retention apply. A sealed encrypted archive can use them; blindly moving a live restic repository to offline storage disrupts checks, maintenance and recovery. The object report compares archival costs separately from always-accessible storage.
- **Hosted PBS free plans:** remote-backups.com's 100 GB tier is currently unavailable. Its free data can be removed after 14 days without a new backup plus a three-day grace period—particularly relevant if the source machine is lost. Tuxis advertises free home/testing accounts but its current public product page does not establish the old 150 GB quota. [Remote pricing](https://remote-backups.com/pricing), [free retention rule](https://remote-backups.com/docs/datastore/free-tier), [Tuxis product](https://www.tuxis.nl/en/proxmox-backup-server/).

## Decision and remaining evidence

For a **new provider**, choose B2 Canada East with encrypted nightly backups and measured retention. R2 Standard is a close alternative if frequent full downloads or existing Cloudflare administration matter more than Canadian placement. Existing paid Proton can beat both on incremental subscription cost as storage grows, provided a tested automation path is acceptable.

The Owner selected B2 Toronto after this comparison. Remaining evidence is B2 account/bucket setup, scoped credentials, actual retained size, and a synthetic unattended upload/restore test. Proton quota is no longer a prerequisite for the selected route. No measured provider latency, durability comparison, account eligibility, private-account quota, or successful live recovery is implied by this pricing research. No new cloud account, bucket or upload was created during research. Issue #254 remains open.
