from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import runpy
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from roundcube_release_assets import RELEASE_DOWNLOAD
from roundcube_reviewed_releases import DEFAULT


main = runpy.run_path(Path(__file__).with_name("check-roundcube-patch-readiness.py"))["main"]


class UnattendedQualificationTest(unittest.TestCase):
    def setUp(self):
        scratch = TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.installed = self.root / "installed.json"
        self.installed.write_text('{"version": "1.7.5"}')
        self.config_path = self.root / "job.json"
        self.config = {"installed_manifest": self.installed.name, "assets": "assets"}
        version = "1.7.6"
        url = f"{RELEASE_DOWNLOAD}{version}/roundcubemail-{version}-complete.tar.gz"
        pins = DEFAULT["candidate"]
        self.plan = {"installed": "1.7.5", "candidate": {
            "version": version,
            "archive": {"url": url, "sha256": pins["archive_sha256"]},
            "signature": {"url": url + ".asc", "sha256": pins["signature_sha256"]},
        }}
        self.calls = []
        self.fixture_failure = False

    def approve(self, review=DEFAULT):
        self.config["reviewed_release"] = "review.json"
        (self.root / "review.json").write_text(json.dumps(review))

    def run_command(self, command, **kwargs):
        self.calls.append(command)
        if len(self.calls) == 1:
            self.assertTrue(command[1].endswith("select-roundcube-security-release.py"))
            self.assertEqual(command[2:], ["--installed", self.plan["installed"], "--fetch-official"])
            return subprocess.CompletedProcess(command, 0, stdout=json.dumps(self.plan))

        self.assertEqual(command[2:], ["--joined-https", "--qualify-only"])
        env = kwargs["env"]
        self.assertNotIn("QS_ROUNDCUBE_FIXTURE_EXPECTED_MANIFEST", env)
        self.assertEqual(json.loads(Path(env["QS_ROUNDCUBE_FIXTURE_RELEASE_PLAN"]).read_text()), self.plan)
        self.assertEqual(json.loads(Path(env["QS_ROUNDCUBE_FIXTURE_REVIEWED_RELEASE"]).read_text()), DEFAULT)
        if self.fixture_failure:
            raise subprocess.CalledProcessError(1, command)
        Path(env["QS_ROUNDCUBE_FIXTURE_QUALIFICATION_MANIFEST"]).write_text('{"plugin.php": "hash"}')

    def execute(self, *extra):
        self.config_path.write_text(json.dumps(self.config))
        out, err = io.StringIO(), io.StringIO()
        argv = ["checker", "--qualification-config", str(self.config_path), *extra]
        with patch.object(sys, "argv", argv), patch.object(subprocess, "run", side_effect=self.run_command), \
                patch.dict(main.__globals__, {"download_selected_assets": self.fetch}), \
                redirect_stdout(out), redirect_stderr(err):
            try:
                main()
                code = 0
            except SystemExit as error:
                code = error.code
        return code, json.loads(out.getvalue()) if out.getvalue() else None, err.getvalue()

    def fetch(self, plan, assets, destination):
        self.assertEqual(plan, self.plan)
        self.assertEqual(assets, self.root / "assets")
        self.calls.append("download")
        return 4

    def test_no_candidate_uses_only_fresh_discovery(self):
        self.installed.write_text('{"version": "1.7.6"}')
        self.plan = {"installed": "1.7.6", "candidate": None}
        self.assertEqual(self.execute()[:2], (0, {"status": "no_candidate", "plan": self.plan}))
        self.assertEqual(len(self.calls), 1)

    def test_candidate_requires_explicit_review_even_for_builtin_pair(self):
        self.assertEqual(self.execute()[:2], (0, {"status": "review_required", "plan": self.plan}))
        self.assertEqual(len(self.calls), 1)

    def test_review_for_another_pair_still_requires_review(self):
        review = deepcopy(DEFAULT)
        review["prior"]["version"] = "1.7.4"
        self.approve(review)
        self.assertEqual(self.execute()[:2], (0, {"status": "review_required", "plan": self.plan}))
        self.assertEqual(len(self.calls), 1)

    def test_matching_review_only_qualifies_and_keeps_its_receipt(self):
        self.approve()
        code, result, diagnostic = self.execute()
        self.assertEqual(code, 0, diagnostic)
        self.assertEqual(result, {"status": "fixture_qualified", "plan": self.plan,
                                  "reviewed_release": DEFAULT, "plugin_files": {"plugin.php": "hash"}})
        self.assertEqual(len(self.calls), 3)
        self.assertIn("4 HTTP requests", diagnostic)

    def test_drift_on_an_approved_tag_fails_before_transfers(self):
        self.approve()
        self.plan["candidate"]["signature"]["sha256"] = "0" * 64
        code, result, diagnostic = self.execute()
        self.assertEqual((code, result), (1, {"status": "failed"}))
        self.assertIn("does not match the reviewed release pair", diagnostic)
        self.assertEqual(len(self.calls), 1)

    def test_fixture_failure_emits_no_qualification_receipt(self):
        self.approve()
        self.fixture_failure = True
        self.assertEqual(self.execute()[:2], (1, {"status": "failed"}))
        self.assertEqual(len(self.calls), 3)

    def test_group_writable_or_symlinked_manifest_fails_before_discovery(self):
        self.installed.chmod(0o664)
        self.assertEqual(self.execute()[:2], (1, {"status": "failed"}))
        self.installed.chmod(0o644)
        symlink = self.root / "linked.json"
        symlink.symlink_to(self.installed)
        self.config["installed_manifest"] = symlink.name
        self.assertEqual(self.execute()[:2], (1, {"status": "failed"}))
        self.assertEqual(self.calls, [])

    def test_job_cannot_override_installed_or_revalidate_cutover(self):
        for option in ("--installed", "--revalidate-receipt"):
            with self.subTest(option=option):
                code, result, diagnostic = self.execute(option, "override")
                self.assertEqual((code, result), (2, None))
                self.assertIn("Use --qualification-config by itself", diagnostic)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
