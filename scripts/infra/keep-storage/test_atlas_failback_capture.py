import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from atlas_failback_capture import Atlas, STATE
from backup_coordinator import Coordinator, OperationFailed, Pending
from backup_guest import BackupError, GIB, read_json, write_json
from test_backup_coordinator import FakeKeep


SCOPE = {"policy_sha256": "a" * 64, "frozen_at": "2025-01-01T00:00:00Z"}
FINGERPRINT = ":".join(["ab"] * 32)


class FrozenCoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(TemporaryDirectory()))
        self.host = FakeKeep(self.root)

    def capture(self, action="run", scope=SCOPE):
        coordinator = Coordinator(self.host, 1, atlas_scope=scope)
        coordinator.deadline = 0
        return coordinator.run_backup(action)

    def assert_held(self):
        self.assertTrue((self.root / "active.json").is_file())
        self.assertFalse(any(event[1] == "resume" for event in self.host.events))

    def test_publish_and_reconnect_keep_writers_paused(self):
        result = self.capture()
        self.assertEqual(result, read_json(self.root / "last-success.json"))
        self.assertEqual(self.capture("recover"), result)
        with self.assertRaisesRegex(Pending, "Unfinished backup"):
            self.capture()
        self.assert_held()
        self.assertEqual(sum(event[0] == "pbs" for event in self.host.events), 1)

    def test_pause_capture_pbs_and_upload_failures_keep_active_without_publication(self):
        for failure in (("files", "pause"), ("quantself", "capture"), "pbs", ("files", "upload")):
            with self.subTest(failure=failure), TemporaryDirectory() as root:
                self.root = Path(root)
                self.host = FakeKeep(self.root)
                self.host.fail.add(failure)
                with self.assertRaises(OperationFailed):
                    self.capture()
                self.assert_held()
                self.assertFalse((self.root / "last-success.json").exists())
                self.assertFalse(list(self.root.glob("runs/*/complete.json")))

    def test_abort_and_changed_policy_never_resume_or_redispatch(self):
        self.host.pending[("files", "capture")] = "running"
        with self.assertRaises(Pending):
            self.capture()
        before = list(self.host.events)
        with self.assertRaisesRegex(BackupError, "capture policy changed"):
            self.capture("recover", SCOPE | {"policy_sha256": "b" * 64})
        self.assertEqual(self.host.events, before)
        self.host.pending.clear()
        result = self.capture("abort")
        self.assertEqual(result["status"], "aborted")
        self.assertEqual(self.capture("recover"), result)
        self.assert_held()
        self.assertEqual(self.host.events, before)

    def test_loss_of_pause_during_offsite_upload_prevents_publication(self):
        guest = self.host.guest

        def check(action, role, restore_id, operation, attempt):
            if (action == "check-paused" and role == "quantself"
                    and ("files", "upload", 1) in self.host.events):
                raise BackupError("synthetic writer restarted")
            return guest(action, role, restore_id, operation, attempt)

        with patch.object(self.host, "guest", side_effect=check), self.assertRaisesRegex(BackupError, "writer restarted"):
            self.capture()
        self.assert_held()
        self.assertFalse((self.root / "last-success.json").exists())

    def test_future_freeze_cannot_dispatch(self):
        with self.assertRaisesRegex(BackupError, "freeze must precede"):
            self.capture(scope=SCOPE | {"frozen_at": "2099-01-01T00:00:00Z"})
        self.assertEqual(self.host.events, [])
        self.assertFalse((self.root / "active.json").exists())


class AtlasDispatchTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(TemporaryDirectory()))
        self.policy_path = self.root / "policy.json"
        ledger_path = self.root / "promoted.json"
        self.ledger = {}
        self.configs = {}
        for role, vmid in (("records", 901), ("originals", 902)):
            disk = f"fixture-store:{vmid}/vm-{vmid}-disk-0.raw"
            generation = f"aaaaaaaa-aaaa-4aaa-8aaa-{vmid:012d}"
            smbios = f"bbbbbbbb-bbbb-4bbb-8bbb-{vmid:012d}"
            self.ledger[role] = {"vmid": vmid, "clone_identity": {"vmgenid": generation, "smbios_uuid": smbios},
                                 "disks": {"scsi0": disk}}
            self.configs[vmid] = {"vmgenid": generation, "smbios1": f"uuid={smbios}", "scsi0": disk}
        self.pbs = {"server": "fixture.invalid", "datastore": "main", "namespace": None,
                    "username": "capture@pbs!fixture", "fingerprint": FINGERPRINT, "encryption-key": FINGERPRINT}
        ledger_raw = json.dumps(self.ledger).encode()
        policy = {"ledger": str(ledger_path), "ledger_sha256": hashlib.sha256(ledger_raw).hexdigest(),
                  "frozen_at": SCOPE["frozen_at"], "vm_storage": "fixture-store",
                  "mount": "/mnt/fixture", "luks_uuid": "fixture", "reserve_gib": 2, "pbs": self.pbs,
                  "vault_hostname": "files-atlas.fixture.ts.net",
                  "offsite_repositories": {"records": "a" * 64, "originals": "b" * 64}}
        self.policy = policy
        raw = json.dumps(policy).encode()
        self.digest = hashlib.sha256(raw).hexdigest()
        with (patch("backup_coordinator.socket.gethostname", return_value="atlas"),
              patch("atlas_failback_capture.private_read", side_effect=lambda path, limit: {self.policy_path: raw, ledger_path: ledger_raw}[path]),
              patch("atlas_failback_capture.read_vault_origin", return_value="https://keep-fixture.tailnet.ts.net")):
            # The mock preserves real hashing and parsing while avoiding privileged metadata.
            self.atlas = Atlas(self.policy_path, self.digest, self.root)

    def test_atlas_rejects_the_staged_keep_hostname(self):
        matching_origin = "https://" + self.policy["vault_hostname"]
        with (patch("backup_coordinator.socket.gethostname", return_value="atlas"),
              patch("atlas_failback_capture.pinned_json", return_value=self.policy),
              patch("atlas_failback_capture.read_vault_origin", return_value=matching_origin),
              self.assertRaises(BackupError)):
            Atlas(self.policy_path, self.digest, self.root)

    def test_guest_dispatch_binds_uuid_disk_and_exact_atlas_id(self):
        with (patch.object(self.atlas, "pve", side_effect=lambda _, path, *_args:
                           self.configs[int(path.split("/")[-2])]),
              patch("backup_coordinator.command", return_value='{"exited":true,"exitcode":0,"out-data":"{}"}') as command):
            self.atlas.guest("start", "quantself", "synthetic", "capture", 1)
            self.assertEqual(command.call_args.args[:4], ("qm", "guest", "exec", "901"))
            self.assertNotIn("--vault-hostname", command.call_args.args)
            self.atlas.guest("start", "files", "synthetic", "preflight", 1)
            self.assertEqual(command.call_args.args[:4], ("qm", "guest", "exec", "902"))
            self.assertEqual(command.call_args.args[-2:], ("--vault-hostname", "files-atlas.fixture.ts.net"))
            self.configs[901]["vmgenid"] = self.configs[902]["vmgenid"]
            with self.assertRaisesRegex(BackupError, "UUIDs differ"):
                self.atlas.guest("start", "quantself", "synthetic", "capture", 1)
            with self.assertRaisesRegex(BackupError, "keeps writers paused"):
                self.atlas.guest("start", "quantself", "synthetic", "resume", 1)
            self.assertEqual(command.call_count, 2)

    def test_guest_preflight_refuses_unapproved_offsite_repository(self):
        reply = {"status": "ok", "result": {"repository": "c" * 64}}
        with (patch.object(self.atlas, "pve", return_value=self.configs[901]),
              patch("backup_coordinator.command", return_value=json.dumps(
                  {"exited": True, "exitcode": 0, "out-data": json.dumps(reply)}))):
            checked = self.atlas.guest("status", "quantself", "synthetic", "preflight", 1)
        self.assertEqual(checked["status"], "failed")
        self.assertIn("pinned identity", checked["error"])

    def test_pbs_worker_checks_original_intent_and_selects_only_promoted_ids(self):
        restore_id = "20261114T053000Z-123456abcdef"
        run = self.root / "runs" / restore_id
        run.mkdir(parents=True)

        def pve(action, endpoint, *args):
            self.assertEqual(action, "get")
            if endpoint == "/storage/backup":
                return self.pbs | {"type": "pbs"}
            if endpoint == "/nodes/atlas/storage/backup/status":
                return {"active": 1, "avail": 100 * GIB}
            if endpoint == "/nodes/atlas/storage/backup/content":
                vmid = int(args[-1])
                return [{"notes": restore_id, "vmid": vmid, "format": "pbs-vm",
                         "encrypted": FINGERPRINT, "volid": f"backup:backup/vm/{vmid}/2026-11-14T05:30:02Z"}]
            _, _, _, _, vmid, kind, *_ = endpoint.split("/")
            if kind == "config":
                return self.configs[int(vmid)]
            return {"vmid": int(vmid), "status": "running", "maxdisk": GIB}

        journal = {"restore_id": restore_id, "atlas_scope": self.atlas.scope, "operations": {}}
        write_json(run / "journal.json", journal)
        write_json(self.root / "active.json", {"restore_id": restore_id})
        with (patch.object(self.atlas, "pve", side_effect=pve), patch("atlas_failback_capture.verify_destination"),
              patch("atlas_failback_capture.check_pbs_key"), patch("atlas_failback_capture.shutil.disk_usage",
                    return_value=SimpleNamespace(free=50 * GIB)), patch("backup_coordinator.command") as command):
            with self.assertRaisesRegex(BackupError, "original dispatch intent"):
                self.atlas.pbs_worker(restore_id)
            command.assert_not_called()
            journal["operations"]["pbs"] = {"attempt": 1}
            write_json(run / "journal.json", journal)
            command.return_value = '{"exited":true,"exitcode":1}'
            with self.assertRaisesRegex(BackupError, "check-paused"):
                self.atlas.pbs_worker(restore_id)
            self.assertEqual(command.call_args.args[0], "qm")
            self.assertFalse((run / "pbs.json").exists())
            command.reset_mock()
            command.return_value = '{"exited":true,"exitcode":0,"out-data":"{}"}'
            self.atlas.pbs_worker(restore_id)
            self.assertEqual([call.args[0] for call in command.call_args_list], ["qm", "qm", "vzdump"])
            self.assertEqual(command.call_args.args[:4], ("vzdump", "902,901", "--node", "atlas"))
            self.assertTrue(all(f"/{vmid}/" in read_json(run / "pbs.json")["result"][role]["volid"]
                                for role, vmid in self.atlas.guests.items()))
        self.assertNotEqual(STATE, Path("/var/lib/keep-backup"))
        self.assertEqual(self.atlas.pbs_worker_args(restore_id)[-1], self.digest)
