from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backup_guest import BackupError
import backup_pair_proof as proof


class BackupPairProofTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.now = datetime(2026, 11, 17, 9, tzinfo=timezone.utc)
        restore_id = "20261117T070753Z-44b2c260a89a"
        self.backup_path = self.root / "last-success.json"
        self.complete_path = self.root / "runs" / restore_id / "complete.json"
        self.restore_path = self.root / "postgres-restore-last-success.json"
        pair = {"format": 1, "restore_id": restore_id, "completed_at": self.when(105), "pbs": {}, "offsite": {}}
        for role, vmid, fake in (("quantself", 2541, "a"), ("files", 2540, "b")):
            pair["pbs"][role] = {
                "volid": f"backup:backup/vm/{vmid}/2026-11-17T07:08:00Z",
                "encryption_fingerprint": ":".join(["cd"] * 32),
            }
            pair["offsite"][role] = {"repository": fake * 64, "snapshot": fake * 64, "manifest": {
                "format": 1, "restore_id": restore_id, "role": role, "inventory_sha256": fake * 64,
            }}
        result = {"status": "verified", "restore_id": restore_id, "vmid": 2544}
        self.state = {self.backup_path: pair, self.complete_path: pair, self.restore_path: {
            **result, "format": 1, "completed_at": self.when(28),
            "volume": "backup-restore-254:backup/vm/2541/2026-11-17T07:08:00Z",
        }}
        self.units = {
            proof.BACKUP: self.make_service(proof.BACKUP, "a" * 32, f"Verified Keep backup {restore_id}.", 104),
            proof.RESTORE: self.make_service(proof.RESTORE, "b" * 32, json.dumps(result), 27),
        }
        self.enterContext(patch.object(proof, "state_file", side_effect=self.state.__getitem__))
        self.enterContext(patch.object(proof, "command", side_effect=self.run_read))

    def when(self, minutes):
        return (self.now - timedelta(minutes=minutes)).isoformat()

    def make_service(self, name, invocation, message, minutes):
        return {
            "properties": {"Id": name, "InvocationID": invocation, **proof.SUCCESS_PROPERTIES},
            "log": [{"_SYSTEMD_UNIT": name, "_SYSTEMD_INVOCATION_ID": invocation, "MESSAGE": message,
                     "__REALTIME_TIMESTAMP": str(int(datetime.fromisoformat(self.when(minutes)).timestamp() * 1_000_000))}],
        }

    def run_read(self, *args, **_kwargs):
        if args[:2] == ("systemctl", "show"):
            return "\n".join(f"{key}={value}" for key, value in self.units[args[-1]]["properties"].items())
        self.assertEqual(args[0], "journalctl")
        self.assertIn("--boot", args)
        service = self.units[args[-2].removeprefix("_SYSTEMD_UNIT=")]
        self.assertEqual(args[-1], "_SYSTEMD_INVOCATION_ID=" + service["properties"]["InvocationID"])
        return "\n".join(map(json.dumps, service["log"]))

    def test_matching_pair_reports_service_success_without_inferring_timer_origin(self):
        self.assertEqual(proof.prove(self.root, self.now), {
            "status": "verified_service_pair", "restore_id": self.state[self.backup_path]["restore_id"],
            "timer_origin": "unverified",
        })

    def test_mismatched_point_and_archive_are_refused(self):
        for change in (
            {"restore_id": "20261116T221725Z-cecfb4a22d10"},
            {"volume": "backup-restore-254:backup/vm/2541/2026-11-16T07:08:00Z"},
        ):
            with self.subTest(change=change), patch.dict(self.state[self.restore_path], change):
                with self.assertRaisesRegex(BackupError, "does not match the encrypted backup"):
                    proof.prove(self.root, self.now)

    def test_stale_pair_is_refused(self):
        with self.assertRaisesRegex(BackupError, "four-hour window"):
            proof.prove(self.root, self.now + timedelta(hours=4))

    def test_failed_timer_and_pending_exit_75_cannot_reuse_success_receipts(self):
        for unit, props in (
            (proof.RESTORE, {"ActiveState": "failed", "Result": "exit-code", "ExecMainStatus": "1"}),
            (proof.BACKUP, {"ExecMainStatus": "75"}),
        ):
            with self.subTest(unit=unit), patch.dict(self.units[unit]["properties"], props):
                with self.assertRaisesRegex(BackupError, "settled exit-zero"):
                    proof.prove(self.root, self.now)

    def test_new_invocation_and_duplicate_proof_are_refused(self):
        props = self.units[proof.RESTORE]["properties"]
        with patch.dict(props, {"InvocationID": "c" * 32}):
            with self.assertRaisesRegex(BackupError, "unique success marker"):
                proof.prove(self.root, self.now)
        self.units[proof.RESTORE]["log"] *= 2
        with self.assertRaisesRegex(BackupError, "unique success marker"):
            proof.prove(self.root, self.now)
