from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from time import monotonic
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from roundcube_release_assets import (
    ARCHIVE_LIMIT,
    CDN,
    RELEASE_DOWNLOAD,
    SIGNATURE_LIMIT,
    download_selected_assets,
    request_asset,
)


ARCHIVE = "roundcubemail-1.7.6-complete.tar.gz"
SIGNATURE = ARCHIVE + ".asc"
BASE = RELEASE_DOWNLOAD + "1.7.6/"
SIGNED = f"https://{CDN}/github-production-release-asset/4224042/f00d-baad?fixture=transient"


class ReleaseAssetTest(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.inputs = root / "trusted"
        self.inputs.mkdir()
        for name in ("pubkey.asc", "roundcubemail-1.7.5-complete.tar.gz", "roundcubemail-1.7.5-complete.tar.gz.asc"):
            (self.inputs / name).write_bytes(name.encode())
        self.staged = root / "staged"
        self.plan = {"installed": "1.7.5", "candidate": {
            "version": "1.7.6", "archive": {"url": BASE + ARCHIVE}, "signature": {"url": BASE + SIGNATURE},
        }}

    def download(self, request):
        return download_selected_assets(self.plan, self.inputs, self.staged, request)

    def test_two_independent_assets_each_follow_one_verified_cdn_redirect(self):
        calls = []

        def request(url, destination, limit, deadline):
            calls.append((url, destination.name, limit, deadline))
            if url == SIGNED:
                destination.write_bytes(destination.name.encode())
                return "200", ""
            return "302", SIGNED

        self.assertEqual(self.download(request), 4)
        self.assertCountEqual([(url, file, limit) for url, file, limit, _ in calls], [
            (BASE + ARCHIVE, ARCHIVE, ARCHIVE_LIMIT), (SIGNED, ARCHIVE, ARCHIVE_LIMIT),
            (BASE + SIGNATURE, SIGNATURE, SIGNATURE_LIMIT), (SIGNED, SIGNATURE, SIGNATURE_LIMIT),
        ])
        self.assertEqual(len({deadline for _, _, _, deadline in calls}), 1)
        self.assertEqual((self.staged / "pubkey.asc").read_bytes(), (self.inputs / "pubkey.asc").read_bytes())
        self.assertFalse((self.inputs / ARCHIVE).exists())
        self.assertEqual((self.staged / ARCHIVE).read_bytes(), ARCHIVE.encode())
        self.assertEqual((self.staged / SIGNATURE).read_bytes(), SIGNATURE.encode())

    def test_handles_direct_200_with_two_requests(self):
        def request(url, destination, limit, deadline):
            destination.write_bytes(b"complete response")
            return "200", ""

        self.assertEqual(self.download(request), 2)

    def test_rejects_wrong_initial_url_before_any_request(self):
        self.plan["candidate"]["signature"]["url"] = BASE + ARCHIVE
        with patch(__name__ + ".request_asset") as request, self.assertRaisesRegex(ValueError, "Unexpected official"):
            self.download(request)
        request.assert_not_called()
        self.assertFalse(self.staged.exists())

    def test_rejects_off_origin_or_other_repository_redirect(self):
        for bad in (
                SIGNED.replace(CDN, "example.test"), SIGNED.replace("https:", "http:"),
                SIGNED.replace("4224042", "4224043"), SIGNED.replace(CDN, "user@" + CDN),
                SIGNED + "#fragment"):
            with self.subTest(bad=bad):
                self.staged = self.staged.with_name(self.staged.name + "x")
                calls = []

                def request(url, destination, limit, deadline):
                    calls.append(url)
                    return "302", bad

                with self.assertRaisesRegex(ValueError, "Unexpected GitHub asset redirect"):
                    self.download(request)
                self.assertTrue(calls)
                self.assertTrue(all(url.startswith(BASE) for url in calls))

    def test_rejects_second_redirect_and_incomplete_body(self):
        for reply in (("302", SIGNED), ("206", ""), ("200", "")):
            with self.subTest(reply=reply):
                self.staged = self.staged.with_name(self.staged.name + "x")

                def request(url, destination, limit, deadline):
                    return reply if url == SIGNED else ("302", SIGNED)

                with self.assertRaisesRegex(ValueError, "Incomplete official download"):
                    self.download(request)

    def test_missing_local_trust_input_prevents_remote_requests(self):
        (self.inputs / "pubkey.asc").unlink()
        with patch(__name__ + ".request_asset") as request, self.assertRaises(FileNotFoundError):
            self.download(request)
        request.assert_not_called()

    def test_rejects_response_over_its_asset_limit(self):
        def request(url, destination, limit, deadline):
            with destination.open("wb") as asset:
                asset.truncate(limit + 1)
            return "200", ""

        with self.assertRaisesRegex(ValueError, "Incomplete official download"):
            self.download(request)

    def test_signed_redirect_uses_stdin_and_bounded_https_transfer(self):
        with patch("subprocess.run", return_value=SimpleNamespace(returncode=0, stdout="200\n")) as run:
            self.assertEqual(request_asset(SIGNED, self.staged / ARCHIVE, ARCHIVE_LIMIT, monotonic() + 2), ("200", ""))
            args, options = run.call_args.args[0], run.call_args.kwargs
            self.assertEqual(args[:2], ["curl", "--disable"])
            self.assertEqual(args[args.index("--proto") + 1], "=https")
            self.assertEqual(args[args.index("--max-filesize") + 1], str(ARCHIVE_LIMIT))
            self.assertNotIn("--location", args)
            self.assertNotIn(SIGNED, args)
            self.assertIn(SIGNED, options["input"])
            self.assertLessEqual(options["timeout"], 2)

    def test_timeout_withholds_signed_url_and_expired_budget_avoids_curl(self):
        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("curl", 1)) as run:
            with self.assertRaisesRegex(ValueError, "^Timed out fetching " + ARCHIVE):
                request_asset(SIGNED, self.staged / ARCHIVE, ARCHIVE_LIMIT, monotonic() + 2)
            with self.assertRaisesRegex(ValueError, "deadline expired"):
                request_asset(SIGNED, self.staged / ARCHIVE, ARCHIVE_LIMIT, monotonic() - 1)
            self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
