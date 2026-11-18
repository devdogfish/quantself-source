#!/usr/bin/env python3
"""Verify the latest coordinated PostgreSQL PBS backup on Keep."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import time
from uuid import UUID

from backup_coordinator import Keep, check_pbs_key
from backup_guest import (ANALYTICS_SERVICES, API_WORKERS, PRODUCTION_APP, RELEASE_SLOTS, RELEASE_STATE, BackupError, GIB, command,
                          locked, private, require, sync_dir, write_json)
from backup_monitor import MonitorError, healthcheck_url, ping, state_file
from backup_retention import validate_pair

STATE = Path("/var/lib/keep-backup")
ATLAS_DRILL_STATE = Path("/var/lib/atlas-postgres-restore")
POLICY = Path("/etc/keep-backup/postgres-restore-policy.json")
REHEARSAL = Path("/etc/keep-backup/postgres-restore-rehearsal.json")
NATIVE_REHEARSAL = Path("/etc/keep-backup/postgres-restore-native-rehearsal.json")
NATIVE_PROFILE = "production-native"
NATIVE_MIGRATIONS = {
    "20261114223000_tracked_links",
    "20261115005000_website_events_and_inquiries",
}
PING = Path("/etc/keep-backup/restore-healthcheck-url")
VMID = "2544"
NAME = "quantself-db-restore-254"
ALIAS = "backup-restore-254"
DISK = re.compile(r"local-lvm:vm-2544-disk-[0-9]+")
CLOUDINIT = "local-lvm:vm-2544-cloudinit"
LEGACY_DISK_GIB = 32
THIN_POOL_RESERVE_GIB = 20
POSTGRES = "keep-quantself-postgres-1"
CONTAINERS = {
    f"keep-quantself-{service}-1": (("running", "unless-stopped") if service == "postgres"
                                  else ("exited", "unless-stopped"))
    for service in ("postgres", "app", "api", "gateway")
}
CONTAINERS.update({f"keep-quantself-{service}-1": ("exited", "no")
                   for service in ("migrate", "auth-secret-init")})
PRODUCTION_POSTGRES = PRODUCTION_APP["postgres"]
ANALYTICS_POSTGRES = "portfolio-analytics-postgres-1"
PRODUCTION_CONTAINERS = {
    **{container: ("running" if name == "postgres" else "exited", "unless-stopped")
       for name, container in PRODUCTION_APP.items()},
    **{f"portfolio-{name}-1": ("running" if name == "analytics-postgres" else "exited", "unless-stopped")
       for name in ANALYTICS_SERVICES},
    **{f"quantself-{name}-1": ("exited", "no") for name in ("migrate", "auth-secret-init")},
}
NATIVE_CONTAINERS = {
    **{container: PRODUCTION_CONTAINERS[container] for container in PRODUCTION_APP.values()},
    **{f"quantself-{name}-1": ("exited", "no") for name in ("migrate", "auth-secret-init")},
}
NATIVE_OCR = PRODUCTION_APP["inventory-preprocessing-worker"]
NATIVE_CONTAINERS[NATIVE_OCR] = ("exited", "no")
ANALYTICS_SQL = """SELECT count(*) FROM pg_class WHERE oid IN
(to_regclass('website_event'), to_regclass('event_data'));
SELECT CASE WHEN EXISTS (SELECT FROM pg_roles WHERE rolname = 'quantself_analytics_reader')
  THEN has_table_privilege('quantself_analytics_reader', 'website_event', 'SELECT')
   AND has_table_privilege('quantself_analytics_reader', 'event_data', 'SELECT')
   AND NOT has_table_privilege('quantself_analytics_reader', 'website_event', 'INSERT,UPDATE,DELETE,TRUNCATE')
   AND NOT has_table_privilege('quantself_analytics_reader', 'event_data', 'INSERT,UPDATE,DELETE,TRUNCATE')
  ELSE false END;"""
CONFIG = { "agent", "autostart", "balloon", "bios", "boot", "cores", "cpu", "description", "digest", "machine",
           "ide2", "memory", "meta", "name", "onboot", "ostype", "scsi0", "scsihw", "serial0", "smbios1",
           "sockets", "startup", "vga", "vmgenid", "tags" }
DROP = {"net0", "ipconfig0", "nameserver", "searchdomain", "cicustom"}
SQL = """SELECT 1;
SELECT COALESCE(json_agg(migration_name ORDER BY migration_name), '[]'::json)
FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
SELECT count(*) FROM pg_class WHERE oid IN
(to_regclass('original_file'), to_regclass('api_idempotency_key'));"""
NATIVE_SQL = SQL + """
SELECT to_regclass('public.website_event') IS NOT NULL
   AND to_regclass('public.website_inquiry') IS NOT NULL;"""


def require_memory_reserve(meminfo=Path("/proc/meminfo")):
    error = "Keep MemAvailable could not be verified"
    try:
        lines = meminfo.read_text(encoding="ascii").split("\n")
        fields = [line for line in lines if re.match(r"[ \t]*MemAvailable\b", line)]
        require(len(fields) == 1, error)
        match = re.fullmatch(r"MemAvailable:[ \t]*([0-9]+)[ \t]+kB[ \t]*", fields[0])
        require(match is not None, error)
        available_bytes = int(match[1]) * 1024
    except (OSError, ValueError):
        raise BackupError(error) from None
    require(available_bytes >= 3 * GIB, "Keep memory reserve is too low")


def approved_geometry(policy):
    legacy = {"format": 1, "vmid": 2544, "storage": "local-lvm", "pbs_alias": ALIAS,
              "allow_cleanup": True}
    require(isinstance(policy, dict) and policy.get("allow_cleanup") is True
            and type(policy.get("format")) is int and type(policy.get("vmid")) is int,
            "Owner nightly restore and cleanup policy is absent")
    if policy == legacy:
        return LEGACY_DISK_GIB
    size = policy.get("system_disk_gib")
    require(type(size) is int and size > 0 and policy == {
        **legacy, "format": 2, "system_disk_gib": size,
    }, "Owner nightly restore and cleanup policy is absent or has invalid geometry")
    return size


def exact_disk_size(options, size):
    return [option for option in options if option.startswith("size=")] == [f"size={size}G"]


def verify_source_hardware(text, disk_gib):
    rows = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition(": ")
        require(separator and key not in rows and key in CONFIG | DROP,
                "PBS source contains unexpected hardware or settings")
        rows[key] = value
    system = rows.get("scsi0", "").split(",")
    seed = rows.get("ide2", "").split(",")
    require(re.fullmatch(r"local-lvm:vm-2541-disk-[0-9]+", system[0])
            and exact_disk_size(system[1:], disk_gib) and seed[0] == "local-lvm:vm-2541-cloudinit"
            and "media=cdrom" in seed and rows.get("boot") == "order=scsi0",
            "PBS source is outside the approved disk and boot scope")


def clone_identity(config):
    smbios = [field.removeprefix("uuid=") for field in config.get("smbios1", "").split(",")
              if field.startswith("uuid=")]
    require(len(smbios) == 1, "Restore VM UUID metadata differs")
    try:
        vmgenid = UUID(config.get("vmgenid", ""))
        smbios_uuid = UUID(smbios[0])
    except ValueError:
        raise BackupError("Restore VM UUID metadata differs") from None
    require(vmgenid.int and smbios_uuid.int, "Restore VM UUID metadata differs")
    return {"vmgenid": str(vmgenid), "smbios_uuid": str(smbios_uuid)}


class Drill:
    vmid = VMID
    storage = "local-lvm"
    name = NAME

    def __init__(self, host):
        self.host = host
        self.root = host.root
        self.node_path = f"/nodes/{host.node}"
        self.vm = f"{self.node_path}/qemu/{self.vmid}"

    def get(self, path, *args):
        return self.host.pve("get", path, *args)

    def config(self):
        return self.get(self.vm + "/config")

    def status(self):
        return self.get(self.vm + "/status/current")["status"]

    def occupied(self):
        return any(str(item["vmid"]) == self.vmid for item in self.get("/cluster/resources", "--type", "vm"))

    def require_no_ha(self):
        require(not any(row.get("sid") == f"vm:{self.vmid}" for row in self.get("/cluster/ha/resources")),
                "Restore VM ID has HA policy")

    def disks(self, config, disk_gib, *, allow_drop=False):
        require(set(config) <= CONFIG | (DROP if allow_drop else set()),
                "Restored VM hardware differs from the approved disk-only clone")
        disk, *options = config["scsi0"].split(",")
        require(DISK.fullmatch(disk) and exact_disk_size(options, disk_gib) and config["boot"] == "order=scsi0",
                "Restored VM disk geometry or boot order differs")
        seed = config["ide2"].split(",")
        require(seed[0] == CLOUDINIT and "media=cdrom" in seed,
                "Restored cloud-init volume is not the clone-owned CD-ROM")
        return {disk, CLOUDINIT}

    def admit(self):
        require(self.host.node == "keep", "Run on Keep")
        require(not os.path.lexists(self.root / "active.json")
                and not os.path.lexists(self.root / "retention-inflight.json"),
                "Backup or retention operation is unresolved")
        pair = state_file(self.root / "last-success.json")
        restore_id = pair["restore_id"]
        completed = validate_pair(pair, restore_id)
        require(0 <= (datetime.now(timezone.utc) - completed).total_seconds() <= 4 * 3600,
                "No fresh coordinated recovery pair")
        require(state_file(self.root / "runs" / restore_id / "complete.json") == pair,
                "Completed recovery point differs from heartbeat")
        policy = state_file(POLICY)
        disk_gib = approved_geometry(policy)
        profile = pair["offsite"]["quantself"]["manifest"].get("profile")
        rehearsal = state_file(NATIVE_REHEARSAL if profile == NATIVE_PROFILE else REHEARSAL)
        self.verify_rehearsal(pair, rehearsal, policy["format"], disk_gib)
        fingerprint = pair["pbs"]["quantself"]["encryption_fingerprint"]
        require(not self.occupied(), "Restore VM ID 2544 is occupied")
        self.require_no_ha()
        require(not self.get(f"/nodes/keep/storage/local-lvm/content", "--vmid", VMID),
                "Restore VM ID has pre-existing disks")
        check_pbs_key(Path(f"/etc/pve/priv/storage/{ALIAS}.enc"))
        backup = self.get("/storage/backup")
        alias = self.get(f"/storage/{ALIAS}")
        require(alias.get("type") == "pbs" and alias.get("encryption-key", "").lower() == fingerprint
                and all(alias.get(key) == backup.get(key)
                        for key in ("server", "port", "datastore", "namespace", "fingerprint")),
                "Independent restore storage differs from source or recovery fingerprint")
        volume = ALIAS + ":" + pair["pbs"]["quantself"]["volid"].split(":", 1)[1]
        snapshots = self.get(f"/nodes/keep/storage/{ALIAS}/content", "--content", "backup", "--vmid", "2541")
        require(any(row.get("volid") == volume and str(row.get("encrypted", "")).lower() == fingerprint
                    for row in snapshots), "Approved encrypted snapshot is not available")
        verify_source_hardware(command("pvesm", "extractconfig", volume), disk_gib)
        storage = self.get("/nodes/keep/storage/local-lvm/status")
        require(storage["active"] and storage["avail"] >= (disk_gib + THIN_POOL_RESERVE_GIB) * GIB,
                "Thin-pool restore reserve is too low")
        lvs = json.loads(command("lvs", "--reportformat", "json", "-o", "metadata_percent",
                                 "keep-vg/data"))["report"][0]["lv"]
        require(len(lvs) == 1 and float(lvs[0]["metadata_percent"]) < 85, "Thin metadata reserve is too low")
        require_memory_reserve()
        return pair, volume, disk_gib

    def verify_rehearsal(self, pair, rehearsal, policy_format, disk_gib):
        app_manifest = pair["offsite"]["quantself"]["manifest"]
        profile = app_manifest.get("profile")
        slot = app_manifest.get("release_slot")
        require(slot is None or (profile == NATIVE_PROFILE and slot in ("legacy", *RELEASE_SLOTS)),
                "Unknown release slot in the nightly restore manifest")
        require(profile in (None, "production", NATIVE_PROFILE), "Unknown nightly restore profile")
        image = app_manifest["images"]["postgres"]
        fingerprint = pair["pbs"]["quantself"]["encryption_fingerprint"]
        expected_rehearsal = {"format": policy_format, "postgres_image": image,
                              "pbs_encryption_fingerprint": fingerprint,
                              "full_restore_verified": True, "postgres_only_no_nic_verified": True}
        if policy_format == 2:
            expected_rehearsal["system_disk_gib"] = disk_gib
        if profile == "production":
            expected_rehearsal.update(
                profile="production",
                analytics_postgres_image=app_manifest["images"]["analytics-postgres"],
                production_two_database_no_nic_verified=True,
            )
        elif profile == NATIVE_PROFILE:
            require(app_manifest["images"].keys() == PRODUCTION_APP.keys(),
                    "Native restore manifest must contain exactly the Quantself service images")
            require(NATIVE_MIGRATIONS.issubset(app_manifest["schema_migrations"]),
                    "Native website migrations are missing from the restore manifest")
            expected_rehearsal.update(profile=NATIVE_PROFILE, production_native_no_nic_verified=True)
        require(rehearsal == expected_rehearsal and type(rehearsal["format"]) is int
                and (policy_format == 1 or type(rehearsal["system_disk_gib"]) is int),
                "Matching full restore and no-NIC PostgreSQL rehearsal are required")

    def disk_inventory(self):
        return dict.fromkeys(row["volid"] for row in self.get(f"{self.node_path}/storage/{self.storage}/content",
                                                              "--vmid", self.vmid))

    def verify_preboot(self, record):
        pass

    def ownership(self):
        return {}

    def restore(self, journal, record):
        write_json(journal, {**record, "phase": "restore_requested"})
        output = command(
            "pvesh", "create", f"{self.node_path}/qemu", "--archive", record["volume"], "--vmid", self.vmid,
            "--storage", self.storage, "--unique", "1", "--start", "0",
            "--onboot", "0", "--autostart", "0", "--output-format", "json", timeout=None,
        )
        candidates = [line.strip() for line in output.splitlines()
                      if line.strip().startswith(("UPID:", '"UPID:'))]
        upid = candidates[0] if len(candidates) == 1 else ""
        if upid.startswith('"') and upid.endswith('"'):
            upid = upid[1:-1]
        require(re.fullmatch(
            rf"UPID:{re.escape(self.host.node)}:(?:[0-9A-Fa-f]+:){{3}}qmrestore:{self.vmid}:[A-Za-z0-9@_.!-]+:",
            upid,
        ), "Original restore task identity could not be confirmed")
        write_json(journal, {**record, "phase": "restore_observing", "upid": upid})
        deadline = time.monotonic() + 2100
        while time.monotonic() < deadline:
            state = self.get(f"{self.node_path}/tasks/{upid}/status")
            if state.get("status") == "stopped":
                require(state.get("exitstatus") == "OK", "Original restore task failed")
                return upid
            require(state.get("status") == "running", "Original restore task outcome is unconfirmed")
            time.sleep(3)
        raise BackupError("Original restore task is still running; inspect the recorded UPID")

    def qga(self, *args):
        reply = json.loads(command("qm", "guest", "exec", self.vmid, "--timeout", "10", "--",
                                   *args, timeout=15))
        require(reply.get("exited") and reply.get("exitcode") == 0, "Restore guest probe did not complete")
        output = reply.get("out-data", "")
        require(isinstance(output, str), "Restore guest probe output is invalid")
        return output.strip()

    def verify_containers(self, expected=CONTAINERS, *, allow_created=(), optional=None):
        names = self.qga("/usr/bin/docker", "ps", "-a", "--format", "{{.Names}}").splitlines()
        optional = optional or {}
        require(expected.keys() <= set(names) <= expected.keys() | optional.keys()
                and len(names) == len(set(names)), "Restored Docker container set differs")
        expected = {**expected, **{name: optional[name] for name in names if name in optional}}
        rows = self.qga("/usr/bin/docker", "inspect", "--format",
                        "{{.Name}} {{.State.Status}} {{.HostConfig.RestartPolicy.Name}}",
                        *sorted(expected)).splitlines()
        actual = {}
        for row in rows:
            name, state, restart = row.split()
            name = name.removeprefix("/")
            if name in allow_created and state == "created":
                state = "exited"
            actual[name] = (state, restart)
        require(actual == expected and len(rows) == len(expected),
                "Restored Docker service state or restart policy differs")

    def verify_slot_containers(self, slot):
        observed = self.qga("/usr/bin/head", "-n", "1", str(RELEASE_STATE / "active"))
        require(observed == slot, "Restored active slot differs from the paired manifest")
        services = (PRODUCTION_APP.keys() | {API_WORKERS}) - {"postgres"}
        slot_sets = {
            color: {f"quantself-{color}-{name}-1": ("exited", "unless-stopped") for name in services}
            for color in RELEASE_SLOTS
        }
        allowed_created = {NATIVE_OCR}
        for color, containers in slot_sets.items():
            ocr = f"quantself-{color}-inventory-preprocessing-worker-1"
            containers[ocr] = ("exited", "no")
            allowed_created.add(ocr)
        if slot == "legacy":
            optional = {name: policy for containers in slot_sets.values() for name, policy in containers.items()}
            self.verify_containers(NATIVE_CONTAINERS, allow_created=allowed_created, optional=optional)
            return
        inactive = "blue" if slot == "green" else "green"
        optional = {**NATIVE_CONTAINERS, **slot_sets[inactive]}
        del optional[PRODUCTION_POSTGRES]
        self.verify_containers({PRODUCTION_POSTGRES: NATIVE_CONTAINERS[PRODUCTION_POSTGRES],
                                **slot_sets[slot]}, allow_created=allowed_created, optional=optional)

    def postgres(self, image, migrations, *, native=False, slot=None):
        postgres = PRODUCTION_POSTGRES if native else POSTGRES
        sql = NATIVE_SQL if native else SQL
        expected_results = ["2", "t", "COMMIT"] if native else ["2", "COMMIT"]
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            try:
                running = self.qga("/usr/bin/docker", "ps", "--format", "{{.Names}}")
            except BackupError:
                time.sleep(2)
                continue
            require(running in ("", postgres), "Unexpected running container in isolated restore")
            if running == postgres:
                try:
                    actual_image = self.qga("/usr/bin/docker", "inspect", "--format", "{{.Image}}", postgres)
                    self.qga("/usr/bin/docker", "exec", postgres, "pg_isready", "-U", "quantself")
                    output = self.qga("/usr/bin/docker", "exec", postgres, "psql", "-XAt", "-w",
                                      "-v", "ON_ERROR_STOP=1", "-U", "quantself", "-d", "quantself",
                                      "-c", "BEGIN READ ONLY; " + sql + " COMMIT;")
                except BackupError:
                    time.sleep(2)
                    continue
                require(actual_image == image, "Restored PostgreSQL image differs")
                rows = output.splitlines()
                require(rows[:2] == ["BEGIN", "1"]
                        and rows[3:] == expected_results and json.loads(rows[2]) == migrations,
                        "Restored PostgreSQL query or schema check differs")
                if slot:
                    self.verify_slot_containers(slot)
                elif native:
                    self.verify_containers(NATIVE_CONTAINERS, allow_created=(NATIVE_OCR,))
                else:
                    self.verify_containers()
                require(self.qga("/usr/bin/docker", "ps", "--format", "{{.Names}}") == postgres,
                        "Unexpected running container after PostgreSQL verification")
                return
            time.sleep(2)
        raise BackupError("Isolated PostgreSQL did not become ready")

    def production_postgres(self, images, migrations):
        expected = {PRODUCTION_POSTGRES, ANALYTICS_POSTGRES}
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            try:
                running = set(self.qga("/usr/bin/docker", "ps", "--format", "{{.Names}}").splitlines())
            except BackupError:
                time.sleep(2)
                continue
            require(running <= expected, "Unexpected running container in production restore")
            if running == expected:
                def read(container, user, sql):
                    self.qga("/usr/bin/docker", "exec", container, "pg_isready", "-U", user)
                    return self.qga("/usr/bin/docker", "exec", container, "psql", "-XAt", "-w",
                                    "-v", "ON_ERROR_STOP=1", "-U", user, "-d", user,
                                    "-c", "BEGIN READ ONLY; " + sql + " COMMIT;").splitlines()

                try:
                    ids = [self.qga("/usr/bin/docker", "inspect", "--format", "{{.Image}}", container)
                           for container in (PRODUCTION_POSTGRES, ANALYTICS_POSTGRES)]
                    app = read(PRODUCTION_POSTGRES, "quantself", SQL)
                    analytics = read(ANALYTICS_POSTGRES, "umami", ANALYTICS_SQL)
                except BackupError:
                    time.sleep(2)
                    continue
                require(ids == [images["postgres"], images["analytics-postgres"]],
                        "Restored production PostgreSQL image differs")
                require(len(app) == 5 and app[:2] == ["BEGIN", "1"] and app[3:] == ["2", "COMMIT"]
                        and json.loads(app[2]) == migrations, "Restored application schema differs")
                require(analytics == ["BEGIN", "2", "t", "COMMIT"],
                        "Restored analytics schema or reader grants differ")
                self.verify_containers(PRODUCTION_CONTAINERS)
                require(set(self.qga("/usr/bin/docker", "ps", "--format", "{{.Names}}").splitlines()) == expected,
                        "Unexpected running container after production verification")
                return
            time.sleep(2)
        raise BackupError("Both isolated production PostgreSQL instances did not become ready")

    def run(self, apply):
        journal = self.root / "postgres-restore-active.json"
        require(not os.path.lexists(journal), "Previous restore drill requires reconciliation")
        pair, volume, disk_gib = self.admit()
        restore_id = pair["restore_id"]
        result_path = self.root / "postgres-restore-last-success.json"
        last = state_file(result_path, optional=True)
        require(last is None or last["restore_id"] != restore_id, "Recovery point already passed the drill")
        vmid = int(self.vmid)
        if not apply:
            return {"status": "preview", "restore_id": restore_id, "vmid": vmid}
        manifest = pair["offsite"]["quantself"]["manifest"]
        production = manifest.get("profile") == "production"
        memory = 2048 if production else 1536
        marker = f"{self.host.node}-postgres-restore:{restore_id}"
        record = {"format": 1, "restore_id": restore_id, "volume": volume, "vmid": vmid,
                  "system_disk_gib": disk_gib, **self.ownership()}
        record["upid"] = self.restore(journal, record)
        config = self.config()
        require(self.status() == "stopped" and config.get("onboot", 0) == 0
                and config.get("autostart", 0) == 0, "Restore VM autostart or state is unexpected")
        disks = self.disks(config, disk_gib, allow_drop=True)
        inventory = self.disk_inventory()
        require(inventory.keys() == disks, "Restore disk ownership differs")
        pinned_disks = any(identity is not None for identity in inventory.values())
        if pinned_disks:
            record["disk_identities"] = inventory
        record["disks"] = sorted(disks)
        record["clone_identity"] = clone_identity(config)
        write_json(journal, {**record, "phase": "configure_requested"})
        removed = sorted(config.keys() & DROP)
        delete = ("--delete", ",".join(removed)) if removed else ()
        command("qm", "set", self.vmid, "--name", self.name, "--description", marker,
                "--onboot", "0", "--memory", str(memory), "--balloon", "0",
                "--sockets", "1", "--cores", "1", *delete)
        def verify_clone():
            current = self.config()
            require(current["name"] == self.name and current["description"] == marker
                    and self.disks(current, disk_gib) == disks and clone_identity(current) == record["clone_identity"]
                    and current["memory"] in (memory, str(memory))
                    and current["cores"] == current["sockets"] == 1
                    and current.get("onboot", 0) == 0 and current.get("autostart", 0) == 0
                    and current.get("balloon", 0) == 0,
                    "Restore VM identity, no-NIC configuration or capacity differs")
        self.verify_preboot(record)
        verify_clone()
        self.require_no_ha()
        starting = {**record, "phase": "start_requested"}
        write_json(journal, starting)
        if pinned_disks:
            require(self.disk_inventory() == inventory, "Restore disk ownership changed before boot")
            verify_clone()
            require(self.status() == "stopped", "Restore clone stopped state changed before boot")
        command("qm", "start", self.vmid, timeout=120)
        try:
            if production:
                self.production_postgres(manifest["images"], manifest["schema_migrations"])
            elif manifest.get("profile") == NATIVE_PROFILE:
                self.postgres(manifest["images"]["postgres"], manifest["schema_migrations"],
                              native=True, slot=manifest.get("release_slot"))
            else:
                self.postgres(manifest["images"]["postgres"], manifest["schema_migrations"])
        finally:
            verify_clone()
            command("qm", "shutdown", self.vmid, "--timeout", "90", timeout=105)
        verify_clone()
        require(self.status() == "stopped", "Restore VM did not shut down")
        require(self.disk_inventory() == inventory, "Restore disk ownership changed before cleanup")
        self.require_no_ha()
        require(state_file(journal) == starting, "Restore ownership journal changed before cleanup")
        write_json(journal, {**record, "phase": "cleanup_requested"})
        if pinned_disks:
            require(self.disk_inventory() == inventory, "Restore disk ownership changed before cleanup")
            verify_clone()
            require(self.status() == "stopped", "Restore clone stopped state changed before cleanup")
        command("qm", "destroy", self.vmid, "--destroy-unreferenced-disks", "0", timeout=120)
        require(not self.occupied() and not self.disk_inventory(),
                "Restore cleanup did not verify")
        receipt = {**record, "status": "verified", "completed_at": datetime.now(timezone.utc).isoformat()}
        if manifest.get("profile") == NATIVE_PROFILE:
            receipt["profile"] = NATIVE_PROFILE
        write_json(result_path, receipt)
        journal.unlink()
        sync_dir(self.root)
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Execute the Owner-approved restore drill")
    args = parser.parse_args()
    os.umask(0o077)
    require(os.geteuid() == 0, "Run as root")
    private(STATE, 0o700)
    url = healthcheck_url(PING) if args.apply else None
    try:
        with locked(STATE / "coordinator.lock"):
            receipt = Drill(Keep()).run(args.apply)
    except Exception:
        if url:
            ping(url, False)
        raise
    if url:
        ping(url, True)
    print(json.dumps({"status": receipt["status"], "restore_id": receipt["restore_id"], "vmid": 2544}))


if __name__ == "__main__":
    try:
        main()
    except (BackupError, MonitorError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("Restore drill did not complete. Preserve the clone and reconcile its private journal.",
              file=sys.stderr)
        sys.exit(1)
