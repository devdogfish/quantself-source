#!/usr/bin/env python3
"""Keep the qualification runtime available while Compose handles termination."""

from contextlib import suppress
import os
from pathlib import Path
import signal
import subprocess
import sys
from time import monotonic, sleep


CHECKER = Path(__file__).resolve().parents[1] / "check-roundcube-patch-readiness.py"
CONFIG = "/etc/quantself-roundcube-qualification/qualification.json"
# Leave time before the service's 30-second stop limit.
STOP_GRACE = 25


def signal_group(pid, signum):
    with suppress(ProcessLookupError):
        os.killpg(pid, signum)


def stop(process, signum):
    deadline = monotonic() + STOP_GRACE
    signal_group(process.pid, signal.SIGTERM)
    while monotonic() < deadline:
        process.poll()
        try:
            # The checker may exit before the fixture's EXIT trap finishes.
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            return 128 + signum
        sleep(0.1)
    print("Qualification teardown exceeded its stop budget. Reconcile the disposable Compose project.", file=sys.stderr)
    signal_group(process.pid, signal.SIGKILL)
    process.wait()
    return 128 + signum


def main():
    stopping = None

    def requested(signum, _frame):
        nonlocal stopping
        stopping = signum

    signal.signal(signal.SIGTERM, requested)
    signal.signal(signal.SIGINT, requested)
    process = subprocess.Popen(
        [sys.executable, "-EBs", str(CHECKER), "--qualification-config", CONFIG],
        start_new_session=True,
    )
    while stopping is None:
        try:
            code = process.wait(timeout=0.25)
        except subprocess.TimeoutExpired:
            continue
        if stopping is None:
            return code if code >= 0 else 128 - code
    return stop(process, stopping)


if __name__ == "__main__":
    sys.exit(main())
