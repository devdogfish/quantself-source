#!/usr/bin/env python3
"""Run an owner SSH command with the private Keep Storage host pins."""

import base64
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile


MAX_PIN_BYTES = 4096
ED25519_KEY_PREFIX = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20"


def read_pins(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError("private pin file required")
        pins = source.read(MAX_PIN_BYTES + 1)
    if len(pins) > MAX_PIN_BYTES:
        raise ValueError("pin file too large")

    hosts = set()
    for line in pins.splitlines():
        host, algorithm, key = line.split()
        if not re.fullmatch(rb"[A-Za-z0-9][A-Za-z0-9._-]*", host) or algorithm != b"ssh-ed25519":
            raise ValueError("direct Ed25519 host pin required")
        decoded = base64.b64decode(key, validate=True)
        if not decoded.startswith(ED25519_KEY_PREFIX) or len(decoded) != len(ED25519_KEY_PREFIX) + 32:
            raise ValueError("invalid Ed25519 host pin")
        if host.lower() in hosts:
            raise ValueError("duplicate host pin")
        hosts.add(host.lower())
    if len(hosts) != 3:
        raise ValueError("three host pins required")
    return pins


def main(args):
    try:
        pins = read_pins(os.environ["KEEP_SSH_KNOWN_HOSTS"])
        with tempfile.TemporaryDirectory(prefix="keep-ssh-", dir="/tmp") as directory:
            staged = Path(directory) / "known_hosts"
            with staged.open("xb") as target:
                os.fchmod(target.fileno(), 0o600)
                target.write(pins)
            process = subprocess.run(
                [
                    "ssh",
                    "-o", "StrictHostKeyChecking=yes",
                    "-o", f"UserKnownHostsFile={staged}",
                    "-o", "GlobalKnownHostsFile=/dev/null",
                    "-o", "KnownHostsCommand=none",
                    "-o", "VerifyHostKeyDNS=no",
                    "-o", "UpdateHostKeys=no",
                    "-o", "ControlPath=none",
                    *args,
                ],
                stderr=subprocess.DEVNULL,
            )
    except (KeyError, OSError, ValueError):
        print("SSH pin setup failed (1)", file=sys.stderr)
        return 1
    if process.returncode:
        print("Pinned SSH command failed (1)", file=sys.stderr)
    return process.returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
