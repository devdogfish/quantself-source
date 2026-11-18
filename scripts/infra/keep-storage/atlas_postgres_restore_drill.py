#!/usr/bin/env python3
"""Verify one pinned Keep PostgreSQL recovery point on encrypted Atlas storage."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

from atlas_failover_admission import verify_destination
from atlas_failover_preboot import check_guest
from backup_coordinator import Keep, check_pbs_key
from backup_guest import BackupError, GIB, command, locked, private, require
from backup_monitor import MonitorError, private_read, state_file
from backup_restore_drill import (
    ATLAS_DRILL_STATE, CONFIG, DROP, THIN_POOL_RESERVE_GIB, Drill, exact_disk_size, require_memory_reserve,
    verify_source_hardware,
)
from backup_retention import FINGERPRINT, HEX, validate_pair


STATE = ATLAS_DRILL_STATE
CAPTURE_STATE = Path("/var/lib/atlas-failback")
ALIAS = "backup-restore-atlas-drill"
PBS_FIELDS = {"server", "port", "datastore", "namespace", "fingerprint", "username"}


def pinned_json(path, expected):
    require(isinstance(expected, str) and re.fullmatch(HEX, expected), "Expected a recorded SHA-256")
    raw = private_read(path, 256 * 1024)
    require(hashlib.sha256(raw).hexdigest() == expected, "Pinned restore input has changed")
    result = json.loads(raw)
    require(isinstance(result, dict), "Expected a restore JSON object")
    return result


def verify_pbs_identity(pbs):
    require(isinstance(pbs, dict) and set(pbs) == PBS_FIELDS and pbs["datastore"] == "main"
            and all(isinstance(pbs[key], str) and pbs[key] for key in ("server", "username"))
            and isinstance(pbs["fingerprint"], str) and re.fullmatch(FINGERPRINT, pbs["fingerprint"], re.I)
            and (pbs["namespace"] is None or isinstance(pbs["namespace"], str))
            and (pbs["port"] is None or (type(pbs["port"]) is int and 1 <= pbs["port"] <= 65535)),
            "Invalid pinned Atlas PBS identity")


def verify_source_pair(pair):
    restore_id = pair["restore_id"]
    completed = validate_pair(pair, restore_id)
    require(0 <= (datetime.now(timezone.utc) - completed).total_seconds() <= 4 * 3600,
            "No fresh coordinated Keep recovery pair")
    started = datetime.strptime(restore_id.split("-", 1)[0], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    require(all(started <= datetime.fromisoformat(item["volid"].rsplit("/", 1)[1]) <= completed
                for item in pair["pbs"].values()), "Keep archives fall outside the coordinated recovery point")


class AtlasDrill(Drill):
    name = "atlas-postgres-restore"

    def __init__(self, host, policy, policy_sha256, point):
        require(host.node == "atlas", "Run on Atlas")
        require(set(policy) == {"format", "vmid", "storage", "mount", "luks_uuid", "system_disk_gib",
                                "allow_cleanup", "pbs", "rehearsal"}
                and type(policy["format"]) is int and policy["format"] == 1 and policy["allow_cleanup"] is True,
                "Invalid Atlas restore and cleanup policy")
        vmid = policy["vmid"]
        require(type(vmid) is int and 100 <= vmid <= 999_999_999 and vmid not in (2540, 2541),
                "Invalid Atlas restore VM ID")
        self.vmid = str(vmid)
        self.storage = policy["storage"]
        self.mount = Path(policy["mount"])
        self.luks_uuid = policy["luks_uuid"]
        self.disk_gib = policy["system_disk_gib"]
        require(type(self.disk_gib) is int and self.disk_gib > 0, "Invalid Atlas system disk geometry")
        pbs = policy["pbs"]
        verify_pbs_identity(pbs)
        point_fields = {"complete", "complete_sha256", "system_disk_sha256"}
        require(isinstance(point, dict) and set(point) in (point_fields, point_fields | {"system_disk_gib"})
                and isinstance(point["system_disk_sha256"], str) and re.fullmatch(HEX, point["system_disk_sha256"]),
                "Invalid pinned Atlas recovery point")
        if "system_disk_gib" in point:
            require(type(point["system_disk_gib"]) is int and point["system_disk_gib"] == self.disk_gib,
                    "Pinned recovery point geometry differs from Atlas policy")
        self.complete = Path(point["complete"])
        require(self.complete.is_absolute(), "Expected an absolute complete-receipt path")
        self.policy = policy
        self.policy_sha256 = policy_sha256
        self.point = point
        super().__init__(host)

    def ownership(self):
        return {
            "node": "atlas", "storage": self.storage, "mount": str(self.mount), "luks_uuid": self.luks_uuid,
            "policy_sha256": self.policy_sha256, "complete_sha256": self.point["complete_sha256"],
            "system_disk_sha256": self.point["system_disk_sha256"],
        }

    def destination(self):
        return verify_destination(self.storage, self.mount, self.luks_uuid)

    def admit(self):
        pair = pinned_json(self.complete, self.point["complete_sha256"])
        restore_id = pair["restore_id"]
        verify_source_pair(pair)
        self.verify_rehearsal(pair, self.policy["rehearsal"], 2, self.disk_gib)
        self.destination()
        require(not self.occupied(), "Atlas restore VM ID is occupied")
        self.require_no_ha()
        require(not os.path.lexists(self.mount / "images" / self.vmid),
                "Atlas restore VM ID has a pre-existing image path")
        check_pbs_key(Path(f"/etc/pve/priv/storage/{ALIAS}.enc"))
        alias = self.get(f"/storage/{ALIAS}")
        fingerprint = pair["pbs"]["quantself"]["encryption_fingerprint"]
        require(alias.get("type") == "pbs" and alias.get("nodes") == "atlas"
                and alias.get("encryption-key", "").lower() == fingerprint
                and all(alias.get(key) == value for key, value in self.policy["pbs"].items()),
                "Atlas restore storage differs from the pinned PBS identity")
        volume = ALIAS + ":" + pair["pbs"]["quantself"]["volid"].split(":", 1)[1]
        snapshots = self.get(f"{self.node_path}/storage/{ALIAS}/content", "--content", "backup", "--vmid", "2541")
        matches = [row for row in snapshots if row.get("volid") == volume]
        require(len(matches) == 1 and matches[0].get("notes") == restore_id
                and matches[0].get("vmid") == 2541 and matches[0].get("format") == "pbs-vm"
                and str(matches[0].get("encrypted", "")).lower() == fingerprint,
                "Pinned encrypted Keep snapshot is unavailable on Atlas")
        verify_source_hardware(command("pvesm", "extractconfig", volume), self.disk_gib)
        space = os.statvfs(self.mount)
        cloudinit = 4 * 1024 ** 2
        require(space.f_bavail * space.f_frsize >= (self.disk_gib + THIN_POOL_RESERVE_GIB) * GIB + cloudinit,
                "Atlas encrypted restore reserve is too low")
        require_memory_reserve()
        return pair, volume, self.disk_gib

    def config(self):
        config = self.get(self.vm + "/config", "--current", "1")
        pending = self.get(self.vm + "/pending")
        require(isinstance(pending, list) and not any("pending" in row or row.get("delete", 0) != 0
                                                     for row in pending),
                "Atlas restore VM has pending configuration changes")
        return config

    def disks(self, config, disk_gib, *, allow_drop=False):
        require(set(config) <= CONFIG | (DROP if allow_drop else set()) and config.get("boot") == "order=scsi0"
                and config.get("serial0", "socket") == "socket", "Atlas restore VM hardware differs")
        system, *options = config["scsi0"].split(",")
        seed, *seed_options = config["ide2"].split(",")
        prefix = f"{self.storage}:{self.vmid}/vm-{self.vmid}-"
        require(re.fullmatch(re.escape(prefix) + r"disk-[0-9]+\.raw", system)
                and exact_disk_size(options, disk_gib) and seed == prefix + "cloudinit.raw"
                and "media=cdrom" in seed_options, "Atlas restore VM disk geometry differs")
        return {system, seed}

    def disk_inventory(self):
        device = self.destination()
        directory = self.mount / "images" / self.vmid
        try:
            info = directory.lstat()
        except FileNotFoundError:
            return {}
        require(stat.S_ISDIR(info.st_mode) and info.st_dev == device,
                "Atlas clone image directory differs from the approved filesystem")
        volumes = {}
        for image in directory.iterdir():
            info = image.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_dev == device and info.st_nlink == 1,
                    "Atlas clone image inventory contains a foreign or linked file")
            volumes[f"{self.storage}:{self.vmid}/{image.name}"] = {"device": info.st_dev, "inode": info.st_ino}
        return volumes

    def verify_preboot(self, record):
        device = self.destination()
        config = self.config()
        evidence = {**record, "disks": {slot: config[slot].split(",", 1)[0] for slot in ("scsi0", "ide2")}}
        require(set(evidence["disks"].values()) == set(record["disks"]), "Atlas clone disk ownership changed")
        check_guest(evidence, self.storage, self.mount, device, config=config, pending=[],
                    status=self.get(self.vm + "/status/current"),
                    task=self.get(f"{self.node_path}/tasks/{record['upid']}/status"))
        require(self.config() == config and self.status() == "stopped", "Atlas clone changed during readback")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", type=Path, required=True)
    parser.add_argument("--policy-sha256", required=True)
    parser.add_argument("--point", type=Path, required=True)
    parser.add_argument("--complete-sha256", required=True, help="Independently selected Keep receipt SHA-256")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    host = Keep(STATE)
    require(os.geteuid() == 0 and host.node == "atlas", "Run as root on Atlas")
    for root in (STATE, CAPTURE_STATE):
        root.mkdir(exist_ok=True)
        private(root, 0o700)
    with locked(CAPTURE_STATE / "coordinator.lock"), locked(STATE / "coordinator.lock"):
        require(not os.path.lexists(CAPTURE_STATE / "active.json"), "Atlas failback capture requires reconciliation")
        policy = pinned_json(args.policy, args.policy_sha256)
        point = state_file(args.point)
        require(re.fullmatch(HEX, args.complete_sha256) and isinstance(point, dict)
                and point.get("complete_sha256") == args.complete_sha256,
                "Atlas point differs from the selected Keep recovery receipt")
        drill = AtlasDrill(host, policy, args.policy_sha256, point)
        receipt = drill.run(args.apply)
    print(json.dumps({key: receipt[key] for key in ("status", "restore_id", "vmid")}))


if __name__ == "__main__":
    try:
        main()
    except (BackupError, MonitorError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, TypeError, ValueError, KeyError, AttributeError):
        print("Atlas restore drill could not be verified. Preserve the clone and reconcile its private journal.",
              file=sys.stderr)
        sys.exit(1)
