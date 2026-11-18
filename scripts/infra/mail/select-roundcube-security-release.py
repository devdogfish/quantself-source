#!/usr/bin/env python3
"""Select a stable Roundcube 1.7 security patch from official metadata."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess
from tempfile import TemporaryDirectory
from time import monotonic
from urllib.parse import urljoin


SITE = "https://roundcube.net"
SECURITY_INDEX = SITE + "/news/security/"
REPOSITORY = "https://github.com/roundcube/roundcubemail"
RELEASE_API = "https://api.github.com/repos/roundcube/roundcubemail/releases/tags/"
NOTICE_URL = re.compile(re.escape(SITE) + r"/news/[0-9]{4}/[0-9]{2}/[0-9]{2}/[a-z0-9][a-z0-9.-]*/?")
STABLE = re.compile(r"1\.7\.(0|[1-9][0-9]*)")
DIGEST = re.compile(r"sha256:([a-f0-9]{64})")
MAX_RESPONSE_BYTES = 512 * 1024
ACQUISITION_SECONDS = 25


class Notice(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.canonical = []
        self.links = set()
        self.security_tag = False
        self.in_security_link = False
        self.feed(html)
        self.close()

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        href = values.get("href")
        if tag == "link" and href is not None and values.get("rel") == "canonical":
            self.canonical.append(href)
        elif tag == "a":
            self.in_security_link = False
            if href is not None:
                link = urljoin(SITE, href)
                self.links.add(link)
                self.in_security_link = link.rstrip("/") == SITE + "/news/security"
        elif tag == "span" and self.in_security_link and "badge" in (values.get("class") or "").split():
            self.security_tag = True

    def handle_endtag(self, tag):
        if tag == "a":
            self.in_security_link = False


def security_notices(bulletins):
    notices = {}
    prefix = f"{REPOSITORY}/releases/tag/"
    for notice in bulletins:
        if (len(notice.canonical) != 1 or not NOTICE_URL.fullmatch(notice.canonical[0])
                or not notice.security_tag):
            raise ValueError("Expected an official Roundcube security bulletin")
        versions = [link[len(prefix):] for link in notice.links if link.startswith(prefix)]
        if not versions:
            raise ValueError("Security bulletin does not link an official release")
        for version in versions:
            if STABLE.fullmatch(version):
                notices.setdefault(version, set()).add(notice.canonical[0])
    return notices


def complete_asset(assets, version, suffix):
    name = f"roundcubemail-{version}-complete.tar.gz{suffix}"
    url = f"{REPOSITORY}/releases/download/{version}/{name}"
    matches = [asset for asset in assets if asset.get("name") == name]
    if len(matches) != 1 or matches[0].get("state") != "uploaded" or matches[0].get("browser_download_url") != url:
        raise ValueError(f"Expected exactly one uploaded official asset {name}")
    digest = matches[0].get("digest")
    if not isinstance(digest, str) or not (matched := DIGEST.fullmatch(digest)):
        raise ValueError(f"Missing SHA-256 digest for {name}")
    return {"url": url, "sha256": matched[1]}


def latest_announced_version(installed, notices):
    current = STABLE.fullmatch(installed)
    if current is None:
        raise ValueError("Installed version must be a stable Roundcube 1.7 patch")
    eligible = [version for version in notices if int(version.rsplit(".", 1)[1]) > int(current[1])]
    return max(eligible, key=lambda item: int(item.rsplit(".", 1)[1]), default=None)


def select_notices(installed, releases, notices):
    version = latest_announced_version(installed, notices)
    if version is None:
        return {"installed": installed, "candidate": None}

    matches = [release for release in releases if release.get("tag_name") == version]
    if len(matches) != 1:
        raise ValueError(f"Expected one official release record for announced security patch {version}")
    release = matches[0]
    published = release.get("published_at")
    if (release.get("draft") is not False or release.get("prerelease") is not False
            or not isinstance(published, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", published)
            or release.get("html_url") != f"{REPOSITORY}/releases/tag/{version}"):
        raise ValueError(f"Expected a published stable official release for {version}")

    assets = release.get("assets")
    if not isinstance(assets, list) or not all(isinstance(asset, dict) for asset in assets):
        raise ValueError(f"Release assets are missing for {version}")
    return {"installed": installed, "candidate": {
        "version": version,
        "bulletin_urls": sorted(notices[version]),
        "archive": complete_asset(assets, version, ""),
        "signature": complete_asset(assets, version, ".asc"),
    }}


def select(installed, releases, bulletins):
    return select_notices(installed, releases, security_notices(Notice(html) for html in bulletins))


class SecurityIndex(Notice):
    def __init__(self, html):
        self.headings = []
        self.articles = []
        self.paginated = False
        super().__init__(html)

    def handle_starttag(self, tag, attrs):
        super().handle_starttag(tag, attrs)
        values = dict(attrs)
        classes = (values.get("class") or "").split()
        if "next" in (values.get("rel") or "").split() or "pagination" in classes:
            self.paginated = True
        href = values.get("href")
        if tag == "a" and href is not None:
            if {"me-2", "text-body"} <= set(classes):
                self.headings.append(urljoin(SITE, href))
            if "read-link" in classes:
                self.articles.append(urljoin(SITE, href))


def indexed_articles(html):
    index = SecurityIndex(html)
    if (not html.rstrip().lower().endswith("</html>") or index.canonical != [SECURITY_INDEX]
            or index.paginated or not 1 <= len(index.articles) <= 20
            or len(set(index.articles)) != len(index.articles) or index.articles != index.headings
            or any(not NOTICE_URL.fullmatch(url) for url in index.articles)):
        raise ValueError("Official Roundcube security index is incomplete or has unexpected links")
    return index.articles


def fetch_official_response(url, deadline):
    api = url.startswith(RELEASE_API) and STABLE.fullmatch(url[len(RELEASE_API):]) is not None
    if not api and url != SECURITY_INDEX and not NOTICE_URL.fullmatch(url):
        raise ValueError("Unexpected Roundcube metadata URL")
    media = "application/json" if api else "text/html"
    remaining = min(7, deadline - monotonic())
    if remaining <= 0:
        raise ValueError("Roundcube metadata acquisition deadline expired")
    with TemporaryDirectory(prefix="qs-roundcube-response-") as scratch:
        body = Path(scratch) / "body"
        result = subprocess.run([
            "curl", "--disable", "--silent", "--show-error", "--fail", "--proto", "=https",
            "--connect-timeout", str(min(3, remaining)), "--max-time", str(remaining),
            "--max-filesize", str(MAX_RESPONSE_BYTES), "--header", f"Accept: {media}",
            "--header", "Cache-Control: no-cache", "--output", str(body),
            "--write-out", "%{http_code}\\n%{content_type}\\n%{url_effective}", url,
        ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=remaining)
        parts = result.stdout.splitlines()
        if len(parts) != 3 or parts[0] != "200" or parts[1].split(";", 1)[0].lower() != media or parts[2] != url:
            raise ValueError(f"Unexpected status, content type or origin for {url}")
        with body.open("rb") as response:
            data = response.read(MAX_RESPONSE_BYTES + 1)
        if not data or len(data) > MAX_RESPONSE_BYTES:
            raise ValueError(f"Invalid response size for {url}")
        return data.decode("utf-8")


def acquire(installed, fetch=fetch_official_response):
    latest_announced_version(installed, {})
    deadline = monotonic() + ACQUISITION_SECONDS
    urls = indexed_articles(fetch(SECURITY_INDEX, deadline))

    def bulletin(url):
        html = fetch(url, deadline)
        notice = Notice(html)
        if not html.rstrip().lower().endswith("</html>") or notice.canonical != [url]:
            raise ValueError(f"Incomplete or mismatched Roundcube security bulletin at {url}")
        return notice

    with ThreadPoolExecutor(max_workers=4) as workers:
        notices = security_notices(workers.map(bulletin, urls))
    if not notices:
        raise ValueError("Official index has no supported stable Roundcube 1.7 security notices")
    version = latest_announced_version(installed, notices)
    releases = []
    if version is not None:
        release = json.loads(fetch(RELEASE_API + version, deadline))
        if not isinstance(release, dict):
            raise ValueError("Expected the official GitHub release record")
        releases.append(release)
    if indexed_articles(fetch(SECURITY_INDEX, deadline)) != urls or monotonic() >= deadline:
        raise ValueError("Official security index changed or acquisition expired")
    return select_notices(installed, releases, notices)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installed", required=True)
    parser.add_argument("--releases", type=Path, help="Official GitHub release list as JSON")
    parser.add_argument("--bulletin", action="append", type=Path, help="Saved official bulletin HTML")
    parser.add_argument("--fetch-official", action="store_true", help="Acquire current official metadata over HTTPS")
    args = parser.parse_args()
    if args.fetch_official and (args.releases or args.bulletin):
        parser.error("Choose fresh discovery or saved metadata")
    if not args.fetch_official and not (args.releases and args.bulletin):
        parser.error("Use --fetch-official or supply --releases and --bulletin")
    try:
        if args.fetch_official:
            print(json.dumps(acquire(args.installed), indent=2))
            return
        releases = json.loads(args.releases.read_text())
        if not isinstance(releases, list) or not all(isinstance(release, dict) for release in releases):
            raise ValueError("Expected a JSON array of release records")
        print(json.dumps(select(args.installed, releases, (path.read_text() for path in args.bulletin)), indent=2))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
