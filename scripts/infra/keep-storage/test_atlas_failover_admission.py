import json
import os
from pathlib import Path
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from atlas_failover_admission import BackupError, GIB, admit


MOUNT = Path("/mnt/atlas-recovery")
UUID = "a1111111-b222-c333-d444-e55555555555"
STORAGE = "atlas-recovery"


class AtlasFailoverAdmissionTest(unittest.TestCase):
    def setUp(self):
        self.config = {
            "storage": STORAGE, "type": "dir", "path": str(MOUNT), "nodes": "atlas",
            "content": "images", "is_mountpoint": "1",
        }
        self.mount = {
            "target": str(MOUNT), "source": "/dev/mapper/recovery", "fstype": "ext4",
            "fsroot": "/", "options": "rw,nosuid,nodev", "maj:min": "253:42",
        }
        self.mounts = [self.mount]
        self.partition = {
            "type": "part", "fstype": "crypto_LUKS", "uuid": UUID,
            "children": [{"type": "disk", "maj:min": "259:0"}],
        }
        self.crypt = {"type": "crypt", "maj:min": "253:42", "children": [self.partition]}
        self.directory = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0, st_dev=os.makedev(253, 42))
        self.paths = dict.fromkeys((MOUNT, MOUNT / "images", MOUNT / "scratch"), self.directory)
        self.mapper_uuid = f"CRYPT-LUKS2-{UUID.replace('-', '')}-recovery\n"
        self.space = SimpleNamespace(f_bavail=182 * GIB // 4096, f_frsize=4096, f_bfree=600 * GIB // 4096)
        self.enterContext(patch("atlas_failover_admission.socket.gethostname", return_value="atlas"))
        self.disk_path = Path("/sys/devices/pci0000:00/nvme/nvme0/nvme0n1")
        self.enterContext(patch("atlas_failover_admission.Path.resolve", autospec=True, side_effect=self.fixture_resolve))
        self.enterContext(patch("atlas_failover_admission.Path.stat", return_value=self.directory))
        self.enterContext(patch("atlas_failover_admission.Path.lstat", autospec=True, side_effect=self.fixture_lstat))
        self.sysfs = self.enterContext(patch(
            "atlas_failover_admission.Path.read_text", autospec=True, side_effect=lambda path: self.mapper_uuid,
        ))
        self.statvfs = self.enterContext(patch("atlas_failover_admission.os.statvfs", return_value=self.space))
        self.get = self.enterContext(patch("atlas_failover_admission.command", side_effect=self.fixture_command))

    def fixture_command(self, *args):
        if args == ("pvesh", "get", f"/storage/{STORAGE}", "--output-format", "json"):
            return json.dumps(self.config)
        if args == ("findmnt", "--kernel", "--json", "--list", "--output", "TARGET,SOURCE,FSTYPE,FSROOT,OPTIONS,MAJ:MIN"):
            return json.dumps({"filesystems": self.mounts})
        if args == ("lsblk", "--inverse", "--json", "--tree", "--output", "NAME,TYPE,FSTYPE,UUID,MAJ:MIN",
                    "--", self.mount["source"]):
            return json.dumps({"blockdevices": [self.crypt]})
        self.fail(f"Unexpected command: {args}")

    def fixture_lstat(self, path):
        if path not in self.paths:
            raise FileNotFoundError
        return self.paths[path]

    def fixture_resolve(self, path, *, strict):
        self.assertTrue(strict)
        if path == MOUNT:
            return MOUNT
        self.assertEqual(path, Path("/sys/dev/block/259:0"))
        return self.disk_path

    def admit(self):
        return admit(STORAGE, MOUNT, UUID, records_vmid=901, originals_vmid=902,
                     records_gib=52, originals_gib=80, scratch_gib=30, reserve_gib=20)

    def test_exact_encrypted_destination_covers_both_guests_scratch_and_reserve(self):
        self.assertEqual(self.admit(), {
            "status": "destination_admitted", "storage": STORAGE, "mount": str(MOUNT),
            "records_vmid": 901, "originals_vmid": 902,
            "available_bytes": 182 * GIB, "required_bytes": 182 * GIB,
        })
        self.sysfs.assert_called_once_with(Path("/sys/dev/block/253:42/dm/uuid"))
        self.statvfs.assert_called_once_with(MOUNT)
        self.assertEqual(self.get.call_count, 3)

    def test_wrong_proxmox_destination_with_ample_free_space_fails_before_mount_reads(self):
        self.config["path"] = "/var/lib/vz"
        with self.assertRaisesRegex(BackupError, "not the approved"):
            self.admit()
        self.assertEqual(self.get.call_count, 1)
        self.statvfs.assert_not_called()

    def test_wrong_encryption_uuid_or_backing_fails_with_ample_free_space(self):
        correct = self.mapper_uuid
        self.mapper_uuid = correct.replace("a111", "f999")
        with self.assertRaisesRegex(BackupError, "not mapped"):
            self.admit()
        self.mapper_uuid = correct
        self.partition["uuid"] = UUID.replace("a111", "f999")
        with self.assertRaisesRegex(BackupError, "backing device differs"):
            self.admit()
        self.statvfs.assert_not_called()

    def test_encrypted_but_virtual_backing_is_refused(self):
        self.disk_path = Path("/sys/devices/virtual/block/zram0")
        with self.assertRaisesRegex(BackupError, "virtual block device"):
            self.admit()
        self.statvfs.assert_not_called()

    def test_existing_plain_directory_or_shared_mount_cannot_pass(self):
        self.mounts.clear()
        with self.assertRaisesRegex(BackupError, "own unambiguous mount"):
            self.admit()
        for alias in (
            self.mount | {"target": "/mnt/other"},
            self.mount | {"target": str(MOUNT / "scratch"), "maj:min": "8:2"},
        ):
            with self.subTest(alias=alias):
                self.mounts[:] = [self.mount, alias]
                with self.assertRaisesRegex(BackupError, "another mount or a nested mount"):
                    self.admit()
        self.statvfs.assert_not_called()

    def test_linked_images_or_nonprivate_scratch_fails(self):
        for path, mode in ((MOUNT / "images", stat.S_IFLNK | 0o777), (MOUNT / "scratch", stat.S_IFDIR | 0o755)):
            self.paths[path] = SimpleNamespace(st_mode=mode, st_uid=0, st_dev=self.directory.st_dev)
            with self.subTest(path=path), self.assertRaises(BackupError):
                self.admit()
            self.paths[path] = self.directory
        self.statvfs.assert_not_called()

    def test_existing_image_path_for_either_vmid_fails_even_if_it_is_a_dangling_link(self):
        for vmid in ("901", "902"):
            path = MOUNT / "images" / vmid
            self.paths[path] = SimpleNamespace(st_mode=stat.S_IFLNK | 0o777)
            with self.subTest(vmid=vmid), self.assertRaisesRegex(BackupError, "image path already exists"):
                self.admit()
            del self.paths[path]
        self.statvfs.assert_not_called()

    def test_nominal_space_cannot_cover_a_one_block_physical_shortfall(self):
        self.space.f_bavail -= 1
        with self.assertRaisesRegex(BackupError, "bytes available; needs"):
            self.admit()
