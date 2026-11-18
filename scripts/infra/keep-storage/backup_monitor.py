#!/usr/bin/env python3
"""Run the Keep backup coordinator and report its verified outcome to Healthchecks."""
import datetime as dt
from concurrent.futures import ThreadPoolExecutor
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

COORDINATOR = Path(__file__).with_name("backup_coordinator.py")
STATE = Path("/var/lib/keep-backup")
PING_FILE = Path("/etc/keep-backup/healthcheck-url")
GROWTH_PING_FILE = Path("/etc/keep-backup/growth-healthcheck-url")
GROWTH_TARGET_FILE = Path("/etc/keep-backup/growth-target-bytes")
GROWTH_DEFAULT_TARGET = 10_000_000_000
GROWTH_GUEST = "/usr/local/lib/keep-backup/backup_growth.py"
GROWTH_ROLES = {"quantself": "quantself", "files": "vault"}
GROWTH_COUNTERS = ("retained_bytes", "retained_versions", "unfinished_bytes", "unfinished_uploads")
PING_URL = re.compile(r"https://hc-ping\.com/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
RESTORE_ID = re.compile(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}")
ROLES = {"quantself": 2541, "files": 2540}
PENDING = 75


class MonitorError(Exception):
    """Diagnostic safe for system logs."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def require(condition, message):
    if not condition:
        raise MonitorError(message)


def private_read(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        meta = os.fstat(source.fileno())
        require(stat.S_ISREG(meta.st_mode) and stat.S_IMODE(meta.st_mode) == 0o600
                and meta.st_uid == meta.st_gid == 0, "Backup state and ping files must be root-owned mode 0600.")
        value = source.read(limit + 1)
        require(len(value) <= limit, "Backup state or ping file exceeds its size limit.")
        return value


def state_file(path, optional=False):
    try:
        return json.loads(private_read(path, 256 * 1024))
    except FileNotFoundError:
        if optional:
            return None
        raise


def healthcheck_url(path=PING_FILE):
    try:
        url = private_read(path, 128).decode("ascii").rstrip("\n")
    except (OSError, ValueError):
        raise MonitorError("Install the root-only Healthchecks ping file before running.") from None
    require(PING_URL.fullmatch(url), "Configure the Healthchecks UUID ping URL.")
    return url


def ping(url, success):
    endpoint = url if success else url + "/fail"
    opener = build_opener(ProxyHandler({}), NoRedirect())
    # Healthchecks can return HTTP 200 for missing checks and rate limits.
    # Confirm its success body and keep remote content out of diagnostics.
    for _ in range(2):
        try:
            with opener.open(Request(endpoint, data=b"", method="POST"), timeout=10) as response:
                if response.status == 200 and response.read(16).strip() == b"OK":
                    return
                break
        except HTTPError as error:
            error.close()
            if error.code < 500:
                break
        except (OSError, ValueError):
            pass
    raise MonitorError("Healthchecks ping could not be confirmed.") from None


def run_coordinator(action, observation, timeout):
    return subprocess.run([sys.executable, str(COORDINATOR), action,
                           "--observation-seconds", str(observation)],
                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, timeout=timeout, check=False)


def verify_complete(root, output, previous_id, active_id, read=state_file):
    receipt = json.loads(output)
    restore_id = receipt["restore_id"]
    require(receipt["status"] == "complete" and RESTORE_ID.fullmatch(restore_id)
            and (active_id == restore_id if active_id else restore_id != previous_id),
            "Coordinator returned an unexpected completion receipt.")
    pair = read(root / "last-success.json")
    require(pair == read(root / "runs" / restore_id / "complete.json")
            and pair["restore_id"] == restore_id and pair["format"] == 1
            and set(pair["pbs"]) == set(pair["offsite"]) == set(ROLES)
            and read(root / "active.json", optional=True) is None,
            "Coordinator did not finalize a matching recovery pair.")
    completed_at = dt.datetime.fromisoformat(pair["completed_at"])
    require(completed_at.tzinfo is not None, "Backup completion timestamp lacks a time zone.")
    fingerprints = set()
    repositories = set()
    for role, vmid in ROLES.items():
        pbs = pair["pbs"][role]
        upload = pair["offsite"][role]
        manifest = upload["manifest"]
        fingerprint = pbs["encryption_fingerprint"]
        require(re.fullmatch(rf"backup:backup/vm/{vmid}/\d{{4}}-\d\d-\d\dT\d\d:\d\d:\d\dZ", pbs["volid"])
                and re.fullmatch(r"(?:[0-9a-f]{2}:){31}[0-9a-f]{2}", fingerprint)
                and re.fullmatch(r"[0-9a-f]{64}", upload["snapshot"])
                and re.fullmatch(r"[0-9a-f]{64}", upload["repository"])
                and manifest["role"] == role and manifest["restore_id"] == restore_id,
                "Backup pair contains mismatched recovery evidence.")
        fingerprints.add(fingerprint)
        repositories.add(upload["repository"])
    require(len(fingerprints) == 1 and len(repositories) == len(ROLES),
            "Backup pair uses mismatched storage targets.")
    return restore_id


def monitor(root, *, report, run=run_coordinator, read=state_file,
            clock=time.monotonic, pause=time.sleep, max_seconds=3600, after_complete=None):
    deadline = clock() + max_seconds
    previous = read(root / "last-success.json", optional=True)
    previous_id = previous["restore_id"] if previous else None
    active_id = read_active(root, read)
    while deadline - clock() > 1:
        remaining = deadline - clock()
        # Most calls settle in this observation window. Allow additional time
        # for bounded coordinator commands and stop watching at the deadline.
        observation = max(1, min(120, int(remaining / 2)))
        try:
            result = run("recover" if active_id else "run", observation, min(remaining, 300))
        except subprocess.TimeoutExpired:
            print("Backup observation timed out. Check the recorded coordinator state.", file=sys.stderr)
            return PENDING
        if result.returncode == 0:
            try:
                restore_id = verify_complete(root, result.stdout, previous_id, active_id, read)
            except (MonitorError, OSError, ValueError, KeyError, TypeError):
                report(False)
                raise MonitorError("Coordinator exited without verified recovery evidence.") from None
            print(f"Verified Keep backup {restore_id}.")
            try:
                report(True)
            finally:
                if after_complete is not None:
                    after_complete(restore_id)
            return 0
        if result.returncode == 1:
            report(False)
            print("Backup coordinator reported terminal failure. Inspect its local state.", file=sys.stderr)
            return 1
        if result.returncode != PENDING:
            print("Backup coordinator exited without a settled outcome.", file=sys.stderr)
            return PENDING
        observed_id = read_active(root, read)
        if observed_id is None or (active_id and observed_id != active_id):
            print("Backup observation could not identify the original run.", file=sys.stderr)
            return PENDING
        active_id = observed_id
        pause(max(0, min(10, deadline - clock())))
    print("Backup outcome remains pending. Check the recorded coordinator state.", file=sys.stderr)
    return PENDING


def read_active(root, read):
    active = read(root / "active.json", optional=True)
    if active is None:
        return None
    restore_id = active["restore_id"]
    require(RESTORE_ID.fullmatch(restore_id), "Invalid active backup identity.")
    return restore_id


def guest_growth(vmid):
    output = subprocess.run(
        ["qm", "guest", "exec", str(vmid), "--timeout", "90", "--",
         "/usr/bin/python3", GROWTH_GUEST],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        timeout=95, check=True,
    ).stdout
    result = json.loads(output)
    require(result.get("exited") and result.get("exitcode") == 0, "Guest B2 census did not complete.")
    return json.loads(result["out-data"])


def growth_target(path=GROWTH_TARGET_FILE):
    try:
        raw = private_read(path, 32).strip()
    except FileNotFoundError:
        return GROWTH_DEFAULT_TARGET
    require(re.fullmatch(rb"[1-9][0-9]{0,18}", raw), "Invalid B2 growth target.")
    return int(raw)


def growth_sample(restore_id, target, collect=guest_growth):
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = {role: pool.submit(collect, vmid) for role, vmid in ROLES.items()}
        guest_samples = {role: pending[role].result() for role in ROLES}
    sample = {}
    for role, raw in guest_samples.items():
        require(raw["format"] == 1 and raw["prefix_role"] == GROWTH_ROLES[role], "B2 census role differs.")
        start = dt.datetime.fromisoformat(raw["sample_start"])
        end = dt.datetime.fromisoformat(raw["sample_end"])
        require(start.tzinfo and end.tzinfo and start <= end, "Invalid B2 census window.")
        counters = {key: raw[key] for key in GROWTH_COUNTERS}
        require(all(type(value) is int and value >= 0 for value in counters.values()), "Invalid B2 census totals.")
        sample[role] = {**counters, "sample_start": start.isoformat(), "sample_end": end.isoformat()}
    total = sum(row["retained_bytes"] + row["unfinished_bytes"] for row in sample.values())
    return {"format": 1, "restore_id": restore_id, "scope": "configured B2 backup prefixes",
            "soft_target_bytes": target, "total_bytes": total, "at_or_over_target": total >= target,
            "guests": sample}


def report_growth(restore_id, *, backup_url=None, sample=growth_sample, report=ping):
    try:
        url = healthcheck_url(GROWTH_PING_FILE)
    except MonitorError:
        print("Growth check URL unavailable. Collecting B2 usage for the local journal.", file=sys.stderr)
        url = None
    if url is not None and url == backup_url:
        print("Configure a separate Healthchecks URL for growth.", file=sys.stderr)
        url = None
    try:
        result = sample(restore_id, growth_target())
        print(json.dumps(result, sort_keys=True))
    except (MonitorError, OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        print("B2 growth sample incomplete. No growth heartbeat sent.", file=sys.stderr)
        return
    if url:
        try:
            report(url, not result["at_or_over_target"])
        except MonitorError:
            print("B2 growth ping could not be confirmed.", file=sys.stderr)


def report_retention(restore_id):
    from backup_retention import automatic_enabled, retain
    from backup_guest import BackupError

    try:
        if automatic_enabled():
            result = retain(STATE, automatic=True, expected_latest=restore_id)
            print(json.dumps({"local_retention": result}, sort_keys=True))
    except (BackupError, OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        print("Local staging retention did not complete. The backup pair remains verified.",
              file=sys.stderr)


def after_verified_pair(restore_id, backup_url):
    report_growth(restore_id, backup_url=backup_url)
    report_retention(restore_id)


def main():
    require(os.geteuid() == 0, "Run the backup monitor as root.")
    os.umask(0o077)
    STATE.mkdir(mode=0o700, exist_ok=True)
    fd = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        meta = os.fstat(fd)
        require(meta.st_uid == meta.st_gid == 0 and stat.S_IMODE(meta.st_mode) == 0o700,
                "Backup state directory must be root-owned mode 0700.")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Backup monitor is already running.", file=sys.stderr)
            return PENDING
        url = healthcheck_url()
        return monitor(STATE, report=lambda success: ping(url, success),
                       after_complete=lambda restore_id: after_verified_pair(restore_id, url))
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Exception, KeyboardInterrupt) as error:
        print(str(error) if isinstance(error, MonitorError) else "Backup monitor stopped. Inspect local state.",
              file=sys.stderr)
        sys.exit(1)
