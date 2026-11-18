#!/usr/bin/env python3
"""Coordinate an encrypted PBS and restic recovery point on Keep."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import time

from backup_guest import (BackupError, Busy, GIB, RESTORE_ID, command, locked, private, read_json,
                          require, sync_dir, unit_status, write_json)

STATE = Path("/var/lib/keep-backup")
GUEST_SCRIPT = "/usr/local/lib/keep-backup/backup_guest.py"
GUESTS = {"quantself": 2541, "files": 2540}
STORAGE = "backup"
POOL = ("keep-vg", "data")


class Pending(BackupError):
    pass


class OperationFailed(BackupError):
    pass


def check_pbs_key(path):
    # pmxcfs presents private files as root:www-data. Verify metadata only.
    key = path.lstat()
    require(stat.S_ISREG(key.st_mode) and key.st_uid == 0 and key.st_gid == 33
            and stat.S_IMODE(key.st_mode) == 0o600, "PBS encryption key permissions differ")
    for directory in (path.parent, path.parent.parent):
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_gid == 33
                and stat.S_IMODE(info.st_mode) == 0o700, "PBS private directory permissions differ")


class Keep:
    guests = GUESTS

    def __init__(self, root=STATE):
        self.root = root
        self.node = socket.gethostname().split(".")[0]

    def pve(self, action, endpoint, *args):
        return json.loads(command("pvesh", action, endpoint, *args, "--output-format", "json"))

    def preflight(self, stage_bytes=0):
        require(self.node == "keep", "Unexpected coordinator hostname")
        key = Path(f"/etc/pve/priv/storage/{STORAGE}.enc")
        check_pbs_key(key)
        config = self.pve("get", f"/storage/{STORAGE}")
        fingerprint = config.get("encryption-key", "")
        require(config["type"] == "pbs" and config["datastore"] == "main"
                and config["username"] == "push@pbs!pve" and bool(config.get("fingerprint"))
                and re.fullmatch(r"(?:[0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}", str(fingerprint)),
                "PBS datastore, token or encryption configuration differs")
        storage = self.pve("get", f"/nodes/{self.node}/storage/{STORAGE}/status")
        require(storage.get("active"), "PBS storage is unavailable")
        require(shutil.disk_usage(self.root).free >= 2 * GIB, "Keep root disk reserve is too low")
        lvs = json.loads(command("lvs", "--reportformat", "json", "--units", "b", "--nosuffix",
                                 "-o", "vg_name,lv_name,lv_size,data_percent,metadata_percent",
                                 "/".join(POOL)))["report"][0]["lv"]
        require(len(lvs) == 1 and (lvs[0]["vg_name"], lvs[0]["lv_name"]) == POOL,
                "Unexpected Keep storage pool")
        pool = lvs[0]
        free = int(pool["lv_size"]) * (1 - float(pool["data_percent"]) / 100)
        require(float(pool["metadata_percent"]) < 85 and free >= 20 * GIB + stage_bytes,
                "Thin-pool reserve is too low for staging plus 20 GiB")
        nominal = 0
        for role, vmid in GUESTS.items():
            data = self.pve("get", f"/nodes/{self.node}/qemu/{vmid}/status/current")
            require(data["status"] == "running" and data["name"] == role, "Unexpected VM state")
            require(data["maxdisk"] > 0, "VM disk capacity is unavailable")
            nominal += data["maxdisk"]
        require(storage["avail"] >= nominal + 20 * GIB, "PBS first-backup capacity reserve is too low")
        return fingerprint.lower()

    def guest(self, action, role, restore_id, operation, attempt, *, vault_hostname=None):
        vault_args = ("--vault-hostname", vault_hostname) if vault_hostname else ()
        result = json.loads(command(
            "qm", "guest", "exec", str(self.guests[role]), "--timeout", "15", "--",
            "/usr/bin/python3", GUEST_SCRIPT, action, role, restore_id, operation, str(attempt),
            *vault_args, timeout=25,
        ))
        if not result.get("exited"):
            raise Pending(f"Guest {role} {operation} outcome is unconfirmed")
        if result.get("exitcode") != 0:
            raise BackupError(f"Guest {role} {action} {operation} failed")
        return json.loads(result["out-data"])

    def pbs_unit(self, restore_id):
        return f"keep-backup-{restore_id}-pbs.service"

    def pbs_worker_args(self, restore_id):
        return (Path(__file__).resolve(), "pbs-worker", restore_id)

    def pbs_start(self, restore_id):
        command("systemd-run", "--quiet", "--no-block", "--unit", self.pbs_unit(restore_id),
                "--property=StandardOutput=null",
                "--property=StandardError=null", sys.executable, *self.pbs_worker_args(restore_id))

    def pbs_status(self, restore_id):
        return unit_status(self.pbs_unit(restore_id), self.root / "runs" / restore_id / "pbs.json")

    def pbs_worker(self, restore_id):
        # This independent unit stays observable even if the coordinator dies.
        # Never start a second vzdump when the result of this one is unknown.
        path = self.root / "runs" / restore_id / "pbs.json"
        require(not path.exists(), "PBS backup already has a durable result")
        try:
            fingerprint = self.preflight()
            vmids = ",".join(str(self.guests[role]) for role in ("files", "quantself"))
            command("vzdump", vmids, "--node", self.node, "--storage", STORAGE,
                    "--mode", "snapshot", "--remove", "0", "--notes-template", restore_id,
                    output=subprocess.DEVNULL, timeout=None)
            snapshots = {}
            for role, vmid in self.guests.items():
                rows = self.pve("get", f"/nodes/{self.node}/storage/{STORAGE}/content",
                                "--content", "backup", "--vmid", str(vmid))
                matches = [row for row in rows if row.get("notes") == restore_id
                           and row.get("vmid") == vmid and row.get("format") == "pbs-vm"]
                require(len(matches) == 1 and str(matches[0].get("encrypted", "")).lower() == fingerprint
                        and re.fullmatch(rf"backup:backup/vm/{vmid}/\d{{4}}-\d{{2}}-\d{{2}}T\d{{2}}:\d{{2}}:\d{{2}}Z",
                                         matches[0]["volid"]),
                        f"Could not verify unique encrypted PBS snapshot for {role}")
                snapshots[role] = {"volid": matches[0]["volid"], "encryption_fingerprint": fingerprint}
            result = {"status": "ok", "result": snapshots}
        except BackupError as error:
            result = {"status": "failed", "error": str(error)}
        except Exception:
            result = {"status": "failed", "error": "PBS result validation failed; inspect locally"}
        write_json(path, result)


class Coordinator:
    def __init__(self, host, observation_seconds, *, atlas_scope=None):
        self.host = host
        self.root = host.root
        self.active = self.root / "active.json"
        self.deadline = time.monotonic() + observation_seconds if observation_seconds else None
        self.atlas_scope = atlas_scope

    def save(self):
        write_json(self.path, self.state)

    def initialize(self, action):
        if action == "run":
            if os.path.lexists(self.root / "retention-inflight.json"):
                require(self.atlas_scope is None, "Unexpected retention operation in Atlas capture state")
                from backup_retention import settle_dispatch

                try:
                    settle_dispatch(self.root)
                except (BackupError, OSError, ValueError, KeyError, TypeError):
                    if os.path.lexists(self.root / "retention-inflight.json"):
                        raise Pending("Original staging retention must settle before backup") from None
                    print("Previous staging retention settled with an error.", file=sys.stderr)
            if self.active.exists():
                raise Pending("Unfinished backup exists; run recover")
            started = datetime.now(timezone.utc).replace(microsecond=0)
            if self.atlas_scope is not None:
                require(started >= datetime.fromisoformat(self.atlas_scope["frozen_at"]),
                        "Atlas write freeze must precede capture")
            now = started.strftime("%Y%m%dT%H%M%SZ")
            self.restore_id = f"{now}-{secrets.token_hex(6)}"
            self.run = self.root / "runs" / self.restore_id
            self.run.mkdir(parents=True)
            sync_dir(self.run.parent)
            self.path = self.run / "journal.json"
            self.state = {"format": 1, "restore_id": self.restore_id, "operations": {}}
            if self.atlas_scope is not None:
                self.state["atlas_scope"] = self.atlas_scope
            self.save()
            write_json(self.active, {"restore_id": self.restore_id})
        else:
            if not self.active.exists():
                raise Pending("No unfinished backup to recover")
            self.restore_id = read_json(self.active)["restore_id"]
            require(RESTORE_ID.fullmatch(self.restore_id), "Invalid active restore ID")
            self.run = self.root / "runs" / self.restore_id
            self.path = self.run / "journal.json"
            self.state = read_json(self.path)
            require(self.state["restore_id"] == self.restore_id, "Backup journal identity differs")
            require(self.state.get("atlas_scope") == self.atlas_scope, "Backup capture policy changed during recovery")

    def launch(self, key, starter, attempt):
        # Persist intent before dispatch. A crash in this window must be
        # reconciled by observation, never by automatically sending a new job.
        self.state["operations"][key] = {"attempt": attempt}
        self.save()
        try:
            starter(attempt)
        except (BackupError, OSError, ValueError):
            pass  # Still observe the original attempt after a lost reply.

    def wait(self, key, observer):
        record = self.state["operations"][key]
        while "status" not in record:
            try:
                result = observer(record["attempt"])
            except (BackupError, OSError, ValueError, KeyError):
                raise Pending(f"{key} observation failed; run recover") from None
            status = result.get("status") if isinstance(result, dict) else None
            if ((status == "ok" and isinstance(result.get("result"), dict))
                    or (status == "failed" and isinstance(result.get("error"), str))):
                record.update(result)
                self.save()
            elif status != "running":
                raise Pending(f"{key} outcome is unknown; inspect the original worker")
            elif self.deadline is not None and time.monotonic() >= self.deadline:
                raise Pending(f"{key} still running; run recover to observe the original worker")
            else:
                time.sleep(2)
        if record["status"] == "failed":
            raise OperationFailed(f"{key}: {record['error']}")
        return record["result"]

    def guest(self, role, operation, retry_failure=False):
        key = f"{role}.{operation}"
        record = self.state["operations"].get(key)
        if record is None or (retry_failure and record.get("status") == "failed"):
            attempt = record["attempt"] + 1 if record else 1
            self.launch(key, lambda n: self.host.guest("start", role, self.restore_id, operation, n), attempt)
        return self.wait(key, lambda n: self.host.guest("status", role, self.restore_id, operation, n))

    def pbs(self):
        if "pbs" not in self.state["operations"]:
            self.launch("pbs", lambda _: self.host.pbs_start(self.restore_id), 1)
        return self.wait("pbs", lambda _: self.host.pbs_status(self.restore_id))

    def finalize(self):
        self.active.unlink()
        sync_dir(self.root)

    def resume(self, recover):
        errors = []
        # Vault first so the API can use it; attempt both after a known failure.
        for role in ("files", "quantself"):
            if f"{role}.pause" in self.state["operations"]:
                try:
                    self.guest(role, "resume", retry_failure=recover)
                except (Pending, OperationFailed) as error:
                    errors.append(str(error))
        if errors:
            raise Pending("; ".join(errors))

    def abort(self):
        require(not (self.run / "complete.json").exists(),
                "Backup was already published; run recover to finish")
        self.state["abort_requested"] = True
        self.save()
        for key, record in self.state["operations"].items():
            if "status" in record:
                continue
            try:
                if key == "pbs":
                    self.wait(key, lambda _: self.host.pbs_status(self.restore_id))
                else:
                    role, operation = key.split(".")
                    self.wait(key, lambda attempt: self.host.guest(
                        "status", role, self.restore_id, operation, attempt
                    ))
            except OperationFailed:
                continue
        if self.atlas_scope is None:
            self.resume(recover=True)
        self.state["failure"] = "Backup aborted by operator"
        self.save()
        if self.atlas_scope is None:
            self.finalize()
        return {"status": "aborted", "restore_id": self.restore_id}

    def check_paused(self):
        # Read-only checks can be repeated before dispatch and after PBS settles.
        for role in GUESTS:
            self.host.guest("check-paused", role, self.restore_id, "pause", 1)

    def run_backup(self, action):
        self.initialize(action)
        operations = self.state["operations"]
        if action == "abort" or self.state.get("abort_requested"):
            return self.abort()
        if not self.state.get("pause_finished"):
            try:
                if not any(key.endswith(".pause") for key in operations):
                    self.host.preflight()
                    stage_bytes = sum(self.guest(role, "preflight")["estimated_copy_bytes"] for role in GUESTS)
                    require(all(re.fullmatch(r"[0-9a-f]{64}", operations[f"{role}.preflight"]["result"]["repository"])
                                for role in GUESTS)
                            and len({operations[f"{role}.preflight"]["result"]["repository"]
                                     for role in GUESTS}) == len(GUESTS),
                            "Guests must have independent repositories")
                    self.host.preflight(stage_bytes)
                for role in GUESTS:
                    self.guest(role, "pause")
                for role in GUESTS:
                    self.guest(role, "capture")
                if "pbs" not in operations:
                    self.check_paused()
                self.pbs()
                self.check_paused()
            except Pending:
                raise
            except BackupError as error:
                self.state["failure"] = str(error)
            except (OSError, ValueError, KeyError, TypeError):
                self.state["failure"] = "Backup phase validation failed"
            self.state["pause_finished"] = True
            self.save()
        if self.atlas_scope is None:
            self.resume(action == "recover")
        if self.state.get("failure"):
            if self.atlas_scope is None:
                self.finalize()
            raise OperationFailed(self.state["failure"])
        # Keep resumes before cloud upload. Atlas checks quiescence and
        # preserves the original pause and active record through failback.
        if self.atlas_scope is not None:
            self.check_paused()
        try:
            offsite = {role: self.guest(role, "upload") for role in GUESTS}
        except OperationFailed as error:
            self.state["failure"] = str(error)
            self.save()
            if self.atlas_scope is None:
                self.finalize()
            raise
        pbs = operations["pbs"]["result"]
        require(set(pbs) == set(offsite) == set(GUESTS), "Recovery point lacks a matching pair")
        for role in GUESTS:
            upload = offsite[role]
            capture = operations[f"{role}.capture"]["result"]
            require(capture == upload["manifest"] and capture["role"] == role
                    and capture["restore_id"] == self.restore_id
                    and upload["repository"] == operations[f"{role}.preflight"]["result"]["repository"]
                    and re.fullmatch(r"[0-9a-f]{64}", upload["snapshot"]),
                    f"Backup evidence does not match for {role}")
        require(len({upload["repository"] for upload in offsite.values()}) == len(GUESTS),
                "Guests must have independent repositories")
        if self.atlas_scope is not None:
            self.check_paused()
        complete = self.run / "complete.json"
        evidence = {"format": 1, "restore_id": self.restore_id, "pbs": pbs, "offsite": offsite}
        if complete.exists():
            manifest = read_json(complete)
            require({k: v for k, v in manifest.items() if k != "completed_at"} == evidence,
                    "Completed backup evidence differs")
        else:
            manifest = {**evidence, "completed_at": datetime.now(timezone.utc).isoformat()}
            write_json(complete, manifest)
        write_json(self.root / "last-success.json", manifest)
        if self.atlas_scope is None:
            self.finalize()
        return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("run", "recover", "abort", "pbs-worker"))
    parser.add_argument("restore_id", nargs="?")
    parser.add_argument("--observation-seconds", type=int, default=0,
                        help="Return while an original worker is still running; zero waits")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        require(os.geteuid() == 0, "Run as root")
        require(args.observation_seconds >= 0, "Invalid observation limit")
        STATE.mkdir(exist_ok=True)
        private(STATE, 0o700)
        host = Keep()
        require(host.node == "keep", "Unexpected coordinator hostname")
        if args.action == "pbs-worker":
            require(args.restore_id and RESTORE_ID.fullmatch(args.restore_id), "Invalid restore ID")
            host.pbs_worker(args.restore_id)
        else:
            require(args.restore_id is None, "Unexpected restore ID argument")
            with locked(STATE / "coordinator.lock"):
                result = Coordinator(host, args.observation_seconds).run_backup(args.action)
                print(json.dumps({"status": result.get("status", "complete"),
                                  "restore_id": result["restore_id"]}))
    except (Busy, Pending) as error:
        print(str(error), file=sys.stderr)
        return 75
    except BackupError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception:
        print("Backup state or command error; inspect privately and recover the existing run",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
