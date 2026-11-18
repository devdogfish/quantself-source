"""Synthetic initializer tests. No cloud or actual restic process."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    "initialize_b2_repository", Path(__file__).with_name("initialize-b2-repository.py"))
init = importlib.util.module_from_spec(spec)
spec.loader.exec_module(init)
ENV = {"RESTIC_REPOSITORY": "s3:https://s3.ca-east-006.backblazeb2.com/fixture-bucket/vault"}
ID = "a" * 64


class InitializeTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        self.b2 = Mock(bucket_id="fixture")
        self.b2.call.return_value = {"files": []}
        self.run = Mock()
        fake_private = patch.object(init, "private_file", side_effect=lambda path: path.read_text())
        fake_private.start()
        self.addCleanup(fake_private.stop)

    def test_empty_prefix_pages_and_durable_intent_before_first_init(self):
        self.b2.call.side_effect = [
            {"files": [{"bucketId": "fixture", "fileName": "vault/_verify/probe"}],
             "nextFileName": "vault/_verify/next", "nextFileId": "older"},
            {"files": []}, {"files": []},
        ]
        invocations = []

        def restic(env, *args):
            invocations.append(args)
            if args[0] == "init":
                self.assertEqual(json.loads((self.directory / init.INTENT).read_text())["bucketId"], "fixture")
                return Mock(returncode=0)
            return Mock(returncode=0, stdout=json.dumps({"version": 2, "id": ID})) if len(invocations) == 3 else Mock(returncode=1)

        self.assertEqual(init.initialize(ENV, self.b2, "vault", self.directory, run=restic), ID)
        self.assertEqual(invocations, [("--no-lock", "cat", "config"), ("init", "--repository-version", "2"),
                                       ("--no-lock", "cat", "config")])
        self.assertEqual(self.b2.call.call_args_list[1].kwargs["startFileId"], "older")

    def test_hidden_or_unfinished_object_blocks_init(self):
        for listing in (
            [{"files": [{"bucketId": "fixture", "fileName": "vault/config", "action": "hide"}]}],
            [{"files": []}, {"files": [{"bucketId": "fixture", "fileName": "vault/keys/partial"}]}],
        ):
            self.b2.call.side_effect = listing
            self.run.return_value = Mock(returncode=1)
            with self.assertRaisesRegex(init.VerifyError, "already has"):
                init.initialize(ENV, self.b2, "vault", self.directory, run=self.run)
        self.assertFalse((self.directory / init.INTENT).exists())
        self.assertEqual([call.args[1] for call in self.run.call_args_list], ["--no-lock", "--no-lock"])

    def test_ambiguous_init_only_rechecks_authenticated_config(self):
        self.run.side_effect = [Mock(returncode=1), subprocess.TimeoutExpired(["restic"], 45),
                                Mock(returncode=1), Mock(returncode=0, stdout=json.dumps({"version": 2, "id": ID}))]
        with self.assertRaises(subprocess.TimeoutExpired):
            init.initialize(ENV, self.b2, "vault", self.directory, run=self.run)
        with self.assertRaisesRegex(init.VerifyError, "Earlier initialization is unresolved"):
            init.initialize(ENV, self.b2, "vault", self.directory, run=self.run)
        self.assertEqual(init.initialize(ENV, self.b2, "vault", self.directory, run=self.run), ID)
        self.assertEqual(sum(call.args[1] == "init" for call in self.run.call_args_list), 1)

    def test_existing_authenticated_repository_is_reused_without_census_or_init(self):
        self.run.return_value = Mock(returncode=0, stdout=json.dumps({"version": 2, "id": ID}))
        self.assertEqual(init.initialize(ENV, self.b2, "vault", self.directory, run=self.run), ID)
        self.run.assert_called_once_with(ENV, "--no-lock", "cat", "config")
        self.b2.call.assert_not_called()
        self.assertFalse((self.directory / init.INTENT).exists())


if __name__ == "__main__":
    unittest.main()
