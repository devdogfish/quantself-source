# Selected offsite policy: B2 Toronto with restic

Owner selected encrypted nightly database + originals backups to B2 Canada East,
starting with 10 GB stored and modest growth. Stack preservation is not a constraint.
Native metadata restore and measured growth tests selected **restic over Kopia with
archive staging**. The Owner provisioned a private bucket in Canada East with 30-day hidden-version expiry
and installed both scoped credentials. Both roles passed the live synthetic
B2 Native/S3 and restic probes. Both primary repositories are initialized
with distinct authenticated IDs. The first encrypted PBS and B2 pair completed on 2026-11-14. Independent PBS and B2 application recovery passed. [Pair evidence](first-pair-proof.json), [PBS recovery](pbs-restore-proof.json), [B2 recovery](b2-restore-proof.json).

## What is protected

Back up the coordinated Quantself database, original attachments, capture JSON,
authentication/configuration state, OpenCloud configuration/system data and PosixFS
metadata/xattrs. Treat the complete set as sensitive; encrypt locally before upload.
Full VM images stay in encrypted PBS. Future personal-document imports require
separate sizing and explicit backup scope. Measured production source totals are
about 2.92 GB; retained cloud bytes have not been measured.

Each Quantself snapshot must include the verified private image archive
(`image.tar.gz`, `image.json` and `SHA256SUMS`) under
`tree/deployment/app-image`. The one-day CI artifact retention makes this copy
necessary for independent recovery. Budget about 0.73 GB for the current image
archive and roughly that much per additional retained revision before measuring
actual restic deduplication and B2 version retention. The growth census includes
these bytes within the existing 10 GB target.

The [provider comparison](offsite-backup-comparison.md) records the market research,
primary sources, prices, rejected alternatives and tool changes. The [local proof](backup-metadata-proof.json)
verifies synthetic metadata and contents through native restic restore; it does not
prove B2 access controls or real application recovery.

## Account and repository boundaries

Choose Canada East when creating the account; obtain the actual S3 endpoint from
that account. Region cannot be changed later. [B2 regions](https://www.backblaze.com/docs/cloud-storage-data-regions).

| Prefix | Credential/password location | Consistent recovery contents |
| --- | --- | --- |
| `quantself/` | root on quantself; independent Owner recovery copy | PostgreSQL dump, capture JSON, app configuration/auth state, manifest |
| `vault/` | root on files; independent Owner recovery copy | OpenCloud config/system data, originals, metadata/xattrs, manifest |

Separate repository passwords and bucket/prefix-scoped application keys preserve
the guest boundary. Quantself receives no backup credential for personal Vault
contents. Keep coordinates through existing QEMU guest agents, without new guest
SSH credentials or network grants. Owner runs credential creation and retention
setup; agents never inspect secret values.

## Version recovery and retention

Settings to verify before scheduling:

- Each uploader receives only required bucket discovery, list/read/write access.
  The helper requests `listBuckets`, `listAllBucketNames`, `listFiles`,
  `readFiles` and `writeFiles`. It omits permanent version deletion and
  bucket/lifecycle administration.
- Retain hidden object versions for 30 days before lifecycle deletion. Count those
  versions in storage/cost monitoring. Do not configure immediate/one-day cleanup.
- Retain 30 daily application snapshots initially; measure resulting footprint and
  discuss growth before raising the budget. Ten GB is a target, not a hard cost cap.
- Failure, missed-backup and growth alerts must reach an independent destination.
  Keep cloud administration and recovery passwords outside the uploading VMs.

B2 distinguishes name-based deletion (`writeFiles`, which hides a version) from
permanent version deletion (`deleteFiles`). Both roles verified restic lock
cleanup through S3 hide markers and permanent-version deletion denial. A
separate synthetic `forget` and `prune` test remains pending.
[B2 permissions](https://www.backblaze.com/docs/cloud-storage-s3-compatible-app-keys),
[restic B2 guidance](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html#backblaze-b2).

The 30-day recovery window is **not compliance Object Lock/WORM**. A compromised
uploader can hide/overwrite the current repository view and cause an outage.
Older versions should remain available until lifecycle expiration, but account
administrators can permanently delete them. Recovery must reconstruct a known-good
version set; ordinary `restore latest` is not sufficient after repository damage.
A live synthetic hide/overwrite/recovery drill is mandatory. Lifecycle runs daily,
so actual cleanup timing is approximate and separately observed.

## Owner credential handoff

In the verified Canada East account, open **App Keys** and generate the master
application key. Keep the key and ID private. From the repo root in the Owner’s
private Mac terminal, run:

Set `KEEP_SSH_KNOWN_HOSTS` to the approved owner-only pin file before running
the setup command. See [deployment and validation](deployment.md). Set
`KEEP_APPROVED_B2_BUCKET` from the Owner-approved private deployment record
on every machine used for the commands below.

```sh
python3 scripts/infra/keep-storage/owner-b2-config.py \
  --bucket "${KEEP_APPROVED_B2_BUCKET:?Set the Owner-approved private bucket}" \
  --recovery-directory "$HOME/.keep-b2-recovery"
```

Enter the master key ID and key at the hidden prompts. The helper verifies the
Canada East S3 endpoint, creates the private bucket and lifecycle rule, and
installs each scoped credential and independent restic password via pinned SSH.
Guest files are root-owned mode 0600 at `/etc/keep-restic/repository.env` and
`/etc/keep-restic/password`. Retain the entire Mac recovery directory privately
and independently of Keep. Reuse the same arguments after interruption. If B2
may have created a key but its one-time reply was lost, the Owner must reconcile
that attempt in B2 before retrying. The helper leaves repository initialization
to a separate step.

## Synthetic B2 access drill

The live drill passed for both roles. [B2 access proof](b2-access-proof.json).

Place the reviewed files in a private staging directory on each target. From
that directory on **both guests**, install:

```sh
sudo install -d -m 0755 /usr/local/lib/keep-backup
sudo install -o root -g root -m 0644 verify_b2_access.py backup_growth.py /usr/local/lib/keep-backup/
```

Generate a fresh lowercase UUID4 hex on the Mac with
`python3 -c 'import uuid; print(uuid.uuid4().hex)'`. Use the same ID on both
guests. Obtain named approval for the generated
`quantself/_verify/<id>/hide-probe` and `vault/_verify/<id>/hide-probe`
hide and permanent-version deletion denial attempts. Run `seed` on **both**
guests before running `verify` on either:

```sh
sudo /usr/bin/python3 /usr/local/lib/keep-backup/verify_b2_access.py seed \
  --bucket "${KEEP_APPROVED_B2_BUCKET:?Set the Owner-approved private bucket}" --run-id "$RUN_ID"
sudo /usr/bin/python3 /usr/local/lib/keep-backup/verify_b2_access.py verify \
  --bucket "${KEEP_APPROVED_B2_BUCKET:?Set the Owner-approved private bucket}" --run-id "$RUN_ID"
```

Set `RUN_ID` to that ID on each guest. The verifier tests own-prefix read,
write and listing, cross-prefix read and write denial, name-based hide, and
permanent version deletion denial against a newly generated fixture. Its
separate synthetic restic repository under `<prefix>/_verify/<id>/restic`
exercises init, backup, read-data check, restore and lock hide markers. Fixtures
remain for separately approved cleanup. The Owner-led overwrite/version
reconstruction drill and application restore are separate acceptance steps.
See the [restore runbook](restore-runbook.md).

## Initialize the primary repositories

On both guests, stage the reviewed files and install the initializer with its
two Python dependencies. Stage the independently approved bucket name as a
single line in `/etc/keep-restic/approved-b2-bucket`, owned by root:root
with mode `0600`. Take the name from the private deployment record. Run
during a quiet window for both repository prefixes.

```sh
sudo install -d -m 0755 /usr/local/lib/keep-backup
sudo install -o root -g root -m 0644 initialize-b2-repository.py verify_b2_access.py \
  backup_growth.py /usr/local/lib/keep-backup/
sudo /usr/bin/python3 /usr/local/lib/keep-backup/initialize-b2-repository.py \
  --bucket "${KEEP_APPROVED_B2_BUCKET:?Set the Owner-approved private bucket}"
```

The initializer requires the command argument, private approval file, and
installed repository bucket to match. It checks the installed restic binary
against its pinned checksum
and reuses a repository only after authenticating its config. For a new repository
it verifies the prefix is empty across current, hidden and unfinished objects,
excluding the synthetic `_verify/` namespace. It records intent before running
restic and prints only the authenticated repository ID. Record distinct IDs
for the two guests. If initialization is interrupted, rerun with the same
arguments to inspect the original outcome. An unresolved attempt requires
manual reconciliation before another initialization.

## Coordinated complete recovery points

1. Lock one Keep coordinator run and check storage reserve.
2. Stop ingress; drain app/API requests and workers. Verify clean exits before
   stopping OpenCloud. Deployed signal proof remains required.
3. Create one restore-point ID. Capture a consistent Docker PostgreSQL dump,
   capture JSON/auth/config state and the stopped OpenCloud tree with xattrs.
   Use a frozen native tree for restic; avoid a tar wrapper. Keep writers paused
   until the source is captured or snapshotted without losing metadata.
4. Take encrypted PBS snapshots of both guests during the same pause; record both
   snapshot IDs plus app/schema/image identity and file/hash inventory. Preserve
   prior service state and resume reliably on failure.
5. Each guest encrypts/uploads its own frozen side. Only a complete matching pair
   advances the success heartbeat. Partial pairs are not valid restore points.
6. Measure combined repositories, including old hidden versions. Configure the
   nightly timer only after manual full recovery and alert tests pass.

## Independent alerts and growth measurement

The monitor and systemd units are installed on **Keep**. The backup and
PostgreSQL restore timers are enabled and active. For future reinstalls:

```sh
sudo install -o root -g root -m 0644 backup_monitor.py /usr/local/lib/keep-backup/
sudo install -o root -g root -m 0644 keep-backup.service keep-backup.timer /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/keep-backup.service /etc/systemd/system/keep-backup.timer
systemd-analyze calendar '*-*-* 03:00:00 America/Halifax'
```

The Owner installed distinct Healthchecks.io URLs for **Keep backup** and
**Keep B2 growth** at `/etc/keep-backup/healthcheck-url` and
`/etc/keep-backup/growth-healthcheck-url`, root:root mode 0600. The schedule is
cron `0 3 * * *` in America/Halifax with an initial two-hour grace period.
Confirm the grace period against observed runtimes and verify delivery to the
Owner’s notification channel. Keep URLs out of command arguments, logs and chat.

Backup success requires a verified matching pair. Terminal backup failures
send an explicit failure ping. An observation timeout leaves the check waiting
for its missed-heartbeat deadline. After a verified pair, Keep samples both
configured B2 prefixes using the guests’ existing credentials. The journal
records aggregate bytes, counts and sampling windows. Bytes include current
and retained hidden/replaced versions and uploaded parts of unfinished
multipart uploads. The sample covers the two configured prefixes, including
any synthetic objects retained there. It measures usage over a time window
and does not represent an account-wide quota or billing total.

The growth check alerts at or above **10 GB decimal (10,000,000,000 bytes)**.
The Owner can set another positive decimal byte target in
`/etc/keep-backup/growth-target-bytes`, root:root mode 0600. The threshold
only controls alerts. An incomplete census sends neither a success nor a
threshold failure ping, so the growth check can detect the missing sample.
View the sanitized record with `sudo journalctl -u keep-backup.service`.

On a disposable Healthchecks check with the same notification route, send a
failure ping and witness delivery. Reset with success, then omit pings past
its period and grace and witness the missed alert. During the approved
manual synthetic backup, use a temporary one-byte target and confirm delivery
from the growth check. Restore the accepted target after the test. Enable
`keep-backup.timer` only after the acceptance checks below pass.

## Live acceptance and retention

Healthchecks accepted both success pings for the first pair at 07:07:48 UTC.
The configured prefixes held 725,903,031 retained bytes, below the 10 GB
target. Failure, missed-heartbeat and growth alerts and their recovery emails
were verified in the Owner’s Proton inbox. The separate synthetic PostgreSQL
restore failure alert also reached the Owner. Both timers are enabled. The
immediate monitored backup exited 0 and verified pair
`20261114T175509Z-a9414550a6bf` at 17:57:32.258033 UTC on November 14. The
configured prefixes then held 726,279,580 bytes against the 10 GB soft target,
with no unfinished uploads. The PostgreSQL restore service verified the same
pair and Healthchecks acknowledged its successful heartbeat. The Owner’s Proton
inbox confirmed the recovery email for the UP transition at 18:01:01 UTC on
November 14. VM 2544 and its
disks were absent afterward, and no backup, restore or retention operation
remained active. [Alert evidence](alert-test-proof.json),
[pair evidence](first-pair-proof.json).

- Production restic 0.19.1 is installed at `/usr/local/bin/restic` on both `files`
  and `quantself`, root:root mode 0755. The published AMD64 archive checksum was
  checked locally, and the extracted executable checksum checked before publishing
  on each guest and again afterward. Version output on each: `restic 0.19.1
  compiled with go1.26.4 on linux/amd64`. Release/checksums are in
  `scripts/infra/keep-storage/restic-release.json`. No repository was initialized
  and no upload or backup timer was started by this installation.
- Live synthetic encrypted uploads, cross-prefix denial, lock cleanup,
  permanent-version deletion denial and hidden-version reads passed for
  both roles. The disposable logical-damage fixture was uploaded. A B2
  download-cap error blocked baseline verification before any damage. The
  Owner saved a payment card and approved $0.10/day for downloads. The B2
  dashboard confirmed storage at $0/10 GB, downloads at $0.10/11 GB, and
  email cap alerts enabled. The synthetic logical-damage drill then passed.
  Synthetic `forget` and `prune` qualification remains pending. Production
  repository maintenance requires separate approval. [B2 access proof](b2-access-proof.json),
  [Hidden-version proof](hidden-version-proof.json).
- Both backup sources passed independent application recovery. B2 snapshots
  passed `restic check --read-data`, restore verification and native metadata
  comparison. See the per-source records for the archived image and patched
  web image used in functional verification. [PBS recovery](pbs-restore-proof.json),
  [B2 recovery](b2-restore-proof.json).
- The backup and PostgreSQL restore timers are active after the retained
  no-NIC rehearsal and exact VM cleanup. Cleanup also verified the removal of
  the isolated restore VMs 2542 and 2543, their four disks, and the temporary
  network and firewall rules. The recorded growth measurement
  covers the configured backup prefixes. [Backup operations](backup-operations.md).

Both primary repositories are initialized. Their IDs and scoped access tests
are recorded in the [B2 access proof](b2-access-proof.json).
