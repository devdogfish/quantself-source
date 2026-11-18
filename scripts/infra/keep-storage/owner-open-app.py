#!/usr/bin/env python3
"""Owner-only: create a short-lived setup link and open it without printing it."""
import importlib.util
import os
from pathlib import Path
import re
import sys
from urllib.parse import parse_qs, urlsplit
import webbrowser


def expected_setup_host():
    try:
        origin = urlsplit(os.environ.get("KEEP_BETTER_AUTH_URL", ""))
        if (origin.scheme == "https" and origin.hostname and origin.username is None and
                origin.password is None and origin.path in ("", "/") and not origin.query and
                not origin.fragment and origin.port != 0):
            return origin.netloc
    except ValueError:
        pass
    raise RuntimeError("Explicit private HTTPS setup origin required")


def main():
    host = expected_setup_host()
    spec = importlib.util.spec_from_file_location("owner_app_config", Path(__file__).with_name("owner-app-config.py"))
    config = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(config)
    print("Creating a temporary Owner setup link; no credential is displayed.")
    output = config.remote("quantself", "sudo -n docker exec keep-quantself-api-1 bun run --cwd packages/auth owner-setup:create --expires-in-minutes 15")
    links = [line for line in output.splitlines() if line.startswith("https://")]
    if len(links) != 1:
        raise RuntimeError("Setup did not return one expected link; no values displayed")
    url = urlsplit(links[0])
    query = parse_qs(url.query)
    if (url.scheme != "https" or url.netloc != host or
            url.path != "/setup/owner" or url.fragment or set(query) != {"token"} or
            len(query["token"]) != 1 or not re.fullmatch(r"[A-Za-z0-9_-]{16,256}", query["token"][0])):
        raise RuntimeError("Setup link format unexpected; no values displayed")
    if not webbrowser.open(links[0], new=2):
        raise RuntimeError("Browser did not open; temporary link expires after 15 minutes")
    print("Browser opened. Click Create owner passkey and save it in Proton Pass.")
    print("Do not paste the address or passkey into chat. Reply after the dashboard opens.")


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print(str(error) if isinstance(error, RuntimeError) else "Setup stopped; no credential values displayed.", file=sys.stderr)
        sys.exit(1)
