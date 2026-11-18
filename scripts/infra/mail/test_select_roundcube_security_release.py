import copy
import json
from pathlib import Path
import runpy
import subprocess
from time import monotonic
from types import SimpleNamespace
import unittest
from unittest.mock import patch


selector = runpy.run_path(Path(__file__).with_name("select-roundcube-security-release.py"))
select = selector["select"]
acquire = selector["acquire"]
fetch_response = selector["fetch_official_response"]
SITE = "https://roundcube.net"
REPOSITORY = "https://github.com/roundcube/roundcubemail"
INDEX = selector["SECURITY_INDEX"]
API = selector["RELEASE_API"]


def bulletin(*versions):
    links = "".join(f'<a href="{REPOSITORY}/releases/tag/{version}"></a>' for version in versions)
    return f'<link rel="canonical" href="{SITE}/news/2026/11/09/security-update">' \
           f'<a href="/news/security"><span class="badge">Security</span></a>{links}'


def release(version):
    prefix = f"roundcubemail-{version}-complete.tar.gz"
    assets = [
        {"name": name, "state": "uploaded", "digest": "sha256:" + letter * 64,
         "browser_download_url": f"{REPOSITORY}/releases/download/{version}/{name}"}
        for name, letter in ((prefix, "a"), (prefix + ".asc", "b"))
    ]
    return {"tag_name": version, "draft": False, "prerelease": False, "published_at": "2026-11-09T12:01:54Z",
            "html_url": f"{REPOSITORY}/releases/tag/{version}", "assets": assets}


class SelectSecurityReleaseTest(unittest.TestCase):
    def test_numeric_latest_announced_stable_in_series_ignores_order_and_other_releases(self):
        versions = ["1.8.0", "1.7.9", "1.7.11", "1.6.21", "1.7.10-rc1", "1.7.10"]
        candidate = select("1.7.6", [release(version) for version in versions],
                           [bulletin("1.7.9", "1.6.21"), bulletin("1.7.10", "1.8.0", "1.7.10-rc1")])["candidate"]
        self.assertEqual(candidate["version"], "1.7.10")
        self.assertEqual(candidate["archive"]["sha256"], "a" * 64)
        self.assertEqual(candidate["signature"]["sha256"], "b" * 64)

    def test_no_upgrade_when_only_equal_older_or_other_series_announced(self):
        self.assertIsNone(select("1.7.6", [], [bulletin("1.7.5", "1.7.6", "1.8.0")])["candidate"])

    def test_installed_version_must_be_stable_1_7(self):
        for version in ("1.6.21", "1.8.0", "1.7.06", "1.7-rc6"):
            with self.subTest(version=version), self.assertRaises(ValueError):
                select(version, [], [bulletin("1.7.6")])

    def test_requires_official_security_notice_with_release_links(self):
        for notice in (bulletin("1.7.6").replace(SITE, "https://example.test"),
                       bulletin("1.7.6").replace("/news/security", "/news/updates"),
                       bulletin("1.7.6").replace('class="badge"', ""), bulletin()):
            with self.subTest(notice=notice), self.assertRaises(ValueError):
                select("1.7.5", [release("1.7.6")], [notice])

    def test_announced_tag_must_have_one_published_stable_release(self):
        for records in ([], [release("1.7.6"), release("1.7.6")],
                        [dict(release("1.7.6"), draft=True)], [dict(release("1.7.6"), prerelease=True)]):
            with self.subTest(records=records), self.assertRaises(ValueError):
                select("1.7.5", records, [bulletin("1.7.6")])

    def test_no_fall_back_when_newest_assets_are_missing(self):
        candidate = release("1.7.7")
        candidate["assets"].pop()
        with self.assertRaisesRegex(ValueError, r"1\.7\.7-complete\.tar\.gz\.asc"):
            select("1.7.5", [release("1.7.6"), candidate], [bulletin("1.7.6"), bulletin("1.7.7")])

    def test_rejects_redirected_duplicate_pending_or_digestless_asset(self):
        for change in ({"browser_download_url": "https://example.test/signature"}, {"state": "open"},
                       {"digest": None}, None):
            candidate = release("1.7.6")
            if change is None:
                candidate["assets"].append(copy.copy(candidate["assets"][1]))
            else:
                candidate["assets"][1].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                select("1.7.5", [candidate], [bulletin("1.7.6")])


def index_page(*urls):
    rows = "".join(f'<a class="me-2 text-body" href="{url}">Title</a>'
                   f'<a class="read-link" href="{url}">Continue</a>' for url in urls)
    return f'<html><link rel="canonical" href="{INDEX}">{rows}</html>'


class OfficialAcquisitionTest(unittest.TestCase):
    older = SITE + "/news/2026/10/19/older"
    newer = SITE + "/news/2026/11/09/newer"

    def setUp(self):
        marker = SITE + "/news/2026/11/09/security-update"
        self.responses = {
            INDEX: index_page(self.older, self.newer),
            self.older: "<html>" + bulletin("1.7.5").replace(marker, self.older) + "</html>",
            self.newer: "<html>" + bulletin("1.6.21", "1.7.6").replace(marker, self.newer) + "</html>",
            API + "1.7.6": json.dumps(release("1.7.6")),
        }
        self.calls = []

    def fetch(self, url, deadline):
        self.calls.append((url, deadline))
        response = self.responses[url]
        if isinstance(response, Exception):
            raise response
        return response

    def test_revalidates_whole_index_and_fetches_one_exact_release_record(self):
        plan = acquire("1.7.5", self.fetch)
        self.assertEqual(plan["candidate"]["version"], "1.7.6")
        self.assertEqual(plan["candidate"]["bulletin_urls"], [self.newer])
        self.assertCountEqual([url for url, _ in self.calls], [INDEX, self.older, self.newer, API + "1.7.6", INDEX])
        self.assertEqual(len({deadline for _, deadline in self.calls}), 1)

    def test_no_candidate_requires_all_notices_but_no_github_request(self):
        self.assertIsNone(acquire("1.7.6", self.fetch)["candidate"])
        self.assertCountEqual([url for url, _ in self.calls], [INDEX, self.older, self.newer, INDEX])

    def test_rejects_incomplete_paginated_and_off_origin_indexes_before_following_links(self):
        for index in (index_page(self.newer).replace('class="read-link"', ""),
                      index_page(self.newer).replace("</html>", '<a rel="next" href="/next">Next</a></html>'),
                      index_page(self.newer).replace("</html>", ""),
                      index_page("https://example.test/news/2026/11/09/newer")):
            with self.subTest(index=index):
                self.calls.clear()
                self.responses[INDEX] = index
                with self.assertRaisesRegex(ValueError, "security index"):
                    acquire("1.7.5", self.fetch)
                self.assertEqual([url for url, _ in self.calls], [INDEX])

    def test_missing_or_incomplete_bulletin_never_yields_a_partial_selection(self):
        for bad in (subprocess.TimeoutExpired("curl", 7), self.responses[self.newer].replace("</html>", ""),
                    self.responses[self.older]):
            with self.subTest(bad=bad):
                self.calls.clear()
                self.responses[self.newer] = bad
                with self.assertRaises((ValueError, subprocess.TimeoutExpired)):
                    acquire("1.7.6", self.fetch)
                self.assertFalse(any(url.startswith(API) for url, _ in self.calls))

    def test_rejects_index_change_during_acquisition(self):
        def changed(url, deadline):
            if url == INDEX and self.calls:
                return index_page(self.newer)
            return self.fetch(url, deadline)

        with self.assertRaisesRegex(ValueError, "index changed"):
            acquire("1.7.5", changed)

    def test_rejects_truncated_or_wrong_release_record(self):
        for response in ('{"tag_name":', json.dumps(release("1.7.5"))):
            with self.subTest(response=response), self.assertRaises(ValueError):
                self.responses[API + "1.7.6"] = response
                acquire("1.7.5", self.fetch)

    def test_http_response_requires_requested_url_status_media_type_and_bounded_body(self):
        for status, media, url, size in (
                ("302", "text/html", INDEX, 1), ("200", "text/html", "https://example.test/", 1),
                ("200", "text/plain", INDEX, 1), ("200", "text/html", INDEX, 0),
                ("200", "text/html", INDEX, selector["MAX_RESPONSE_BYTES"] + 1)):
            def respond(args, **options):
                self.assertEqual(args[:2], ["curl", "--disable"])
                self.assertNotIn("--location", args)
                self.assertNotIn("--insecure", args)
                self.assertLessEqual(options["timeout"], 2)
                Path(args[args.index("--output") + 1]).write_bytes(b"x" * size)
                return SimpleNamespace(stdout=f"{status}\n{media}\n{url}")

            with self.subTest(status=status, media=media, url=url, size=size), patch("subprocess.run", side_effect=respond):
                with self.assertRaises(ValueError):
                    fetch_response(INDEX, monotonic() + 2)

    def test_http_refuses_unknown_origin_and_expired_budget_before_starting_curl(self):
        with patch("subprocess.run") as run:
            with self.assertRaisesRegex(ValueError, "Unexpected Roundcube metadata URL"):
                fetch_response("https://example.test/news/2026/11/09/newer", monotonic() + 2)
            with self.assertRaisesRegex(ValueError, "deadline expired"):
                fetch_response(INDEX, monotonic() - 1)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
