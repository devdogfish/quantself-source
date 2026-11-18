#!/usr/bin/env python3
"""Read-only proof that the latest Keep services verified the same recovery point."""

from datetime import datetime, timedelta, timezone
import json
import os
import re
import sys

from backup_guest import BackupError, command, private, require
from backup_monitor import MonitorError, RESTORE_ID, state_file
from backup_restore_drill import ALIAS, STATE, VMID
from backup_retention import validate_pair


BACKUP = "keep-backup.service"
RESTORE = "keep-postgres-restore.service"
INVOCATION_ID = re.compile(r"[0-9a-f]{32}")
SUCCESS_PROPERTIES = {"ActiveState": "inactive", "Result": "success", "ExecMainCode": "1", "ExecMainStatus": "0"}
INFLIGHT = ("active.json", "retention-inflight.json", "postgres-restore-active.json")


def successful_invocation(unit):
    properties = ("Id", "InvocationID", *SUCCESS_PROPERTIES)
    output = command(
        "systemctl", "show", "--no-pager", *(f"--property={key}" for key in properties), unit, timeout=15,
    )
    rows = dict(line.split("=", 1) for line in output.splitlines())
    require(rows.get("Id") == unit and all(rows.get(key) == value for key, value in SUCCESS_PROPERTIES.items()),
            f"{unit} has no settled exit-zero result")
    invocation = rows.get("InvocationID", "")
    require(INVOCATION_ID.fullmatch(invocation) and int(invocation, 16), f"{unit} has no invocation identity")
    return invocation


def success_timestamp(unit, invocation, message):
    output = command(
        "journalctl", "--boot", "--no-pager", "--output=json",
        "--output-fields=MESSAGE,_SYSTEMD_UNIT,_SYSTEMD_INVOCATION_ID",
        f"--grep=^{re.escape(message)}$", f"_SYSTEMD_UNIT={unit}",
        f"_SYSTEMD_INVOCATION_ID={invocation}", timeout=15,
    )
    rows = [json.loads(line) for line in output.splitlines()]
    require(len(rows) == 1 and rows[0].get("MESSAGE") == message
            and rows[0].get("_SYSTEMD_UNIT") == unit
            and rows[0].get("_SYSTEMD_INVOCATION_ID") == invocation,
            f"{unit} has no unique success marker for this recovery point")
    micros = rows[0]["__REALTIME_TIMESTAMP"]
    require(isinstance(micros, str) and bool(re.fullmatch(r"[1-9][0-9]{0,15}", micros)),
            "Malformed success marker timestamp")
    return datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=int(micros))


def require_settled(root):
    require(not any(os.path.lexists(root / name) for name in INFLIGHT),
            "Backup, retention or restore state is unresolved")


def prove(root, now):
    require_settled(root)
    backup, restore = successful_invocation(BACKUP), successful_invocation(RESTORE)
    require(backup != restore, "Backup and restore invocation identities are not distinct")
    pair = state_file(root / "last-success.json")
    restore_id = pair["restore_id"]
    require(RESTORE_ID.fullmatch(restore_id), "Invalid recovery point identity")
    backed_up = validate_pair(pair, restore_id)
    require(timedelta() <= now - backed_up <= timedelta(hours=4), "Recovery point is outside the four-hour window")
    require(state_file(root / "runs" / restore_id / "complete.json") == pair,
            "Durable backup receipt does not match the latest completed pair")
    restore_path = root / "postgres-restore-last-success.json"
    receipt = state_file(restore_path)
    archive = ALIAS + ":" + pair["pbs"]["quantself"]["volid"].split(":", 1)[1]
    require(receipt["format"] == 1 and receipt["restore_id"] == restore_id
            and receipt["status"] == "verified" and str(receipt["vmid"]) == VMID
            and receipt["volume"] == archive, "Restore receipt does not match the encrypted backup point and archive")
    restored = datetime.fromisoformat(receipt["completed_at"])
    require(restored.tzinfo is not None, "Restore receipt lacks a time zone")
    backup_logged = success_timestamp(BACKUP, backup, f"Verified Keep backup {restore_id}.")
    restore_logged = success_timestamp(RESTORE, restore, json.dumps({
        "status": "verified", "restore_id": restore_id, "vmid": int(VMID),
    }))
    require(backed_up <= backup_logged <= restored <= restore_logged <= now,
            "Backup and restore completion order differs from the service journal")
    require((successful_invocation(BACKUP), successful_invocation(RESTORE)) == (backup, restore)
            and state_file(root / "last-success.json") == pair and state_file(restore_path) == receipt,
            "Service or recovery evidence changed during the check")
    require_settled(root)
    return {"status": "verified_service_pair", "restore_id": restore_id, "timer_origin": "unverified"}


def main():
    if len(sys.argv) != 1:
        print("Usage: backup_pair_proof.py", file=sys.stderr)
        return 2
    try:
        require(os.geteuid() == 0, "Run the read-only proof as root")
        private(STATE, 0o700)
        result = prove(STATE, datetime.now(timezone.utc))
    except BackupError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (MonitorError, OSError, ValueError, TypeError, KeyError):
        print("Missing, unreadable or malformed recovery evidence", file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
