from contextlib import redirect_stderr
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from test_atlas_release import image_fixture


BROKER = Path(__file__).resolve().with_name("atlas-keep-deploy.py")
SHA = "1" * 40


class KeepDeployTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.deploy = runpy.run_path(str(BROKER))["promote"]
        code = self.deploy.__globals__
        release = code["RELEASE"]
        journal_module = code["JOURNAL"]
        source = self.root / "candidate"
        (source / "scripts").mkdir(parents=True)
        self.events = self.root / "events"
        script = source / "scripts" / "promote-home.sh"
        script.write_text('printf "%s %s %s\\n" "$1" "$3" "$4" >> "$2/events"\n')
        lock = self.root / "lock"
        lock.touch(mode=0o600)
        self.journal = journal_module["DeployJournal"](lock, self.root / "journal.sqlite")
        self.journal.initialize()
        self.reconciliation_required = journal_module["ReconciliationRequired"]
        self.bundle = self.root / "release"
        image = self.bundle / "app-image"
        image.mkdir(parents=True)
        image_fixture(image, SHA)
        self.record = release["release_record"](image, SHA)
        signer = self.root / "signer"
        subprocess.run(
            ["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(signer)], check=True,
        )
        allowed = self.root / "allowed-signers"
        allowed.write_text(f"quantself-atlas {signer.with_suffix('.pub').read_text()}")
        release["sign_bundle"](self.bundle, self.record, signer)
        self.request = code["CONTROL"]["Request"](SHA, "42", "1")
        self.claim = journal_module["Claim"]("314", "42", "1", SHA, self.record["image_id"])
        self.authenticate = Mock()
        self.verify = Mock(side_effect=lambda _bundle, claim:
                           release["verify_bundle"](self.bundle, claim.source_sha, allowed))
        self.load = Mock()
        self.check_main = Mock()
        self.maintenance = self.root / "maintenance"
        self.enterContext(patch.dict(os.environ, {
            "QUANTSELF_DEPLOY_MODE": "atlas",
            "BACKUP_READY_REVISION": SHA,
            "BACKUP_READY_IMAGE": self.record["image_id"],
            "DEPLOY_PATH": str(self.root),
            "PRODUCTION_URL": "https://qs.girke.dev",
            "PRODUCTION_HTTPS_IP": "100.64.12.34",
        }, clear=True))
        self.enterContext(patch.dict(code, {
            "open_journal": lambda: self.journal,
            "authenticate": self.authenticate,
            "verify_release": self.verify,
            "ensure_image": self.load,
            "STATE": self.root,
            "MAINTENANCE": self.maintenance,
        }))
        self.enterContext(patch.dict(release, {"trusted_path": lambda path: path}))
        self.enterContext(patch.dict(code["SOURCE"], {
            "admit": lambda *_args, **_kwargs: {"checkout": source},
            "check_main": self.check_main,
        }))
        self.enterContext(patch.dict(code["CONTROL"], {
            "load_policy": lambda: SimpleNamespace(repository_id=314),
        }))

    def assert_no_claim(self):
        with self.assertRaisesRegex(self.reconciliation_required, "No claim found"):
            self.journal.reconcile(self.claim, lambda _: None)
        self.assertFalse(self.events.exists())

    def test_exact_request_promotes_once_and_authenticates_replay(self):
        with tempfile.TemporaryFile(mode="w+") as stderr, redirect_stderr(stderr):
            self.deploy(self.request, "ghs_fixture")
            self.deploy(self.request, "ghs_fixture")
            stderr.seek(0)
            output = stderr.read()
        marker = f"Atlas promotion receipt 314 42 1 {SHA} {self.claim.image_id}"
        self.assertEqual(output.splitlines(), [marker])
        self.assertEqual(self.authenticate.call_count, 2)
        self.assertEqual(self.verify.call_count, 2)
        self.load.assert_called_once()
        self.check_main.assert_called_once()
        self.assertEqual(self.events.read_text(), f"promote {SHA} {self.record['image_id']}\n")
        self.assertEqual(self.journal.reconcile(self.claim, lambda _: None).outcome, "succeeded")

    def test_invalid_run_and_tampered_receipt_cannot_claim(self):
        self.authenticate.side_effect = ValueError("untrusted run")
        with self.assertRaisesRegex(ValueError, "untrusted run"):
            self.deploy(self.request, "ghs_fixture")
        self.verify.assert_not_called()
        self.assert_no_claim()
        self.authenticate.side_effect = None
        with (self.bundle / "release.json").open("ab") as file:
            file.write(b" ")
        with self.assertRaisesRegex(ValueError, "signature rejected"):
            self.deploy(self.request, "ghs_fixture")
        self.load.assert_not_called()
        self.assert_no_claim()

    def test_wrong_main_preparation_leaves_no_claim_and_retry_works(self):
        self.check_main.side_effect = ValueError("canonical main changed")
        with self.assertRaisesRegex(ValueError, "main changed"):
            self.deploy(self.request, "ghs_fixture")
        self.assert_no_claim()
        self.check_main.side_effect = None
        self.deploy(self.request, "ghs_fixture")
        self.assertTrue(self.events.exists())

    def test_maintenance_and_unapproved_mode_prevent_any_admission(self):
        self.maintenance.symlink_to(self.root / "missing")
        with self.assertRaisesRegex(ValueError, "recovery is active"):
            self.deploy(self.request, "ghs_fixture")
        self.maintenance.unlink()
        with patch.dict(os.environ, {"QUANTSELF_DEPLOY_MODE": "legacy"}):
            with self.assertRaisesRegex(ValueError, "disabled"):
                self.deploy(self.request, "ghs_fixture")
        self.authenticate.assert_not_called()
        self.assert_no_claim()

    def test_signed_release_checks_drain_proof_in_isolated_python(self):
        drain = self.bundle / "web-drain.json"
        drain.write_text(json.dumps({
            "format": 1,
            "image": self.claim.image_id,
            "contract": "next-sigterm-deferred-request-v1",
        }))
        drain.chmod(0o600)
        backup = BROKER.parent.parent / "keep-storage" / "backup_guest.py"
        result = subprocess.run(
            [sys.executable, "-I", "-B", "-c", """
import runpy
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

broker, backup, policy, release, revision, image = sys.argv[1:]
verify = runpy.run_path(broker)["verify_release"]
path_stat = Path.stat

def root_owned_stat(path, **options):
    info = path_stat(path, **options)
    # Simulate root ownership while keeping the real path and file modes.
    return SimpleNamespace(st_mode=info.st_mode, st_uid=0, st_gid=0)

def root_owned_lstat(path):
    # Some Python versions call os.lstat directly instead of delegating to Path.stat.
    return root_owned_stat(path, follow_symlinks=False)

with patch.dict(verify.__globals__, BACKUP_TOOLS=Path(backup), POLICY_DIR=Path(policy)):
    with patch.object(Path, "stat", root_owned_stat), patch.object(Path, "lstat", root_owned_lstat):
        verify(Path(release), SimpleNamespace(source_sha=revision, image_id=image))
""", str(BROKER), str(backup), str(self.root.resolve()), str(self.bundle.resolve()),
             SHA, self.claim.image_id],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_untrusted_socket_frame_is_rejected_without_ack(self):
        for action in ("deploy", "rollback-atlas", "rollback-verified"):
            with self.subTest(action=action):
                result = subprocess.run(
                    [sys.executable, "-I", "-B", str(BROKER)],
                    input=f"{action} {SHA} 42 1\nghs_fixture\n",
                    capture_output=True, text=True, check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                self.assertIn("malformed request", result.stderr)
                self.assertNotIn("ghs_fixture", result.stderr)


if __name__ == "__main__":
    unittest.main()
