# Synthetic backup metadata comparison

Research proof only. These scripts are **not deployed backup commands** and must
never target live files or a live repository. They create disposable fixtures and
local encrypted repositories inside a network-disabled Linux container.

Both paths verify contents, xattrs, modes, numeric owners, mtimes, links and sparse
restoration, then measure total repository growth on unchanged and 64 KiB-changed
snapshots. Kopia needs a GNU tar payload for metadata; restic backs up the tree
directly. Results and limits: `docs/infra/keep-storage/backup-metadata-proof.json`.

Verified release archives, from the vendors' GitHub release checksum files:

| Archive | SHA-256 |
| --- | --- |
| kopia-0.23.1-linux-arm64.tar.gz | a4ffbc019e0b0f932e2632054e73ec521dc1e80172a00095369c53ecf4e5a6cb |
| kopia-0.23.1-linux-x64.tar.gz | 416d0f84a3dbb321a8b2d8f0997b1a0a6e915babe79ee76fa6e4d2bd1e1c5178 |
| restic_0.19.1_linux_arm64.bz2 | a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465 |
| restic_0.19.1_linux_amd64.bz2 | f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c |

Run with Python 3.11+, GNU tar, root inside the disposable container, CHOWN,
DAC_OVERRIDE and FOWNER capabilities, read-only root filesystem, 512 MiB memory,
384 MiB tmpfs `/tmp`, and no network. Mount the repository's `scripts` directory
at `/scripts` read-only.
For Kopia mount the verified binary at `/kopia/kopia` and set
`KOPIA_BINARY=/kopia/kopia`; execute `/scripts/integration/backup-metadata/prove-kopia.py`.
For restic mount the verified binary at `/restic/restic`; execute
`/scripts/integration/backup-metadata/prove-restic.py`. The restic proof uses the
same independent inventory verifier intended for the actual recovery drill.
Set `HOME=/tmp` and `PYTHONDONTWRITEBYTECODE=1`. No host credential directories are
mounted. The hardcoded repository passwords protect synthetic data only.

The first Kopia test accidentally selected archive export by restoring to a
`.tar` target; corrected to restore the actual payload to a suffix-free target.
GNU sparse headers also prevented byte-identical rebuilt archives; the final
proof measures that behavior instead of assuming deterministic byte output.
