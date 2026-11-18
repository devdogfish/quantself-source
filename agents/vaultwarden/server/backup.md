# Vaultwarden backup and recovery

Before live credential handoff, check both the encrypted PBS VM snapshot and
the encrypted Vaultwarden data snapshot in B2 using only a synthetic vault.
Use a fixture with one known item and an attachment with known bytes. Keep
the restore receipt with the #376 evidence. Follow the [Keep offsite
policy](../../../docs/infra/keep-storage/offsite.md) for repository permissions,
recovery material and retention.

Keep the backup and restore steps in the private #376 operation journal.
Record each intent and exact target before dispatch. Record the returned task
or snapshot ID immediately and keep the original output. After an interrupted
or ambiguous reply, reconcile that operation before retrying. Exclude
credential values and vault contents from the journal.

## Synthetic fixture receipt

Create a disposable secure note and upload an attachment with known bytes.
Record their item and attachment IDs and the SHA-256 of the original plaintext
attachment through the trusted Owner session. On a stopped data copy, capture
the fixture receipt outside the vault directory. From the repository root:

```sh
python3 -I agents/vaultwarden/server/restore-proof.py capture \
  "$SOURCE_DATA" "$ITEM_ID" "$ATTACHMENT_ID" "$PRIVATE_RECEIPT"
```

Retain the receipt separately from the snapshot under test. Run the same check
against the cold data from each restore before starting Vaultwarden:

```sh
python3 -I agents/vaultwarden/server/restore-proof.py verify \
  "$RESTORED_DATA" "$PRIVATE_RECEIPT"
```

The verifier checks SQLite integrity with WAL enabled, the encrypted item and
attachment record, the attachment bytes, the signing key and file permissions.
Keep the receipt private. To complete the app check, unlock the isolated
synthetic vault, read the note, download the attachment and compare its
plaintext SHA-256 with the one recorded before backup.

## Encrypted PBS

Use the existing encrypted Keep PBS storage `backup` for VM 2549. Verify its
client encryption fingerprint. Record the node, VMID, storage and dispatch
time before backup, then capture the `vzdump` UPID and exact snapshot ID.
Read the configuration through `backup-restore-254`. Before restoring, record
the exact PBS volume, approved clone VMID, target storage and planned network
isolation. Capture the `qmrestore` UPID and verify the task ended with
`exitstatus=OK`. On a lost response, match the original task in Keep's task
history and reconcile the snapshot or clone configuration and disk ownership
before retrying. Use the [Keep restore runbook](../../../docs/infra/keep-storage/restore-runbook.md)
for the Proxmox task status and disconnected restore procedure.

Confirm the approved restored guest has autostart disabled and no NIC before
boot. Through the guest agent, check SQLite integrity,
start the pinned Vaultwarden image on loopback and verify the fixture item
and attachment. Record the snapshot and app results before cleaning up the
restore guest under its own approval. Include VM 2549 in nightly encrypted
PBS after the drill passes.

## Encrypted B2

The Owner provisions a prefix-scoped application key for `vaultwarden/` in
the existing Canada East bucket and a separate restic repository password.
Use root-only files on the guest and an independently retained Owner recovery
copy. Verify the scope and use the [pinned restic release](../../../scripts/infra/keep-storage/restic-release.json).
Keep credential values and file contents out of the issue and logs.

Stop Vaultwarden for the local capture and copy the complete
`/var/lib/vaultwarden` data directory into a private staging directory on
Keep's encrypted disk. Include any SQLite WAL and the attachments and keys.
Restart Vaultwarden and check its loopback health before uploading. This
keeps the database and attachments from the same capture and limits service
downtime to the local copy. Resume the app and stop the backup if capture
fails. See the [Vaultwarden backup guidance](https://github.com/dani-garcia/vaultwarden/wiki/Backing-up-your-vault).

From that staging directory, back up the copied `data` directory with
`restic --no-cache backup --json --tag vaultwarden data` using the approved
private repository settings. Before upload, record the repository ID, staging
path, capture manifest and digest, dispatch time and the existing matching
snapshot IDs. Record the full new snapshot ID from the upload result. If the
upload outcome is uncertain, first determine whether the original uploader
is still running, then reconcile newly listed snapshots against the staged
capture using the independent reader. Retain staging while the outcome is
uncertain. Before restoring, record the snapshot ID and exact empty restore
directory. Restore that exact snapshot using the independent recovery
credentials and `restic restore SNAPSHOT_ID --target RESTORE_DIR --verify`.
If restore is interrupted, retain the directory and original output until the
restore result is reconciled.
Check SQLite integrity and the synthetic item, attachment bytes and
permissions in the restored copy. Keep PBS and B2 snapshot IDs with their
verification results. For scheduled runs, retain the job identifier, expected
run time, first unattended run result, snapshot ID and verification evidence.
The commands here are the manual rehearsal. Unattended retries need a durable
helper that records intent and results across process restarts and reconciles
an unfinished capture or upload before starting another. The fixture verifier
checks restored data and does not manage those operations.
