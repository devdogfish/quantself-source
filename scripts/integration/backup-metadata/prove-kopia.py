#!/usr/bin/env python3
"""Linux-only, isolated synthetic proof. Never point this at a live tree/repo.

Run inside a disposable network-disabled container. KOPIA_BINARY supplies the
checksum-verified binary. All fixtures, credentials and repos are synthetic.
"""
import hashlib
import json
import os
from pathlib import Path
import random
import stat
import subprocess
import tempfile


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout


def inventory(root):
    result = {}
    for path in [root] + sorted(root.rglob("*")):
        s = path.lstat()
        value = {"mode": s.st_mode, "uid": s.st_uid, "gid": s.st_gid,
                 "mtimeNs": s.st_mtime_ns,
                 "xattrs": {k: os.getxattr(path, k, follow_symlinks=False).hex()
                            for k in sorted(os.listxattr(path, follow_symlinks=False))}}
        if stat.S_ISREG(s.st_mode):
            value["sha256"] = hashlib.file_digest(path.open("rb"), "sha256").hexdigest()
            value["size"] = s.st_size
        elif path.is_symlink():
            value["link"] = os.readlink(path)
        result[str(path.relative_to(root))] = value
    return result


def main():
    with tempfile.TemporaryDirectory(prefix="archive-proof-") as tmp:
        base = Path(tmp)
        source = base / "source"
        source.mkdir(mode=0o700)
        data = source / "original.bin"
        data.write_bytes(random.Random(254).randbytes(16 * 1024 * 1024))
        data.chmod(0o640)
        os.chown(data, 1000, 1000)
        os.setxattr(data, "user.oc.fileid", b"synthetic-file-id-254")
        os.setxattr(source, "user.oc.spaceid", b"synthetic-space-id-254")
        os.link(data, source / "hardlink.bin")
        (source / "symlink").symlink_to("original.bin")
        (source / "readable name.txt").write_text("Synthetic receipt only.\n")
        sparse = source / "sparse.bin"
        with sparse.open("wb") as f:
            f.seek(64 * 1024 * 1024 - 1)
            f.write(b"\0")
        archive_script = str(Path(__file__).with_name("archive-tree.sh"))
        archive = base / "capture.tar"
        before = inventory(source)
        run(["bash", archive_script, str(source), str(archive)])
        assert before == inventory(source), "Capture modified source metadata"
        # Existing captures are immutable inputs: retries must refuse overwrite.
        assert subprocess.run(["bash", archive_script, str(source), str(archive)], capture_output=True).returncode != 0
        expected_hash = hashlib.file_digest(archive.open("rb"), "sha256").hexdigest()

        kopia = os.environ["KOPIA_BINARY"]
        env = dict(os.environ, KOPIA_PASSWORD="SYNTHETIC-LOCAL-PROOF-NO-PRIVATE-DATA")
        common = [kopia, "--config-file=" + str(base / "repository.config"),
                  "--log-dir=" + str(base / "logs")]
        repo = base / "repository"
        repo.mkdir()
        run(common + ["repository", "create", "filesystem", "--path=" + str(repo)], env=env)
        run(common + ["policy", "set", "--global", "--compression=zstd"], env=env)

        def snapshot():
            output = json.loads(run(common + ["snapshot", "create", "--json", "--force-hash=100", str(archive)], env=env))
            return output

        first = snapshot()
        first_bytes = sum(p.stat().st_size for p in repo.rglob("*") if p.is_file())
        run(common + ["snapshot", "verify", first["id"], "--verify-files-percent=100"], env=env)
        # A .tar destination selects Kopia's archive-export mode; use a plain
        # destination so this restores our tar payload rather than wrapping it.
        restored = base / "restored-archive"
        # Restore takes a file/directory object ID, not the snapshot manifest ID.
        run(common + ["snapshot", "restore", first["rootEntry"]["obj"], str(restored),
                      "--no-ignore-permission-errors"], env=env)
        assert hashlib.file_digest(restored.open("rb"), "sha256").hexdigest() == expected_hash, {
            "entry": first["rootEntry"], "expectedBytes": archive.stat().st_size,
            "restoredBytes": restored.stat().st_size, "prefix": restored.read_bytes()[:200]}
        destination = base / "restored-tree"
        destination.mkdir()
        run(["tar", "--extract", "--file=" + str(restored), "--directory=" + str(destination),
             "--numeric-owner", "--same-owner", "--same-permissions", "--acls", "--xattrs", "--xattrs-include=*"])
        assert before == inventory(destination), "Restored metadata/content differs"
        assert (destination / "original.bin").stat().st_ino == (destination / "hardlink.bin").stat().st_ino
        assert (destination / "sparse.bin").stat().st_blocks * 512 < 1024 * 1024

        # Rebuild at the same path and measure dedup. GNU sparse headers can
        # contain a process ID even with stable PAX names, so byte equality is
        # measured, not assumed. Metadata fidelity takes priority over forcing
        # an older sparse format merely to make the archives identical.
        archive.unlink()  # Only this script's synthetic fixture.
        run(["bash", archive_script, str(source), str(archive)])
        unchanged_identical = hashlib.file_digest(archive.open("rb"), "sha256").hexdigest() == expected_hash
        snapshot()
        unchanged_bytes = sum(p.stat().st_size for p in repo.rglob("*") if p.is_file())
        with data.open("r+b") as f:
            f.seek(8 * 1024 * 1024)
            f.write(random.Random(255).randbytes(64 * 1024))
        archive.unlink()
        run(["bash", archive_script, str(source), str(archive)])
        snapshot()
        changed_bytes = sum(p.stat().st_size for p in repo.rglob("*") if p.is_file())
        print(json.dumps({"syntheticOnly": True, "kopiaVersion": run([kopia, "--version"]).strip(),
                          "metadataAndContentsRestored": True, "hardlinkAndSparseRestored": True,
                          "unchangedArchiveIdentical": unchanged_identical, "existingCaptureOverwriteDenied": True,
                          "archiveBytes": archive.stat().st_size, "initialRepositoryBytes": first_bytes,
                          "unchangedSnapshotAddedBytes": unchanged_bytes - first_bytes,
                          "changed64KiBAddedBytes": changed_bytes - unchanged_bytes}, indent=2))


if __name__ == "__main__":
    main()
