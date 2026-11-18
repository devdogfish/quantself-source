"""Synthetic local retention and interrupted-removal fixtures."""

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import backup_retention as retention
from backup_guest import BackupError, private, write_json


@unittest.skipUnless(os.geteuid() == 0 and Path("/proc/self/mountinfo").exists(),
                     "Run root-owned retention fixtures in an isolated Linux container")
class RetentionTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(os.umask, os.umask(0o077))
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.runs = self.root / "runs"
        self.runs.mkdir()
        self.policy = self.root / "policy.json"
        setting = patch.object(retention, "POLICY", self.policy)
        setting.start()
        self.addCleanup(setting.stop)

    def fixture(self, day, complete=True):
        restore_id = f"202611{day:02}T000000Z-abcdefabcdef"
        run = self.runs / restore_id
        run.mkdir()
        pair = {"format": 1, "restore_id": restore_id, "pbs": {}, "offsite": {},
                "completed_at": datetime(2026, 11, day, tzinfo=timezone.utc).isoformat()}
        operations = {}
        for role, vmid in retention.GUESTS.items():
            manifest = {"format": 1, "restore_id": restore_id, "role": role,
                        "inventory_sha256": hashlib.sha256(b"fixture").hexdigest()}
            upload = {"manifest": manifest, "snapshot": "d" * 64,
                      "repository": ("a" if role == "files" else "b") * 64}
            pair["pbs"][role] = {"volid": f"backup:backup/vm/{vmid}/2026-11-{day:02}T00:00:00Z",
                                 "encryption_fingerprint": "aa:" * 31 + "aa"}
            pair["offsite"][role] = upload
            for operation, evidence in (("capture", manifest), ("upload", upload),
                                        ("preflight", {"repository": upload["repository"]}), ("resume", {})):
                operations[f"{role}.{operation}"] = {"status": "ok", "result": evidence}
        operations["pbs"] = {"status": "ok", "result": pair["pbs"]}
        write_json(run / "journal.json", {"format": 1, "restore_id": restore_id,
                                          "pause_finished": True, "operations": operations,
                                          **({} if complete else {"failure": "fixture"})})
        if complete:
            write_json(run / "complete.json", pair)
            write_json(self.root / "last-success.json", pair)
        return run, pair

    def staging(self, run, pair):
        role = "files"
        upload = pair["offsite"][role]
        frozen = run / "frozen"
        frozen.mkdir()
        write_json(frozen / "manifest.json", upload["manifest"])
        (frozen / "inventory.json").write_bytes(b"fixture")
        (frozen / "synthetic-file").write_bytes(b"fixture")
        for operation, evidence in (("capture", upload["manifest"]), ("upload", upload)):
            write_json(run / f"{operation}-1.json", {"status": "ok", "result": evidence})
        return frozen

    def enable(self):
        write_json(self.policy, {"format": 1, "keep_verified": 2})

    def test_preview_keeps_latest_two_and_excludes_failed_runs(self):
        _, old = self.fixture(10)
        _, previous = self.fixture(11)
        _, newest = self.fixture(12)
        self.fixture(13, complete=False)
        with patch.object(retention, "dispatch") as dispatch:
            self.assertEqual(retention.retain(self.root), {
                "mode": "preview", "protected": [newest["restore_id"], previous["restore_id"]],
                "eligible": [old["restore_id"]],
            })
            dispatch.assert_not_called()
            with self.assertRaises(FileNotFoundError):
                retention.retain(self.root, [old["restore_id"]])
            dispatch.assert_not_called()
            self.enable()
            with self.assertRaisesRegex(BackupError, "Approved restore IDs"):
                retention.retain(self.root, [newest["restore_id"]])
            dispatch.assert_not_called()
            retention.retain(self.root, [old["restore_id"]])
            self.assertEqual([call.args for call in dispatch.call_args_list],
                             [(self.root, role, old) for role in retention.GUESTS])
            dispatch.reset_mock()
            self.assertEqual(retention.retain(self.root, [old["restore_id"]])["eligible"], [])
            dispatch.assert_not_called()

    def test_automatic_cleanup_requires_opt_in_and_current_verified_pair(self):
        _, old = self.fixture(10)
        self.fixture(11)
        _, newest = self.fixture(12)
        self.assertFalse(retention.automatic_enabled())
        self.enable()
        self.assertFalse(retention.automatic_enabled())
        with patch.object(retention, "dispatch") as dispatch:
            with self.assertRaisesRegex(BackupError, "policy"):
                retention.retain(self.root, automatic=True, expected_latest=newest["restore_id"])
            dispatch.assert_not_called()
            self.policy.unlink()
            write_json(self.policy, {"format": 1, "keep_verified": 2, "automatic": True})
            self.assertTrue(retention.automatic_enabled())
            with self.assertRaisesRegex(BackupError, "Newest"):
                retention.retain(self.root, automatic=True, expected_latest=old["restore_id"])
            dispatch.assert_not_called()
            result = retention.retain(self.root, automatic=True, expected_latest=newest["restore_id"])
            self.assertEqual(result["eligible"], [old["restore_id"]])
            self.assertEqual(dispatch.call_count, 2)
            self.assertTrue(all(call.kwargs == {"automatic": True} for call in dispatch.call_args_list))

    def test_guest_requires_automatic_opt_in_even_if_manual_policy_exists(self):
        run, pair = self.fixture(10)
        frozen = self.staging(run, pair)
        self.enable()
        with self.assertRaisesRegex(BackupError, "policy"):
            retention.remove_frozen(self.root, "files", pair, automatic=True)
        self.assertTrue(frozen.exists())
        self.assertFalse((run / "retention.json").exists())

    def test_running_qga_retention_blocks_backup_until_original_pid_exits(self):
        from backup_coordinator import Coordinator, Keep, Pending

        _, pair = self.fixture(10)
        marker = self.root / "retention-inflight.json"
        boot = "fixture-boot"
        result = {"exited": True, "exitcode": 0, "out-data": json.dumps({
            "role": "files", "restore_id": pair["restore_id"], "result": "removed",
        })}
        calls = []

        def qga(role, action, *args, **kwargs):
            self.assertTrue(marker.exists())
            calls.append((role, action, args))
            if action == "exec":
                return {"pid": 241}
            return {"exited": False} if len(calls) < 4 else result

        with patch.object(retention, "guest_boot", return_value=boot), \
             patch.object(retention, "qga", side_effect=qga), \
             patch.object(retention.time, "monotonic", side_effect=[0, 121, 122, 122, 123]):
            with self.assertRaisesRegex(BackupError, "still running"):
                retention.dispatch(self.root, "files", pair)
            coordinator = Coordinator(Keep(self.root), 0)
            with self.assertRaises(Pending):
                coordinator.initialize("run")
            self.assertFalse((self.root / "active.json").exists())
            coordinator.initialize("run")
        self.assertTrue((self.root / "active.json").exists())
        self.assertFalse(marker.exists())
        self.assertEqual([call[:2] for call in calls], [("files", "exec")] + [("files", "exec-status")] * 3)
        self.assertTrue(all(call[2] == ("241",) for call in calls[1:]))

    def test_lost_pid_or_reboot_never_dispatches_again(self):
        _, pair = self.fixture(10)
        marker = self.root / "retention-inflight.json"
        with patch.object(retention, "guest_boot", return_value="old-boot"), \
             patch.object(retention, "qga", side_effect=BackupError("transport lost")) as qga:
            with self.assertRaisesRegex(BackupError, "transport lost"):
                retention.dispatch(self.root, "files", pair)
            with self.assertRaisesRegex(BackupError, "unconfirmed"):
                retention.settle_dispatch(self.root)
            qga.assert_called_once()
        state = json.loads(marker.read_text())
        write_json(marker, {**state, "pid": 241})
        with patch.object(retention, "guest_boot", return_value="new-boot"), \
             patch.object(retention, "qga") as qga:
            with self.assertRaisesRegex(BackupError, "rebooted"):
                retention.settle_dispatch(self.root)
            qga.assert_not_called()
        self.assertTrue(marker.exists())

    def test_active_or_mismatched_heartbeat_fails_closed(self):
        run, pair = self.fixture(10)
        write_json(self.root / "active.json", {"restore_id": run.name})
        with self.assertRaisesRegex(BackupError, "active"):
            retention.retain(self.root)
        (self.root / "active.json").unlink()
        write_json(self.root / "last-success.json", {**pair, "completed_at": "2026-11-10T10:00:00+00:00"})
        with self.assertRaisesRegex(BackupError, "Heartbeat"):
            retention.retain(self.root)

    def test_staging_cleanup_is_idempotent_and_leaves_external_symlink_target(self):
        run, pair = self.fixture(10)
        frozen = self.staging(run, pair)
        self.enable()
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "preserve").touch()
        (frozen / "link").symlink_to(outside)
        self.assertEqual(retention.remove_frozen(self.root, "files", pair), "removed")
        self.assertEqual(retention.remove_frozen(self.root, "files", pair), "already-removed")
        self.assertTrue((outside / "preserve").exists())
        self.assertTrue((run / "complete.json").exists())

    def test_interrupted_removal_resumes_tombstone(self):
        run, pair = self.fixture(10)
        frozen = self.staging(run, pair)
        self.enable()
        with patch.object(retention.shutil, "rmtree", side_effect=InterruptedError) as remove:
            remove.avoids_symlink_attacks = True
            with self.assertRaises(InterruptedError):
                retention.remove_frozen(self.root, "files", pair)
        self.assertFalse(frozen.exists())
        self.assertTrue((run / ".retention-removing").is_dir())
        self.assertEqual(retention.remove_frozen(self.root, "files", pair), "removed")

    def test_symlink_frozen_root_or_corrupt_inventory_never_removed(self):
        run, pair = self.fixture(10)
        frozen = self.staging(run, pair)
        self.enable()
        (frozen / "inventory.json").write_bytes(b"corrupt")
        with self.assertRaisesRegex(BackupError, "digest"):
            retention.remove_frozen(self.root, "files", pair)
        alternate = run / "alternate"
        frozen.rename(alternate)
        frozen.symlink_to(alternate)
        with self.assertRaisesRegex(BackupError, "permissions"):
            retention.remove_frozen(self.root, "files", pair)
        private(alternate, 0o700)


if __name__ == "__main__":
    unittest.main()
