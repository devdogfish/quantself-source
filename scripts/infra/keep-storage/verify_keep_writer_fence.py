#!/usr/bin/env python3
"""Read-only verification of the powered-off Keep or Atlas writer fence."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import socket
import sys

from backup_coordinator import GUESTS
from backup_guest import BackupError, command, require
from backup_monitor import MonitorError, private_read
from backup_restore_drill import clone_identity


WRITERS = {role: GUESTS[role] for role in ("quantself", "files")}


def get(path):
    return json.loads(command("pvesh", "get", path, "--output-format", "json", timeout=15))


def verify_start_policy(rows):
    require(isinstance(rows, list), "Writer guest configuration is missing")
    config = {}
    for row in rows:
        key = row["key"]
        require(isinstance(key, str) and key not in config, "Writer guest configuration is ambiguous")
        require("pending" not in row and row.get("delete", 0) in (0, "0"),
                "A writer guest has unapplied configuration changes")
        config[key] = row["value"]
    require(isinstance(config["name"], str) and config["name"] and "lock" not in config,
            "Writer guest identity or lock differs")
    require(all(config.get(key, 0) in (0, "0") for key in ("onboot", "autostart")),
            "A writer guest can start automatically")
    return config


def verify_fence(atlas_ledger=None):
    node = "keep" if atlas_ledger is None else "atlas"
    require(socket.gethostname().split(".", 1)[0] == node, f"Expected the {'Keep' if node == 'keep' else 'Atlas'} hypervisor")
    writers = WRITERS
    if atlas_ledger is not None:
        require(set(atlas_ledger) == {"records", "originals"}, "Expected both Atlas writer roles in the promotion ledger")
        writers = {role: record["vmid"] for role, record in atlas_ledger.items()}
        require(all(type(vmid) is int and 100 <= vmid <= 999_999_999 for vmid in writers.values())
                and len(set(writers.values())) == 2, "Expected two distinct Atlas writer IDs")
        require(all(len({record["clone_identity"][key] for record in atlas_ledger.values()}) == 2
                    for key in ("vmgenid", "smbios_uuid")), "Atlas writer identities must be distinct")
    paths = {role: f"/nodes/{node}/qemu/{vmid}" for role, vmid in writers.items()}
    with ThreadPoolExecutor(max_workers=3) as pool:
        ha = pool.submit(get, "/cluster/ha/resources")
        configs = {name: pool.submit(get, f"{path}/pending") for name, path in paths.items()}
        rows = ha.result()
        require(isinstance(rows, list) and all(isinstance(row["sid"], str) for row in rows)
                and not {row["sid"] for row in rows} & {f"vm:{vmid}" for vmid in writers.values()},
                "A writer guest is managed by HA or HA state is unknown")
        names = {}
        for role, response in configs.items():
            config = verify_start_policy(response.result())
            if atlas_ledger is None:
                require(config["name"] == role, "Keep guest identity differs")
            else:
                require(clone_identity(config) == atlas_ledger[role]["clone_identity"],
                        "Atlas guest UUIDs differ from the promotion ledger")
            names[role] = config["name"]

        # Observe power state after the startup-policy checks, immediately before reporting.
        statuses = {name: pool.submit(get, f"{path}/status/current") for name, path in paths.items()}
        for role, response in statuses.items():
            status = response.result()
            require(type(status["vmid"]) is int and status["vmid"] == writers[role]
                    and status["name"] == names[role] and status["status"] == "stopped",
                    f"Both exact {'Keep' if node == 'keep' else 'Atlas'} guests must be stopped")
    return {"status": f"{node}_guests_fenced", "node": node, "guests": writers}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--atlas-ledger", type=Path, help="Private ledger of the Atlas pair recorded at promotion")
    parser.add_argument("--atlas-ledger-sha256", help="SHA-256 recorded independently at Atlas promotion")
    args = parser.parse_args()
    try:
        require((args.atlas_ledger is None) == (args.atlas_ledger_sha256 is None),
                "Supply both the Atlas ledger and its recorded SHA-256")
        if args.atlas_ledger is None:
            result = verify_fence()
        else:
            require(re.fullmatch(r"[0-9a-f]{64}", args.atlas_ledger_sha256), "Invalid Atlas promotion ledger SHA-256")
            raw = private_read(args.atlas_ledger, 256 * 1024)
            require(hashlib.sha256(raw).hexdigest() == args.atlas_ledger_sha256,
                    "Atlas ledger differs from the fingerprint recorded at promotion")
            ledger = json.loads(raw)
            require(isinstance(ledger, dict), "Atlas promotion ledger must be a JSON object")
            result = verify_fence(ledger)
    except BackupError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (MonitorError, OSError, TypeError, ValueError, KeyError, AttributeError):
        label = "Keep" if args.atlas_ledger is None else "Atlas"
        print(f"{label} fence evidence is missing or malformed", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
