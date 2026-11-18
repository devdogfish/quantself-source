import runpy
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


fixture = runpy.run_path(str(Path(__file__).with_name("prove-vault-drain.py")))
classify = fixture["classify"]
dav_root = fixture["dav_root"]
body = fixture["BODY"]
ProofError = fixture["ProofError"]


class VaultDrainEvidenceTests(unittest.TestCase):
    def test_pinned_upload_sessions_shape(self):
        count = fixture["upload_session_count"]
        self.assertEqual(count("null"), 0)
        self.assertEqual(count("[]"), 0)
        self.assertEqual(count('[{"id":"fixture","processing":false}]'), 1)
        for invalid in ('{}', '[{}]', '[{"id":""}]'):
            with self.subTest(invalid=invalid), self.assertRaises(ProofError):
                count(invalid)

    def test_accepts_acknowledged_full_object_or_absent_aborted_object(self):
        self.assertEqual(classify(201, 200, body), "completed")
        self.assertEqual(classify(None, 404, b""), "aborted_without_visible_object")
        self.assertEqual(classify(503, 404, b""), "aborted_without_visible_object")

    def test_rejects_partial_objects_and_unexplained_success(self):
        with self.assertRaises(ProofError):
            classify(201, 200, body[:-1])
        with self.assertRaises(ProofError):
            classify(201, 404, b"")
        with self.assertRaises(ProofError):
            classify(None, 200, body[:-1])
        with self.assertRaises(ProofError):
            classify(401, 404, b"")

    def test_dav_root_rejects_external_or_non_dav_target(self):
        def personal(url):
            return {"value": [{"driveType": "personal", "root": {"webDavUrl": url}}]}

        self.assertEqual(
            dav_root(personal("https://vault-fixture.test:9200/dav/spaces/alpha$beta/")),
            "/dav/spaces/alpha$beta",
        )
        for url in ("https://other.example/dav/spaces/alpha",
                    "https://vault-fixture.test:9200/dav/spaces/..",
                    "https://vault-fixture.test:9200/graph/v1.0/me"):
            with self.subTest(url=url), self.assertRaises(ProofError):
                dav_root(personal(url))

    def test_staging_reader_ignores_symlinks_hardlinks_and_fifos(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            uploads = directory / "data/storage/users/uploads"
            uploads.mkdir(parents=True)
            outside = directory / "outside"
            outside.write_bytes(fixture["PREFIX"])
            (uploads / "symlink").symlink_to(outside)
            os.link(outside, uploads / "hardlink")
            os.mkfifo(uploads / "fifo")
            self.assertFalse(fixture["staged_prefix"](directory))
            (uploads / "admitted").write_bytes(fixture["PREFIX"])
            self.assertTrue(fixture["staged_prefix"](directory))

    def test_staging_reader_rejects_symlinked_parent(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            target = directory / "elsewhere"
            (target / "storage/users/uploads").mkdir(parents=True)
            (directory / "data").symlink_to(target)
            with self.assertRaises(OSError):
                fixture["staged_prefix"](directory)

    def test_scratch_rejects_symlink_before_using_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            (directory / "actual").mkdir()
            alias = directory / "alias"
            alias.symlink_to(directory / "actual")
            with self.assertRaisesRegex(ProofError, "canonical"):
                fixture["scratch_parent"](alias)

    def test_docker_is_pinned_to_local_socket(self):
        with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 0, stdout="fixture-id\n")) as run, patch.dict(os.environ, {
                    "DOCKER_HOST": "ssh://remote.example", "DOCKER_CONTEXT": "production"}):
            self.assertEqual(fixture["command"]("docker", "network", "ls"), "fixture-id")
        self.assertEqual(run.call_args.args[0][:3],
                         ("/usr/bin/docker", "--host", "unix:///var/run/docker.sock"))
        self.assertNotIn("DOCKER_HOST", run.call_args.kwargs["env"])
        self.assertNotIn("DOCKER_CONTEXT", run.call_args.kwargs["env"])

    def test_create_timeout_names_fixture_for_exact_label_reconciliation(self):
        vault = fixture["Fixture"](Path("/synthetic"))
        with patch.object(subprocess, "run", side_effect=subprocess.TimeoutExpired(["docker"], 15)):
            with self.assertRaisesRegex(ProofError, vault.name):
                vault.create("network", "create")
        self.assertIsNone(vault.network)


if __name__ == "__main__":
    unittest.main()
