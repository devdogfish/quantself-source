#!/usr/bin/env python3
"""Offline restore test for the proposed Roundcube disk layout, using synthetic data only."""

from base64 import b64encode
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

PACKAGE = Path(__file__).resolve().parent
SCRIPTS = PACKAGE.parents[2]
sys.path.insert(0, str(SCRIPTS / "infra/keep-storage"))
from backup_inventory import InventoryError, verify_inventory, write_inventory

CONFIG_TREE = Path("opt/quantself-roundcube")
RUNTIME_TREE = Path("run/quantself-roundcube")
CONFIG = Path("config/quantself-original.inc.php")
PLUGIN = Path("plugins/quantself_original")
EXPECTED_FILES = {
    CONFIG,
    *(PLUGIN / name for name in ("quantself_original.php", "bounded_imap.php", "mailbox.php", "verify.php")),
}
CANARIES = {
    Path("sessions/fixture"): b"ROUND-CUBE-FIXTURE-SESSION",
    Path("db/roundcube.sqlite"): b"ROUND-CUBE-FIXTURE-SESSION-DB",
    Path("temp/message.eml"): b"ROUND-CUBE-FIXTURE-TRANSIENT-MESSAGE",
    Path("spool/part.bin"): b"ROUND-CUBE-FIXTURE-PRIVATE-SPOOL",
    Path("log/access.log"): b"ROUND-CUBE-FIXTURE-MESSAGE-LOG",
    Path("credentials/runtime"): b"ROUND-CUBE-FIXTURE-CREDENTIAL-MARKER",
}


def reviewed_tree(tree):
    subprocess.run(["bash", str(PACKAGE / "stage.sh"), str(tree)], check=True)
    template = tree / CONFIG.with_suffix(".php.example")
    public_fixture = b64encode(bytes(range(32))).decode("ascii")
    (tree / CONFIG).write_text(
        template.read_text().replace(
            "$jobsImapHost = 'replace.invalid';", "$jobsImapHost = 'imap.example.test';"
        ).replace(
            "'audience' => 'replace.invalid'", "'audience' => 'roundcube.example.test'"
        ).replace(
            "replace@replace.invalid", "jobs@example.test"
        ).replace(
            "'public_key_base64' => ''", f"'public_key_base64' => '{public_fixture}'"
        ).replace(
            "/run/quantself-original-spool", "/run/quantself-roundcube/spool"
        )
    )
    template.unlink()
    files = {path.relative_to(tree) for path in tree.rglob("*") if path.is_file()}
    if files != EXPECTED_FILES:
        raise RuntimeError("Staged package or reviewed configuration set changed")


def archive_restore(backed_disk, work, name):
    archive = work / f"{name}.tar"
    subprocess.run(
        ["bash", str(SCRIPTS / "integration/backup-metadata/archive-tree.sh"), str(backed_disk), str(archive)],
        check=True, stdout=subprocess.DEVNULL,
    )
    restored = work / name
    restored.mkdir()
    # The fixture's tmpfs has no ACL support. Its inventory compares files, modes,
    # owners, timestamps and xattrs without relying on ACL restoration.
    subprocess.run(
        ["tar", "--extract", f"--file={archive}", f"--directory={restored}",
         "--same-owner", "--same-permissions", "--no-acls", "--xattrs", "--xattrs-include=*"],
        check=True,
    )
    return restored


def audit_fixture_restore(restored, inventory):
    verified = verify_inventory(restored / CONFIG_TREE, inventory)
    runtime = restored / RUNTIME_TREE
    if runtime.is_symlink() or not runtime.is_dir() or any(runtime.iterdir()):
        raise InventoryError("Expected an empty runtime mountpoint on the restored disk")
    # The root in this test is wholly synthetic. For a real disconnected restore,
    # check only the independently documented fixture-canary locations.
    for path in restored.rglob("*"):
        if not path.is_symlink() and path.is_file():
            data = path.read_bytes()
            if any(marker in data for marker in CANARIES.values()):
                raise InventoryError("Synthetic runtime marker survived on the backed disk")
    return len(verified["entries"])


def expect_rejected(restored, inventory, reason):
    try:
        audit_fixture_restore(restored, inventory)
    except InventoryError as error:
        if str(error) != reason:
            raise
    else:
        raise RuntimeError(f"Restore unexpectedly passed: {reason}")


def main():
    with tempfile.TemporaryDirectory(prefix="roundcube-config-proof-") as temporary:
        work = Path(temporary)
        reviewed = work / "reviewed"
        reviewed_tree(reviewed)
        inventory = work / "reviewed.inventory.json"
        write_inventory(reviewed, inventory)

        backed_disk = work / "backed-disk"
        shutil.copytree(reviewed, backed_disk / CONFIG_TREE)
        (backed_disk / RUNTIME_TREE).mkdir(parents=True)
        (backed_disk / "etc").mkdir()
        (backed_disk / "etc/fixture-release").write_text("synthetic Atlas apps root disk\n")

        # Model the separate guest runtime mount at /run/quantself-roundcube.
        # Archive the backing disk tree, without a path exclusion filter.
        runtime = work / "excluded-runtime"
        for path, marker in CANARIES.items():
            target = runtime / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(marker)
            if target.read_bytes() != marker:
                raise RuntimeError("Synthetic runtime input was not populated")
        restored = archive_restore(backed_disk, work, "restore-ok")
        entries = audit_fixture_restore(restored, inventory)
        print(f"PASS reviewed config and four plugin files restored ({entries} inventory entries)")
        print(f"PASS {len(CANARIES)} runtime markers excluded from restored backing disk")

        misplaced = backed_disk / "var/lib/roundcube-misplaced"
        shutil.copytree(runtime, misplaced)
        leaked = archive_restore(backed_disk, work, "restore-leak")
        for path, marker in CANARIES.items():
            if (leaked / "var/lib/roundcube-misplaced" / path).read_bytes() != marker:
                raise RuntimeError("Negative control did not persist all its markers")
        expect_rejected(leaked, inventory, "Synthetic runtime marker survived on the backed disk")
        print("PASS restore with misplaced runtime data rejected")

        (restored / RUNTIME_TREE / "unexpected").touch()
        expect_rejected(restored, inventory, "Expected an empty runtime mountpoint on the restored disk")
        (restored / RUNTIME_TREE / "unexpected").unlink()
        print("PASS nonempty backed mountpoint rejected")

        installed = restored / CONFIG_TREE
        plugin = installed / PLUGIN / "bounded_imap.php"
        plugin.write_bytes(plugin.read_bytes() + b"\n")
        expect_rejected(restored, inventory, "Restored contents or filesystem metadata differ")
        shutil.copy2(reviewed / PLUGIN / "bounded_imap.php", plugin)
        audit_fixture_restore(restored, inventory)
        (installed / CONFIG).unlink()
        expect_rejected(restored, inventory, "Restored contents or filesystem metadata differ")
        print("PASS altered plugin and missing reviewed config rejected independently")


if __name__ == "__main__":
    main()
