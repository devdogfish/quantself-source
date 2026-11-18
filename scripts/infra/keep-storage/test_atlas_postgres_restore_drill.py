import hashlib
import io
import json
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import atlas_postgres_restore_drill as atlas
import atlas_failback_capture as capture
from backup_guest import BackupError, GIB, read_json, snapshot_digest, write_json
from backup_restore_drill import CONTAINERS, POSTGRES, Drill


@unittest.skipUnless(atlas.os.geteuid() == 0, "Private restore fixture requires root")
class AtlasRestoreTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(TemporaryDirectory())).resolve()
        self.state = self.root / "drill"
        self.capture_state = self.root / "capture"
        self.mount = self.root / "encrypted"
        self.images = self.mount / "images"
        self.images.mkdir(parents=True)
        self.directory = self.images / "901"
        self.storage = "atlas-fixture"
        self.disk = "vm-901-disk-0.raw"
        self.seed = "vm-901-cloudinit.raw"
        self.raw = b"R" * 52
        self.upid = "UPID:atlas:1111:2222:3333:qmrestore:901:root@pam:"
        self.fingerprint = ":".join(["ab"] * 32)
        self.status = "stopped"
        self.config = None
        self.pending = []
        self.events = []
        self.space = (52 + 20) * GIB + 4 * 1024 ** 2
        self.actual_raw = self.raw
        self.running_containers = POSTGRES
        self.host_node = "atlas"
        self.now = datetime.now(timezone.utc).replace(microsecond=0)
        self.restore_id = (self.now - timedelta(minutes=3)).strftime("%Y%m%dT%H%M%SZ") + "-abcdefabcdef"
        self.archive_time = (self.now - timedelta(minutes=2)).isoformat().replace("+00:00", "Z")
        pair = {"format": 1, "restore_id": self.restore_id, "completed_at": self.now.isoformat(),
                "pbs": {}, "offsite": {}}
        for role, vmid, char in (("quantself", 2541, "a"), ("files", 2540, "b")):
            pair["pbs"][role] = {
                "volid": f"backup:backup/vm/{vmid}/{self.archive_time}",
                "encryption_fingerprint": self.fingerprint,
            }
            pair["offsite"][role] = {
                "snapshot": char * 64, "repository": char * 64,
                "manifest": {"format": 1, "restore_id": self.restore_id, "role": role,
                             "inventory_sha256": char * 64,
                             "images": {"postgres": "postgres-fixture"}, "schema_migrations": ["fixture"]},
            }
        self.complete = self.root / "complete.json"
        self.policy_path = self.root / "policy.json"
        self.point_path = self.root / "point.json"
        write_json(self.complete, pair)
        self.point = {"complete": str(self.complete), "complete_sha256": self.sha(self.complete),
                      "system_disk_sha256": hashlib.sha256(self.raw).hexdigest()}
        self.selected_complete_sha = self.point["complete_sha256"]
        write_json(self.point_path, self.point)
        self.pbs = {"server": "pbs.fixture.invalid", "port": None, "datastore": "main",
                    "namespace": "fixture", "fingerprint": self.fingerprint, "username": "reader@pbs!fixture"}
        self.policy = {"format": 1, "vmid": 901, "storage": self.storage, "mount": str(self.mount),
                       "luks_uuid": "a1111111-b222-c333-d444-e55555555555", "system_disk_gib": 52,
                       "allow_cleanup": True, "pbs": self.pbs, "rehearsal": {
                           "format": 2, "system_disk_gib": 52, "postgres_image": "postgres-fixture",
                           "pbs_encryption_fingerprint": self.fingerprint, "full_restore_verified": True,
                           "postgres_only_no_nic_verified": True,
                       }}
        write_json(self.policy_path, self.policy)
        self.policy_sha = self.sha(self.policy_path)
        self.volume = f"{atlas.ALIAS}:backup/vm/2541/{self.archive_time}"
        self.snapshot = {"volid": self.volume, "vmid": 2541, "notes": self.restore_id,
                         "format": "pbs-vm", "encrypted": self.fingerprint}

        patches = (
            patch.object(atlas, "STATE", self.state),
            patch.object(atlas, "CAPTURE_STATE", self.capture_state),
            patch("backup_coordinator.socket.gethostname", side_effect=lambda: self.host_node),
            patch.object(atlas.Keep, "pve", side_effect=self.pve),
            patch.object(atlas, "verify_destination", return_value=self.mount.stat().st_dev),
            patch.object(atlas, "check_pbs_key"),
            patch.object(atlas, "require_memory_reserve"),
            patch.object(atlas.os, "statvfs",
                  side_effect=lambda _: SimpleNamespace(f_bavail=self.space, f_frsize=1)),
            patch.object(atlas, "command", side_effect=self.extractconfig),
            patch("backup_restore_drill.command", side_effect=self.command),
            patch("atlas_failover_preboot.GIB", 1),
            patch.object(Drill, "qga", side_effect=self.qga),
        )
        for context in patches:
            self.enterContext(context)

    def sha(self, path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def pve(self, action, path, *args):
        self.assertEqual(action, "get")
        if path == "/cluster/resources":
            self.assertEqual(args, ("--type", "vm"))
            return [] if self.config is None else [{"vmid": 901}]
        if path == "/cluster/ha/resources":
            return []
        if path == f"/storage/{atlas.ALIAS}":
            return self.pbs | {"type": "pbs", "nodes": "atlas", "encryption-key": self.fingerprint}
        if path == f"/nodes/atlas/storage/{atlas.ALIAS}/content":
            self.assertEqual(args, ("--content", "backup", "--vmid", "2541"))
            return [self.snapshot]
        prefix = "/nodes/atlas/qemu/901/"
        if path == prefix + "config":
            self.assertEqual(args, ("--current", "1"))
            return dict(self.config)
        if path == prefix + "pending":
            return self.pending
        if path == prefix + "status/current":
            return {"status": self.status, "vmid": 901}
        if path == f"/nodes/atlas/tasks/{self.upid}/status":
            return {"status": "stopped", "exitstatus": "OK", "upid": self.upid,
                    "type": "qmrestore", "node": "atlas", "id": "901"}
        self.fail(f"Unexpected PVE read {path}")

    def extractconfig(self, *args):
        self.assertEqual(args, ("pvesm", "extractconfig", self.volume))
        return "boot: order=scsi0\nscsi0: local-lvm:vm-2541-disk-0,size=52G\n" \
               "ide2: local-lvm:vm-2541-cloudinit,media=cdrom,size=4M\n"

    def command(self, *args, timeout=60):
        journal = read_json(self.state / "postgres-restore-active.json")
        if args[0] == "pvesh":
            self.assertEqual(journal["phase"], "restore_requested")
            self.assertEqual(args, ("pvesh", "create", "/nodes/atlas/qemu", "--archive", self.volume,
                                    "--vmid", "901", "--storage", self.storage, "--unique", "1",
                                    "--start", "0", "--onboot", "0", "--autostart", "0", "--output-format", "json"))
            self.events.append("restore")
            self.directory.mkdir()
            (self.directory / self.disk).write_bytes(self.actual_raw)
            (self.directory / self.seed).write_bytes(b"seed")
            self.config = {"boot": "order=scsi0", "onboot": 0, "autostart": 0, "net0": "inherited",
                           "scsi0": f"{self.storage}:901/{self.disk},size=52G",
                           "ide2": f"{self.storage}:901/{self.seed},media=cdrom,size=4M",
                           "vmgenid": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                           "smbios1": "uuid=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}
            return json.dumps(self.upid)
        binary, action, vmid, *options = args
        self.assertEqual((binary, vmid), ("qm", "901"))
        self.events.append(action)
        if action == "set":
            self.assertEqual(journal["phase"], "configure_requested")
            self.assertEqual(options[-2:], ["--delete", "net0"])
            del self.config["net0"]
            self.config.update(name=options[1], description=options[3], memory=1536,
                               sockets=1, cores=1, balloon=0)
        elif action == "start":
            self.assertEqual(journal["phase"], "start_requested")
            self.assertNotIn("net0", self.config)
            self.status = "running"
        elif action == "shutdown":
            self.status = "stopped"
        elif action == "destroy":
            self.assertEqual(journal["phase"], "cleanup_requested")
            self.assertEqual(options, ["--destroy-unreferenced-disks", "0"])
            self.config = None
            for image in self.directory.iterdir():
                image.unlink()
            self.directory.rmdir()
        else:
            self.fail(f"Unexpected command {args}")
        return ""

    def qga(self, *args):
        self.assertEqual(self.status, "running")
        executable, action, *options = args
        self.assertEqual(executable, "/usr/bin/docker")
        if action == "ps":
            return "\n".join(CONTAINERS) if "-a" in options else self.running_containers
        if action == "inspect":
            if options[1] == "{{.Image}}":
                return "postgres-fixture"
            self.assertEqual(options[2:], sorted(CONTAINERS))
            return "\n".join(f"/{name} {state} {policy}" for name, (state, policy) in CONTAINERS.items())
        self.assertEqual((action, options[0]), ("exec", POSTGRES))
        if options[1] == "pg_isready":
            return ""
        self.assertEqual(options[1], "psql")
        self.assertIn("BEGIN READ ONLY;", options[-1])
        self.events.append("postgres")
        return 'BEGIN\n1\n["fixture"]\n2\nCOMMIT'

    def invoke(self, *options):
        argv = ["atlas_postgres_restore_drill.py", "--policy", str(self.policy_path),
                "--policy-sha256", self.policy_sha, "--point", str(self.point_path),
                "--complete-sha256", self.selected_complete_sha, *options]
        output = io.StringIO()
        with patch.object(sys, "argv", argv), redirect_stdout(output):
            atlas.main()
        return json.loads(output.getvalue())

    def test_entrypoint_previews_and_runs_the_single_verified_clone(self):
        self.assertEqual(self.invoke(), {"status": "preview", "restore_id": self.restore_id, "vmid": 901})
        self.assertEqual(self.events, [])
        write_json(self.point_path, self.point | {"system_disk_gib": 52})
        self.assertEqual(self.invoke("--apply")["status"], "verified")
        self.assertEqual(self.events, ["restore", "set", "start", "postgres", "shutdown", "destroy"])
        receipt = read_json(self.state / "postgres-restore-last-success.json")
        self.assertEqual(receipt["system_disk_sha256"], self.point["system_disk_sha256"])
        self.assertEqual(receipt["volume"], self.volume)
        self.assertEqual(receipt["complete_sha256"], self.point["complete_sha256"])
        self.assertEqual(receipt["policy_sha256"], self.policy_sha)
        self.assertFalse((self.state / "postgres-restore-active.json").exists())
        with self.assertRaisesRegex(BackupError, "already passed the drill"):
            self.invoke("--apply")

    def test_same_length_corruption_preserves_clone_and_blocks_retry(self):
        self.actual_raw = b"S" + self.raw[1:]
        with self.assertRaisesRegex(BackupError, "differs from the verified PBS image"):
            self.invoke("--apply")
        self.assertEqual(self.events, ["restore", "set"])
        self.assertEqual(self.status, "stopped")
        self.assertTrue(self.directory.is_dir())
        self.assertFalse((self.state / "postgres-restore-last-success.json").exists())
        with self.assertRaisesRegex(BackupError, "requires reconciliation"):
            self.invoke("--apply")
        self.assertEqual(self.events, ["restore", "set"])

    def test_wrong_node_archive_capacity_and_source_receipt_block_dispatch(self):
        self.host_node = "keep"
        with self.assertRaisesRegex(BackupError, "Run as root on Atlas"):
            self.invoke("--apply")
        self.assertFalse(self.state.exists())
        self.host_node = "atlas"
        self.snapshot["notes"] = "other"
        with self.assertRaisesRegex(BackupError, "snapshot is unavailable"):
            self.invoke("--apply")
        self.snapshot["notes"] = self.restore_id
        self.space -= 1
        with self.assertRaisesRegex(BackupError, "restore reserve is too low"):
            self.invoke("--apply")
        self.complete.write_bytes(self.complete.read_bytes() + b" ")
        with self.assertRaisesRegex(BackupError, "input has changed"):
            self.invoke("--apply")
        self.assertEqual(self.events, [])

    def test_point_geometry_must_match_standing_policy(self):
        write_json(self.point_path, self.point | {"system_disk_gib": 44})
        with patch.object(atlas.Keep, "pve") as pve:
            with self.assertRaisesRegex(BackupError, "geometry differs from Atlas policy"):
                self.invoke("--apply")
        pve.assert_not_called()

    def test_stale_point_and_partial_publication_cannot_displace_selected_receipt(self):
        self.selected_complete_sha = "d" * 64
        with patch.object(atlas.Keep, "pve") as pve:
            with self.assertRaisesRegex(BackupError, "differs from the selected Keep recovery receipt"):
                self.invoke("--apply")
            self.point_path.write_text('{"complete":')
            with self.assertRaises(json.JSONDecodeError):
                self.invoke("--apply")
        pve.assert_not_called()
        self.assertEqual(self.events, [])

    def test_pending_nic_and_unfinished_capture_block_before_boot(self):
        self.capture_state.mkdir(mode=0o700)
        write_json(self.capture_state / "active.json", {})
        with self.assertRaisesRegex(BackupError, "failback capture requires reconciliation"):
            self.invoke("--apply")
        self.assertEqual(self.events, [])
        (self.capture_state / "active.json").unlink()
        self.pending = [{"key": "net0", "pending": "inherited"}]
        with self.assertRaisesRegex(BackupError, "pending configuration"):
            self.invoke("--apply")
        self.assertEqual(self.events, ["restore"])

    def test_unexpected_running_container_stops_clone_and_preserves_evidence(self):
        self.running_containers += "\nunexpected-writer"
        with self.assertRaisesRegex(BackupError, "Unexpected running container"):
            self.invoke("--apply")
        self.assertEqual(self.events, ["restore", "set", "start", "shutdown"])
        self.assertEqual(self.status, "stopped")
        self.assertTrue((self.state / "postgres-restore-active.json").exists())
        self.assertFalse((self.state / "postgres-restore-last-success.json").exists())

    def test_disk_replaced_after_shutdown_must_not_be_removed(self):
        def replace(*args, **kwargs):
            result = self.command(*args, **kwargs)
            if args[:2] == ("qm", "shutdown"):
                path = self.directory / self.disk
                replacement = self.root / "foreign.raw"
                replacement.write_bytes(path.read_bytes())
                replacement.replace(path)
            return result

        with patch("backup_restore_drill.command", side_effect=replace):
            with self.assertRaisesRegex(BackupError, "disk ownership"):
                self.invoke("--apply")
        self.assertEqual(self.events, ["restore", "set", "start", "postgres", "shutdown"])
        self.assertTrue((self.directory / self.disk).is_file())
        record = read_json(self.state / "postgres-restore-active.json")
        disk = f"{self.storage}:901/{self.disk}"
        self.assertNotEqual(record["disk_identities"][disk]["inode"], (self.directory / self.disk).stat().st_ino)

    def test_lost_response_after_restore_shutdown_and_removal_never_redispatches(self):
        for operation, command_prefix, phase, remaining in (
            ("restore", ("pvesh", "create"), "restore_requested", True),
            ("shutdown", ("qm", "shutdown"), "start_requested", True),
            ("destroy", ("qm", "destroy"), "cleanup_requested", False),
        ):
            with self.subTest(operation=operation):
                def lose_reply(*args, **kwargs):
                    result = self.command(*args, **kwargs)
                    if args[:2] == command_prefix:
                        raise BackupError("synthetic lost response")
                    return result

                with patch("backup_restore_drill.command", side_effect=lose_reply):
                    with self.assertRaisesRegex(BackupError, "synthetic lost response"):
                        self.invoke("--apply")
                    journal = self.state / "postgres-restore-active.json"
                    self.assertEqual(read_json(journal)["phase"], phase)
                    self.assertEqual(self.config is not None, remaining)
                    self.assertFalse((self.state / "postgres-restore-last-success.json").exists())
                    recorded_events = list(self.events)
                    self.assertEqual(recorded_events.count("restore"), 1)
                    self.assertEqual(recorded_events[-1], operation)
                    with self.assertRaisesRegex(BackupError, "requires reconciliation"):
                        self.invoke("--apply")
                    self.assertEqual(self.events, recorded_events)

                # Reset only the synthetic host between independent interruption scenarios.
                journal.unlink()
                if remaining:
                    for disk in self.directory.iterdir():
                        disk.unlink()
                    self.directory.rmdir()
                self.config = None
                self.events.clear()

    def test_interruption_during_readback_keeps_clone_stopped_and_blocks_retry(self):
        def interrupt(path):
            snapshot_digest(path)
            raise KeyboardInterrupt

        with patch("atlas_failover_preboot.snapshot_digest", side_effect=interrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.invoke("--apply")
        journal = read_json(self.state / "postgres-restore-active.json")
        self.assertEqual(journal["phase"], "configure_requested")
        self.assertEqual(journal["upid"], self.upid)
        self.assertEqual(self.status, "stopped")
        with self.assertRaisesRegex(BackupError, "requires reconciliation"):
            self.invoke("--apply")
        self.assertEqual(self.events, ["restore", "set"])

    def test_changed_uuid_after_boot_or_cleanup_intent_prevents_dispatch(self):
        for phase, events in (
            ("start_requested", ["restore", "set"]),
            ("cleanup_requested", ["restore", "set", "start", "postgres", "shutdown"]),
        ):
            with self.subTest(phase=phase):
                def replace_after_intent(path, record):
                    write_json(path, record)
                    if record.get("phase") == phase:
                        self.config["vmgenid"] = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

                with patch("backup_restore_drill.write_json", side_effect=replace_after_intent):
                    with self.assertRaisesRegex(BackupError, "Restore VM identity"):
                        self.invoke("--apply")
                self.assertEqual(self.events, events)
                self.assertEqual(self.status, "stopped")
                journal = self.state / "postgres-restore-active.json"
                self.assertEqual(read_json(journal)["phase"], phase)
                journal.unlink()
                for disk in self.directory.iterdir():
                    disk.unlink()
                self.directory.rmdir()
                self.config = None
                self.events.clear()

    def test_unresolved_drill_blocks_failback_capture_after_lock_released(self):
        self.state.mkdir(mode=0o700)
        write_json(self.state / "postgres-restore-active.json", {"phase": "restore_requested"})
        argv = ["atlas_failback_capture.py", "run", "--policy", "/unused", "--policy-sha256", "a" * 64]
        with (patch.object(sys, "argv", argv), patch.object(capture, "ATLAS_DRILL_STATE", self.state),
              patch.object(capture, "Atlas", return_value=SimpleNamespace(root=self.capture_state)),
              patch.object(capture, "Coordinator") as coordinator, patch("sys.stderr", new_callable=io.StringIO)):
            self.assertEqual(capture.main(), 1)
        coordinator.assert_not_called()
