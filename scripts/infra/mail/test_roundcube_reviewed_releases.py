from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from roundcube_reviewed_releases import DEFAULT, check_plan, load_review


class ReviewedReleasesTest(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / "review.json"
        self.review = deepcopy(DEFAULT)
        self.review["candidate"]["version"] = "1.7.10"
        self.review["candidate"]["archive_sha256"] = "a" * 64
        self.review["candidate"]["signature_sha256"] = "b" * 64
        url = "https://github.com/roundcube/roundcubemail/releases/download/1.7.10/roundcubemail-1.7.10-complete.tar.gz"
        self.plan = {"installed": "1.7.5", "candidate": {
            "version": "1.7.10",
            "archive": {"url": url, "sha256": "a" * 64},
            "signature": {"url": url + ".asc", "sha256": "b" * 64},
        }}

    def test_selected_plan_requires_matching_review_for_another_patch(self):
        self.path.write_text(json.dumps(self.review))
        check_plan(self.plan, load_review(self.path))
        with self.assertRaisesRegex(ValueError, "does not match"):
            check_plan(self.plan, load_review())

    def test_rejects_widened_or_incomplete_review(self):
        for entry in (
            {"version": "1.7.4"}, {"version": "1.7.5"}, {"version": "1.7.010"},
            {"version": "1.7.10-rc1"}, {"version": "1.8.0"},
            {"signer": "arbitrary"}, {"archive_sha256": None}, {"signature_sha256": "invalid"},
        ):
            with self.subTest(entry=entry):
                review = deepcopy(self.review)
                review["candidate"].update(entry)
                self.path.write_text(json.dumps(review))
                with self.assertRaises(ValueError):
                    load_review(self.path)

    def test_rejects_changed_selected_release_or_asset_identity(self):
        for key, value in (("installed", "1.7.4"), ("version", "1.7.11")):
            with self.subTest(key=key):
                plan = deepcopy(self.plan)
                (plan if key == "installed" else plan["candidate"])[key] = value
                with self.assertRaisesRegex(ValueError, "does not match"):
                    check_plan(plan, self.review)
        for asset in ("archive", "signature"):
            for field, value in (("url", "https://example.com/file"), ("sha256", "0" * 64)):
                with self.subTest(asset=asset, field=field):
                    plan = deepcopy(self.plan)
                    plan["candidate"][asset][field] = value
                    with self.assertRaisesRegex(ValueError, "does not match"):
                        check_plan(plan, self.review)

    def test_explicit_review_requires_selected_security_plan(self):
        self.path.write_text(json.dumps(self.review))
        result = subprocess.run(
            [sys.executable, "-B", str(Path(__file__).with_name("roundcube_reviewed_releases.py")), "--review", str(self.path)],
            capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires a selected security plan", result.stderr)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
