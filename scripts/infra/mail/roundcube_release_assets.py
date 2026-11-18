"""Fetch only the official candidate assets into the disposable staging input."""

from concurrent.futures import ThreadPoolExecutor
import json
import re
from shutil import copyfile
import subprocess
from time import monotonic
from urllib.parse import urlsplit


RELEASE_DOWNLOAD = "https://github.com/roundcube/roundcubemail/releases/download/"
CDN = "release-assets.githubusercontent.com"
CDN_PATH = re.compile(r"/github-production-release-asset/4224042/[a-f0-9-]+")
STABLE = re.compile(r"1\.7\.(?:0|[1-9][0-9]*)")
ARCHIVE_LIMIT = 32 * 1024 * 1024
SIGNATURE_LIMIT = 64 * 1024
PAIR_TIMEOUT = 45


def cdn_redirect(url):
    if not all("!" <= char <= "~" and char not in '"\\' for char in url):
        return False
    try:
        target = urlsplit(url)
    except ValueError:
        return False
    return (target.scheme == "https" and target.netloc == CDN and bool(CDN_PATH.fullmatch(target.path))
            and bool(target.query) and not target.fragment)


def request_asset(url, destination, limit, deadline):
    remaining = min(30, deadline - monotonic())
    if remaining <= 0:
        raise ValueError("Roundcube asset transfer deadline expired")
    try:
        # Keep the CDN's transient signed query out of the shell, process arguments and diagnostics.
        response = subprocess.run([
            "curl", "--disable", "--silent", "--show-error", "--globoff", "--proto", "=https",
            "--connect-timeout", str(min(5, remaining)), "--max-time", str(remaining),
            "--max-filesize", str(limit), "--header", "Cache-Control: no-cache",
            "--output", str(destination), "--write-out", "%{http_code}\\n%{redirect_url}", "--config", "-",
        ], input=f"url = {json.dumps(url)}\n", capture_output=True, text=True, timeout=remaining)
    except subprocess.TimeoutExpired:
        raise ValueError(f"Timed out fetching {destination.name}") from None
    if response.returncode:
        raise ValueError(f"Transfer of {destination.name} failed (curl exit {response.returncode})")
    status, separator, redirect = response.stdout.partition("\n")
    if not separator:
        raise ValueError(f"Invalid transfer response for {destination.name}")
    return status, redirect


def download_selected_assets(plan, local_assets, destination, request=request_asset):
    installed = plan["installed"]
    candidate = plan["candidate"]
    version = candidate["version"]
    if not STABLE.fullmatch(installed) or not STABLE.fullmatch(version):
        raise ValueError("Expected stable Roundcube 1.7 release assets")
    basename = f"roundcubemail-{version}-complete.tar.gz"
    urls = []
    for kind, name in (("archive", basename), ("signature", basename + ".asc")):
        url = RELEASE_DOWNLOAD + version + "/" + name
        if candidate[kind]["url"] != url:
            raise ValueError(f"Unexpected official {kind} URL")
        urls.append((url, name, ARCHIVE_LIMIT if kind == "archive" else SIGNATURE_LIMIT))

    destination.mkdir(mode=0o700)
    prior = f"roundcubemail-{installed}-complete.tar.gz"
    for name in (prior, prior + ".asc", "pubkey.asc"):
        copyfile(local_assets / name, destination / name)

    deadline = monotonic() + PAIR_TIMEOUT

    def download(asset):
        url, name, limit = asset
        output = destination / name
        status, location = request(url, output, limit, deadline)
        requests = 1
        if status == "302":
            if not cdn_redirect(location):
                raise ValueError(f"Unexpected GitHub asset redirect for {name}")
            status, location = request(location, output, limit, deadline)
            requests += 1
        if status != "200" or location or not output.is_file() or not 0 < output.stat().st_size <= limit:
            raise ValueError(f"Incomplete official download for {name}")
        return requests

    with ThreadPoolExecutor(max_workers=2) as workers:
        count = sum(workers.map(download, urls))
    if monotonic() >= deadline:
        raise ValueError("Roundcube asset transfer deadline expired")
    return count
