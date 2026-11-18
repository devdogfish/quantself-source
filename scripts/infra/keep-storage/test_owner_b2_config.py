"""Synthetic B2 and SSH fixtures only. No network or real credentials."""
import copy
import importlib.util
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("owner_b2_config", Path(__file__).with_name("owner-b2-config.py"))
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)

BUCKET = "synthetic-keep-9ab5"
AUTH = {"accountId": "synthetic-account", "authorizationToken": "synthetic-token",
        "apiInfo": {"storageApi": {"apiUrl": "https://api006.backblazeb2.com",
                                   "s3ApiUrl": "https://s3.ca-east-006.backblazeb2.com",
                                   "allowed": {"buckets": None, "namePrefix": None,
                                               "capabilities": ["listBuckets", "writeBuckets",
                                                                "listKeys", "writeKeys"]}}}}


class FakeB2(config.B2):
    def __init__(self):
        super().__init__(AUTH)
        self.bucket = None
        self.keys = []
        self.calls = []
        self.fail_after = None
        self.malformed = False

    def call(self, operation, **fields):
        self.calls.append((operation, fields))
        if operation == "b2_list_buckets":
            assert fields == {"bucketName": BUCKET}
            return {"buckets": [copy.deepcopy(self.bucket)] if self.bucket else []}
        if operation == "b2_create_bucket":
            self.bucket = {**copy.deepcopy(fields), "bucketId": "synthetic-bucket",
                           "accountId": self.account}
            self.bucket["lifecycleRules"][0]["daysFromUploadingToHiding"] = None
            reply = copy.deepcopy(self.bucket)
        elif operation == "b2_list_keys":
            assert fields["maxKeyCount"] == 1000
            if not fields.get("startApplicationKeyId"):
                return {"keys": [], "nextApplicationKeyId": "synthetic-next"}
            assert fields["startApplicationKeyId"] == "synthetic-next"
            return {"keys": copy.deepcopy(self.keys)}
        elif operation == "b2_create_key":
            item = {**copy.deepcopy(fields), "accountId": self.account,
                    "applicationKeyId": f"synthetic-id-{len(self.keys)}"}
            if self.malformed:
                item["capabilities"].append("deleteFiles")
            self.keys.append(item)
            reply = {**item, "applicationKey": f"Synthetic/Secret+{len(self.keys)}="}
        else:
            raise AssertionError(operation)
        if self.fail_after == operation:
            self.fail_after = None
            raise config.SetupError("synthetic interrupted response")
        return reply

    def count(self, operation):
        return sum(name == operation for name, _ in self.calls)


class OwnerB2ConfigTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        self.b2 = FakeB2()
        self.installed = []
        self.real_install = config.install_guest
        for name in ("api_json", "install_guest"):
            blocked = patch.object(config, name, side_effect=AssertionError("No network allowed"))
            blocked.start()
            self.addCleanup(blocked.stop)

    def setup_fixture(self, install=None):
        config.setup(self.b2, BUCKET, self.directory,
                     install or (lambda host, payload: self.installed.append((host, payload))))

    def test_retry_after_second_guest_failure_preserves_credentials_and_scope(self):
        def fail_second(host, payload):
            self.installed.append((host, payload))
            if host == "files":
                raise config.SetupError("synthetic SSH interruption")

        with self.assertRaises(config.SetupError):
            self.setup_fixture(fail_second)
        self.setup_fixture()
        self.assertEqual(self.installed[:2], self.installed[2:])
        self.assertEqual(self.b2.count("b2_create_bucket"), 1)
        self.assertEqual(self.b2.count("b2_create_key"), 2)
        self.assertEqual(self.b2.count("b2_list_keys"), 4)
        self.assertEqual(self.b2.bucket["lifecycleRules"], [
            {"fileNamePrefix": "", "daysFromHidingToDeleting": 30, "daysFromUploadingToHiding": None}])
        self.assertEqual(self.b2.bucket["bucketType"], "allPrivate")
        passwords = set()
        for index, (host, payload) in enumerate(self.installed[:2]):
            self.assertEqual(host, ["quantself", "files"][index])
            role = ["quantself", "vault"][index]
            key = self.b2.keys[index]
            self.assertEqual(key["namePrefix"], f"{role}/")
            self.assertEqual(key["bucketIds"], ["synthetic-bucket"])
            self.assertEqual(set(key["capabilities"]),
                             {"listBuckets", "listAllBucketNames", "listFiles", "readFiles", "writeFiles"})
            env = dict(token.split("=", 1) for token in shlex.split(payload["repository.env"]))
            self.assertEqual(env["RESTIC_REPOSITORY"], f"s3:{self.b2.endpoint}/{BUCKET}/{role}")
            self.assertEqual(env["AWS_DEFAULT_REGION"], "ca-east-006")
            self.assertEqual(env["AWS_SECRET_ACCESS_KEY"], f"Synthetic/Secret+{index + 1}=")
            self.assertEqual(env["RESTIC_PASSWORD_FILE"], "/etc/keep-restic/password")
            passwords.add(payload["password"])
        self.assertEqual(len(passwords), 2)
        self.assertEqual({p.stat().st_mode & 0o777 for p in self.directory.iterdir()}, {0o600})
        self.assertNotIn(AUTH["authorizationToken"],
                         "".join(path.read_text() for path in self.directory.iterdir()))

    def test_bucket_response_loss_reconciles_only_matching_setup_intent(self):
        self.b2.fail_after = "b2_create_bucket"
        with self.assertRaises(config.SetupError):
            self.setup_fixture()
        self.assertFalse(self.installed)
        self.setup_fixture()
        self.assertEqual(self.b2.count("b2_create_bucket"), 1)
        self.assertEqual(len(self.installed), 2)
        self.installed.clear()
        self.b2.bucket["lifecycleRules"][0]["daysFromUploadingToHiding"] = 1
        with self.assertRaisesRegex(config.SetupError, "lifecycle"):
            self.setup_fixture()
        self.assertFalse(self.installed)

    def test_preexisting_bucket_is_not_adopted(self):
        self.b2.bucket = {"bucketName": BUCKET, "bucketType": "allPrivate"}
        with self.assertRaisesRegex(config.SetupError, "no adoption"):
            self.setup_fixture()
        self.assertEqual(list(self.directory.iterdir()), [])
        self.assertEqual(self.b2.count("b2_create_bucket"), 0)

    def test_lost_key_reply_blocks_duplicate_creation(self):
        self.b2.fail_after = "b2_create_key"
        with self.assertRaises(config.SetupError):
            self.setup_fixture()
        with self.assertRaisesRegex(config.SetupError, "no local response"):
            self.setup_fixture()
        self.b2.keys.clear()  # A stale listing may omit a remotely created key.
        with self.assertRaisesRegex(config.SetupError, "no local response"):
            self.setup_fixture()
        self.assertEqual(self.b2.count("b2_create_key"), 1)
        self.assertFalse(self.installed)

    def test_retry_after_first_key_saved_creates_only_missing_key(self):
        fake_call = self.b2.call

        def fail_before_second_key(operation, **fields):
            if operation == "b2_create_key" and fields["namePrefix"] == "vault/":
                raise config.B2Rejection("synthetic explicit rejection before creation")
            return fake_call(operation, **fields)

        with patch.object(self.b2, "call", side_effect=fail_before_second_key), self.assertRaises(config.SetupError):
            self.setup_fixture()
        original = config.private_json(self.directory / "quantself-key.json")
        self.assertFalse(self.installed)
        self.setup_fixture()
        self.assertEqual(self.b2.count("b2_create_key"), 2)
        self.assertEqual(config.private_json(self.directory / "quantself-key.json"), original)
        self.assertEqual(len(self.installed), 2)

    def test_invalid_scope_persists_reply_before_stopping(self):
        self.b2.malformed = True
        with self.assertRaisesRegex(config.SetupError, "scope") as error:
            self.setup_fixture()
        self.assertNotIn("Synthetic/Secret", str(error.exception))
        key = config.private_json(self.directory / "quantself-key.json")
        self.assertEqual(key["applicationKey"], "Synthetic/Secret+1=")
        with self.assertRaisesRegex(config.SetupError, "scope"):
            self.setup_fixture()
        self.assertEqual(self.b2.count("b2_create_key"), 1)
        self.assertFalse(self.installed)

    def test_reject_wrong_region_and_untrusted_native_endpoint(self):
        for field, value in (("s3ApiUrl", "https://s3.us-east-005.backblazeb2.com"),
                             ("apiUrl", "https://api006.backblazeb2.com.invalid")):
            response = copy.deepcopy(AUTH)
            response["apiInfo"]["storageApi"][field] = value
            with self.subTest(field=field), self.assertRaises(config.SetupError):
                config.B2(response)

    def test_recovery_account_mismatch_stops_before_cloud_requests(self):
        self.setup_fixture()
        self.b2.account = "another-synthetic-account"
        self.b2.calls.clear()
        with self.assertRaisesRegex(config.SetupError, "different account"):
            self.setup_fixture()
        self.assertFalse(self.b2.calls)

    def test_nonprivate_recovery_file_rejected(self):
        self.setup_fixture()
        (self.directory / "setup.json").chmod(0o644)
        self.b2.calls.clear()
        with self.assertRaisesRegex(config.SetupError, "mode 0600"):
            self.setup_fixture()
        self.assertFalse(self.b2.calls)

    def test_interrupted_unlink_keeps_published_reply_readable(self):
        path = self.directory / "synthetic-key.json"
        with patch.object(config.os, "unlink", side_effect=OSError("synthetic interrupted cleanup")):
            with self.assertRaises(OSError):
                config.save_private(path, {"applicationKey": "synthetic-key"})
        self.assertEqual(os.stat(path).st_nlink, 2)
        self.assertEqual(config.private_json(path), {"applicationKey": "synthetic-key"})

    def test_ssh_error_does_not_echo_payload_or_remote_diagnostics(self):
        payload = {"repository.env": "SYNTHETIC=private-fixture", "password": "fixture-password"}
        # Capture the real function separately; subprocess remains mocked.
        with patch.object(config.subprocess, "run", return_value=subprocess.CompletedProcess(
                args=[], returncode=42, stdout="private-fixture", stderr="fixture-password")) as run:
            with self.assertRaisesRegex(config.SetupError, "exit 42") as error:
                self.real_install("files", payload)
        self.assertNotIn("private-fixture", str(error.exception))
        self.assertNotIn("fixture-password", str(error.exception))
        command = run.call_args.args[0]
        self.assertNotIn("private-fixture", " ".join(command))
        self.assertIn("StrictHostKeyChecking=yes", command)
        self.assertIn("fixture-password", run.call_args.kwargs["input"])


if __name__ == "__main__":
    unittest.main()
