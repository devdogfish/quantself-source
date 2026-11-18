# Independent recovery inventory

`scripts/infra/keep-storage/backup_inventory.py` captures or verifies a frozen
Linux filesystem tree. It compares SHA-256 contents, paths, sizes, numeric owners,
modes, nanosecond mtimes, symlink targets, hardlink relationships and SHA-256 of
every readable extended attribute. OpenCloud file/space IDs and ACLs stored in
xattrs are therefore checked without writing their raw values into the inventory.

Run as root on the stopped/frozen source, then as root against the isolated
restored tree. A live tree is not a supported consistency boundary. The tool
detects changes during individual reads, but cannot establish an atomic snapshot
across the whole tree; the backup coordinator must establish that boundary first.
Nested filesystems, special files and hardlinks crossing the root boundary fail
closed. Verify each separately captured filesystem, retaining all linked files
in the same tree.

Example on a **disposable synthetic tree**, with the script installed locally:

```sh
python3 backup_inventory.py capture /tmp/synthetic-source /tmp/inventory.json
python3 backup_inventory.py verify /tmp/synthetic-restored /tmp/inventory.json
```

The inventory must be outside the scanned tree. Capture writes mode 0600,
publishes atomically and refuses to overwrite an existing file. The inventory
contains sensitive filenames and hashes: include it in the encrypted recovery
set, never git, issue comments or agent output. Console results contain only the
action/count; failures omit filenames and attribute values. Verify against the
inventory captured **before** backup, not one regenerated from the restored data.

This verifies filesystem recovery, not database/application semantics, sparse
allocation efficiency, cloud deletion permissions or cross-VM consistency.
Receipt rendering, audio seeking, database relations and application access
denials remain separate acceptance gates.

Validation: 12 isolated Linux fixture tests cover successful `cp -a` recovery,
same-size content corruption with preserved mtime, xattr/permission/link changes,
extra files, special-file rejection and inventory safety. The native restic
0.19.1 synthetic backup/restore also passed this verifier, including numeric
ownership, hardlinks and a separately checked sparse file. These are local
synthetic checks, not a live Keep recovery claim.
