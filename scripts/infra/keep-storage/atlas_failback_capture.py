#!/usr/bin/env python3
"""Capture one coordinated Atlas failback pair while retaining the writer pause."""

import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys

from atlas_failover_admission import verify_destination
from backup_coordinator import Coordinator, Keep, Pending, STORAGE, check_pbs_key
from backup_guest import (BackupError, Busy, GIB, RESTORE_ID, VAULT_HOSTNAME,
                          locked, private, read_json, read_vault_origin, require)
from backup_monitor import MonitorError, private_read
from backup_restore_drill import ATLAS_DRILL_STATE, clone_identity


STATE = Path("/var/lib/atlas-failback")
PBS_FIELDS = {"server", "datastore", "namespace", "username", "fingerprint", "encryption-key"}


def pinned_json(path, sha256):
    require(re.fullmatch(r"[0-9a-f]{64}", sha256), "Expected a recorded SHA-256")
    raw = private_read(path, 256 * 1024)
    require(hashlib.sha256(raw).hexdigest() == sha256, "Pinned Atlas capture input has changed")
    result = json.loads(raw)
    require(isinstance(result, dict), "Expected an Atlas capture JSON object")
    return result


class Atlas(Keep):
    def __init__(self, policy_path, policy_sha256, root=STATE):
        super().__init__(root)
        require(self.node == "atlas", "Expected the Atlas hypervisor")
        self.policy_path = policy_path.absolute()
        self.policy = policy = pinned_json(self.policy_path, policy_sha256)
        require(set(policy) == {"ledger", "ledger_sha256", "frozen_at", "vm_storage", "mount",
                                "luks_uuid", "reserve_gib", "pbs", "offsite_repositories",
                                "vault_hostname"}, "Invalid Atlas capture policy")
        keep_hostname = read_vault_origin().removeprefix("https://")
        hostname = policy["vault_hostname"]
        require(isinstance(hostname, str) and VAULT_HOSTNAME.fullmatch(hostname)
                and hostname != keep_hostname, "Expected the distinct Atlas Vault Tailscale hostname")
        self.scope = {"policy_sha256": policy_sha256, "frozen_at": policy["frozen_at"]}
        require(datetime.fromisoformat(policy["frozen_at"]).tzinfo is not None, "Atlas freeze time needs a timezone")
        ledger_path = Path(policy["ledger"])
        require(ledger_path.is_absolute(), "Expected an absolute Atlas ledger path")
        ledger = pinned_json(ledger_path, policy["ledger_sha256"])
        require(set(ledger) == {"records", "originals"}, "Expected both promoted Atlas roles")
        self.writers = {"quantself": ledger["records"], "files": ledger["originals"]}
        self.guests = {role: writer["vmid"] for role, writer in self.writers.items()}
        require(all(type(vmid) is int and 100 <= vmid <= 999_999_999 for vmid in self.guests.values())
                and len(set(self.guests.values())) == 2
                and all(len({writer["clone_identity"][key] for writer in self.writers.values()}) == 2
                        for key in ("vmgenid", "smbios_uuid")), "Atlas writer identities must be distinct")
        require(type(policy["reserve_gib"]) is int and policy["reserve_gib"] > 0, "Invalid Atlas capture reserve")
        offsite = policy["offsite_repositories"]
        require(set(offsite) == set(ledger) and all(re.fullmatch(r"[0-9a-f]{64}", value) for value in offsite.values())
                and len(set(offsite.values())) == 2, "Expected two distinct pinned Atlas offsite repositories")
        self.repositories = {"quantself": offsite["records"], "files": offsite["originals"]}
        pbs = policy["pbs"]
        require(isinstance(pbs, dict) and set(pbs) == PBS_FIELDS and pbs["datastore"] == "main"
                and all(isinstance(pbs[key], str) and pbs[key] for key in PBS_FIELDS - {"namespace"})
                and (pbs["namespace"] is None or isinstance(pbs["namespace"], str))
                and all(re.fullmatch(r"(?:[0-9a-f]{2}:){31}[0-9a-f]{2}", pbs[key], re.I)
                        for key in ("fingerprint", "encryption-key")), "Invalid pinned PBS identity")

    def verify_writer(self, role):
        vmid = self.guests[role]
        path = f"/nodes/atlas/qemu/{vmid}"
        config = self.pve("get", f"{path}/config", "--current", "1")
        require(clone_identity(config) == self.writers[role]["clone_identity"],
                "Atlas writer UUIDs differ from the promotion ledger")
        require("lock" not in config, "Atlas writer has a Proxmox lock")
        disks = self.writers[role]["disks"]
        disk_slots = {key for key in config if re.fullmatch(r"(?:scsi|ide|sata|virtio)\d+|(?:efidisk|tpmstate)0", key)}
        require("scsi0" in disks and disk_slots == set(disks)
                and all(volume.startswith(f"{self.policy['vm_storage']}:{vmid}/")
                        and config[slot].split(",", 1)[0] == volume for slot, volume in disks.items()),
                "Atlas writer disks differ from the promotion ledger")
        return path

    def preflight(self, stage_bytes=0):
        policy = self.policy
        verify_destination(policy["vm_storage"], Path(policy["mount"]), policy["luks_uuid"])
        check_pbs_key(Path(f"/etc/pve/priv/storage/{STORAGE}.enc"))
        config = self.pve("get", f"/storage/{STORAGE}")
        require(config.get("type") == "pbs" and all(config.get(key) == value for key, value in policy["pbs"].items()),
                "Atlas PBS storage differs from the pinned identity")
        storage = self.pve("get", f"/nodes/atlas/storage/{STORAGE}/status")
        reserve = policy["reserve_gib"] * GIB
        require(storage["active"] and shutil.disk_usage(policy["mount"]).free >= stage_bytes + reserve,
                "Atlas encrypted storage reserve is too low")
        nominal = 0
        for role, vmid in self.guests.items():
            path = self.verify_writer(role)
            status = self.pve("get", f"{path}/status/current")
            require(type(status["vmid"]) is int and status["vmid"] == vmid and status["status"] == "running"
                    and type(status["maxdisk"]) is int and status["maxdisk"] > 0,
                    "Unexpected Atlas writer state or size")
            nominal += status["maxdisk"]
        require(storage["avail"] >= nominal + reserve, "Atlas PBS reserve is too low")
        return policy["pbs"]["encryption-key"].lower()

    def guest(self, action, role, restore_id, operation, attempt):
        require(operation != "resume", "Atlas capture keeps writers paused")
        self.verify_writer(role)
        result = super().guest(action, role, restore_id, operation, attempt,
                               vault_hostname=self.policy["vault_hostname"] if role == "files" else None)
        if (action == "status" and operation == "preflight" and result.get("status") == "ok"
                and result["result"].get("repository") != self.repositories[role]):
            return {"status": "failed", "error": "Atlas guest offsite repository differs from the pinned identity"}
        return result

    def pbs_unit(self, restore_id):
        return f"atlas-failback-{restore_id}-pbs.service"

    def pbs_worker_args(self, restore_id):
        return (Path(__file__).resolve(), "pbs-worker", restore_id,
                "--policy", self.policy_path, "--policy-sha256", self.scope["policy_sha256"])

    def pbs_worker(self, restore_id):
        journal = read_json(self.root / "runs" / restore_id / "journal.json")
        require(read_json(self.root / "active.json") == {"restore_id": restore_id}
                and journal["restore_id"] == restore_id and journal["atlas_scope"] == self.scope
                and journal["operations"].get("pbs") == {"attempt": 1},
                "Atlas PBS worker lacks its original dispatch intent")
        for role in self.guests:
            self.guest("check-paused", role, restore_id, "pause", 1)
        super().pbs_worker(restore_id)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("run", "recover", "abort", "pbs-worker"))
    parser.add_argument("restore_id", nargs="?")
    parser.add_argument("--policy", type=Path, required=True)
    parser.add_argument("--policy-sha256", required=True)
    parser.add_argument("--observation-seconds", type=int, default=0)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        require(os.geteuid() == 0, "Run as root")
        require(args.observation_seconds >= 0, "Invalid observation limit")
        atlas = Atlas(args.policy, args.policy_sha256)
        atlas.root.mkdir(exist_ok=True)
        private(atlas.root, 0o700)
        if args.action == "pbs-worker":
            require(RESTORE_ID.fullmatch(args.restore_id or ""), "Invalid Atlas restore ID")
            atlas.pbs_worker(args.restore_id)
        else:
            require(args.restore_id is None, "Unexpected restore ID argument")
            with locked(atlas.root / "coordinator.lock"):
                require(not os.path.lexists(ATLAS_DRILL_STATE / "postgres-restore-active.json"),
                        "Atlas PostgreSQL restore drill requires reconciliation")
                result = Coordinator(atlas, args.observation_seconds, atlas_scope=atlas.scope).run_backup(args.action)
                print(json.dumps({"status": result.get("status", "complete"), "restore_id": result["restore_id"]}))
    except (Busy, Pending) as error:
        print(str(error), file=sys.stderr)
        return 75
    except BackupError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (MonitorError, OSError, ValueError, KeyError, TypeError, AttributeError):
        print("Atlas capture could not be verified. Preserve the freeze and reconcile the original run.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
