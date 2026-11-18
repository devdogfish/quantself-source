import json
from subprocess import CompletedProcess
import tempfile
from pathlib import Path
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from backup_coordinator import Coordinator, GUESTS, Keep, OperationFailed, Pending, check_pbs_key
from backup_guest import BackupError
from backup_guest import read_json, write_json
from backup_monitor import monitor


class FakeKeep:
    def __init__(self, root):
        self.root = root
        self.events = []
        self.fail = set()
        self.pending = {}
        self.dispatch_failure = None

    def preflight(self, stage_bytes=0):
        self.events.append(("disk", stage_bytes))

    def guest(self, action, role, restore_id, operation, attempt):
        key = (role, operation)
        if action == "check-paused":
            return {}
        if action == "start":
            self.events.append((role, operation, attempt))
            if self.dispatch_failure == key:
                raise Pending("lost dispatch reply")
            return {}
        repository = ("a" if role == "quantself" else "b") * 64
        manifest = {"role": role, "restore_id": restore_id}
        result = {
            "preflight": {"repository": repository, "estimated_copy_bytes": 12},
            "capture": manifest,
            "upload": {"repository": repository, "manifest": manifest, "snapshot": "c" * 64},
        }.get(operation, {})
        if key in self.fail:
            return {"status": "failed", "error": "fixture failure"}
        if key in self.pending:
            return {"status": self.pending[key]}
        return {"status": "ok", "result": result}

    def pbs_start(self, restore_id):
        self.events.append(("pbs", restore_id))

    def pbs_status(self, restore_id):
        if "pbs" in self.fail:
            return {"status": "failed", "error": "one encrypted snapshot is missing"}
        if "pbs" in self.pending:
            return {"status": self.pending["pbs"]}
        return {"status": "ok", "result": {
            role: {"volid": f"backup:backup/vm/{vmid}/2026-11-14T05:12:23Z",
                   "encryption_fingerprint": ":".join(["ab"] * 32)}
            for role, vmid in GUESTS.items()
        }}


class CoordinatorTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.host = FakeKeep(Path(directory.name))

    def run_backup(self, action="run"):
        coordinator = Coordinator(self.host, 1)
        coordinator.deadline = 0
        return coordinator.run_backup(action)

    def test_pair_is_published_only_after_two_resumes_and_uploads(self):
        result = self.run_backup()
        order = self.host.events
        pbs = ("pbs", result["restore_id"])
        self.assertLess(order.index(("quantself", "pause", 1)), order.index(("files", "pause", 1)))
        self.assertLess(order.index(("files", "capture", 1)), order.index(pbs))
        self.assertLess(order.index(pbs), order.index(("files", "resume", 1)))
        self.assertLess(order.index(("files", "resume", 1)), order.index(("quantself", "resume", 1)))
        self.assertLess(order.index(("quantself", "resume", 1)), order.index(("quantself", "upload", 1)))
        self.assertIn(("files", "upload", 1), order)
        self.assertEqual(read_json(self.host.root / "last-success.json"), result)
        self.assertFalse((self.host.root / "active.json").exists())

    def test_failed_pause_or_capture_restores_only_affected_guests(self):
        cases = [("quantself", "pause"), ("files", "pause"), ("quantself", "capture")]
        for key in cases:
            with self.subTest(key=key):
                self.host.events.clear()
                self.host.fail = {key}
                with self.assertRaises(OperationFailed):
                    self.run_backup()
                self.assertIn(("quantself", "resume", 1), self.host.events)
                self.assertEqual(("files", "resume", 1) in self.host.events, key != cases[0])
                self.assertFalse(any(event[0] == "pbs" for event in self.host.events))
        self.assertFalse((self.host.root / "last-success.json").exists())

    def test_failed_pbs_resumes_and_never_uploads(self):
        self.host.fail = {"pbs"}
        with self.assertRaises(OperationFailed):
            self.run_backup()
        self.assertIn(("files", "resume", 1), self.host.events)
        self.assertIn(("quantself", "resume", 1), self.host.events)
        self.assertNotIn(("files", "upload", 1), self.host.events)
        self.assertFalse((self.host.root / "last-success.json").exists())

    def test_second_upload_failure_then_fresh_retry_reports_only_verified_success(self):
        root = self.host.root
        heartbeat = root / "last-success.json"
        previous = {"restore_id": "20261114T000000Z-0123456789ab"}
        write_json(heartbeat, previous)
        self.host.fail = {("files", "upload")}
        notifications = []
        actions = []

        def run(action, _observation, _timeout):
            actions.append(action)
            try:
                pair = self.run_backup(action)
            except OperationFailed:
                return CompletedProcess([], 1, stdout="")
            receipt = {"status": "complete", "restore_id": pair["restore_id"]}
            return CompletedProcess([], 0, stdout=json.dumps(receipt))

        def read(path, *, optional=False):
            if optional and not path.exists():
                return None
            return read_json(path)

        def observe():
            return monitor(root, report=notifications.append, run=run, read=read)

        self.assertEqual(observe(), 1)
        self.assertEqual(notifications, [False])
        failed_run, = (root / "runs").iterdir()
        operations = read_json(failed_run / "journal.json")["operations"]
        self.assertEqual(operations["quantself.upload"]["status"], "ok")
        self.assertEqual(operations["files.upload"]["status"], "failed")
        first_upload = self.host.events.index(("quantself", "upload", 1))
        for role in GUESTS:
            self.assertEqual(operations[f"{role}.resume"]["status"], "ok")
            self.assertLess(self.host.events.index((role, "resume", 1)), first_upload)
        self.assertLess(first_upload, self.host.events.index(("files", "upload", 1)))
        self.assertFalse((failed_run / "complete.json").exists())
        self.assertFalse((root / "active.json").exists())
        self.assertEqual(read_json(heartbeat), previous)

        self.host.fail.clear()
        self.assertEqual(observe(), 0)
        self.assertEqual(actions, ["run", "run"])
        self.assertEqual(notifications, [False, True])
        complete, = (root / "runs").glob("*/complete.json")
        self.assertNotEqual(complete.parent, failed_run)
        self.assertEqual(read_json(heartbeat), read_json(complete))
        self.assertFalse((root / "active.json").exists())

    def test_timeout_recovers_original_pbs_before_resume(self):
        self.host.pending = {"pbs": "running"}
        with self.assertRaises(Pending):
            self.run_backup()
        self.assertNotIn(("files", "resume", 1), self.host.events)
        self.host.pending = {}
        result = self.run_backup("recover")
        self.assertEqual(self.host.events.count(("pbs", result["restore_id"])), 1)

    def test_unknown_dispatch_is_not_resent_or_treated_as_completed(self):
        key = ("files", "pause")
        self.host.dispatch_failure = key
        self.host.pending = {key: "unknown"}
        with self.assertRaises(Pending):
            self.run_backup()
        with self.assertRaises(Pending):
            self.run_backup("recover")
        self.assertEqual(self.host.events.count((*key, 1)), 1)
        self.assertNotIn(("quantself", "resume", 1), self.host.events)
        self.host.pending = {}
        self.run_backup("recover")

    def test_resume_tries_both_and_retries_only_confirmed_failure(self):
        self.host.fail = {("files", "resume")}
        with self.assertRaises(Pending):
            self.run_backup()
        self.assertIn(("quantself", "resume", 1), self.host.events)
        self.assertNotIn(("quantself", "upload", 1), self.host.events)
        self.host.fail.clear()
        self.run_backup("recover")
        self.assertIn(("files", "resume", 2), self.host.events)
        self.assertEqual(self.host.events.count(("quantself", "resume", 1)), 1)

    def test_abort_observes_original_worker_then_resumes_without_publishing(self):
        self.host.pending = {"pbs": "running"}
        with self.assertRaises(Pending):
            self.run_backup()
        with self.assertRaises(Pending):
            self.run_backup("abort")
        self.assertNotIn(("files", "resume", 1), self.host.events)
        self.host.pending.clear()
        result = self.run_backup("recover")
        self.assertEqual(result["status"], "aborted")
        self.assertEqual(self.host.events.count(("pbs", result["restore_id"])), 1)
        self.assertIn(("files", "resume", 1), self.host.events)
        self.assertIn(("quantself", "resume", 1), self.host.events)
        self.assertFalse((self.host.root / "last-success.json").exists())

    def test_completion_publication_is_idempotent(self):
        with patch.object(Coordinator, "finalize", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.run_backup()
        original = read_json(self.host.root / "last-success.json")
        self.assertEqual(self.run_backup("recover"), original)

    def test_pbs_key_accepts_pmxcfs_root_www_data_and_rejects_unsafe_metadata(self):
        path = Path("/etc/pve/priv/storage/backup.enc")
        key = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_gid=33)
        directory = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0, st_gid=33)
        with patch.object(Path, "lstat", side_effect=[key, directory, directory]):
            check_pbs_key(path)
        for bad_mode in (stat.S_IFREG | 0o640, stat.S_IFLNK | 0o600):
            with self.subTest(mode=bad_mode), patch.object(Path, "lstat", return_value=SimpleNamespace(
                st_mode=bad_mode, st_uid=0, st_gid=33,
            )):
                with self.assertRaisesRegex(BackupError, "key permissions"):
                    check_pbs_key(path)

    def test_pbs_requires_unique_encrypted_pair_and_disables_remove(self):
        host = Keep(self.host.root)
        restore_id = "20261114T100000Z-abcdefabcdef"
        run = host.root / "runs" / restore_id
        run.mkdir(parents=True)
        fingerprint = "ab:" * 31 + "ab"
        rows = [[{"vmid": vmid, "format": "pbs-vm", "notes": restore_id,
                  "volid": f"backup:backup/vm/{vmid}/2026-11-14T10:00:00Z",
                  "encrypted": fingerprint if role == "quantself" else "1"}]
                for role, vmid in GUESTS.items()]
        with patch.object(host, "preflight", return_value=fingerprint), \
             patch.object(host, "pve", side_effect=rows), \
             patch("backup_coordinator.command") as command:
            host.pbs_worker(restore_id)
        args = command.call_args.args
        self.assertEqual(args[:2], ("vzdump", "2540,2541"))
        self.assertEqual(args[args.index("--remove") + 1], "0")
        self.assertEqual(read_json(run / "pbs.json")["status"], "failed")


if __name__ == "__main__":
    unittest.main()
