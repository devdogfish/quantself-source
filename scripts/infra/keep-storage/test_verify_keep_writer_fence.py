import hashlib
import json
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import unittest
from unittest.mock import patch

from verify_keep_writer_fence import BackupError, main, verify_fence


class KeepWriterFenceTest(unittest.TestCase):
    def setUp(self):
        self.ha = "/cluster/ha/resources"
        self.app = "/nodes/keep/qemu/2541"
        self.files = "/nodes/keep/qemu/2540"
        self.responses = {
            self.ha: [{"sid": "vm:999", "state": "started"}],
            self.app + "/pending": [{"key": "name", "value": "quantself"}, {"key": "onboot", "value": "0"}],
            self.files + "/pending": [{"key": "name", "value": "files"}, {"key": "autostart", "value": 0}],
            self.app + "/status/current": {"name": "quantself", "vmid": 2541, "status": "stopped"},
            self.files + "/status/current": {"name": "files", "vmid": 2540, "status": "stopped"},
        }
        self.host = self.enterContext(patch("verify_keep_writer_fence.socket.gethostname", return_value="keep"))
        self.command = self.enterContext(patch("verify_keep_writer_fence.command", side_effect=self.fixture_command))

    def fixture_command(self, *args, timeout):
        self.assertEqual(args[:2], ("pvesh", "get"))
        self.assertEqual(args[3:], ("--output-format", "json"))
        self.assertEqual(timeout, 15)
        return json.dumps(self.responses[args[2]])

    def test_both_exact_guests_stopped_after_policy_reads(self):
        self.assertEqual(verify_fence(), {
            "status": "keep_guests_fenced", "node": "keep", "guests": {"quantself": 2541, "files": 2540},
        })
        paths = [call.args[2] for call in self.command.call_args_list]
        self.assertCountEqual(paths[:3], [self.ha, self.app + "/pending", self.files + "/pending"])
        self.assertCountEqual(paths[3:], [self.app + "/status/current", self.files + "/status/current"])

    def test_running_database_api_guest_or_vault_guest_blocks(self):
        for path in (self.app, self.files):
            with self.subTest(path=path):
                status = self.responses[path + "/status/current"]
                status["status"] = "running"
                with self.assertRaisesRegex(BackupError, "Both exact Keep guests"):
                    verify_fence()
                status["status"] = "stopped"

    def test_autostart_pending_or_lock_blocks_stopped_guest(self):
        config = self.responses[self.files + "/pending"]
        for row in (
            {"key": "onboot", "value": 1},
            {"key": "onboot", "value": "0", "pending": "1"},
            {"key": "onboot", "value": 1, "delete": 1},
            {"key": "lock", "value": "suspended"},
        ):
            with self.subTest(row=row):
                config.append(row)
                with self.assertRaises(BackupError):
                    verify_fence()
                config.pop()
        config[1]["value"] = "1"
        with self.assertRaisesRegex(BackupError, "can start automatically"):
            verify_fence()

    def test_any_ha_entry_for_keep_guest_blocks_even_if_disabled(self):
        self.responses[self.ha] = [{"sid": "vm:2541", "state": "disabled"}]
        with self.assertRaisesRegex(BackupError, "managed by HA"):
            verify_fence()

    def test_wrong_vmid_or_host_blocks(self):
        self.responses[self.files + "/status/current"]["vmid"] = 999
        with self.assertRaises(BackupError):
            verify_fence()
        self.command.reset_mock()
        self.host.return_value = "atlas"
        with self.assertRaisesRegex(BackupError, "Expected the Keep hypervisor"):
            verify_fence()
        self.command.assert_not_called()

    def atlas_pair(self):
        self.host.return_value = "atlas"
        pair = {}
        for role, vmid in (("records", 901), ("originals", 902)):
            name = f"fixture-{role}"
            identity = {"vmgenid": f"aaaaaaaa-aaaa-4aaa-8aaa-{vmid:012d}",
                        "smbios_uuid": f"bbbbbbbb-bbbb-4bbb-8bbb-{vmid:012d}"}
            pair[role] = {"vmid": vmid, "clone_identity": identity}
            path = f"/nodes/atlas/qemu/{vmid}"
            self.responses[path + "/pending"] = [
                {"key": "name", "value": name},
                {"key": "vmgenid", "value": identity["vmgenid"]},
                {"key": "smbios1", "value": f"uuid={identity['smbios_uuid']}"},
                {"key": "net0", "value": "virtio,bridge=fixture"},
            ]
            self.responses[path + "/status/current"] = {"name": name, "vmid": vmid, "status": "stopped"}
        return pair

    def test_atlas_pair_uses_five_reads_and_does_not_require_preboot_hardware(self):
        self.assertEqual(verify_fence(self.atlas_pair()), {
            "status": "atlas_guests_fenced", "node": "atlas", "guests": {"records": 901, "originals": 902},
        })
        paths = [call.args[2] for call in self.command.call_args_list]
        self.assertCountEqual(paths[:3], [self.ha, "/nodes/atlas/qemu/901/pending", "/nodes/atlas/qemu/902/pending"])
        self.assertCountEqual(paths[3:], ["/nodes/atlas/qemu/901/status/current", "/nodes/atlas/qemu/902/status/current"])

    def test_stopped_replacement_at_same_atlas_id_fails_uuid_check(self):
        pair = self.atlas_pair()
        self.responses["/nodes/atlas/qemu/902/pending"][1]["value"] = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        with self.assertRaisesRegex(BackupError, "UUIDs differ"):
            verify_fence(pair)
        self.assertEqual(self.command.call_count, 3)

    def test_running_or_ha_managed_atlas_writer_is_rejected(self):
        pair = self.atlas_pair()
        self.responses["/nodes/atlas/qemu/902/status/current"]["status"] = "running"
        with self.assertRaisesRegex(BackupError, "Both exact Atlas guests"):
            verify_fence(pair)
        self.responses[self.ha] = [{"sid": "vm:902", "state": "disabled"}]
        with self.assertRaisesRegex(BackupError, "managed by HA"):
            verify_fence(pair)

    def test_missing_evidence_fails_without_echoing_private_values(self):
        self.command.side_effect = ValueError("synthetic-private-response")
        stdout, stderr = StringIO(), StringIO()
        with patch("sys.argv", ["verify_keep_writer_fence.py"]), redirect_stdout(stdout), redirect_stderr(stderr):
            self.assertEqual(main(), 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "Keep fence evidence is missing or malformed\n")

    def run_atlas_cli(self, raw, fingerprint):
        stdout, stderr = StringIO(), StringIO()
        args = ["verify_keep_writer_fence.py", "--atlas-ledger", "fixture.json"]
        if fingerprint is not None:
            args.extend(("--atlas-ledger-sha256", fingerprint))
        with (patch("verify_keep_writer_fence.private_read", return_value=raw) as read,
              patch("sys.argv", args),
              redirect_stdout(stdout), redirect_stderr(stderr)):
            result = main()
        self.assertLessEqual(read.call_count, 1)
        return result, stdout.getvalue(), stderr.getvalue()

    def test_null_atlas_ledger_cannot_report_keep_fenced(self):
        code, output, error = self.run_atlas_cli(b"null", hashlib.sha256(b"null").hexdigest())
        self.assertEqual((code, output), (1, ""))
        self.assertIn("Atlas promotion ledger", error)
        self.command.assert_not_called()

    def test_fence_uses_exact_ledger_bytes_captured_at_promotion(self):
        raw = json.dumps(self.atlas_pair()).encode()
        fingerprint = hashlib.sha256(raw).hexdigest()
        code, output, error = self.run_atlas_cli(raw, fingerprint)
        self.assertEqual((code, error), (0, ""))
        self.assertEqual(json.loads(output)["status"], "atlas_guests_fenced")
        self.assertEqual(self.command.call_count, 5)

    def test_stale_or_role_swapped_ledger_and_missing_pin_fail_before_proxmox_reads(self):
        pair = self.atlas_pair()
        raw = json.dumps(pair).encode()
        fingerprint = hashlib.sha256(raw).hexdigest()
        swapped = {"records": pair["originals"], "originals": pair["records"]}
        prior = {**pair, "records": {**pair["records"], "vmid": 899}}
        for candidate, pin in ((json.dumps(swapped).encode(), fingerprint),
                               (json.dumps(prior).encode(), fingerprint),
                               (raw + b"\n", fingerprint), (raw, None), (raw, "invalid")):
            with self.subTest(pin=pin, candidate=candidate):
                code, output, error = self.run_atlas_cli(candidate, pin)
                self.assertEqual((code, output), (1, ""))
                self.assertTrue(error)
        self.command.assert_not_called()
