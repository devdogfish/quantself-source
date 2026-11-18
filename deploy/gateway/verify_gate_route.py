#!/usr/bin/env python3
"""Compare a staged Gate relay to the reviewed policy rendered for Atlas."""

import argparse
from ipaddress import IPv4Address, IPv4Network
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


GATEWAY = Path(__file__).resolve().parent
TAILNET = IPv4Network("100.64.0.0/10")
POLICIES = {
    "funnel": ("Gate.Funnel.Caddyfile", {"QUANTSELF_FUNNEL_HOST"}),
    "legacy": ("Gate.Caddyfile", {"GATE_TAILNET_IP", "HOSTINGER_TAILNET_IP"}),
}
ORIGIN = "QUANTSELF_TAILNET_IP"
KEEP = "FENCED_KEEP_TAILNET_IP"
FUNNEL_HOST = "QUANTSELF_FUNNEL_HOST"


def unique_keys(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("Duplicate approved settings")
    return result


def read_approval(path, ingress):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or not 0 < info.st_size <= 4096):
            raise ValueError("Expected a private owner-only approval file")
        raw = source.read(4097)
    if len(raw) > 4096:
        raise ValueError("Oversized approval file")
    settings = json.loads(raw, object_pairs_hook=unique_keys)
    if (not isinstance(settings, dict) or set(settings) != ingress | {ORIGIN, KEEP}
            or any(not isinstance(value, str) for value in settings.values())):
        raise ValueError("Incorrect approved settings")
    if FUNNEL_HOST in settings and not re.fullmatch(
        r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net",
        settings[FUNNEL_HOST],
    ):
        raise ValueError("Invalid Funnel hostname")
    addresses = [IPv4Address(settings[key]) for key in sorted(settings.keys() - {FUNNEL_HOST})]
    if len(addresses) != len(set(addresses)) or any(ip not in TAILNET for ip in addresses):
        raise ValueError("Expected distinct approved tailnet IPs")
    del settings[KEEP]
    return settings


def adapt(caddy, path, settings):
    result = subprocess.run(
        [caddy, "adapt", "--config", str(path), "--adapter", "caddyfile"],
        env={"PATH": os.defpath, **settings},
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, check=True,
    )
    return json.loads(result.stdout)


def verify(mode, candidate, approval, caddy):
    filename, ingress = POLICIES[mode]
    expected = read_approval(approval, ingress)
    observed = {key: os.environ.get(key) for key in expected}
    if observed != expected:
        raise ValueError("Staged relay settings differ from the approved Atlas origin or Gate ingress")
    if adapt(caddy, candidate, observed) != adapt(caddy, GATEWAY / filename, expected):
        raise ValueError("Staged Caddy routes differ from the reviewed Atlas relay policy")
    return {"verified_relays": 1}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("relay", choices=POLICIES)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("approval", type=Path, help="Independent owner-only approved route settings (JSON)")
    parser.add_argument("--caddy", default="/usr/local/bin/caddy")
    args = parser.parse_args()
    try:
        result = verify(args.relay, args.candidate, args.approval, args.caddy)
    except (OSError, subprocess.SubprocessError, ValueError):
        # Adapter errors and malformed inputs can include private configuration values.
        print('{"verified_relays": 0}', file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
