#!/usr/bin/env python3
"""Preview or remove old, completed local Keep backup staging."""

import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time

from backup_guest import (BackupError, RESTORE_ID, locked, private, read_json, require,
                          snapshot_digest, sync_dir, write_json)

STATE = Path("/var/lib/keep-backup")
POLICY = Path("/etc/keep-backup/retention.json")
INSTALL = "/usr/local/lib/keep-backup/backup_retention.py"
GUESTS = {"quantself": 2541, "files": 2540}
KEEP = 2
HEX = r"[0-9a-f]{64}"
FINGERPRINT = r"(?:[0-9a-f]{2}:){31}[0-9a-f]{2}"


def private_json(path):
    private(path, 0o600)
    return read_json(path)


def check_policy(automatic=False):
    policy = private_json(POLICY)
    manual = {"format": 1, "keep_verified": KEEP}
    enabled = policy.get("automatic") is True
    require(policy == (dict(manual, automatic=True) if enabled else manual)
            and (not automatic or enabled), "Owner retention policy is missing or differs")
    return enabled


def automatic_enabled():
    if not os.path.lexists(POLICY):
        return False
    return check_policy()


def result(operations, key):
    record = operations[key]
    require(record["status"] == "ok", "Backup journal operation did not succeed")
    return record["result"]


def pair_time(pair):
    timestamp = datetime.fromisoformat(pair["completed_at"])
    require(timestamp.tzinfo is not None, "Backup completion timezone is missing")
    return timestamp


def validate_pair(pair, restore_id):
    require(pair["format"] == 1 and pair["restore_id"] == restore_id
            and RESTORE_ID.fullmatch(restore_id)
            and set(pair["pbs"]) == set(pair["offsite"]) == set(GUESTS),
            "Invalid completed recovery pair")
    repositories = set()
    fingerprints = set()
    for role, vmid in GUESTS.items():
        pbs = pair["pbs"][role]
        upload = pair["offsite"][role]
        manifest = upload["manifest"]
        require(re.fullmatch(rf"backup:backup/vm/{vmid}/\d{{4}}-\d\d-\d\dT\d\d:\d\d:\d\dZ", pbs["volid"])
                and re.fullmatch(FINGERPRINT, pbs["encryption_fingerprint"])
                and re.fullmatch(HEX, upload["repository"]) and re.fullmatch(HEX, upload["snapshot"])
                and manifest["format"] == 1 and manifest["restore_id"] == restore_id
                and manifest["role"] == role and re.fullmatch(HEX, manifest["inventory_sha256"]),
                "Invalid completed recovery evidence")
        repositories.add(upload["repository"])
        fingerprints.add(pbs["encryption_fingerprint"])
    require(len(repositories) == 2 and len(fingerprints) == 1, "Invalid backup target pairing")
    return pair_time(pair)


def verified_pairs(root):
    require(not os.path.lexists(root / "active.json"), "An active or pending backup exists")
    runs = root / "runs"
    if not os.path.lexists(runs):
        return []
    private(runs, 0o700)
    verified = []
    for run in runs.iterdir():
        if not RESTORE_ID.fullmatch(run.name):
            continue
        private(run, 0o700)
        complete = run / "complete.json"
        if not os.path.lexists(complete):
            continue
        pair = private_json(complete)
        timestamp = validate_pair(pair, run.name)
        journal = private_json(run / "journal.json")
        require(journal["format"] == 1 and journal["restore_id"] == run.name
                and journal.get("pause_finished") is True and not journal.get("failure")
                and not journal.get("abort_requested"), "Completed run has conflicting journal state")
        operations = journal["operations"]
        require(result(operations, "pbs") == pair["pbs"], "PBS journal evidence differs")
        for role in GUESTS:
            upload = pair["offsite"][role]
            require(result(operations, f"{role}.upload") == upload
                    and result(operations, f"{role}.capture") == upload["manifest"]
                    and result(operations, f"{role}.preflight")["repository"] == upload["repository"],
                    "Guest journal evidence differs")
            result(operations, f"{role}.resume")
        verified.append((timestamp, run.name, pair))
    if not verified:
        require(not os.path.lexists(root / "last-success.json"), "Heartbeat has no completed pair")
        return []
    verified.sort(reverse=True)
    require(private_json(root / "last-success.json") == verified[0][2],
            "Heartbeat does not match the newest verified pair")
    candidates = []
    for _, restore_id, pair in verified:
        receipt = runs / restore_id / "retention.json"
        applied = os.path.lexists(receipt)
        if applied:
            require(private_json(receipt) == pair, "Keep retention receipt differs")
        candidates.append((pair, applied))
    return candidates


def reject_nested_mounts(path):
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        raw = line.split()[4]
        mounted = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), raw)
        require(not Path(mounted).is_relative_to(path), "Frozen staging contains a mount")


def remove_frozen(root, role, pair, automatic=False):
    check_policy(automatic)
    restore_id = pair["restore_id"]
    validate_pair(pair, restore_id)
    private(root, 0o700)
    private(root / "runs", 0o700)
    run = root / "runs" / restore_id
    private(run, 0o700)
    evidence = pair["offsite"][role]
    for name, expected in (("capture", evidence["manifest"]), ("upload", evidence)):
        row = private_json(run / f"{name}-1.json")
        require(row["status"] == "ok" and row["result"] == expected, "Guest staging evidence differs")

    frozen = run / "frozen"
    tombstone = run / ".retention-removing"
    receipt = run / "retention.json"
    intent = {"format": 1, "restore_id": restore_id, "role": role, "upload": evidence}
    has_frozen = os.path.lexists(frozen)
    has_tombstone = os.path.lexists(tombstone)
    require(not (has_frozen and has_tombstone), "Guest staging has conflicting cleanup paths")
    if os.path.lexists(receipt):
        require(private_json(receipt) == intent, "Guest retention intent differs")
    else:
        require(has_frozen, "Guest staging is missing without retention intent")
    if has_frozen:
        private(frozen, 0o700)
        require(private_json(frozen / "manifest.json") == evidence["manifest"], "Frozen manifest differs")
        inventory = frozen / "inventory.json"
        private(inventory, 0o600)
        require(snapshot_digest(inventory) == evidence["manifest"]["inventory_sha256"],
                "Frozen inventory digest differs")
        reject_nested_mounts(frozen)
        if not os.path.lexists(receipt):
            write_json(receipt, intent)
        frozen.rename(tombstone)
        sync_dir(run)
        has_tombstone = True
    if has_tombstone:
        private(tombstone, 0o700)
        require(shutil.rmtree.avoids_symlink_attacks, "Safe recursive removal is unavailable")
        reject_nested_mounts(tombstone)
        shutil.rmtree(tombstone)
        sync_dir(run)
        return "removed"
    return "already-removed"


def qga(role, action, *args, payload=None):
    try:
        reply = subprocess.run(["qm", "guest", action, str(GUESTS[role]), *args],
                               input=payload, text=True, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, timeout=25, check=False)
        require(reply.returncode == 0, "Could not observe guest retention operation")
        return json.loads(reply.stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        raise BackupError("Guest retention outcome is unconfirmed") from None


def guest_boot(role):
    reply = qga(role, "exec", "--timeout", "10", "--", "/usr/bin/cat",
                "/proc/sys/kernel/random/boot_id")
    boot = reply.get("out-data", "").strip()
    require(reply.get("exited") and reply.get("exitcode") == 0
            and re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", boot),
            "Guest boot identity is unconfirmed")
    return boot


def settle_dispatch(root, *, observation=0):
    path = root / "retention-inflight.json"
    if not os.path.lexists(path):
        return
    work = private_json(path)
    role = work["role"]
    pid = work.get("pid")
    require(role in GUESTS and RESTORE_ID.fullmatch(work["restore_id"])
            and type(pid) is int and pid > 0, "Original guest retention dispatch is unconfirmed")
    if "terminal" in work:
        finish_dispatch(root, work["terminal"])
        return
    require(guest_boot(role) == work["boot"], "Guest rebooted during retention; reconcile original operation")
    deadline = time.monotonic() + observation
    while True:
        reply = qga(role, "exec-status", str(pid))
        if reply.get("exited"):
            break
        require(time.monotonic() < deadline, "Original guest retention operation still running")
        time.sleep(1)
    require(guest_boot(role) == work["boot"], "Guest rebooted during retention; reconcile original operation")
    success = reply.get("exitcode") == 0
    if success:
        response = json.loads(reply["out-data"])
        require(response["restore_id"] == work["restore_id"] and response["role"] == role
                and response["result"] in ("removed", "already-removed"), "Guest retention receipt differs")
    # Persist terminal observation before clearing the in-flight guard.
    # QGA can consume its result on the first terminal status read.
    terminal = "ok" if success else "failed"
    write_json(path, {**work, "terminal": terminal})
    finish_dispatch(root, terminal)


def finish_dispatch(root, terminal):
    require(terminal in ("ok", "failed"), "Invalid terminal retention record")
    (root / "retention-inflight.json").unlink()
    sync_dir(root)
    require(terminal == "ok", "Guest retention worker exited unsuccessfully")


def dispatch(root, role, pair, automatic=False):
    path = root / "retention-inflight.json"
    require(not os.path.lexists(path), "An original guest retention operation is unresolved")
    work = {"role": role, "restore_id": pair["restore_id"], "boot": guest_boot(role)}
    write_json(path, work)
    reply = qga(role, "exec", "--synchronous", "0", "--pass-stdin", "1", "--",
                "/usr/bin/python3", INSTALL, "--guest-automatic" if automatic else "--guest",
                payload=json.dumps(pair))
    pid = reply.get("pid")
    require(type(pid) is int and pid > 0, "Original guest retention dispatch is unconfirmed")
    write_json(path, {**work, "pid": pid})
    settle_dispatch(root, observation=120)


def retain(root, approved_ids=None, *, automatic=False, expected_latest=None):
    require(not automatic or (expected_latest is not None and approved_ids is None),
            "Automatic retention needs one verified completion receipt")
    private(root, 0o700)
    with locked(root / "coordinator.lock"):
        if approved_ids is not None or automatic:
            settle_dispatch(root)
        pairs = verified_pairs(root)
        protected = pairs[:KEEP]
        require(not any(applied for _, applied in protected),
                "One of the newest pairs has a retention receipt")
        candidates = [pair for pair, applied in pairs[KEEP:] if not applied]
        if expected_latest is not None:
            require(protected and protected[0][0]["restore_id"] == expected_latest,
                    "Newest verified pair changed before automatic retention")
        apply = approved_ids is not None or automatic
        if apply:
            check_policy(automatic)
        if approved_ids is not None:
            known = {pair["restore_id"] for pair, _ in pairs[KEEP:]}
            require(len(approved_ids) == len(set(approved_ids)) and set(approved_ids) <= known,
                    "Approved restore IDs differ from eligible or previously applied staging")
            candidates = [pair for pair in candidates if pair["restore_id"] in approved_ids]
        if apply:
            for pair in candidates:
                for role in GUESTS:
                    dispatch(root, role, pair, automatic=automatic)
                write_json(root / "runs" / pair["restore_id"] / "retention.json", pair)
        return {"mode": "automatic" if automatic else "apply" if apply else "preview",
                "protected": [pair["restore_id"] for pair, _ in protected],
                "eligible": [pair["restore_id"] for pair in candidates]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--apply", metavar="RESTORE_ID", nargs="+",
                       help="Remove only the named, previewed restore IDs after Owner approval")
    modes.add_argument("--guest", action="store_true", help=argparse.SUPPRESS)
    modes.add_argument("--guest-automatic", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    os.umask(0o077)
    require(os.geteuid() == 0, "Run as root")
    hostname = socket.gethostname().split(".")[0]
    if args.guest or args.guest_automatic:
        require(hostname in GUESTS, "Unexpected guest hostname")
        payload = sys.stdin.buffer.read(262145)
        require(len(payload) <= 262144, "Retention evidence exceeds size limit")
        pair = json.loads(payload)
        private(STATE, 0o700)
        with locked(STATE / "worker.lock"):
            status = remove_frozen(STATE, hostname, pair, automatic=args.guest_automatic)
        return {"restore_id": pair["restore_id"], "role": hostname, "result": status}
    require(hostname == "keep", "Unexpected coordinator hostname")
    return retain(STATE, args.apply)


if __name__ == "__main__":
    try:
        print(json.dumps(main()))
    except BackupError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError, TypeError):
        print("Local retention state could not be validated; inspect privately.", file=sys.stderr)
        sys.exit(1)
