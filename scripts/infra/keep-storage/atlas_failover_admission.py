#!/usr/bin/env python3
"""Read-only Atlas admission check for a dedicated ext4-on-LUKS directory storage."""

import argparse
import json
import os
from pathlib import Path
import re
import socket
import stat
import sys

from backup_guest import BackupError, command, require


GIB = 1024 ** 3


def verify_backing(mount, luks_uuid):
    device = mount["maj:min"]
    source = mount["source"]
    require(re.fullmatch(r"[0-9]+:[0-9]+", device) and source.startswith("/dev/"),
            "Restore filesystem lacks an identifiable block device")
    mapper_uuid = Path(f"/sys/dev/block/{device}/dm/uuid").read_text().strip()
    require(re.fullmatch(rf"CRYPT-LUKS[12]-{luks_uuid.replace('-', '')}-.+", mapper_uuid),
            "Restore mount is not mapped by the approved LUKS container")
    nodes = json.loads(command(
        "lsblk", "--inverse", "--json", "--tree", "--output", "NAME,TYPE,FSTYPE,UUID,MAJ:MIN", "--", source,
    ))["blockdevices"]
    require(len(nodes) == 1 and nodes[0]["type"] == "crypt" and nodes[0]["maj:min"] == device,
            "Restore mount does not match the encrypted block device")
    backing = nodes[0].get("children", [])
    require(len(backing) == 1, "Restore device does not have a single backing device")
    parent, = backing
    require(parent["fstype"] == "crypto_LUKS" and parent["uuid"] == luks_uuid,
            "Restore backing device differs from the approved LUKS container")
    if parent["type"] == "part":
        disks = parent.get("children", [])
        require(len(disks) == 1, "Restore partition does not have a single physical disk")
        parent, = disks
    require(parent["type"] == "disk" and not parent.get("children"),
            "Restore filesystem needs a directly backed local disk")
    disk = parent["maj:min"]
    require(re.fullmatch(r"[0-9]+:[0-9]+", disk), "Restore disk identity is missing")
    device_path = Path(f"/sys/dev/block/{disk}").resolve(strict=True)
    require(device_path.is_relative_to("/sys/devices") and not device_path.is_relative_to("/sys/devices/virtual"),
            "Restore backing disk is a virtual block device")


def verify_destination(storage, mount_path, luks_uuid):
    require(socket.gethostname().split(".", 1)[0] == "atlas", "Expected the Atlas node")
    require(re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", storage)
            and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", luks_uuid),
            "Expected an exact storage ID and LUKS UUID")
    require(mount_path.is_absolute() and mount_path != Path("/")
            and mount_path.resolve(strict=True) == mount_path, "Expected a dedicated canonical mount path")

    config = json.loads(command("pvesh", "get", f"/storage/{storage}", "--output-format", "json"))
    require(config["storage"] == storage and config["type"] == "dir" and config["path"] == str(mount_path)
            and config.get("nodes") == "atlas" and config["content"] == "images"
            and config.get("is_mountpoint") in ("1", "yes", str(mount_path))
            and not config.get("content-dirs") and config.get("shared", 0) == config.get("disable", 0) == 0,
            "Proxmox storage is not the approved mounted Atlas image directory")

    mounts = json.loads(command(
        "findmnt", "--kernel", "--json", "--list", "--output", "TARGET,SOURCE,FSTYPE,FSROOT,OPTIONS,MAJ:MIN",
    ))["filesystems"]
    candidates = [row for row in mounts if row["target"] == str(mount_path)]
    require(len(candidates) == 1, "The approved path needs its own unambiguous mount")
    mount, = candidates
    require(mount["fstype"] == "ext4" and mount["fsroot"] == "/" and "rw" in mount["options"].split(","),
            "Expected a writable ext4 filesystem mounted at its root")
    require(all(row is mount or (row["maj:min"] != mount["maj:min"]
                and mount_path not in Path(row["target"]).parents) for row in mounts),
            "Restore filesystem has another mount or a nested mount")
    verify_backing(mount, luks_uuid)

    root = mount_path.stat()
    images = mount_path / "images"
    for path in (mount_path, images, mount_path / "scratch"):
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_dev == root.st_dev,
                "Restore image and scratch paths must be real root-owned directories on the approved mount")
        if path != images:
            require(stat.S_IMODE(info.st_mode) == 0o700, "Restore mount and scratch must be root-only")
    require(f"{os.major(root.st_dev)}:{os.minor(root.st_dev)}" == mount["maj:min"],
            "Restore path device changed during inspection")
    return root.st_dev


def admit(storage, mount_path, luks_uuid, *, records_vmid, originals_vmid,
          records_gib, originals_gib, scratch_gib, reserve_gib):
    budgets = (records_gib, originals_gib, scratch_gib, reserve_gib)
    require(all(type(size) is int and size > 0 for size in budgets), "Expected four positive capacity budgets")
    vmids = (records_vmid, originals_vmid)
    require(all(type(vmid) is int and 100 <= vmid <= 999_999_999 for vmid in vmids)
            and records_vmid != originals_vmid, "Expected two distinct destination VM IDs")
    verify_destination(storage, mount_path, luks_uuid)
    images = mount_path / "images"
    for vmid in vmids:
        try:
            (images / str(vmid)).lstat()
        except FileNotFoundError:
            continue
        raise BackupError("A destination image path already exists")
    space = os.statvfs(mount_path)
    available = space.f_bavail * space.f_frsize
    required = sum(budgets) * GIB
    require(available >= required, f"Encrypted destination has {available} bytes available; needs {required}")
    return {"status": "destination_admitted", "storage": storage, "mount": str(mount_path),
            "records_vmid": records_vmid, "originals_vmid": originals_vmid,
            "available_bytes": available, "required_bytes": required}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("storage")
    parser.add_argument("mount", type=Path)
    parser.add_argument("luks_uuid")
    parser.add_argument("--records-vmid", type=int, required=True)
    parser.add_argument("--originals-vmid", type=int, required=True)
    for budget in ("records", "originals", "scratch", "reserve"):
        parser.add_argument(f"--{budget}-gib", type=int, required=True)
    args = parser.parse_args()
    try:
        result = admit(args.storage, args.mount, args.luks_uuid, records_vmid=args.records_vmid,
                       originals_vmid=args.originals_vmid, records_gib=args.records_gib,
                       originals_gib=args.originals_gib, scratch_gib=args.scratch_gib, reserve_gib=args.reserve_gib)
    except BackupError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, TypeError, ValueError, KeyError, AttributeError):
        print("Atlas destination evidence is missing or malformed", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
