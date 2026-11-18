#!/usr/bin/env python3
"""Receive a disposable Atlas relay rehearsal request as an SSH forced command."""

import os
from pathlib import Path
import re
import select
import subprocess
import sys
import time


VERIFIER = Path("/usr/local/libexec/quantself-atlas/atlas-control-admit.py")
MAX_FRAME = 4256
READ_TIMEOUT = 5
VERIFY_TIMEOUT = 21
VERIFY_SUCCESS = b"Control run admitted.\n"
FRAME = re.compile(
    rb"promote-atlas ([0-9a-f]{40}) ([1-9][0-9]{0,19}) ([1-9][0-9]{0,9})\n"
    rb"(ghs_[A-Za-z0-9_.-]{1,4091})\n"
)


def read_frame(fd=0):
    deadline = time.monotonic() + READ_TIMEOUT
    data = bytearray()
    while len(data) <= MAX_FRAME:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            break
        block = os.read(fd, MAX_FRAME + 1 - len(data))
        if not block:
            match = FRAME.fullmatch(data)
            if match:
                return match.groups()
            break
        data.extend(block)
    raise ValueError("Invalid relay frame")


def main():
    try:
        if os.environ.get("SSH_ORIGINAL_COMMAND") != "atlas-relay-canary":
            raise ValueError("Invalid relay command")
        source, run_id, attempt, token = read_frame()
        argv = ["/usr/bin/python3", "-I", "-B", str(VERIFIER)]
        argv.extend(value.decode("ascii") for value in (source, run_id, attempt))
        completed = subprocess.run(
            argv, input=token + b"\n", capture_output=True,
            env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"}, timeout=VERIFY_TIMEOUT,
        )
        if completed.returncode or completed.stdout != VERIFY_SUCCESS or completed.stderr:
            raise ValueError("Control verifier failed")
    except Exception:
        print("Atlas relay canary rejected.", file=sys.stderr)
        return 1
    sys.stdout.buffer.write(b"atlas-relay-canary-ok " + b" ".join((source, run_id, attempt)) + b"\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
