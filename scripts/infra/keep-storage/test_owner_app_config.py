"""Synthetic-only handoff regression tests. No SSH or real credential access."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("owner_app_config", Path(__file__).with_name("owner-app-config.py"))
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)
TOKEN = "alpha bravo charlie delta echo foxtrot"
IMAGE = "sha256:" + "1" * 64


class OwnerAppConfigTest(unittest.TestCase):
    def test_diceware_spaces_preserved(self):
        self.assertEqual(config.parse_app_token(f"App token created for quantself\n token: {TOKEN}\n"), TOKEN)
        self.assertTrue(config.valid_app_token("synthetic_compact-123"))

    def test_ambiguous_unsafe_and_empty_output_rejected_without_echo(self):
        for output in (" token: \n", " token: aaaaaaaa\n token: bbbbbbbb\n",
                       " token: unsafe'quoted\n", " token: unsafe$syntax\n",
                       " token: unsafe\tcontrol\n", "unexpected-private-content"):
            with self.subTest(output=output), self.assertRaises(RuntimeError) as error:
                config.parse_app_token(output)
            self.assertNotIn(output, str(error.exception))

    def run_synthetic(self, directory, calls):
        def fake_remote(host, command, payload=None, timeout=120):
            calls.append((host, command, payload))
            if "cat /opt/keep-quantself/image-id" in command:
                return IMAGE
            if "auth-app create" in command:
                return f"App token created for quantself\n token: {TOKEN}\n"
            return ""

        with patch.object(config, "remote", side_effect=fake_remote), \
             patch.object(config.secrets, "token_hex", return_value="0" * 64), \
             patch.object(config.subprocess, "run", side_effect=AssertionError("No processes allowed in this test")), \
             patch.object(config.sys, "argv", ["test", "--email", "synthetic@example.invalid", "--recovery-directory", str(directory)]), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            config.main()
        self.assertNotIn(TOKEN, output.getvalue())

    def test_retry_reuses_saved_credentials_and_literal_compose_value(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            self.run_synthetic(Path(directory), calls)
            self.run_synthetic(Path(directory), calls)
            self.assertEqual(sum("auth-app create" in c[1] for c in calls), 1)
            payloads = [c[2] for c in calls if c[2] and "QUANTSELF_OPENCLOUD_TOKEN=" in c[2]]
            self.assertEqual(len(payloads), 2)
            self.assertEqual(payloads[0], payloads[1])
            self.assertIn(f"QUANTSELF_OPENCLOUD_TOKEN='{TOKEN}'\n", payloads[0])
            self.assertIn("$36b7656a-8f4c-4d30-8fdd-2934394b7102'", payloads[0])
            self.assertEqual(os.stat(Path(directory) / "keep-app-secrets.json").st_mode & 0o777, 0o600)

    def test_pending_response_reused_after_bundle_write_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            original = config.save_new
            calls = []

            def fail_bundle(path, value):
                if path.name == "keep-app-secrets.json":
                    raise OSError("synthetic interrupted write")
                original(path, value)

            with patch.object(config, "save_new", side_effect=fail_bundle), self.assertRaises(OSError):
                self.run_synthetic(Path(directory), calls)
            pending = Path(directory) / "keep-app-token-pending.json"
            self.assertEqual(pending.stat().st_mode & 0o777, 0o600)
            self.run_synthetic(Path(directory), calls)
            self.assertEqual(sum("auth-app create" in c[1] for c in calls), 1)
            self.assertEqual(json.loads((Path(directory) / "keep-app-secrets.json").read_text())["appToken"], TOKEN)


if __name__ == "__main__":
    unittest.main()
