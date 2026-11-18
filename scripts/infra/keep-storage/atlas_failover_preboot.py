#!/usr/bin/env python3
"""Read-only pre-boot proof for the two recorded Atlas PBS restores."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import stat
import sys

from atlas_failover_admission import verify_destination
from backup_guest import BackupError, GIB, command, require, snapshot_digest
from backup_monitor import MonitorError, state_file
from backup_restore_drill import CONFIG, clone_identity, exact_disk_size


ROLES = ("records", "originals")
DISK_OPTIONS = {"aio", "backup", "cache", "detect_zeroes", "discard", "iothread", "replicate", "size", "ssd"}


def get(path, *args):
    return json.loads(command("pvesh", "get", path, *args, "--output-format", "json", timeout=15))


def check_guest(record, storage, mount, device, *, config, pending, status, task):
    vmid = str(record["vmid"])
    require(type(status["vmid"]) is int and str(status["vmid"]) == vmid and status["status"] == "stopped",
            "The recorded clone must be stopped")
    require(isinstance(pending, list) and not any("pending" in row or row.get("delete", 0) != 0 for row in pending),
            "The clone has pending configuration changes")
    require(set(config) <= CONFIG and config.get("serial0", "socket") == "socket"
            and config.get("onboot", 0) == config.get("autostart", 0) == 0 and config.get("boot") == "order=scsi0",
            "The clone must boot only from its disk, with no NIC, passthrough, shared mount or autostart")
    require(task["upid"] == record["upid"] and task["node"] == "atlas" and task["type"] == "qmrestore"
            and task["id"] == vmid and task["status"] == "stopped" and task["exitstatus"] == "OK",
            "The exact recorded Atlas restore task did not succeed")
    require(clone_identity(config) == record["clone_identity"], "The clone UUIDs differ from the restore ledger")

    directory = mount / "images" / vmid
    info = directory.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_dev == device,
            "The clone image directory is outside the approved filesystem")
    expected_disks = record["disks"]
    slots = config.keys() & {"scsi0", "ide2"}
    require("scsi0" in slots and slots == expected_disks.keys(), "The clone disk slots differ from the restore ledger")
    disk_gib = record.get("system_disk_gib")
    disk_sha256 = record.get("system_disk_sha256")
    verify_image = "system_disk_gib" in record or "system_disk_sha256" in record
    if verify_image:
        require(type(disk_gib) is int and disk_gib > 0 and isinstance(disk_sha256, str)
                and re.fullmatch(r"[0-9a-f]{64}", disk_sha256), "Invalid recorded system disk evidence")
    prefix = f"{storage}:{vmid}/vm-{vmid}-"
    filenames = set()
    for slot in slots:
        volume, *fields = config[slot].split(",")
        label = r"disk-[0-9]+" if slot == "scsi0" else "cloudinit"
        require(volume == expected_disks[slot] and re.fullmatch(re.escape(prefix) + label + r"\.raw", volume),
                "A clone disk is not its recorded raw volume")
        options = dict(field.split("=", 1) for field in fields)
        require(len(fields) == len(options) and (
            options.keys() <= DISK_OPTIONS if slot == "scsi0"
            else options.get("media") == "cdrom" and options.keys() <= {"media", "size"}
        ), "A clone disk has an unsupported option")
        image = directory / volume.split("/", 1)[1]
        filenames.add(image.name)
        info = image.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_dev == device and info.st_nlink == 1,
                "A clone disk is linked or outside the approved filesystem")
        if slot == "scsi0" and verify_image:
            require(exact_disk_size(fields, disk_gib) and info.st_size == disk_gib * GIB,
                    "The clone system disk geometry differs from the approved archive")
            require(snapshot_digest(image) == disk_sha256 and image.lstat() == info,
                    "The clone system disk differs from the verified PBS image")
    # Listing via the storage content API can activate the storage and create directories.
    require({path.name for path in directory.iterdir()} == filenames,
            "The destination inventory contains missing or unexpected clone volumes")
    return record["vmid"]


def verify_pair(storage, mount, luks_uuid, ledger):
    require(set(ledger) == set(ROLES), "Expected records and originals in the restore ledger")
    vmids = [ledger[role]["vmid"] for role in ROLES]
    require(all(type(vmid) is int and 100 <= vmid <= 999_999_999 for vmid in vmids) and len(set(vmids)) == 2,
            "Expected two distinct Atlas clone IDs")
    for role in ROLES:
        record = ledger[role]
        require(re.fullmatch(rf"UPID:atlas:(?:[0-9a-fA-F]+:){{3}}qmrestore:{record['vmid']}:[A-Za-z0-9@_.!-]+:",
                             record["upid"]), "The restore ledger names the wrong Atlas task")
    for key in ("vmgenid", "smbios_uuid"):
        require(len({ledger[role]["clone_identity"][key] for role in ROLES}) == 2,
                "The restore ledger contains reused clone UUIDs")
    device = verify_destination(storage, mount, luks_uuid)
    with ThreadPoolExecutor(max_workers=4) as pool:
        ha = pool.submit(get, "/cluster/ha/resources")
        reads = {}
        for role in ROLES:
            record = ledger[role]
            path = f"/nodes/atlas/qemu/{record['vmid']}"
            reads[role] = {
                "config": pool.submit(get, f"{path}/config", "--current", "1"),
                "pending": pool.submit(get, f"{path}/pending"),
                "status": pool.submit(get, f"{path}/status/current"),
                "task": pool.submit(get, f"/nodes/atlas/tasks/{record['upid']}/status"),
            }
        rows = ha.result()
        require(isinstance(rows, list) and all(isinstance(row["sid"], str) for row in rows)
                and not {row["sid"] for row in rows} & {f"vm:{vmid}" for vmid in vmids},
                "A recorded clone is managed by HA or HA state is unknown")
        results = {role: check_guest(ledger[role], storage, mount, device,
                                    **{key: read.result() for key, read in reads[role].items()}) for role in ROLES}
    verified = [role for role in ROLES if "system_disk_sha256" in ledger[role]]
    result = {"status": "preboot_verified", "storage": storage, "guests": results}
    if verified:
        result["whole_image_verified"] = verified
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("storage")
    parser.add_argument("mount", type=Path)
    parser.add_argument("luks_uuid")
    parser.add_argument("ledger", type=Path)
    args = parser.parse_args()
    try:
        result = verify_pair(args.storage, args.mount, args.luks_uuid, state_file(args.ledger))
    except BackupError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (MonitorError, OSError, TypeError, ValueError, KeyError, AttributeError):
        print("Atlas pre-boot evidence is missing or malformed", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
