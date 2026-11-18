#!/usr/bin/env python3
"""Export a settled Keep receipt or preview its verified Atlas restore point."""

import argparse
import base64
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
from select import select
import socket
import stat
import subprocess
import sys
from tempfile import TemporaryDirectory
from time import monotonic

from atlas_postgres_restore_drill import verify_source_pair
from backup_guest import BackupError, Busy, private, require
from backup_monitor import MonitorError, private_read, state_file
from backup_pair_proof import BACKUP, INVOCATION_ID, success_timestamp, successful_invocation
from backup_restore_drill import STATE


RECEIPT_LIMIT = 256 * 1024
FRAME_LIMIT = 4 * ((RECEIPT_LIMIT + 2) // 3) + 1024
FETCH_TIMEOUT = 60
EXPORT_COMMAND = "keep-backup-receipt"
SCRIPTS = Path(__file__).resolve().parent


def require_settled_backup(root):
    require(not any(os.path.lexists(root / name) for name in ("active.json", "retention-inflight.json")),
            "Keep backup or retention is unresolved")


def export_receipt(root):
    private(root, 0o700)
    fd = os.open(root / "coordinator.lock", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as lock:
        info = os.fstat(lock.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0
                and stat.S_IMODE(info.st_mode) == 0o600, "Unexpected Keep coordinator lock")
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Busy("Keep coordinator is busy") from None
        require_settled_backup(root)
        invocation = successful_invocation(BACKUP)
        pair = state_file(root / "last-success.json")
        verify_source_pair(pair)
        restore_id = pair["restore_id"]
        complete = private_read(root / "runs" / restore_id / "complete.json", RECEIPT_LIMIT)
        require(json.loads(complete) == pair, "Keep heartbeat differs from the durable complete receipt")
        logged = success_timestamp(BACKUP, invocation, f"Verified Keep backup {restore_id}.")
        now = datetime.now(timezone.utc)
        require(datetime.fromisoformat(pair["completed_at"]) <= logged <= now
                and now - logged <= timedelta(hours=4), "Keep completion is outside the invocation window")
        require(successful_invocation(BACKUP) == invocation and state_file(root / "last-success.json") == pair,
                "Keep backup invocation or receipt changed during selection")
        require_settled_backup(root)
    return {"invocation_id": invocation, "complete_sha256": hashlib.sha256(complete).hexdigest(),
            "complete_base64": base64.b64encode(complete).decode("ascii")}


def read_receipt_frame(args):
    deadline = monotonic() + FETCH_TIMEOUT
    frame = bytearray()
    with subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          bufsize=0) as process:
        try:
            while True:
                remaining = deadline - monotonic()
                require(remaining > 0 and select([process.stdout], [], [], remaining)[0],
                        "Keep receipt fetch timed out")
                chunk = process.stdout.read(min(64 * 1024, FRAME_LIMIT - len(frame) + 1))
                if not chunk:
                    break
                frame.extend(chunk)
                require(len(frame) <= FRAME_LIMIT, "Keep receipt envelope exceeds its size limit")
            remaining = deadline - monotonic()
            require(remaining > 0, "Keep receipt fetch timed out")
            try:
                require(process.wait(timeout=remaining) == 0, "Unable to fetch the current Keep receipt")
            except subprocess.TimeoutExpired:
                raise BackupError("Keep receipt fetch timed out") from None
            return frame
        finally:
            if process.poll() is None:
                process.kill()


def fetch_receipt(host, known_hosts, identity_file):
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,252}", host), "Invalid pinned Keep hostname")
    known_hosts_path = str(known_hosts.absolute())
    require(re.fullmatch(r"/[A-Za-z0-9_/.-]+", known_hosts_path), "Expected a literal Keep known-hosts path")
    reply = read_receipt_frame(
        ["/usr/bin/ssh", "-F", "/dev/null", "-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
         "-o", "IdentityAgent=none", "-o", "PreferredAuthentications=publickey",
         "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no",
         "-o", f"UserKnownHostsFile={known_hosts_path}", "-o", "GlobalKnownHostsFile=/dev/null",
         "-o", "ConnectTimeout=10", "-i", str(identity_file.absolute()), "--", f"atlas-receipt@{host}", EXPORT_COMMAND],
    )
    frame = json.loads(reply)
    require(isinstance(frame, dict) and set(frame) == {"invocation_id", "complete_sha256", "complete_base64"},
            "Malformed Keep receipt envelope")
    invocation = frame["invocation_id"]
    require(isinstance(invocation, str) and INVOCATION_ID.fullmatch(invocation) and int(invocation, 16),
            "Malformed Keep receipt invocation")
    require(isinstance(frame["complete_base64"], str), "Malformed Keep receipt encoding")
    complete = base64.b64decode(frame["complete_base64"], validate=True)
    digest = hashlib.sha256(complete).hexdigest()
    require(len(complete) <= RECEIPT_LIMIT and frame["complete_sha256"] == digest,
            "Keep receipt bytes differ from the exported SHA-256")
    verify_source_pair(json.loads(complete))
    return invocation, digest, complete


def run_helper(name, args, expected):
    result = subprocess.run([sys.executable, "-B", str(SCRIPTS / name), *args],
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, check=False)
    require(result.returncode == 0 and len(result.stdout) <= expected, f"{name} failed")
    return result.stdout


def preview(args):
    def fetch():
        return fetch_receipt(args.keep_host, args.keep_known_hosts, args.keep_identity_file)

    selection = fetch()
    _, digest, raw = selection
    policy_args = ["--policy", str(args.policy), "--policy-sha256", args.policy_sha256]
    with TemporaryDirectory(prefix="atlas-receipt-handoff-") as directory:
        complete = Path(directory) / "complete.json"
        point = Path(directory) / "point.json"
        complete.write_bytes(raw)
        producer_args = [*policy_args, "--complete", str(complete), "--atlas-complete", str(complete),
                         "--complete-sha256", digest, "--keyfile", str(args.keyfile),
                         "--password-file", str(args.password_file)]
        if args.key_password_file is not None:
            producer_args.extend(("--key-password-file", str(args.key_password_file)))
        point.write_bytes(run_helper("atlas_postgres_restore_point.py", producer_args, 4096))
        require(fetch() == selection, "Keep selected a different receipt while producing the Atlas point")
        output = run_helper("atlas_postgres_restore_drill.py",
                            [*policy_args, "--point", str(point), "--complete-sha256", digest], 4096)
        result = json.loads(output)
        require(result["status"] == "preview" and result["restore_id"] == json.loads(raw)["restore_id"],
                "Atlas admission did not verify the selected Keep receipt")
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    actions.add_parser("export")
    atlas = actions.add_parser("preview")
    atlas.add_argument("--keep-host", required=True)
    atlas.add_argument("--keep-known-hosts", type=Path, required=True)
    atlas.add_argument("--keep-identity-file", type=Path, required=True)
    atlas.add_argument("--policy", type=Path, required=True)
    atlas.add_argument("--policy-sha256", required=True)
    atlas.add_argument("--keyfile", type=Path, required=True)
    atlas.add_argument("--password-file", type=Path, required=True)
    atlas.add_argument("--key-password-file", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    node = socket.gethostname().split(".", 1)[0]
    require(os.geteuid() == 0, "Run the receipt handoff as root")
    if args.action == "export":
        require(node == "keep", "Export the completed receipt on Keep")
        result = export_receipt(STATE)
    else:
        require(node == "atlas", "Preview the completed receipt on Atlas")
        result = preview(args)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except (BackupError, MonitorError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.SubprocessError):
        print("Unable to verify the Keep receipt handoff", file=sys.stderr)
        sys.exit(1)
