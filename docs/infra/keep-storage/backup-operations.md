# Keep backup operations

The coordinator runs on Keep and uses QEMU guest agents for `quantself` (2541) and `files` (2540). Follow [#217](https://github.com/devdogfish/quantself/issues/217) for live actions and Owner secret handoffs. Use a maintenance window with no deployments, migrations, direct database clients or other writers. The first manual encrypted PBS and B2 pair completed on 2026-11-14. Both timers stayed disabled through the recovery and alert drills. Independent PBS and B2 application recovery passed. [Pair evidence](first-pair-proof.json), [PBS recovery](pbs-restore-proof.json), [B2 recovery](b2-restore-proof.json).

The current `backup_guest.py` is installed on Keep and both guests. Keep also has `backup_monitor.py`, `backup_restore_drill.py` and both service and timer pairs installed. `systemd-analyze verify` passed. Both timers are enabled and active. The Owner installed distinct private Healthchecks URLs for backup, B2 growth and PostgreSQL restore. Healthchecks accepted backup and growth success pings. The Owner received the backup terminal-failure, missed-heartbeat and growth alerts. The Owner also verified email delivery for the separate synthetic PostgreSQL restore failure. Healthchecks acknowledged the successful drill heartbeat. The Owner’s Proton inbox confirmed the recovery email for the UP transition at 18:01:01 UTC on November 14. [Alert proof](alert-test-proof.json). The nightly restore policy and rehearsal receipt are installed. An immediate run of `keep-backup.service` exited 0 and verified fresh pair `20261114T175509Z-a9414550a6bf` at 17:57:32.258033 UTC on November 14. No active backup journal remained. B2 usage measured 726,279,580 bytes against the 10 GB soft target, with no unfinished uploads. The first `keep-postgres-restore.service` run passed against that same pair. Both services reported success. VM 2544 and its disks were absent afterward, and no backup, restore or retention operation remained active.

## Install and check

Stage the reviewed scripts on one machine at a time using its existing pinned SSH identity. Install as root:root, mode 0644, under root-owned `/usr/local/lib/keep-backup/`. Invoke the scripts through `/usr/bin/python3`.

| Machine | Python files |
| --- | --- |
| Keep | `backup_coordinator.py`, `backup_guest.py`, `backup_inventory.py`, `backup_monitor.py`, `backup_retention.py`, `backup_restore_drill.py` |
| Each guest | `backup_guest.py`, `backup_inventory.py`, `backup_retention.py`, `verify_b2_access.py`, `backup_growth.py` |

Use root:root mode 0700 for `/var/lib/keep-backup` and `/etc/keep-backup` on all three machines. Keep journals, staged trees and backup manifests private. The coordinator never needs B2 credentials. The Owner configures each guest's independent repository under `/etc/keep-restic` and retains independent recovery material. Verify the installed restic 0.19.1 pin and run the scoped B2 probes before initializing the real repositories. [B2 setup and monitoring](offsite.md)

Before pausing services:

- Stage the approved Vault HTTPS origin as the root-only backup identity on
  Files before installing the candidate backup script. [Staging procedure](deployment.md#stage-the-vault-backup-identity)
- Stage the verified `image.tar.gz`, `image.json` and `SHA256SUMS` in `/opt/keep-quantself/app-image`. The archive must match the running app and API image. Quantself captures the three files under `tree/deployment/app-image` so recovery can load the private image after the one-day CI artifact expires.
- Confirm both VMs and their guest agents respond. Verify the existing PBS `backup` storage, `main` datastore, `push@pbs!pve` token and client encryption fingerprint. The Owner retains the independent key copy. Check available PBS, thin-pool and guest disk space. The coordinator requires nominal guest disk capacity plus 20 GiB free on PBS, and projected local staging plus 20 GiB free in the thin pool.
- Use the verified image and Caddyfile recorded in the [runtime drain evidence](runtime-drain-proof.json). Ensure the actual Next container has `DEBUG=next:start-server`. A Compose configuration change takes effect after recreating that container. Run the isolated drain harness against the current deployment inputs, check memory before adding its fixture containers, then install the accepted image-bound proof on quantself at `/etc/keep-backup/web-drain.json`, root:root mode 0600. Its fields are `{"format":1,"image":"sha256:<exact image ID>","contract":"next-sigterm-deferred-request-v1"}`. Repeat the fixture when the image, launch path or gateway changes. The checked-in Next/Caddy evidence used synthetic upstream gates. Verify the deployed API and OpenCloud stop paths with admitted synthetic writes before scheduling. [Drain procedure](restore-runbook.md)
- Confirm `nsenter` and `ss` are present on quantself, along with Docker and the expected Compose projects. Caddy begins shutdown, then the coordinator waits for its actual listener to close. Next drains with API still available. API closes its streams and drains. The coordinator verifies Caddy, Next and API exits before stopping OpenCloud. A missing cleanup marker or forced stop fails the capture.

## Run and recover

On Keep:

```sh
sudo /usr/bin/python3 /usr/local/lib/keep-backup/backup_coordinator.py run --observation-seconds 120
```

The limit is for observation. A running worker may outlast the command. `run` creates one restore ID and refuses another while `active.json` exists. For exit 75 or an interrupted terminal, observe the same run:

```sh
sudo /usr/bin/python3 /usr/local/lib/keep-backup/backup_coordinator.py recover --observation-seconds 120
```

Known pause, capture or PBS failures trigger service restoration. A known resume failure remains active for recovery. Exit 1 reports a failure. Check the journal and service state before starting another run. To abandon a pending run and restore the recorded service state, use `abort --observation-seconds 120`. It waits for recorded workers to settle and never publishes a partial pair.

An unknown result can follow a lost dispatch reply, daemon timeout or reboot. Do not restart workers, start or replace containers, launch another backup or edit the active journal while an original stop, capture, PBS backup or upload could still be running. Inspect the original worker and its durable result on the owning machine. For PBS also check the original Proxmox task. If a worker ended without durable evidence, leave the run active and reconcile the recorded container and task state with the Owner before manual recovery. An observation timeout is not evidence of completion or failure.

Exit 0 from a completed run prints `{"status":"complete","restore_id":"..."}`. Verify `/var/lib/keep-backup/last-success.json` matches `runs/<restore-id>/complete.json` and that `active.json` is absent. The receipt records both encrypted PBS volume IDs and both full restic snapshot IDs, repository IDs and frozen manifest identities. On each guest, `runs/<restore-id>/frozen/` contains `manifest.json`, `inventory.json` and `tree/`. Use the matching pair for the [independent restore drills](restore-runbook.md).

## Retain staging and schedule

Local staging cleanup requires separate Owner approval. The enabled timers do
not themselves authorize deletion of staging trees.

On Keep, run the local staging preview:

```sh
sudo /usr/bin/python3 /usr/local/lib/keep-backup/backup_retention.py
```

It preserves the two newest completed pairs and excludes active, pending and failed runs. Deletion requires the Owner to approve the exact older restore IDs on both guests and install root:root mode 0600 `/etc/keep-backup/retention.json` with `{"format":1,"keep_verified":2}` on Keep and both guests. Then run `backup_retention.py --apply <approved-restore-id> ...` via the same interpreter. It removes only the matching local frozen trees. Manifests, failed or partial staging, PBS and B2 snapshots remain. Recheck disk reserve after cleanup and before each run.

For recurring cleanup, obtain separate Owner approval naming both guests and the scope `/var/lib/keep-backup/runs/<verified-id>/frozen`. Set `{"format":1,"keep_verified":2,"automatic":true}` in the same root-only policy on all three machines. The monitor verifies a new complete pair and attempts the backup heartbeat, then measures and reports B2 growth before running local cleanup. It retains the two newest pairs and reports cleanup failures separately in the service journal. Failed and interrupted staging needs separate named disposition. Remove the automatic flag on all three machines to disable recurring cleanup.

Review the local cleanup cadence and offsite retention before enabling nightly runs. Install and verify the unit files with the timer disabled. Complete one manual encrypted pair, restore independently from PBS and B2, run the logical-damage drill and witness the failed-backup, missed-heartbeat and growth alerts. Confirm observed runtime fits the configured schedule. [Monitoring installation and alert checks](offsite.md#independent-alerts-and-growth-measurement)


## Nightly PostgreSQL restore drill

The installed timer targets **04:30 America/Halifax**. The backup timer targets
**03:00 America/Halifax**. Both timers are enabled and active. The next scheduled runs are November 15,
2026 at 03:00 and 04:30 AST. The monitor and both service
and timer pairs match the reviewed files.

The helper handles mixed Proxmox progress and task output and binds shutdown
and cleanup to the restored VM's UUIDs.
The first no-NIC rehearsal passed the PostgreSQL checks, then the helper
reported failure because the successful cloud-init marker test returned no QGA
`out-data`. The clone shut down and was retained. The regression test covers
successful empty output and rejects failed or invalid responses. The
continuation verified PostgreSQL, the disabled cloud-init marker, zero NICs
and a stopped VM at restore point `20261114T065840Z-d419ee3d4cd9`. Cleanup
verified removal of only VM 2544, `local-lvm:vm-2544-disk-0` and
`local-lvm:vm-2544-cloudinit`.

The drill uses VM **2544** `quantself-db-restore-254`, one vCPU, 1536 MiB RAM and one restored system disk on encrypted `local-lvm`. It requires the independently retained recovery key on the `backup-restore-254` PBS alias and a fresh coordinated pair. Keep's installed qemu-server **9.2.15** source passes restore overrides through `API2/Qemu.pm:1434` and merges them before publishing the restored VM config in `QemuServer.pm:6979`. The drill uses that API to disable autostart atomically and records the original restore task before polling. It removes inherited NIC and cloud-init settings while stopped, then verifies zero NICs before boot. The live rehearsal verified that configuration path.

After the manual full restore and no-NIC rehearsal passed, the Owner approved recurring creation and deletion of only VM 2544 and its verified 32 GiB system disk and generated clone-owned cloud-init CD-ROM volume. For reinstall, use these root:root mode 0600 files under `/etc/keep-backup/`:

- `postgres-restore-policy.json` with `{"format":1,"vmid":2544,"storage":"local-lvm","pbs_alias":"backup-restore-254","allow_cleanup":true}`.
- `postgres-restore-rehearsal.json` with `format` set to 1, `postgres_image` and `pbs_encryption_fingerprint` matching the rehearsed recovery point, and `full_restore_verified` and `postgres_only_no_nic_verified` both set to true.
- `restore-healthcheck-url` with the Owner's distinct UUID URL for the PostgreSQL restore check. Test the independent notification before scheduling.

### Review a changed system-disk size

Format 1 retains the original 32 GiB geometry and 52 GiB physical free floor. On November 17 the deployed 44 GiB policy rejected the encrypted 52 GiB archive for recovery point `20261117T070753Z-44b2c260a89a`. The last recorded Keep capacity check found 39.14 GiB physically free. [Recovery record](https://github.com/devdogfish/quantself/issues/254#issuecomment-6931528155) · [Capacity gate](https://github.com/devdogfish/quantself/issues/208)

For 52 GiB, plan for at least 72 GiB physically free on the thin pool. The floor is the exact nominal system disk plus 20 GiB. Remeasure after any separately approved capacity work. Rehearse the exact geometry on the isolated no-NIC clone and obtain the existing named creation and cleanup approvals before installing the revised files. [Rehearsal and cleanup procedure](restore-runbook.md#nightly-postgresql-restore-drill-on-keep)

The proposed root-only policy is `{"format":2,"vmid":2544,"storage":"local-lvm","pbs_alias":"backup-restore-254","allow_cleanup":true,"system_disk_gib":52}`. The matching rehearsal receipt uses format 2 and adds the integer `"system_disk_gib":52` to the existing verified fields. Use `postgres-restore-native-rehearsal.json` for a `production-native` manifest and retain its native profile fields. The drill requires the exact size in the encrypted archive and restored clone, and records it in the ownership journal before allocation.

Run `sudo /usr/bin/python3 /usr/local/lib/keep-backup/backup_restore_drill.py` to preview admission. The approved `--apply` run verifies that only PostgreSQL is running, checks restart policies and exact migration names, verifies the clone UUIDs before start and shutdown, and rechecks UUIDs and disk ownership before cleanup. A failed or unresolved run preserves its private `postgres-restore-active.json` and blocks future attempts. Inspect the original UPID and reconcile VM and disk ownership before any manual action. [Manual rehearsal](restore-runbook.md#nightly-postgresql-restore-drill-on-keep)

### Verify one Keep recovery point on Atlas

The Keep timer still uses Keep's `local-lvm` and VM 2544. The separate
`atlas_postgres_restore_drill.py` entry point accepts a single-clone Atlas
policy and a fresh completed Keep recovery point. Install it with its
sibling backup and Atlas verification modules. Size the dedicated
[Atlas ext4-on-LUKS destination](../../home-production-cutover.md#check-the-atlas-restore-destination)
for the exact nominal system disk, 4 MiB for cloud-init and 20 GiB
reserve. For a 52 GiB disk this is 72 GiB plus 4 MiB.

Prepare two private root:root mode-0600 JSON files:

- The standing policy has `format: 1`, the approved integer `vmid`,
  `storage`, absolute `mount`, `luks_uuid`, integer `system_disk_gib`,
  and `allow_cleanup: true`. The `pbs` object pins the Atlas-only
  `backup-restore-atlas-drill` alias's `server`, `port`, `datastore`
  (`main`), `namespace`, TLS `fingerprint` and `username`. Use JSON null
  for omitted port and namespace. The alias uses an independently retained
  client key and a scoped restore credential. The `rehearsal` object uses
  the format 2 rehearsal fields above. Record the proof from a full
  restore and isolated PostgreSQL test on this exact Atlas target before
  approving the policy. Record the policy SHA-256 separately.
- Each point file has the absolute Atlas-local `complete` path,
  `complete_sha256`, `system_disk_gib` and `system_disk_sha256`. Legacy
  point files can omit the geometry field. Copy the complete receipt
  byte for byte from the settled Keep backup and pin its SHA-256
  through the trusted recovery-point handoff. Use only points completed
  within four hours.

#### Rehearse Atlas target admission without reading a PBS image

Use the approved Atlas operator session and reviewed, root-owned helper
directory. Take the storage ID, mount, LUKS UUID, VM ID and exact nominal
disk size from the independently reviewed target record. This is one
metadata-only probe. It creates no files, locks, VMs or disks.

```sh
sudo /usr/bin/python3 -B - "$reviewed_helpers" "$storage_id" "$mount_path" \
  "$luks_uuid" "$restore_vmid" "$system_disk_gib" <<'PY'
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, sys.argv[1])
from atlas_failover_admission import verify_destination
from backup_coordinator import Keep
from backup_guest import GIB, require
from backup_restore_drill import THIN_POOL_RESERVE_GIB, require_memory_reserve

storage, mount, luks_uuid, vmid, disk_gib = sys.argv[2:]
mount, vmid, disk_gib = Path(mount), int(vmid), int(disk_gib)
require(100 <= vmid <= 999_999_999 and vmid not in (2540, 2541) and disk_gib > 0,
        "Unexpected rehearsal target or geometry")
verify_destination(storage, mount, luks_uuid)
host = Keep()
guests = host.pve("get", "/cluster/resources", "--type", "vm")
ha = host.pve("get", "/cluster/ha/resources")
require(all(str(row["vmid"]) != str(vmid) for row in guests)
        and all(row["sid"] != f"vm:{vmid}" for row in ha)
        and not os.path.lexists(mount / "images" / str(vmid)),
        "VM ID, HA entry or image directory is already present")
space = os.statvfs(mount)
available = space.f_bavail * space.f_frsize
required = (disk_gib + THIN_POOL_RESERVE_GIB) * GIB + 4 * 1024 ** 2
require(available >= required, "Atlas encrypted restore reserve is too low")
require_memory_reserve()
print(json.dumps({"status": "atlas_target_metadata_verified", "storage": storage,
                  "vmid": vmid, "available_bytes": available, "required_bytes": required}))
PY
```

Require `atlas_target_metadata_verified` for the approved target. A
52 GiB archive needs 77,313,605,632 available bytes and the probe
requires at least 3 GiB `MemAvailable`. Stop on any mismatch or missing
evidence. Record the metadata result privately. There is no rehearsal
state to remove. This records target admission only. The exact-target
full restore and no-NIC PostgreSQL rehearsal remain separate. The
receipt-handoff preview streams the private PBS image before final Atlas
admission, so use this metadata probe before that exposure is authorized.

The checks below are evidence for a later live preview. Run read-only
checks one machine at a time. Keep the scoped keys and private inputs
with the Owner. No cleanup is needed for these checks.

| Evidence still needed | Read-only check | Stop condition |
| --- | --- | --- |
| Approved helper revisions on Keep and Atlas | `sudo sha256sum -c "$reviewed_install_checksums"` on each node | Missing file or digest mismatch |
| Settled Keep source | `sudo /usr/bin/python3 -B "$reviewed_helpers/atlas_keep_receipt_handoff.py" export > /dev/null` on Keep, through the existing approved operator session | Busy coordinator, unsettled backup, stale receipt, journal or receipt mismatch |
| Atlas workload separation | `sudo pvesh get /cluster/resources --type vm --output-format json` on Atlas. Compare the Atlas rows to the Owner's reviewed coding, sandbox and untrusted workload inventory | Unknown workload or required workload still running before private PBS data is read |
| Exact policy and independent Atlas rehearsal | `sudo stat -c '%u:%g %a %F' -- "$atlas_drill_policy"` and `sudo sha256sum -c "$reviewed_policy_and_rehearsal_checksums"` | Missing exact-target full restore or no-NIC PostgreSQL evidence, policy mismatch, or policy outside root:root mode 0600 |
| Scoped receipt transport | `getent passwd atlas-receipt` and, if authorized, `sudo -n -l -U atlas-receipt` on Keep. On Atlas, `ssh-keygen -F "$keep_host" -f "$keep_known_hosts" > /dev/null` must find the independently verified pin | Unapproved or absent account, broader sudo or missing host pin. The loopback proof supplies no live authorization |
| PBS key and exact source archive metadata | `sudo stat -c '%u:%g %a %F' -- "$recovery_keyfile" "$pbs_reader_password_file"` on Atlas, followed by the private check below when the alias and access are already approved | Missing or insecure credentials, wrong archive identity or geometry. Do not run an image read to discover a missing prerequisite |

For the PBS metadata check, use the exact VM 2541 volume from the
selected receipt with the approved Atlas restore alias. Set
`selected_restore_id` and `selected_pbs_key_fingerprint` from that same
receipt. This sequence checks the local alias before contacting PBS.
It leaves the archive inventory and extracted config out of the output.

```sh
(
  set -e -o pipefail
  sudo pvesh get /storage/backup-restore-atlas-drill --output-format json |
    sudo jq -e --slurpfile policy "$atlas_drill_policy" --arg key "$selected_pbs_key_fingerprint" '
      . as $a | $policy[0].pbs as $p
      | $a.type == "pbs" and $a.nodes == "atlas" and ($a."encryption-key" | ascii_downcase) == $key
      and all($p | keys[]; . as $k | $a[$k] == $p[$k])
    ' > /dev/null
  sudo pvesh get /nodes/atlas/storage/backup-restore-atlas-drill/content --content backup --vmid 2541 --output-format json |
    jq -e --arg volume "$atlas_pbs_volume" --arg id "$selected_restore_id" --arg key "$selected_pbs_key_fingerprint" '
      [.[] | select(.volid == $volume)] | length == 1 and
      (.[0] | .notes == $id and .vmid == 2541 and .format == "pbs-vm" and (.encrypted | ascii_downcase) == $key)
    ' > /dev/null
  sudo pvesm extractconfig "$atlas_pbs_volume" |
    PYTHONPATH="$reviewed_helpers" /usr/bin/python3 -B -c \
      'import sys; from backup_restore_drill import verify_source_hardware; verify_source_hardware(sys.stdin.read(), int(sys.argv[1]))' \
      "$system_disk_gib"
)
```

The recurring Atlas path also needs an explicit decision on the
[ADR 0045 Keep-only restore boundary](../../adr/0045-self-hosted-home-infrastructure.md#quantself-runs-on-the-owners-own-machines-with-no-paid-vps)
before moving private data as a routine operation. Leave scheduling
outside this metadata rehearsal.

On the independent recovery reader, generate the point using the
reviewed PBS client, scoped reader credential and independently retained
client key. Use root:root mode-0600 credential files. Supply
`--key-password-file` if the recovery key is passphrase-protected.
Capture stdout in a private temporary file and publish the point only
after exit zero. Deliver it with the original complete receipt over the
trusted handoff.

```sh
sudo /usr/bin/python3 /usr/local/lib/keep-backup/atlas_postgres_restore_point.py \
  --policy "$atlas_drill_policy" --policy-sha256 "$recorded_policy_sha256" \
  --complete "$keep_complete" --complete-sha256 "$recorded_keep_complete_sha256" \
  --atlas-complete "$atlas_complete_path" --keyfile "$recovery_keyfile" \
  --password-file "$pbs_reader_password_file"
```

The reader pins the exact Keep PBS snapshot, checks signed encrypted
system-image geometry and reads the logical disk once into a SHA-256
hash. It requires the full byte count, a successful PBS client exit
and matching signed manifest fields before and after the image read.
Two minutes without readable output aborts the reader. The timeout
restarts on progress, so a full disk read can take longer.
PBS index checksums authenticate chunk indexes. The point records a
SHA-256 of the logical disk bytes for Atlas readback.
[Proxmox PBS client restore implementation](https://github.com/proxmox/proxmox-backup/blob/master/proxmox-backup-client/src/main.rs)

```sh
sudo /usr/bin/python3 /usr/local/lib/keep-backup/atlas_postgres_restore_drill.py \
  --policy "$atlas_drill_policy" --policy-sha256 "$recorded_policy_sha256" \
  --point "$atlas_drill_point" --complete-sha256 "$recorded_keep_complete_sha256"
```

Pass the receipt SHA-256 from the trusted selection for this run. If
point production fails for a newer receipt, a point left from an
earlier receipt will fail admission.
Preview verifies admission. Add `--apply` for the approved single clone
restore and cleanup. The drill removes inherited NIC settings before
boot and checks the exact raw length and whole-image SHA-256. Success
requires the isolated PostgreSQL checks, verified shutdown and removal
of the recorded clone. The journal records the raw disks' device and
inode numbers. Rechecks after the boot and cleanup intents reject a
changed clone or disk. Keep the VM ID and image directory under the
drill operator's exclusive control until cleanup or reconciliation.
Inspect the receipt and any unresolved
journal under `/var/lib/atlas-postgres-restore`. A failed drill preserves
its journal for reconciliation. The Atlas entry point has no timer.

### Preview the current Keep receipt from Atlas

The receipt handoff for [#208](https://github.com/devdogfish/quantself/issues/208)
uses the point producer and admission from [#505](https://github.com/devdogfish/quantself/pull/505).
It selects the latest settled exit-zero `keep-backup.service` invocation.
Keep verifies the matching invocation journal, heartbeat and durable
receipt under its coordinator lock. It exports the exact receipt bytes
and SHA-256. A pending or failed invocation blocks export even if its
predecessor is still within four hours. This proves backup completion.
Timer-origin evidence follows the separate guarded procedure below.

Before using the handoff, stage the reviewed sibling helpers on both
hosts in the approved infrastructure window. Keep needs a dedicated
`atlas-receipt` SSH identity for unattended transport. [#217](https://github.com/devdogfish/quantself/issues/217)
currently restricts new SSH identities and sudo rules. Treat the
following as the reviewed fixture layout until the Owner approves a
named live exception. Install `keep-backup-receipt-ssh` as
root:root mode 0755 in `/usr/local/libexec/` and authorize the scoped key
with `restrict,command="/usr/local/libexec/keep-backup-receipt-ssh"`.
The wrapper accepts only the exact `keep-backup-receipt` request. Scope
the account's passwordless sudo to
`/usr/bin/python3 -B /usr/local/lib/keep-backup/atlas_keep_receipt_handoff.py export`.
Keep the pinned Keep host key and the corresponding scoped client key
on the trusted Atlas host. The exporter uses no PBS
credentials. The Atlas reader still needs its approved destination,
isolated rehearsal, PBS identity and independently retained key. Confirm
the approved workload isolation before preview because the reader will
stream the private disk through Atlas.

```sh
sudo /usr/bin/python3 /usr/local/lib/keep-backup/atlas_keep_receipt_handoff.py preview \
  --keep-host "$keep_host" --keep-known-hosts "$keep_known_hosts" \
  --keep-identity-file "$atlas_receipt_ssh_key" \
  --policy "$atlas_drill_policy" --policy-sha256 "$recorded_policy_sha256" \
  --keyfile "$recovery_keyfile" --password-file "$pbs_reader_password_file"
```

Supply `--key-password-file` when needed. The handoff stages the receipt
and point in a private temporary directory for this invocation. Each
SSH fetch has a bounded frame and a 60-second deadline. The handoff
fetches the current Keep selection again after the PBS read and runs
Atlas preview only if the invocation, bytes and digest still match.
The command performs preview admission and leaves scheduling and live
restore to the approved rehearsal and activation steps.

#### Reproduce the SSH restriction in disposable Linux

Build a Debian fixture with OpenSSH and sudo, then run the proof with
only loopback and a read-only source mount. The build uses public
Debian packages. The proof generates its own expiring client key and
temporary host key, exercises both entry points, and removes the
temporary account, sudo rule, daemon and keys. Keep service status, PBS
and Proxmox responses are synthetic.

```sh
docker build -t quantself-atlas-ssh-proof:debian13 - <<'DOCKER'
FROM debian:13-slim
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server openssh-client sudo python3 \
    && rm -f /etc/ssh/ssh_host_* \
    && rm -rf /var/lib/apt/lists/*
DOCKER
docker run --rm --network none --pull never --hostname keep \
  --mount "type=bind,source=$PWD/scripts/infra/keep-storage,target=/code,readonly" \
  --entrypoint /usr/bin/python3 quantself-atlas-ssh-proof:debian13 \
  -B /code/prove-atlas-keep-ssh.py
```

### Verify same-point service results

After both services settle, run the reviewed copy of `backup_pair_proof.py`
as root on Keep from a path with its reviewed sibling backup scripts:

```sh
sudo -n /usr/bin/python3 -B /path/to/reviewed/keep-storage/backup_pair_proof.py
```

`verified_service_pair` binds the latest exit-zero service invocations to
the same encrypted recovery point and exact PBS archive. The backup must
be within four hours. A missing journal marker, a failed or pending
invocation, a conflicting receipt or unresolved work fails the check. The
proof prints only the result and recovery point ID. It reads no keys or
Healthchecks URLs.

### Observe the next scheduled pair for #208

The read-only pair proof reports `timer_origin: unverified`. On systemd
257 a timer can add its details to an already queued manual job before
that job starts. Both a matching timer timestamp and a live job snapshot
can therefore appear on a manual invocation.

For a guarded observation window, use the staged
[service drop-in](../../../scripts/infra/keep-storage/scheduled-origin/10-quantself-timer-only.conf).
It is separate from the shipped units and only needed while collecting
evidence. It rejects direct manual starts. Review the effective units and
their reverse dependencies first. The matching timer must be the only
activation source for each service during the window.
Apply the temporary Keep change in the approved scope under the
[infrastructure session workflow](../../agents/infrastructure-sessions.md).

1. Before 03:00 Halifax time, record both active timers' next elapse
   times, the boot ID and both current invocation IDs. Confirm both
   services are idle with no pending jobs. Place
   the drop-in under each service's `/run/systemd/system/<unit>.service.d/`
   using its exact filename. Reload the manager and confirm
   `RefuseManualStart=yes`, both services still idle with no pending jobs,
   and the same two upcoming elapse times. Leave both timers armed
   throughout the window. If a timer or guard changes, discard the window.
2. During each expected run, record the boot ID, job ID, invocation ID
   and execution start time. With `unit` set to `keep-backup` or
   `keep-postgres-restore`, gather the evidence on Keep:

   ```sh
   (
     set -eu
     service="$unit.service"
     timer_path=$(printf '%s' "$unit" | sed 's/-/_2d/g')_2etimer
     snapshot() {
       systemctl show "$service" -p Job -p InvocationID -p ActiveState \
         -p ExecMainStartTimestampMonotonic -p RefuseManualStart
     }
     cat /proc/sys/kernel/random/boot_id
     before=$(snapshot)
     printf '%s\n' "$before"
     job=$(printf '%s\n' "$before" | sed -n 's/^Job=//p')
     test "$job" -gt 0
     busctl --json=short get-property org.freedesktop.systemd1 \
       "/org/freedesktop/systemd1/job/$job" org.freedesktop.systemd1.Job ActivationDetails
     systemctl show "$unit.timer" -p LastTriggerUSec
     busctl --json=short get-property org.freedesktop.systemd1 \
       "/org/freedesktop/systemd1/unit/$timer_path" org.freedesktop.systemd1.Timer LastTriggerUSecMonotonic
     test "$before" = "$(snapshot)"
   )
   ```

   Require `ActiveState=activating`, `RefuseManualStart=yes`, a fresh
   invocation ID and `trigger_unit` equal to the matching timer. Match
   `trigger_timer_monotonic_usec` to `LastTriggerUSecMonotonic` and require
   it to precede or equal the nonzero execution start timestamp. Check
   the realtime trigger against the recorded elapse at 03:00 or 04:30
   within the timer's configured accuracy window. A missed sample leaves
   origin unverified.
3. After both services settle, confirm the same boot and compare both
   current invocation IDs to the captured IDs immediately before and
   after the read-only pair proof. Record its verified recovery point
   alongside the two timer captures. At the end of the window, remove
   the two temporary drop-ins, reload the manager, and confirm the
   normal manual-start setting is restored and both timers remain armed.

[systemd 257 timer job handling](https://github.com/systemd/systemd/blob/v257/src/core/timer.c#L545-L579)
· [systemd manual-start settings](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html#RefuseManualStart=)
