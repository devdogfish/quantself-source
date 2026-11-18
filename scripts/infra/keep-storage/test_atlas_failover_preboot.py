import hashlib
import json
from pathlib import Path
import stat
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from atlas_failover_preboot import BackupError, verify_pair
from backup_guest import GIB, snapshot_digest


STORAGE = "atlas-recovery"
MOUNT = Path("/mnt/atlas-recovery")
UUID = "a1111111-b222-c333-d444-e55555555555"


class AtlasPrebootTest(unittest.TestCase):
    def setUp(self):
        self.records = {}
        self.responses = {("/cluster/ha/resources",): []}
        self.paths = {}
        self.directories = {}
        for vmid, role in ((901, "records"), (902, "originals")):
            genid = f"11111111-1111-4111-8111-{vmid:012d}"
            smbios = f"22222222-2222-4222-8222-{vmid:012d}"
            upid = f"UPID:atlas:00000001:00000002:00000003:qmrestore:{vmid}:root@pam:"
            volume = f"{STORAGE}:{vmid}/vm-{vmid}-disk-0.raw"
            disks = {"scsi0": volume}
            config = {"boot": "order=scsi0", "onboot": 0, "autostart": 0,
                      "scsi0": f"{volume},size=52G", "vmgenid": genid, "smbios1": f"uuid={smbios}"}
            if role == "originals":
                disks["ide2"] = f"{STORAGE}:{vmid}/vm-{vmid}-cloudinit.raw"
                config["ide2"] = disks["ide2"] + ",media=cdrom,size=4M"
            self.records[role] = {"vmid": vmid, "upid": upid, "disks": disks,
                                  "clone_identity": {"vmgenid": genid, "smbios_uuid": smbios}}
            root = f"/nodes/atlas/qemu/{vmid}"
            self.responses[(f"{root}/config", "--current", "1")] = config
            self.responses[(f"{root}/pending",)] = []
            self.responses[(f"{root}/status/current",)] = {"status": "stopped", "vmid": vmid}
            self.responses[(f"/nodes/atlas/tasks/{upid}/status",)] = {
                "upid": upid, "node": "atlas", "type": "qmrestore", "id": str(vmid),
                "status": "stopped", "exitstatus": "OK",
            }
            directory = MOUNT / "images" / str(vmid)
            self.paths[directory] = SimpleNamespace(st_dev=42, st_mode=stat.S_IFDIR)
            self.directories[directory] = [directory / vol.split("/", 1)[1] for vol in disks.values()]
            for image in self.directories[directory]:
                self.paths[image] = SimpleNamespace(st_dev=42, st_mode=stat.S_IFREG, st_nlink=1,
                                                    st_size=52 * GIB if "disk-" in image.name else 4 * 1024 ** 2)

        self.command = self.enterContext(patch("atlas_failover_preboot.command", side_effect=self.fixture_command))
        self.destination = self.enterContext(patch("atlas_failover_preboot.verify_destination", return_value=42))
        self.enterContext(patch("atlas_failover_preboot.Path.lstat", autospec=True, side_effect=self.paths.__getitem__))
        self.enterContext(patch("atlas_failover_preboot.Path.iterdir", autospec=True, side_effect=self.directories.__getitem__))
        self.config = self.responses[("/nodes/atlas/qemu/902/config", "--current", "1")]

    def fixture_command(self, executable, method, *args, timeout):
        self.assertEqual((executable, method, timeout), ("pvesh", "get", 15))
        self.assertEqual(args[-2:], ("--output-format", "json"))
        return json.dumps(self.responses[args[:-2]])

    def check(self):
        return verify_pair(STORAGE, MOUNT, UUID, self.records)

    def test_both_exact_clones_pass_using_only_scoped_gets(self):
        self.assertEqual(self.check(), {
            "status": "preboot_verified", "storage": STORAGE, "guests": {"records": 901, "originals": 902},
        })
        self.destination.assert_called_once_with(STORAGE, MOUNT, UUID)
        self.assertCountEqual([call.args[2:-2] for call in self.command.call_args_list], self.responses)

    def test_nic_autostart_and_passthrough_are_refused_on_the_second_clone(self):
        original = self.config.copy()
        for change in ({"net0": "virtio,bridge=vmbr0"}, {"onboot": 1}, {"autostart": 1},
                       {"hostpci0": "00:02.0"}, {"serial0": "/dev/ttyS0"}, {"virtiofs0": "work"}):
            with self.subTest(change=change):
                self.config.update(change)
                with self.assertRaisesRegex(BackupError, "no NIC"):
                    self.check()
                self.config.clear()
                self.config.update(original)

    def test_pending_ha_or_running_state_is_refused(self):
        for path, value in (
            (("/nodes/atlas/qemu/902/pending",), [{"key": "net0", "pending": "virtio,bridge=vmbr0"}]),
            (("/nodes/atlas/qemu/902/pending",), [{"key": "net0", "delete": 1}]),
            (("/cluster/ha/resources",), [{"sid": "vm:902", "state": "disabled"}]),
            (("/nodes/atlas/qemu/902/status/current",), {"status": "running", "vmid": 902}),
        ):
            with self.subTest(path=path):
                original = self.responses[path]
                self.responses[path] = value
                with self.assertRaises(BackupError):
                    self.check()
                self.responses[path] = original

    def test_wrong_clone_or_wrong_restore_task_is_refused(self):
        original = self.config["vmgenid"]
        self.config["vmgenid"] = self.records["records"]["clone_identity"]["vmgenid"]
        with self.assertRaisesRegex(BackupError, "UUIDs differ"):
            self.check()
        self.config["vmgenid"] = original
        task = self.responses[(f"/nodes/atlas/tasks/{self.records['originals']['upid']}/status",)]
        task["exitstatus"] = "ERROR"
        with self.assertRaisesRegex(BackupError, "did not succeed"):
            self.check()

    def test_reused_disk_and_local_hardlink_are_refused(self):
        original = self.config["scsi0"]
        self.config["scsi0"] = self.records["records"]["disks"]["scsi0"]
        with self.assertRaisesRegex(BackupError, "recorded raw volume"):
            self.check()
        self.config["scsi0"] = original + ",file=/dev/source"
        with self.assertRaisesRegex(BackupError, "unsupported option"):
            self.check()
        self.config["scsi0"] = original
        directory = MOUNT / "images" / "902"
        self.paths[self.directories[directory][0]].st_nlink = 2
        with self.assertRaisesRegex(BackupError, "linked or outside"):
            self.check()

    def test_wrong_filesystem_blocks_guest_reads(self):
        self.destination.side_effect = BackupError("wrong LUKS mapping")
        with self.assertRaisesRegex(BackupError, "wrong LUKS"):
            self.check()
        self.command.assert_not_called()

    def test_whole_image_evidence_binds_raw_length_and_contents(self):
        raw = b"source-image" + bytes(40)
        self.records["records"].update(system_disk_gib=52, system_disk_sha256=hashlib.sha256(raw).hexdigest())
        image = self.directories[MOUNT / "images" / "901"][0]
        fixture = Path(self.enterContext(TemporaryDirectory())) / "fixture.raw"
        fixture.write_bytes(raw)
        # Model 1 GiB as one byte while reading the entire raw fixture.
        self.paths[image].st_size = len(raw) - 1
        with (patch("atlas_failover_preboot.GIB", 1),
              patch("atlas_failover_preboot.snapshot_digest", side_effect=lambda _: snapshot_digest(fixture)) as digest):
            with self.assertRaisesRegex(BackupError, "geometry"):
                self.check()
            digest.assert_not_called()
            self.paths[image].st_size = len(raw)
            self.assertEqual(self.check()["whole_image_verified"], ["records"])
            digest.assert_called_once_with(image)
            fixture.write_bytes(b"S" + raw[1:])
            with self.assertRaisesRegex(BackupError, "differs from the verified PBS image"):
                self.check()

    def test_partial_or_malformed_whole_image_evidence_is_refused(self):
        record = self.records["records"]
        record["system_disk_gib"] = 52
        with self.assertRaisesRegex(BackupError, "Invalid recorded system disk evidence"):
            self.check()
        record.update(system_disk_sha256="a" * 64, system_disk_gib=True)
        with self.assertRaisesRegex(BackupError, "Invalid recorded system disk evidence"):
            self.check()
