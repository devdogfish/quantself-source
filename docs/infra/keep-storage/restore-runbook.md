# Keep isolated recovery acceptance

Status **encrypted PBS and B2 application recovery, nightly services and lab cleanup verified**. [Pair evidence](first-pair-proof.json). [#254](https://github.com/devdogfish/quantself/issues/254) requires both encrypted PBS and B2 recovery. Record separate results for each source against the same pre-backup evidence. A missing or partial pair fails admission. Follow [#217](https://github.com/devdogfish/quantself/issues/217) for live operations and Owner-only secret entry.

## Acceptance record

| Gate | Evidence recorded | Scope notes |
| --- | --- | --- |
| Private Keep app and originals | Owner passkey startup, archived PDF download, PNG receipt rendering, full and ranged To-Do WAV bytes, and browser playback and seeking of a separate synthetic Inventory original. [Deployment](deployment.md), [receipts](live-receipt-proof.json), [recording](live-audio-proof.json). Live scoped Vault denials and app credential rotation/revocation passed. [Permissions](vault-permissions-proof.json) | Restored receipt, To-Do playback and Vault permissions passed for PBS and B2. |
| Writer shutdown | The deployed replacement app image passed isolated Next, Caddy and API drain tests with a deferred capture, active and abandoned SSE clients, and a TCP reset during a WAV range response. Isolated Vault quiescence preserved exact bytes after restart. The pinned Vault gateway drained an admitted PUT and closed SSE in 30.195 s. A stalled PUT returned 502, left one session and blocked OpenCloud stop. The live private Serve route through the gateway on loopback 9201 was verified. The first coordinated backup verified clean pauses and resumes. [Runtime proof](runtime-drain-proof.json), [Vault proof](vault-drain-proof.json), [Pair evidence](first-pair-proof.json) | Signal tests used isolated fixtures. The live backup coordinator passed full pause and resume. |
| PBS recovery | Both encrypted VM snapshots restored using the independently retained Owner key. Native audits matched 770 files-side entries and 16 Quantself entries. Restored Vault passed trusted TLS and issuer checks. The Owner installed the temporary CA and verified trusted HTTPS in Chrome. Isolated guest network denial checks passed. The functional database import matched 66 migrations and expected auth counts, and the app passed trusted HTTPS health. TCP probes from the API container failed as intended for the two sampled targets, Keep’s configured LAN address on port 22 and TEST-NET-2 `198.51.100.1:443`. [PBS proof](pbs-restore-proof.json), [Network proof](restore-network-proof.json) | Optional follow-up: capture the full To-Do response hash and exact HTTP ranges on the restored runtime. |
| B2 and native metadata | Both snapshots restored using independently retained Owner credentials. Native metadata audits matched 770 files-side entries and 16 Quantself entries. The disposable damaged repository was reconstructed from six saved object versions. Isolated B2 application and browser recovery passed. [B2 restore proof](b2-restore-proof.json), [B2 access proof](b2-access-proof.json), [Hidden-version proof](hidden-version-proof.json) | Nightly PostgreSQL restore is tracked separately below. |
| Failure detection | Healthchecks and Owner email confirmed terminal-failure, missed-heartbeat, growth and synthetic PostgreSQL restore failure alerts. Both timers are enabled. [Alert proof](alert-test-proof.json) | Both services passed on the same new pair. VM 2544 and the application lab were removed. [Nightly and cleanup evidence](nightly-proof.json). |

For each future run, record the UTC observation time, restore-point ID, measured result and evidence location. Keep browser proof, synthetic runtime proof, and actual backup and recovery outcomes distinct.

## Owner approval and admission

Proposed on **Keep** only. Confirm these IDs are unused across QEMU/LXC and that neither ID is in a backup or HA job.

| VM | Name | CPU / RAM | Disk on encrypted `local-lvm` | Isolated IP |
| --- | --- | --- | --- | --- |
| 2542 | files-restore-254 | 2 / 2048 MiB | 40 GiB virtual | 192.0.2.42/24 |
| 2543 | quantself-restore-254 | 2 / 4096 MiB | 32 GiB virtual | 192.0.2.43/24 |

Request named approval for creation and initialization of **only** these two new virtual disks, their isolated network, and any guest firewall changes on these two IDs. Separately name any later reboot, deletion, credential revocation or cloud fixture damage. Keep data on encrypted storage, including recovery scratch. Budget one restored pair at a time. Before allocation, record:

```sh
qm list
pct list
pvesm status
lvs --units b -o vg_name,lv_name,lv_size,data_percent,metadata_percent keep-vg
free -m
ip -br link
ha-manager status
```

Use current thin data and metadata usage and snapshot transfer/allocation estimates. Maintain at least 20 GiB physical pool reserve after projected allocations, including concurrent source growth and cloud staging. The full 72 GiB nominal pair needs at least 92 GiB physical free if allocation is unknown. Keep the existing VG reserve. Require 6 GiB guest RAM, QEMU overhead and at least 1 GiB host headroom. Boot serially and remeasure if headroom is tight. Recheck after each restore and stop on an unexpected footprint. Review current [capacity gates](README.md#allocated-capacity-and-restore-admission).

Select one completed coordinator manifest. Match its restore-point ID, two PBS volume IDs and encryption fingerprints, two full restic snapshot IDs and repository identities. Preserve the expected encrypted manifests and inventories independently of the uploader for this drill. Record exact source paths, numeric owners, schema migration, app and storage image IDs, dump SHA-256, capture JSON inventory and frozen OpenCloud inventory. Capture the synthetic ledger rows and IDs before backup. Independently preserved evidence is the comparison baseline.

For the first actual paired restore, review these operations with the Owner under #217:

- On `files` (2540), repoint the existing private Tailscale Serve HTTPS 443 root from loopback 9200 to the verified Vault gateway on loopback 9201. Prepare the exact reverse change. Verify trusted HTTPS, Owner login and scoped WebDAV access, then use the approved maintenance window to capture one paired backup from `files` and `quantself` (2541). Confirm both services resume and both PBS and restic destinations contain the same restore point.
- On Keep, allow the temporary PBS alias `backup-restore-254` with the Owner’s independently retained client key. Approve initialization of new virtual disks for 2542 and 2543 on encrypted `local-lvm`, the no-uplink `vmbr254` and `keep-restore-254` test namespace, and the guest firewall changes confined to these two restore VMs. Keep the source guest disks and existing PBS storage outside this scope.
- Owner supplies independent B2 read access and restic passwords locally. Review the encrypted scratch path and its capacity. Use fresh application volumes for the B2 run and verify they are seeded solely from B2 and the pinned install bundle. If resetting isolated disks or volumes is necessary, name those exact resources before cleanup or reuse. Only compare full, separately restored application results against the captured baseline.

## Encrypted PBS restore

Phase 1 covers the two powered-off restores and their disconnected boots for read-only checks. Review and authorize the exact complete restore-point ID, both PBS volume IDs, temporary key alias, VM 2542 and VM 2543 with the Owner. Keep each VM disconnected and shut it down after recording the checks. The isolated bridge and service configuration follow in a separate phase.

1. **Owner:** After approving temporary storage `backup-restore-254`, run this from the Mac checkout. The wrapper creates a disabled alias scoped to Keep with the existing server, datastore, namespace and TLS fingerprint. It imports the independently retained Mac key through SSH stdin, checks the approved encryption fingerprint, and copies the existing PBS credential between Keep's root-private storage files. It enables the alias after those checks. The existing backup storage configuration stays in place. Inspect alias state before retrying after any error or disconnected SSH session. [Proxmox storage CLI source](https://github.com/proxmox/pve-storage/blob/master/src/PVE/CLI/pvesm.pm).

   ```sh
   bash scripts/infra/keep-storage/owner-pbs-restore-alias.sh "$approved_encryption_fingerprint"
   ```
2. Set `pbs_files_volume` and `pbs_app_volume` from the admitted complete manifest, replacing only the storage prefix with `backup-restore-254`. In the alias's PBS inventory verify exactly one row per exact volume ID, matching restore-point note, source VM ID, `pbs-vm` format and manifest client encryption fingerprint. Refuse an occupied destination ID or one reserved by an HA resource. `pvesm extractconfig` is a private preflight. Inspect hardware, disk size, passthrough and network privately. The commands below assume the reviewed configuration has one NIC named `net0` per guest. Stop and review any deviation before restoring.
3. Restore powered off, with autostart disabled before the cloned configuration is published. Keep's installed QEMU server 9.2.15 supports the overrides on the restore API. Submit one restore at a time. Capture its returned UPID, then observe that exact task until `status=stopped` and `exitstatus=OK` before changing the VM or submitting the second restore. If the UPID or result is uncertain, reconcile Keep's task and VM records before further action. [Proxmox VM restore API source](https://github.com/proxmox/qemu-server/blob/master/src/PVE/API2/Qemu.pm).

Set `KEEP_SSH_KNOWN_HOSTS` and `KEEP_PBS_SSH_HOST` before installing the alias.
See [deployment and validation](deployment.md).

   ```sh
   pvesm list backup-restore-254 --content backup --vmid 2540
   pvesm list backup-restore-254 --content backup --vmid 2541
   pvesm extractconfig "$pbs_files_volume"
   pvesm extractconfig "$pbs_app_volume"
   pvesh create /nodes/keep/qemu --archive "$pbs_files_volume" --vmid 2542 \
     --storage local-lvm --unique 1 --start 0 --onboot 0 --autostart 0 --output-format json
   pvesh get "/nodes/keep/tasks/$files_restore_upid/status" --output-format json
   qm set 2542 --name files-restore-254 --onboot 0 --cores 2 --memory 2048 --balloon 0 --delete net0
   qm config 2542
   # Recheck thin-pool data/metadata and RAM before allocating the second guest.
   pvesh create /nodes/keep/qemu --archive "$pbs_app_volume" --vmid 2543 \
     --storage local-lvm --unique 1 --start 0 --onboot 0 --autostart 0 --output-format json
   pvesh get "/nodes/keep/tasks/$app_restore_upid/status" --output-format json
   qm set 2543 --name quantself-restore-254 --onboot 0 --cores 2 --memory 4096 --balloon 0 --delete net0
   qm config 2543
   ```

4. Verify both stopped VMs have **zero NICs**, no passthrough and no shared mount. Inspect every hardware entry and compare with the local-lvm volume inventory for that clone. Admit only its restored `scsi0` system disk and, if present, its generated `ide2` cloud-init CD-ROM. Require `boot: order=scsi0` and verify that cloud-init was disabled in the source guest before backup. Keep the generated CD-ROM attached if it belongs to the clone. Stop if it references a source disk or if any additional disk, ISO or orphan appears. `--unique` changes MAC addresses only. Before admitting this boot path, verify the source containers used the tracked restart policies during the selected backup and that no boot unit independently launches the production Compose projects. The coordinator checks that both guests are paused before and after PBS. PostgreSQL stays running. The stopped services use `unless-stopped`, which preserves a manual stop across Docker daemon restarts. The app's initialization and migration containers use `no`. [Docker restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/).
5. Boot with zero NICs after the hardware review above. Use QEMU Guest Agent to inspect the service label, state and restart policy without printing environment variables. Expect no running container on 2542 and only the restored PostgreSQL container on 2543. The restored services, including any retained one-shot containers, must be stopped. Run separately for each restored VM, starting with 2542. Wait for the guest-agent ping before running the Docker checks.

   ```sh
   # Select exactly 2542 or 2543 after reviewing its hardware.
   start_disconnected_restore() {
     case "$1" in
       2542) expected_memory=2048 ;;
       2543) expected_memory=4096 ;;
       *) return 1 ;;
     esac
     [ "$(qm status "$1")" = 'status: stopped' ] || return 1
     restore_config=$(qm config "$1") || return 1
     printf '%s\n' "$restore_config" | grep -qx 'onboot: 0' || return 1
     printf '%s\n' "$restore_config" | grep -qx "memory: $expected_memory" || return 1
     printf '%s\n' "$restore_config" | grep -qx 'boot: order=scsi0' || return 1
     printf '%s\n' "$restore_config" |
       grep -Eq "^scsi0: local-lvm:vm-$1-disk-[0-9]+(,|$)" || return 1
     if printf '%s\n' "$restore_config" | grep -q '^ide2:'; then
       printf '%s\n' "$restore_config" |
         grep -Eq "^ide2: local-lvm:vm-$1-cloudinit,media=cdrom(,size=[0-9]+[KMGT])?$" || return 1
     fi
     if printf '%s\n' "$restore_config" | grep -Eq '^autostart:[[:space:]]+1$'; then
       return 1
     fi
     if printf '%s\n' "$restore_config" |
       grep -Eq '^(net[0-9]+|hostpci[0-9]+|usb[0-9]+|virtiofs[0-9]+|ivshmem|args|hookscript|cicustom|unused[0-9]+|ide[013]|sata[0-9]+|scsi[1-9][0-9]*|virtio[0-9]+|efidisk0|tpmstate0):'; then
       return 1
     fi
     qm start "$1"
   }
   start_disconnected_restore "$restore_vmid"
   qm agent "$restore_vmid" ping
   qm guest exec "$restore_vmid" -- docker ps -aq
   qm guest exec "$restore_vmid" -- docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}} {{.State.Status}} {{.HostConfig.RestartPolicy.Name}}' "$container_id"
   ```

   Inspect every returned container ID and require successful guest execution. Record the expected states, shut down the guest using `qm shutdown "$restore_vmid" --timeout 60`, and verify stopped status. On an unavailable agent or unexpected state or policy, shut down the affected VM with its NICs absent and halt the drill. A shutdown timeout requires operator review. Rehearse this path on the first actual restore before relying on it.
6. While still disconnected, permanently mask `tailscaled.service` and any restored cloud-init, backup, coordinator and heartbeat units. Disable DHCP and IPv6 autoconfiguration for the future isolated NIC. Stop the restored PostgreSQL container and set all restored production containers to restart policy `no`, retaining their volumes. Verify the masks, disabled restart policies and no running production containers, then shut down before attaching an isolated NIC. Use a **new** restore-only Compose project with explicit volume paths and a reduced environment. Keep restored production configurations and secret volumes private. Prove firewall and boot isolation before starting the restore-only services.

Before masking the original `keep-storage-firewall.service`, set all retained
production containers to restart policy `no`, stop PostgreSQL if running, and
verify no production container is running. Stop Docker and its socket. The
cloned Docker unit requires the original firewall through
`/etc/systemd/system/docker.service.d/keep-storage-firewall.conf`. Preserve the
original drop-in, replace its verified `Requires` and `After` entries with
`keep-restore-boundary.service`, and reload systemd. Verify the new firewall
unit and its nftables table are active before starting Docker. Confirm the
original containers remain stopped with restart policy `no` before shutting
down for NIC attachment. Keep the NIC absent if any check fails.

The first files clone passed its native audit with 770 inventory entries. Its
initial preparation stopped at the Docker dependency after the old firewall
was masked. The verified offline completion rewired that dependency, confirmed
both original containers stopped with restart policy `no`, and shut down the
clone. [PBS restore evidence](pbs-restore-proof.json).

## Private service network and browser

The proposed host boundary is `scripts/infra/keep-storage/restore/keep.nft`.
Its syntax passed `nft -c` on Keep; it has not been applied. With named approval,
load its two dedicated tables before attaching guest taps. The bridge-family
rules deny lab traffic to/from the host while preserving forwarding between lab
ports; inet rules additionally deny routing across the lab boundary. A bridge
with no uplink alone does not prove that the host cannot route traffic. Verify
positive lab traffic and negative host/LAN/internet probes, including a routed
probe directed to the bridge MAC. Preserve existing host firewall tables.

Use a temporary host bridge with no uplink, no host IP or IPv6 link-local, and no physical port. Confirm the installed PVE version recognizes the transient bridge for guest tap attachment before boot. If it requires a persisted bridge stanza, review that separately and leave existing interfaces untouched. Attach only the two restore guests and a dedicated test network namespace. In that namespace use one veth, `192.0.2.41/24`, no default route and no DNS forwarding. Disable bridge/namespace IPv6 and verify no routes except the connected isolated IPv4 subnet. The following is the proposed setup on Keep after named network approval, with both guests shut down:

```sh
ip link add vmbr254 type bridge
sysctl -w net.ipv6.conf.vmbr254.disable_ipv6=1
ip link set vmbr254 up
ip netns add keep-restore-254
ip link add kr254-host type veth peer name kr254-test netns keep-restore-254
sysctl -w net.ipv6.conf.kr254-host.disable_ipv6=1
ip link set kr254-host master vmbr254
ip link set kr254-host up
ip netns exec keep-restore-254 sysctl -w net.ipv6.conf.all.disable_ipv6=1
ip -n keep-restore-254 addr add 192.0.2.41/24 dev kr254-test
ip -n keep-restore-254 link set kr254-test up
ip -n keep-restore-254 link set lo up
qm set 2542 --net0 virtio=02:54:00:00:02:42,bridge=vmbr254
qm set 2543 --net0 virtio=02:54:00:00:02:43,bridge=vmbr254
bridge link show master vmbr254
ip -br addr show vmbr254
ip -n keep-restore-254 route show
```

Configure only the static addresses above using the guest console. No DNS server, DHCP, default gateway or proxy. Use isolated names `files-restore.test` and `quantself-restore.test` mapped explicitly in guest and API-container hosts files. Inspect both guests' routes and firewall. On these guests only, permit Vault TCP 19443 from Quantself and tester, Quantself TCP 18443 from tester, and the narrow Docker forwarding needed for API → Vault. Test those positive connections, then verify failure for LAN, Tailscale, PBS, internet, known production endpoints and public hooks. Repeat from inside the API container. Verify the bridge's only members are the restore taps and namespace peer. Keep existing host firewall, LAN, Tailnet and DNS configuration intact.

Use a throwaway CA for the two test names. Configure trusted HTTPS on each isolated Caddy listener using explicit cert/key files. OpenCloud's upstream remains loopback 9200. Set `OC_URL=https://files-restore.test:19443` and check issuer/redirect URLs point at that origin. Configure API trust with the test CA, `QUANTSELF_OPENCLOUD_URL=https://files-restore.test:19443`, same restored space ID, and a restore-only scoped token. Trust the CA in an isolated Owner browser profile. Use a TCP-to-Unix-socket proxy inside the test namespace and Owner's existing Keep SSH transport to reach it. For example, if reviewed `socat` is installed, have the Owner run this as their Keep login user from an existing private directory they own (mode 0700):

```sh
# Run on Keep via a reviewed privilege drop after entering the namespace.
socat UNIX-LISTEN:/run/keep-restore-254/app.sock,mode=0600,fork TCP:192.0.2.43:18443
socat UNIX-LISTEN:/run/keep-restore-254/vault.sock,mode=0600,fork TCP:192.0.2.42:19443
```

Run the proxies as the Owner in separate sessions. Create the socket directory on Keep as Owner-writable and inaccessible to other users. On the Mac, use the existing pinned Keep SSH alias and local-only forwards:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:18443:/run/keep-restore-254/app.sock \
  -L 127.0.0.1:19443:/run/keep-restore-254/vault.sock keep
```

Keep's effective SSH settings allow StreamLocal and TCP forwarding, with `DisableForwarding no`. `/usr/bin/socat` is present. Verify both end-to-end forwards after creating the isolated test network.

Use a fresh, unsynced browser profile with no live sessions or extensions, isolated name mappings to 127.0.0.1, and exact origins `https://quantself-restore.test:18443` and `https://files-restore.test:19443`. Use the same HTTPS ports on the guests and in the browser so issuer and auth origins stay consistent. Verify TLS and check that discovery, login and redirects remain on the test origins before entering any credential. Stop if the browser requests a live origin. If PVE bridge setup, SSH policy or local trust prevents this, keep the VMs isolated and stop for a reviewed equivalent path.

Use `BETTER_AUTH_URL` equal to the isolated app browser origin and `BETTER_AUTH_RP_ID=quantself-restore.test` on app and API. Verify restored auth tables and protected auth-secret bytes before testing sign-in. Passkeys are RP-bound. On a **separate isolated functional-test database copy**, Owner may clear the copied bootstrap marker, sessions and setup tokens, retaining the `owner` user ID and its application rows. Confirm the schema and get named approval for those copy-only deletions before using normal first-owner setup to register a test-only passkey. Retain untouched baseline evidence of the restored owner and passkey rows. Use a fresh runtime auth secret for the test copy. Keep external integration variables out of both app containers, disable phone, and leave all external egress physically absent. Use only the restored Vault for test token creation and revocation.

The restore helpers retain temporary test credentials automatically in private
files when needed for setup or retry. Use mode-0700 directories and mode-0600
files. Leave test-only tokens and setup links out of the password manager. The
Owner saves actual setup credentials through the usual private workflow. The
Owner explicitly authorized automatic management of temporary test credentials
on VMs 2542 and 2543, including revocation of the two named prior app tokens
in the restored Vault. The usual #217 Owner-run credential workflow still
applies to actual setup credentials.

## B2 recovery onto clean application volumes

Use a root-only, encrypted recovery workspace with enough room for the encrypted reconstructed repositories, extracted trees and Docker volumes. Owner supplies independently retained restic passwords and bucket/prefix-scoped read credentials. Keep those credentials off both restored application guests. Deployment `.env`, auth, OpenCloud config and inventories carry secrets or sensitive names. Use mode-0700 directories, mode-0600 logs and a private terminal. Avoid shell tracing and full Docker inspect output. Confirm the Toronto account's actual S3 endpoint and use it explicitly. The example assumes the password files and AWS configuration were prepared privately by Owner.

For an intact repository, use the manifest snapshot IDs, a fresh local cache and a read-only cloud credential. Coordinate a quiet source window if using `--no-lock`, so repository maintenance cannot change objects while checking. Repeat for each side.

```sh
restic --repo "$restore_repo" --password-file "$restore_password_file" \
  --no-lock --no-cache check --read-data
restic --repo "$restore_repo" --password-file "$restore_password_file" \
  --no-lock --no-cache restore "$restore_snapshot_id" --target "$empty_restore_tree" --sparse --verify
```

The coordinator restores `manifest.json`, `inventory.json` and `tree/` directly under the empty target. Verify the inventory digest in the manifest and the custom dump at `tree/postgres/quantself.dump` against its inventory SHA-256. Always use an empty target on Linux as root and compare the native restored trees using [backup_inventory.py](restore-inventory.md). Check exact archive roots against the manifest before placing files. Preserve owners, modes, hardlinks, timestamps and all xattrs with the root-only filesystem copy into empty destination trees, then verify **again** at their runtime mountpoints. Keep OpenCloud config/system data/PosixFS on the approved single ext4 filesystem. Never copy into the live guests. [restic 0.19.1 restore documentation](https://restic.readthedocs.io/en/v0.19.1/050_restore.html).

Run the read-only pair audit against the independently retained coordinator manifest and both frozen extractions before copying runtime data:

```sh
python3 scripts/infra/keep-storage/audit_restore_pair.py "$complete_manifest" \
  --files "$files_restore_tree" --quantself "$quantself_restore_tree"
```

The audit reports entry counts. Verify remote repository and PBS identities during retrieval, then use the runtime checks below for application recovery.

Load the app image from the verified B2 extraction as described below. Use pinned OpenCloud, PostgreSQL and Caddy images that match the manifest, loaded via encrypted offline transfer or already verified local copies. For the independent B2 application test, use freshly provisioned recovery disks/guests under the same approved envelope, or separate empty application volumes on the isolated guests. Seed only from B2 and the pinned install bundle, including the isolated Compose/TLS configuration. Record which infrastructure bootstrap was used. Keep recovered application images read-only where practical. A review must account for cloud staging before committing to both drills in one window.

Verify the dump digest and `pg_restore --list` before importing. Start only the fresh restore PostgreSQL container. For the reviewed coordinator's PostgreSQL custom-format dump, the intended command is:

```sh
docker compose --env-file restore.env -f quantself.compose.yaml up -d --no-deps postgres
docker compose --env-file restore.env -f quantself.compose.yaml exec -T postgres \
  pg_isready -U quantself -d quantself
docker compose --env-file restore.env -f quantself.compose.yaml exec -T postgres \
  pg_restore --exit-on-error --single-transaction --no-owner --no-acl \
  --username quantself --dbname quantself < "$recovered_pg_dump"
```

First confirm PostgreSQL contains only a fresh initialization, with no application schemas/data. Restore logs stay private. Verify schema/version and the database baseline before starting app/API. Use the captured privileges/roles if the dump contract requires any beyond the single Quantself role. Restore the encrypted configuration/auth/capture trees to their documented destinations before startup. Seed independent isolated runtime secrets and keep restored secret-bearing inputs read-only/private. Start OpenCloud first, then API/Next/gateway with only explicit isolated dependencies. Run the same end-to-end checks for each backup source.

### B2 runtime bootstrap on the isolated guests

Use the approved 2542/2543 isolation envelope. The verified B2 extraction was transferred offline into fresh `/srv/keep-restore-254-b2` roots on the guests’ encrypted disks. On 2542, OpenCloud mounts `runtime/opencloud/config` and `runtime/opencloud/data` from that root. On 2543, the synthetic capture volume is under `runtime/captures`, the verified dump is at `runtime/postgres/quantself.dump`, and PostgreSQL initializes in the separate, initially empty `runtime/pgdata`. Keep the verified extracted trees intact as the baseline.

Stage the reviewed B2 versions of the [restore templates](../../../scripts/infra/keep-storage/restore/) under the B2 root. Reuse the isolated test-origin TLS bundle through read-only mounts from `/srv/keep-restore-254/tls`. OpenCloud, web and API use the shared public test CA. The bundle is lab infrastructure. The B2 Vault, captures, PostgreSQL and app image were recovered independently from B2. The recovered deployment secrets stay private. Install fresh credentials and the runtime auth secret for B2.

On 2543, use the three recovered files in `tree/deployment/app-image/`: `image.tar.gz`, `image.json` and `SHA256SUMS`. The pair audit verifies the three-file set, both checksum rows, and the metadata's Linux AMD64 config ID against the complete manifest. Set `expected_app_image` from the independently retained manifest's equal app/API IDs. After offline transfer to 2543, verify again before loading. Use the recovered artifact even when the same image ID already exists locally. Recovery does not depend on CI artifact retention.

```sh
(
  set -eu
  cd "$app_tree/deployment/app-image"
  sha256sum --strict -c SHA256SUMS
  python3 -c 'import json, sys; m = json.load(open("image.json")); sys.exit(0 if (m.get("id"), m.get("os"), m.get("architecture")) == (sys.argv[1], "linux", "amd64") else 1)' "$expected_app_image"
  docker load --input image.tar.gz
  test "$(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$expected_app_image")" = "$expected_app_image linux/amd64"
)
```

Require every command to pass. Enter the verified image IDs in a fresh mode-0600 `restore.env`. Both templates specify `pull_policy: never`. Restore service definitions use the following mappings:

| Guest / service | Source and container mount | Network and settings |
| --- | --- | --- |
| 2542 OpenCloud | `runtime/opencloud/config:/etc/opencloud` and `runtime/opencloud/data:/var/lib/opencloud` | UID/GID 1000, host network. `OC_URL=https://files-restore.test:19443`, `OC_INSECURE=false`, `PROXY_TLS=false`, `PROXY_HTTP_ADDR=127.0.0.1:9200`, `PROXY_ENABLE_BASIC_AUTH=false`, `STORAGE_USERS_DRIVER=posix`. Use a restore-only hosts entry for `files-restore.test` and trust the test CA inside OpenCloud for self-requests. |
| 2542 Vault HTTPS Caddy | Restore-only config and test cert/key read-only | Host network, bind only `192.0.2.42:19443`, reverse proxy to `127.0.0.1:9200` and preserve the original host and HTTPS scheme. |
| 2543 PostgreSQL | `runtime/pgdata:/var/lib/postgresql` | Compose bridge, no published ports. Use pinned image, fresh local password, initialize with database/user `quantself`, then import the verified dump into `quantself_restore_ui`. |
| 2543 API | `runtime/captures:/app/storage/todo-captures` and new restore-only auth secret at `/run/quantself/auth-secret` read-only | Compose bridge. Use `bun run --cwd apps/api start:production`, `API_PORT=3001`, `QUANTSELF_PHONE_ENABLED=0`, `QUANTSELF_TODO_CAPTURE_ROOT=/app/storage/todo-captures`, `QUANTSELF_ORIGINALS_PROVIDER=opencloud`, `QUANTSELF_OPENCLOUD_URL=https://files-restore.test:19443` and the restored Originals space ID. Add host `files-restore.test:192.0.2.42`, mount the test CA read-only and set `NODE_EXTRA_CA_CERTS` to its container path. Supply only a newly issued isolated Vault token. |
| 2543 Next | Same restore-only auth secret read-only | Compose bridge, no published ports. Use `bun run --cwd apps/web start`, `PORT=3000`, `HOSTNAME=0.0.0.0`, and `QUANTSELF_API_INTERNAL_URL=http://api:3001`. |
| 2543 Quantself HTTPS Caddy | Restore-only config and test cert/key read-only | Same Compose bridge, publish only `192.0.2.43:18443:18443`. Retain the deployed route split and internal API deny from the captured Caddyfile. Add explicit TLS for `quantself-restore.test` and use port 18443. |

Use `restart: "no"` for each restore service. Give app and API only the isolated database URL and auth settings, including `BETTER_AUTH_SECRET_FILE=/run/quantself/auth-secret`, the test browser origin and RP ID described above. Keep PostgreSQL and the web services on the same guest-local bridge so Docker names `postgres`, `api` and `app` resolve. A Docker `internal: true` network alone would block the required API-to-Vault hop. Enforce that hop in the isolated guest firewall before startup, including the Docker forward path. Apply a default-deny outbound policy in the guest except the required internal paths, and prove absence of default routes and external DNS independently. Allow the tester to reach both listeners, the app API to reach only Vault HTTPS and OpenCloud to reach its own HTTPS origin.

After importing the B2 dump, record the read-only auth baseline of the isolated functional database. The verified passkey fixture preserved the original restored Owner passkey and added one public credential record from the PBS lab for the same test RP. B2 then had two Owner passkeys. The existing Owner user, marker, sessions and setup tokens were preserved. Use normal sign-in with the existing test-origin passkey. Keep the extracted B2 data and original baseline intact. Retain the SSH Unix-socket browser forwards above and verify the isolated Vault issuer and certificate before testing.

B2 passed all 17 Vault permission checks. Rotation revoked one restored token
and left one replacement. The old credential returned HTTP 401 and the
replacement returned HTTP 200. Verification also passed after the isolated
OpenCloud restart.

After restart, Brave accepted the existing test passkey. The post-login URL
showed a blank page. Navigating directly to the restore root opened Today.
The PNG receipt rendered completely at 1200 × 1600. The PDF downloaded
through the receipt UI and matched the expected SHA-256 and 792-byte length.
The native player on `/restore-audio-check` played the 90-second To-Do WAV,
sought to 44.167501 seconds, and advanced to 49.76877 seconds with no media
error before pausing. The HTTP probe returned the full 8,640,044-byte WAV
with HTTP 200 and the expected SHA-256. Prefix, middle and suffix requests
returned HTTP 206 with exact bytes. Beyond-EOF returned 416 and anonymous
access returned 401. The continuation used a 29-character temporary key
name after the initial name exceeded the 32-character limit. The key was
disabled and denied on reuse. Original gateway configuration restoration
verified. [B2 proof](b2-restore-proof.json).

The PBS functional database `quantself_restore_ui` has been imported. The
guarded import verified 66 migrations, one Owner user and passkey, one
bootstrap marker, two Owner sessions, zero other sessions, and two setup
tokens. The Owner approved the reset in this copy. It committed and left one
user, one passkey, zero markers, zero sessions and zero setup tokens. The app
started, and trusted HTTPS health passed from the Keep namespace and the Mac.
The API reached the isolated Vault issuer. TCP was unavailable to the sampled
Keep LAN and public test endpoints. The Owner registered a test-origin
passkey in Brave. The access-context endpoint confirmed the Owner web session.
On the restored Inventory route, the 90-second synthetic audio played, sought
to 43.8 seconds in the UI, and advanced past 52 seconds without a media error.
That route bypasses the custom protected-page proxy while the API authenticates
the Owner session. The To-Do capture's 90-second original also played in Brave
using the existing Owner session on the temporary same-origin
`/restore-audio-check` page. The player sought to 45.6 seconds and continued
past 53 seconds without a media error. This was a media API probe. The normal
To-Do task pane requires the GitHub relation unavailable in the lab. The probe
used existing Brave protections. The validated temporary Caddy configuration
required only a gateway restart and preserved its container ID. Restoration
of the original configuration passed. The PBS playback probe did not record
the full response hash, exact range response bytes or unsatisfiable range
status. Those are optional follow-up checks for this PBS run. Browser playback and seeking passed. [PBS proof](pbs-restore-proof.json).

Next 16.2.9 runs with `HOSTNAME=0.0.0.0` and `PORT=3000`. Its proxy-derived
HTTPS self-request was refused while the internal API returned HTTP 200. The
isolated `keep254-pbs-self-origin` unit exited 0 and verified HTTPS after the
CA/DNS correction. The redirect persisted. Source commit
`0560c98e37c8631c4956f0cf95e7f137a2c81aee` switches those checks to the internal
API. The 13 focused tests and full typecheck passed. The full suite reported 1,746
passed, 12 skipped and three failures. Both failing UI tests passed in a
seven-test rerun with `TZ=America/Halifax`. The supervisor test collided
with an external development process on port 47329. CI run 43612415589 passed
typecheck and all 16 test shards with 1,748 passed, zero failed and 13 skipped.
The replacement image was verified and loaded on clone 2543. The verified
deployment recreated only the web container. API, PostgreSQL, gateway and
network IDs matched before and after. Brave loaded the November 14 Today
dashboard at the restore root using the existing Owner session, resolving the
login redirect loop. The archived backup image remains unchanged.
The private validation app at its configured HTTPS origin loaded
Today with the existing Owner session and showed no login loop. To-Do requires
the GitHub configuration absent from that validation environment.

The restored PNG receipt rendered its original from the API at 1200 × 1600.
The restored PDF downloaded through the receipt UI. The browser download
event timed out, and the resulting file verified as 792 bytes with the
expected SHA-256. [PBS proof](pbs-restore-proof.json).

The isolated OpenCloud restart verified in `manual-pbs-vault-restart.json`.
The Owner browser then rendered the restored PNG and downloaded the verified
PDF. The isolated Vault permission probe passed 17 checks. The original
conditional attempt returned HTTP 412. Authorization checks then passed with
the existing temporary credential. Anonymous read returned 401. The app's
Personal-space read and write returned 404, with the Owner's sentinel still
readable and unchanged. Viewer create, overwrite and delete returned 403.
The app created, overwrote, read and deleted the exact disposable Originals
fixture, and the final read returned 404. The isolated token rotation
continuation verified API health and a trusted fixture read before revoking
both named prior tokens. One token remains. The old token returned 401 and
the replacement returned 200. The initial failed switch remains recorded.
[PBS proof](pbs-restore-proof.json).

On the verified 2543 console, create the new functional database and import the same dump. The following transaction is only for the named functional copy after the Owner approves its auth reset:

```sh
docker compose --env-file restore.env -f quantself.compose.yaml exec -T postgres \
  createdb -U quantself quantself_restore_ui
docker compose --env-file restore.env -f quantself.compose.yaml exec -T postgres \
  pg_restore --exit-on-error --single-transaction --no-owner --no-acl \
  --username quantself --dbname quantself_restore_ui < "$recovered_pg_dump"
docker compose --env-file restore.env -f quantself.compose.yaml exec -T postgres \
  psql -X -v ON_ERROR_STOP=1 -U quantself -d quantself_restore_ui <<'SQL'
BEGIN;
DO $guard$
BEGIN
  IF current_database() <> 'quantself_restore_ui'
     OR NOT EXISTS (SELECT 1 FROM auth_owner WHERE id = 'singleton' AND "userId" = 'owner') THEN
    RAISE EXCEPTION 'Unexpected restore database or owner';
  END IF;
END;
$guard$;
DELETE FROM "session";
DELETE FROM owner_setup_token;
DELETE FROM auth_owner WHERE id = 'singleton' AND "userId" = 'owner';
COMMIT;
SQL
```

The functional database URL must use `postgres:5432/quantself_restore_ui`. Restore the Vault first and issue its isolated token before evaluating the Quantself Compose template, which requires all restore-only environment values even for PostgreSQL-only startup.

Owner places the test CA at `tls/ca.pem`, the corresponding host certificate at `tls/server.pem`, and its key at `tls/server.key` on each guest. Keep CA signing material off the guests. Set certificate SANs to the specific test hostnames. On 2543, create `runtime/auth-secret` privately with at least 32 random characters and readability for the pinned image user. Set `RESTORE_FUNCTIONAL_DATABASE_URL` to the functional database before creating app/API. Set fresh `RESTORE_POSTGRES_PASSWORD`, the isolated Owner email, the audited Originals space ID, and the test-only Vault username/token in that guest's `restore.env`.

For future lab certificates, explicitly include `subjectKeyIdentifier=hash`
and `authorityKeyIdentifier=keyid:always` in both CA and leaf extensions.
Retain critical CA constraints, certificate-signing usage on the CA, and
server authentication usage and exact DNS SANs on leaves. Verify each new
leaf with OpenSSL 3 `verify -x509_strict -purpose sslserver -verify_hostname
<test-hostname> -CAfile ca.pem server.pem`. The first lab certificate omitted
an authority key identifier: Python 3.13 rejected it with verification code
85, although curl verified its chain and hostname. Never disable certificate
or hostname verification to compensate.

Before starting services, confirm the actual VM ID and static address from its console, zero default routes, no Tailscale/DHCP services and no preexisting live Docker containers. Verify only the isolated NIC and bridge are present. Run `nft -c -f files.nft` or `nft -c -f quantself.nft` before loading the matching file under the named guest firewall approval. Resolve any existing firewall chains that would drop the allowed paths, retaining the no-egress boundary. Use `docker compose --env-file restore.env -f <guest>.compose.yaml config --quiet`; plain `config` can print credentials.

After those checks, start the following explicitly. The PostgreSQL import above uses `quantself.compose.yaml` and the same private `restore.env`.

```sh
# 2542. Check the isolated HTTPS discovery issuer before starting 2543 app/API.
docker compose --env-file restore.env -f files.compose.yaml up -d --no-deps opencloud gateway
curl --fail --silent --cacert ./restore-ca.pem --resolve files-restore.test:19443:192.0.2.42 \
  https://files-restore.test:19443/.well-known/openid-configuration
# 2543, after verified dump import and isolated Vault token setup.
docker compose --env-file restore.env -f quantself.compose.yaml up -d --no-deps api app gateway
curl --fail --silent --cacert ./restore-ca.pem --resolve quantself-restore.test:18443:192.0.2.43 \
  https://quantself-restore.test:18443/api/health
```

Set `SSL_CERT_FILE` inside the OpenCloud container to the mounted test CA bundle if the image does not already trust it. Check that issuer, key URL and browser redirects stay under the isolated Vault origin. Keep raw discovery and application logs on the restore guest.

## B2 hidden version recovery

Use a separate disposable synthetic repository and equivalent restricted uploader permissions/lifecycle. Name the exact bucket/prefix and test keys for Owner approval of logical damage. Run with automatic pagination, including a test that requires multiple service pages. Stop concurrent writes and preserve an **independent, complete** pre-damage object-version map of the known-good view, with exact bucket, prefix, region, restore-point/snapshot IDs and key/version/size per entry. The map is sensitive. Keep it on encrypted storage outside uploader control. Use a listing while the repository is quiescent. Exclude ephemeral `locks/` only after confirming the repo is unlocked.

```sh
aws --profile "$recovery_profile" --endpoint-url "$b2_endpoint" s3api list-object-versions \
  --bucket "$synthetic_bucket" --prefix "$synthetic_prefix/" --page-size 2 --output json \
  > "$private_version_listing"
```

In the fixed disposable fixture, B2's post-damage paged listing returned
eight identities in four pages, but flagged both the pack's original version
and its delete marker as latest. A single explicitly untruncated
`max-keys=32` listing returned the same eight identities and flagged only the
delete marker latest. The continuation cross-checks both identity sets and
independent current-object reads. This bounded check applies to this fixture
only. For other repositories, contradictory latest flags block recovery-map
selection until the listing can be reconciled. [Drill evidence](hidden-version-test-plan.md).

Freeze the map by selecting entries in `Versions` with `IsLatest=true`; a key whose latest entry is a delete marker has no current object. Verify unique exact keys, one `config`, expected `keys/`, `data/`, `index/`, `snapshots/` structure and no unreviewed paths. Independently record encrypted byte SHA-256 for the two objects deliberately damaged. Record a successful `restic check --read-data` first.

1. Under the restricted uploader, delete one named synthetic pack by **name** and overwrite a different synthetic object's key with harmless fixture bytes. Check default reads fail or return the changed bytes and a pinned ordinary restore fails. Re-list versions and confirm the hide marker and prior versions still exist.
2. Under that uploader try version-specific deletion against one named disposable historical fixture version. Require explicit authorization denial and successful version-specific recovery afterward. Stop immediately if deletion unexpectedly succeeds. Demonstrate normal restic lock cleanup and synthetic `forget`/`prune` with the same capabilities, then confirm the retained versions exist. Test upload/read/list denials outside the uploader's scope. Keep bucket-admin and permanent-version-delete authority away from uploader identities. [B2 S3 capability mapping](https://www.backblaze.com/docs/cloud-storage-map-iam-policies-and-s3-acls-to-backblaze-b2-access-controls).
3. Recover **every** mapped version into a new encrypted local restic repository directory, stripping only the exact leading prefix. Resolve keys against a vetted allowlist of restic path patterns. Reject absolute paths, empty, dot or parent components, symlinks, duplicates and absent IDs. Use a private temporary path and compare response version ID and size to the saved row before publishing each file. Limit concurrency and account for one request per version. Example invocation for one already validated row:

   ```sh
   aws --profile "$recovery_profile" --endpoint-url "$b2_endpoint" s3api get-object \
     --bucket "$synthetic_bucket" --key "$saved_exact_key" --version-id "$saved_version_id" \
     "$new_ciphertext_file" > "$private_response_metadata"
   ```

4. Verify the damaged objects' ciphertext hashes and the entire local repository with `restic check --read-data`. Restore the original full snapshot ID with `--verify --sparse` and compare the pre-damage inventory, contents and xattrs. Record version listing/read counts, duration, retained bytes and the configured 30-day hidden-version rule. Live observation of deletion timing remains separate. For real recovery, reconstruct both repositories from the same paired checkpoint, then run the complete application restore. Recover into a fresh destination before considering any change to the damaged repository. [B2 list versions](https://www.backblaze.com/apidocs/s3-list-object-versions), [B2 GET by version](https://www.backblaze.com/apidocs/s3-get-object), [AWS CLI pagination](https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-pagination.html).

## Application comparison

Before starting application writers, verify dump SHA-256, native inventory on restored mountpoints, schema migration state, row counts and ledger fields against the pre-backup baseline. Record only counts/match results for private data. In PostgreSQL use a read-only transaction. A minimal relation check for known synthetic receipt IDs is:

```sql
BEGIN READ ONLY;
SELECT r.id, r."scanStatus", r.image IS NULL AS external_only,
       o.provider, o."spaceId", o."fileId", o.bytes, o.sha256, o.state
FROM budget_receipt AS r
JOIN original_file AS o ON o.key = 'original:' || r."originalKey"
WHERE r."ownerId" = 'owner'
  AND r.id IN ('7d76f27e-20cf-47ee-b0b3-9075c336bf74',
               'cb117495-d376-4a39-a8a0-4437b0a03855');
SELECT provider, "spaceId", "fileId", bytes, sha256, state
FROM original_file WHERE key = 'todo:e36b6ed6-63a7-4de5-8fdc-01c9cfc889a1';
SELECT "idempotencyKey", "responseBody" #>> '{input,key}' AS original_reference
FROM api_idempotency_key
WHERE "clientId" = 'todos' AND operation = 'capture-archive'
  AND "idempotencyKey" IN ('capture:e36b6ed6-63a7-4de5-8fdc-01c9cfc889a1',
                           'audio:e36b6ed6-63a7-4de5-8fdc-01c9cfc889a1');
SELECT count(*) FROM auth_owner;
SELECT count(*) FROM passkey;
ROLLBACK;
```

Confirm the exact receipt join against the captured fixture. Compare all ready ledger space/file IDs, sizes and hashes, and cross-check real OpenCloud metadata by stable ID. Verify the restored capture and audio metadata rows, the `original:todo:…` reference and the capture-volume inventory, and compare each full downloaded fixture hash to its source.

- Owner login on test origin. Archived PDF detail and original download work. Expected PDF 792 bytes and SHA-256 `a2f3b23e9f1ef34f9a0c023a34421205242dd293e0468e8bf84178c4280a218f`. The 5,763,517-byte PNG renders in actual receipt detail and matches SHA-256 `617dde7b47140b8da416a5e1fff569bdb889b1f8181ed11c3dfbe947e75ecc86`. [Live receipt proof](live-receipt-proof.json).
- Verify To-Do capture `e36b6ed6-63a7-4de5-8fdc-01c9cfc889a1` through `GET /api/v1/todo-captures/{id}/audio`. Require full 200 with 8,640,044 bytes, SHA-256 `31d6b7c418ac1485c02d35b70d08596ec14b2de9e879b21fcc8611b539aa2148`, prefix/middle/suffix 206 with correct `Content-Range` and bytes, and unsatisfiable 416. Exercise playback and seeking in the actual Owner UI on restored Inventory item `cmwfw8s81000108pexfd5few0` and audio `cmwfweps7000508pe801fwaus`. This separate Inventory original uses the same synthetic 90-second WAV. Record fresh-start and repeat playback/seek latencies and upstream request counts. Report To-Do browser playback separately. [Live audio proof](live-audio-proof.json).
- Owner Vault Viewer reads but cannot create, overwrite or delete in Originals. App Editor may create/read a disposable synthetic object in Originals and is denied read/write on a distinct private-document test space. Anonymous and unscoped clients fail. Inspect membership as admin and verify actual HTTP denials against known resources.
- Restart only the isolated OpenCloud service. Verify IDs/hashes/readiness again. Owner issues a new isolated scoped token, switches only the isolated API, proves reads and a disposable write, revokes the old isolated token and proves old-token denial. Verify negative access checks again. No production auth test is implied by rotation in the restored instance.

## Backup drain acceptance

The production API tracks active HTTP handlers even after client disconnect and stops workers, freshness cache, then Prisma. Its positive signal is `API drain complete` plus exit 0. A timeout or failed drain is exit 1 and blocks publication. Next 16.2.9 registers its own handler, closes HTTP acceptance, waits for active requests, cleans up and intentionally exits 143 on SIGTERM. Bun and Docker also can report 143 after a raw signal; exit status alone cannot identify the Next handler path. `DEBUG=next:start-server` exposes `start-server process cleanup finished` after cleanup and before exit. Verify the exact installed build and log output. [Quantself API entry point](../../../apps/api/src/index.ts), [Next 16.2.9 shutdown source](https://github.com/vercel/next.js/blob/v16.2.9/packages/next/src/server/lib/start-server.ts).

Run an isolated test using the exact deployed image ID, Bun command, `init: true` and stop grace periods. No deployed app credentials are needed.

1. On a Docker internal network, run a synthetic local upstream aliased `api:3001` and the deployed Next command. Use no live mounts or env. Use `/inventory` to exercise an actual Next page whose middleware checks Owner setup before its server render loads inventory. Hold the middleware call behind an explicit gate. Require the page-render API call to reach the upstream **after** SIGTERM and gate release. Use a fresh connection for the intake probe.
2. Begin `docker stop -t 900 <test-web-container>` asynchronously. Verify the Next cleanup-start marker, that a fresh connection is refused or a fresh request is explicitly rejected, and that the first client and stop command remain pending. Release the upstream gate. Require the first client to finish with the expected complete HTML and verify the cleanup-finished marker, 143 and `OOMKilled=false`. Container runtime errors or forced SIGKILL fail. Record timestamps and the exact image/entrypoint. Persist the coordinator's image-bound proof only after the drill passes.
3. On the isolated application pair, put a test TLS proxy before restored OpenCloud. Match and gate the first upstream PUT for a new synthetic capture audio file. Forward every other request normally. Preserve method, URL, Authorization and response status/body. The proxy emits only synthetic phase names and counts. Start the exact deployed API entry point with its test-only scoped Vault token, PostgreSQL and auth environment. Create a disposable capture through its authenticated route using the isolated Owner session, then PUT its audio. Wait for the proxy gate to confirm the API admitted the write. Begin `docker stop -t 900 <test-api-container>`, bypassing the gateway only for this internal stop probe. Verify new direct requests get a shutdown 503 or a refused connection and a second write does not reach Vault. Confirm the original client and stop remain pending. Release the gate, require full client success and the current-run API drain marker plus exit 0. Compare the ledger and read back the bytes with the isolated API restarted before stopping Vault. Repeat with a new fixture and a disconnected first client, expecting the admitted mutation to settle and the ledger to remain consistent. Use no new live credential. This observes Docker PID 1/Bun delivery and actual storage writes.
4. Signal Caddy asynchronously. Observe its current-run shutdown marker and confirm fresh TCP connections to port 3000 are refused inside the gateway network namespace. Docker’s host-side published port can still accept a TCP handshake after the container listener closes. Keep Caddy’s stop pending while stopping Next. Verify Next cleanup and keep API available to complete admitted server renders. Then stop and verify API and separate writers. API shutdown closes the To-Do SSE streams that [Keep Caddy](../../../Caddyfile) proxies directly. Await clean gateway exit before stopping Vault. A blocking Caddy stop with active SSE can exhaust Docker’s deadline because Caddy’s default HTTP grace period is unbounded. Require current-run evidence and restore service state if any step fails. [Caddy grace period](https://caddyserver.com/docs/caddyfile/options#grace-period).
5. With Quantself drained, close the Vault Caddy listener on loopback 9201. Require a clean bounded exit and two empty unfiltered OpenCloud upload-session checks before stopping OpenCloud. A client can receive 502 while its upload session remains. A pending session blocks Vault stop and capture. Reopen ingress and reconcile the session. Resume OpenCloud first, then Vault Caddy, then Quantself. Verify canonical HTTPS access after resuming. [Vault shutdown evidence](vault-drain-proof.json).

### Next deferred-request reproduction

Run `python3 scripts/infra/keep-storage/prove-runtime-drain.py` where the verified image is already loaded and scratch space is approved. The harness runs an ungated control followed by the SIGTERM test. Each uses a separate Docker internal network and three disposable containers with unique `keep254-drain-*` names. It publishes no ports, mounts no host volumes and accepts no live secrets. The fixture holds `/api/owner-setup/state` before the actual Next inventory page renders. Release the gate only after the new connection is refused and the stop and first request remain pending. The harness requires a new inventory render API call after gate release, full HTML, the cleanup-complete marker and exit 143. It removes only its own containers and network. Preserve the sanitized proof output and keep it scoped to Next with the synthetic upstream.

After the fixture passes, install the coordinator's image-bound proof using its reviewed procedure. Its runtime needs the web container's `DEBUG=next:start-server` cleanup marker. Any service recreation to enable that environment variable needs the scoped maintenance plan. The candidate image from CI run 43565134284 passed on quantself with `--api-sse`, `--api-media` and the pinned Caddy configuration. The API ran with isolated PostgreSQL, synthetic credentials, a table-lock gate and a synthetic TLS media upstream. It completed the admitted capture, closed the retained SSE stream and exited cleanly after the abandoned SSE and partial WAV client resets. The separate pinned Vault gateway fixture completed an admitted 233,472-byte PUT and read back the exact bytes in 103 ms after reopening canonical HTTPS. A separate quiescent OpenCloud stop preserved exact bytes after restart. The live private Serve route now forwards to the Vault gateway on loopback 9201. The first coordinated backup and its manual PBS and B2 application recovery completed. [Pair evidence](first-pair-proof.json). [Runtime drain proof](runtime-drain-proof.json), [Vault proof](vault-drain-proof.json).

## Failure and missed-heartbeat acceptance

Healthchecks recorded the synthetic terminal failure, missed heartbeat and growth threshold breach. Proton received all three alerts and both recovery notices after rearming from the same verified pair. [Alert delivery evidence](alert-test-proof.json).

If the coordinator reports an unknown outcome, inspect its private durable journal and the original guest worker units, and check the original PBS task and snapshot identity. Resume observation of the same attempt with the coordinator's recovery command. A missing transient unit after a reboot does not prove the original command never ran. If completion cannot be established, leave the point unpublished, reconcile all originally running services and health under Owner review, and preserve evidence before allowing a new run. Any manual state changes must be scoped to the same point.

Use an Owner-approved independent test destination and test IDs separate from nightly production monitoring. Authorize a test notification before sending.

- Trigger a controlled failure after successful drain and before the second upload commits, using only a synthetic coordinator run. Verify nonzero result, failure delivery and timestamps, restart of originally running services, health and original read, lock/staging disposition, and no new complete manifest or success heartbeat. Retry using a new valid run and verify a single successful complete point. Separately simulate failed drain and confirm capture/upload were never reached.
- For missed-heartbeat, register a short test interval/grace on an independently hosted monitor. Seed one successful test heartbeat, suppress the next entirely and keep the coordinator unavailable for that interval. Require the monitor itself to alert, then verify recovery after the next complete pair. Record schedule/time zone, grace, actual elapsed delay and receipt/recovery timestamps. A failure webhook alone cannot prove detection of a powered-off Keep.
- Establish the separate nightly PostgreSQL restore drill below. Confirm measured cloud retained growth and thin-pool reserve before scheduling.

## Nightly PostgreSQL restore drill on Keep

[ADR 0045](../../adr/0045-self-hosted-home-infrastructure.md) calls for restoring the latest Quantself VM backup nightly into a throwaway 1.5 GB VM with no network, starting PostgreSQL alone, checking it answers, then deleting the VM. It requires one manual full restore before relying on backups. The PostgreSQL restore drill is implemented and installed with a separate Healthchecks check. The manual no-NIC rehearsal passed and VM 2544 and its two volumes were removed. The backup and restore timers are enabled for 03:00 and 04:30 America/Halifax. The requested immediate backup completed at 17:57:32 UTC as `20261114T175509Z-a9414550a6bf`. B2 stored 726,279,580 bytes against the 10,000,000,000-byte target, with no unfinished uploads. The PostgreSQL restore service verified the same pair, removed VM 2544
and its volumes, and reported success to Healthchecks. [Nightly evidence](nightly-proof.json).

1. After the manual full restore passes, reserve **proposed VM 2544 `quantself-db-restore-254`**, 1 vCPU, 1536 MiB RAM and the exact reviewed system-disk size on Keep’s encrypted `local-lvm`. Confirm the ID is unused. Obtain named approval for creation and initialization of that virtual disk and, separately, the exact recurring cleanup scope. Confirm recurring deletion authorization before enabling the timer. Until then, one approved manual run may retain its stopped VM for review. A subsequent run must refuse an occupied ID. [Geometry and physical reserve](backup-operations.md#review-a-changed-system-disk-size)
2. Trigger after the coordinated nightly job completes. Under a single lock, verify a fresh complete manifest, exact Quantself PBS snapshot identity, encryption fingerprint, thin-pool and memory headroom, and the existing VM and backup inventories. Reject a stale point or a snapshot outside VM group 2541. Use a deterministic restore job and durable journal. If the original job’s result is unknown, observe it before further action.
3. Restore only the admitted snapshot via `pvesh create /nodes/keep/qemu --archive <verified PBS volume ID> --vmid 2544 --storage local-lvm --unique 1 --start 0 --onboot 0 --autostart 0`. On Keep, the CLI runs synchronously and can emit progress before the final UPID. The drill records intent before invocation, waits for the command without a short client timeout, then records the single matching UPID and verifies terminal success. Missing or ambiguous output requires reconciliation before retry. Verify new disk ownership, zero passthrough and zero shared mounts, delete all cloned NIC definitions before boot, and set 1536 MiB RAM. Use the manually rehearsed zero-NIC PBS boot path above. Keep zero NICs throughout the drill and fail it if the hardware or container state differs.
4. Through the guest agent verify only restored PostgreSQL is running. Mask restored Tailscale and scheduling units while the VM remains disconnected. Require `pg_isready` and an authenticated `psql -XAt -v ON_ERROR_STOP=1` query that returns `1` from `SELECT 1`, plus a read-only application schema check. Shut down the VM and record the restore ID, snapshot ID, query outcomes, timestamps and allocated bytes.
5. Before authorized cleanup, compare the stopped VM’s ID, created disk identifiers and run marker to its journal. Delete only that exact throwaway VM and its owned disks. Keep the PBS source snapshot. Report success only after the database checks and approved cleanup succeed. On failed or uncertain cleanup, preserve the stopped VM and fail future runs closed until reconciled. Use the separate Healthchecks check for failure and missed restore alerts. Exercise the notification path and a successful nightly run before marking this gate passed.

Record per source the restore-point ID, image/schema, snapshot IDs, encryption/key provenance, capacity delta, wall time, query/ledger/inventory comparisons, browser and authorization checks, restart/rotation and drill alert results. Keep credentials, manifests, private filenames, hashes of private files and private raw logs in encrypted evidence storage. Stop both restore VMs and close Owner forwards after review. Request separate named approval before deleting the restore VMs/disks, temporary PBS alias/key material, network namespace or cloud fixtures. Never remove the independent recovery copies. Keep #254 open until live acceptance passes.
