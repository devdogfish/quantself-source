"""Synthetic recovery checks; no network, secrets or live data."""

import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("inventory", Path(__file__).with_name("backup_inventory.py"))
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


class RecoveryInventoryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.tree = self.base / "source"
        self.tree.mkdir()
        self.file = self.tree / "readable original.txt"
        self.file.write_bytes(b"original content")
        self.file.chmod(0o640)
        os.setxattr(self.file, "user.file-id", b"synthetic-file-id")
        os.setxattr(self.tree, "user.space-id", b"synthetic-space-id")
        os.link(self.file, self.tree / "second name")
        (self.tree / "outside symlink").symlink_to("/does-not-exist")
        self.manifest = self.base / "inventory.json"

    def capture(self):
        return inventory.write_inventory(self.tree, self.manifest)

    def assert_changed(self):
        with self.assertRaisesRegex(inventory.InventoryError, "differ"):
            inventory.verify_inventory(self.tree, self.manifest)

    def test_copy_restore_preserves_full_inventory(self):
        self.capture()
        restored = self.base / "restored"
        subprocess.run(["cp", "-a", str(self.tree), str(restored)], check=True)
        inventory.verify_inventory(restored, self.manifest)
        self.assertEqual(stat.S_IMODE(self.manifest.stat().st_mode), 0o600)

    def test_content_change_detected_even_with_same_size_and_mtime(self):
        self.capture()
        info = self.file.stat()
        self.file.write_bytes(b"modified content")
        os.utime(self.file, ns=(info.st_atime_ns, info.st_mtime_ns))
        self.assert_changed()

    def test_missing_xattr_detected(self):
        self.capture()
        os.removexattr(self.file, "user.file-id")
        self.assert_changed()

    def test_directory_xattr_change_detected(self):
        self.capture()
        os.setxattr(self.tree, "user.space-id", b"wrong-space-id")
        self.assert_changed()

    def test_permission_change_detected(self):
        self.capture()
        self.file.chmod(0o600)
        self.assert_changed()

    def test_lost_hardlink_detected(self):
        self.capture()
        import shutil
        link = self.tree / "second name"
        root_info = self.tree.stat()
        link.unlink()
        shutil.copy2(self.file, link)
        os.utime(self.tree, ns=(root_info.st_atime_ns, root_info.st_mtime_ns))
        self.assert_changed()

    def test_missing_or_extra_file_detected(self):
        self.capture()
        (self.tree / "extra").write_bytes(b"unexpected")
        self.assert_changed()

    def test_symlink_target_change_detected(self):
        self.capture()
        link = self.tree / "outside symlink"
        link.unlink()
        link.symlink_to("/another-target")
        self.assert_changed()

    def test_external_hardlink_rejected(self):
        os.link(self.file, self.base / "outside")
        with self.assertRaisesRegex(inventory.InventoryError, "boundary"):
            self.capture()

    def test_inventory_inside_source_rejected(self):
        with self.assertRaisesRegex(inventory.InventoryError, "outside"):
            inventory.write_inventory(self.tree, self.tree / "inventory.json")

    def test_existing_inventory_preserved(self):
        self.capture()
        before = self.manifest.read_bytes()
        with self.assertRaisesRegex(inventory.InventoryError, "overwrite"):
            self.capture()
        self.assertEqual(self.manifest.read_bytes(), before)

    def test_special_file_rejected(self):
        os.mkfifo(self.tree / "pipe")
        with self.assertRaisesRegex(inventory.InventoryError, "special"):
            self.capture()


if __name__ == "__main__":
    unittest.main()
