#!/usr/bin/env python3
"""Read-only validation of a complete manifest and extracted restic pair."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import stat
import sys

from backup_guest import (
    ANALYTICS_BUNDLE, JOBS_BACKUP, JOBS_BINDS, JOBS_OUTBOX_TREE, JOBS_OUTBOX_VOLUME,
    JOBS_TEMPLATE_FILES, JOBS_TEMPLATES, LEGACY_MOUNTS, PRODUCTION_APP, PRODUCTION_COMPOSE, PRODUCTION_IMAGES, PRODUCTION_NATIVE_PROFILE,
    BackupError, jobs_outbox_declared, jobs_templates_declared, verify_app_image_archive, verify_image_pin, verify_web_drain_proof,
)
from backup_inventory import InventoryError, verify_inventory
from backup_monitor import MonitorError, private_read


ROLES = {"files": 2540, "quantself": 2541}
HEX_ID = re.compile(r"[0-9a-f]{64}")
FINGERPRINT = re.compile(r"(?:[0-9a-f]{2}:){31}[0-9a-f]{2}")
RESTORE_ID = re.compile(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}")
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}")


class AuditError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise AuditError(message)


def read_file(path):
    require(stat.S_ISREG(path.lstat().st_mode), "Recovery metadata must be regular files")
    return path.read_bytes()


def pinned_json(raw, fingerprint, mismatch):
    require(HEX_ID.fullmatch(fingerprint or ""), "Expected a recorded SHA-256")
    require(hashlib.sha256(raw).hexdigest() == fingerprint, mismatch)
    return json.loads(raw)


def audit_pair(manifest_path, roots, *, atlas_ledger=None, atlas_frozen_at=None, atlas_complete_sha256=None):
    raw = read_file(manifest_path)
    roles = ROLES
    atlas = atlas_ledger is not None
    if atlas:
        complete = pinned_json(raw, atlas_complete_sha256, "Complete manifest differs from the recorded Atlas point")
        require(isinstance(atlas_ledger, dict) and set(atlas_ledger) == {"records", "originals"},
                "Expected both promoted Atlas roles")
        roles = {"quantself": atlas_ledger["records"]["vmid"], "files": atlas_ledger["originals"]["vmid"]}
        require(all(type(vmid) is int and 100 <= vmid <= 999_999_999 for vmid in roles.values())
                and len(set(roles.values())) == 2, "Expected two distinct promoted Atlas VM IDs")
    else:
        complete = json.loads(raw)
    require(type(complete["format"]) is int and complete["format"] == 1
            and RESTORE_ID.fullmatch(complete["restore_id"]),
            "Unsupported or invalid complete manifest")
    completed = datetime.fromisoformat(complete["completed_at"])
    require(completed.tzinfo is not None, "Complete manifest timestamp needs a timezone")
    if atlas:
        started = datetime.strptime(complete["restore_id"].split("-", 1)[0], "%Y%m%dT%H%M%SZ").replace(
            tzinfo=timezone.utc)
        frozen = datetime.fromisoformat(atlas_frozen_at)
        require(frozen.tzinfo is not None and frozen <= started <= completed <= datetime.now(timezone.utc),
                "Atlas recovery point falls outside the recorded write freeze")
    require(set(complete["pbs"]) == set(complete["offsite"]) == set(roots) == set(ROLES),
            "Complete manifest requires both recovery roles")
    repositories = set()
    fingerprints = set()
    for role, vmid in roles.items():
        pbs = complete["pbs"][role]
        require(re.fullmatch(rf"backup:backup/vm/{vmid}/[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}T[0-9]{{2}}:[0-9]{{2}}:[0-9]{{2}}Z",
                             pbs["volid"]) and FINGERPRINT.fullmatch(pbs["encryption_fingerprint"]),
                "PBS source identity or encryption fingerprint differs")
        if atlas:
            snapshot_time = datetime.fromisoformat(pbs["volid"].rsplit("/", 1)[1])
            require(started <= snapshot_time <= completed, "Atlas archive falls outside its coordinated recovery run")
        fingerprints.add(pbs["encryption_fingerprint"])
        offsite = complete["offsite"][role]
        require(HEX_ID.fullmatch(offsite["repository"]) and HEX_ID.fullmatch(offsite["snapshot"]),
                "Invalid offsite repository or snapshot identity")
        repositories.add(offsite["repository"])
    require(len(repositories) == 2 and len(fingerprints) == 1,
            "Expected independent offsite repositories and the same PBS encryption key")
    results = {role: audit_tree(roots[role], complete["offsite"][role]["manifest"], role, complete["restore_id"])
               for role in roles}
    result = {"status": "verified", "inventory_entries": results}
    if atlas:
        return result | {"status": "atlas_failback_pair_verified", "restore_id": complete["restore_id"]}
    return result


def audit_tree(root, expected, role, restore_id):
    require(stat.S_ISDIR(root.lstat().st_mode), "Extracted root must be a real directory")
    require({entry.name for entry in root.iterdir()} == {"manifest.json", "inventory.json", "tree"},
            "Extracted archive root differs")
    manifest = json.loads(read_file(root / "manifest.json"))
    require(manifest == expected and manifest["format"] == 1 and manifest["role"] == role
            and manifest["restore_id"] == restore_id, "Extracted manifest does not match the complete point")
    service_names = ({"opencloud", "vault-gateway"} if role == "files"
                     else {"gateway", "app", "api", "postgres"})
    profile = manifest.get("profile")
    production = profile in ("production", PRODUCTION_NATIVE_PROFILE)
    umami = profile == "production"
    require(profile is None or (production and role == "quantself"), "Unexpected recovery profile")
    if production:
        service_names = PRODUCTION_IMAGES if umami else set(PRODUCTION_APP)
    require(set(manifest["images"]) == service_names
            and all(IMAGE_ID.fullmatch(image) for image in manifest["images"].values()),
            "Extracted manifest has unexpected service images")
    inventory_path = root / "inventory.json"
    inventory_bytes = read_file(inventory_path)
    require(hashlib.sha256(inventory_bytes).hexdigest() == manifest["inventory_sha256"],
            "Extracted inventory checksum differs")
    inventory = verify_inventory(root / "tree", inventory_path)
    entries = inventory["entries"]
    require(len(entries) == manifest["inventory_entries"], "Extracted inventory entry count differs")
    indexed = {entry["path"]: entry for entry in entries}
    required_dirs = ({"opencloud/config", "opencloud/data", "deployment"} if role == "files"
                     else {"captures", "auth", "postgres", "deployment"})
    jobs_paths = {f"{JOBS_BACKUP}/{name}" for name in JOBS_BINDS.values()}
    template_paths = {f"{JOBS_BACKUP}/{JOBS_TEMPLATES}/{name}" for name in JOBS_TEMPLATE_FILES}
    jobs_entries = {path for path, entry in indexed.items()
                    if path.startswith(JOBS_BACKUP + "/") and entry["type"] != "directory"}
    jobs_manifest = manifest.get("jobs_binds")
    templates_manifest = manifest.get("jobs_templates")
    expected_jobs = set()
    for declared, expected in ((jobs_manifest, jobs_paths), (templates_manifest, template_paths)):
        if declared is not None:
            require(production and declared == sorted(expected),
                    "Invalid Jobs configuration recovery pair")
            expected_jobs.update(expected)
    require(jobs_entries == expected_jobs, "Invalid Jobs configuration recovery pair")
    require(all(indexed[path]["type"] == "file" and indexed[path]["mode"] == 0o600
                and indexed[path]["uid"] == indexed[path]["gid"] == 0
                and indexed[path]["size"] > 0 and "hardlink" not in indexed[path] for path in expected_jobs),
            "Invalid recovered Jobs configuration file")
    if templates_manifest is not None:
        directory = indexed.get(f"{JOBS_BACKUP}/{JOBS_TEMPLATES}", {})
        require(directory.get("type") == "directory" and directory["mode"] == 0o700
                and directory["uid"] == directory["gid"] == 0, "Invalid recovered Jobs template directory")
    outbox = manifest.get("jobs_codex_outbox")
    if outbox is not None or JOBS_OUTBOX_TREE in indexed:
        outbox_entry = indexed.get(JOBS_OUTBOX_TREE, {})
        require(production and outbox == JOBS_OUTBOX_VOLUME
                and outbox_entry.get("type") == "directory"
                and outbox_entry["uid"] == outbox_entry["gid"] == 0
                and not outbox_entry["mode"] & 0o022, "Invalid Jobs Codex outbox recovery tree")
    if production:
        deployment = root / "tree" / "deployment"
        require(not jobs_outbox_declared(deployment / "compose.prod.yaml") or outbox == JOBS_OUTBOX_VOLUME,
                "Jobs Codex outbox is missing from deployment recovery")
        require(jobs_templates_declared(deployment / "compose.home.yaml") == (templates_manifest is not None),
                "Jobs templates differ from deployment recovery")
    if production:
        legacy_sources = manifest["legacy_sources"]
        require(isinstance(legacy_sources, list) and legacy_sources == sorted(set(legacy_sources))
                and set(legacy_sources) <= set(LEGACY_MOUNTS.values()), "Invalid legacy storage manifest")
        required_dirs.update({"codex", *legacy_sources})
        if umami:
            required_dirs.add("analytics")
        else:
            require("analytics" not in indexed and "deployment/analytics" not in indexed,
                    "Native production bundle contains a stale Umami tree")
        require({path for path in indexed if path in LEGACY_MOUNTS.values()} == set(legacy_sources),
                "Recovered legacy volumes do not match the manifest")
    require(all(indexed.get(path, {}).get("type") == "directory" for path in required_dirs),
            "Extracted recovery tree lacks a required directory")
    required_files = {"deployment/compose.yaml"}
    if role == "files":
        required_files.add("deployment/vault.Caddyfile")
    else:
        required_files.update({"deployment/.env", "deployment/Caddyfile", "deployment/image-id",
                               "auth/auth-secret"})
    if production:
        required_files.update(f"deployment/{name}" for name in PRODUCTION_COMPOSE)
        secret_files = {"deployment/production-profile.json", "deployment/deploy.env.recovery-reference"}
        if umami:
            required_files.update(f"deployment/analytics/{name}" for name in ANALYTICS_BUNDLE)
            secret_files.update({"deployment/analytics/.env", "analytics/umami.dump", "analytics/roles.sql"})
        else:
            native_profile = json.loads(read_file(root / "tree/deployment/production-profile.json"))
            require(isinstance(native_profile, dict) and set(native_profile) == {"format", "app_path"} and type(native_profile["format"]) is int
                    and native_profile["format"] == 2 and isinstance(native_profile["app_path"], str)
                    and Path(native_profile["app_path"]).is_absolute(), "Native production profile differs")
            secret_files.add("deployment/web-drain.json")
        required_files.update(secret_files)
        require(all(indexed.get(path, {}).get("mode", 0o777) & 0o077 == 0 for path in secret_files),
                "Production backup file permissions differ")
    require(all(indexed.get(path, {}).get("type") == "file" and indexed[path]["size"] > 0
                for path in required_files), "Extracted recovery tree lacks required deployment or auth files")
    if role == "quantself":
        require(all(indexed[path]["mode"] & 0o077 == 0
                    for path in ("deployment/.env", "auth/auth-secret"))
                and indexed["auth/auth-secret"]["size"] >= 32, "Recovered auth file permissions or size differ")
        require(manifest["images"]["app"] == manifest["images"]["api"], "Recovered app and API images differ")
        prefix = "deployment/app-image/"
        try:
            verify_image_pin(root / "tree/deployment/image-id", manifest["images"]["app"])
            if profile == PRODUCTION_NATIVE_PROFILE:
                verify_web_drain_proof(root / "tree/deployment/web-drain.json", manifest["images"]["app"])
            verify_app_image_archive(root / "tree" / prefix, manifest["images"]["app"],
                                     digests={path.removeprefix(prefix): entry["sha256"]
                                              for path, entry in indexed.items()
                                              if path.startswith(prefix) and entry["type"] == "file"})
        except BackupError as error:
            raise AuditError(str(error)) from None
        dump = indexed.get("postgres/quantself.dump", {})
        require(dump.get("type") == "file" and dump.get("size", 0) > 0
                and manifest["schema_migrations"], "Extracted recovery tree lacks the database dump or schema")
    return len(entries)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("complete_manifest", type=Path)
    parser.add_argument("--files", type=Path, required=True, help="extracted Vault restic root")
    parser.add_argument("--quantself", type=Path, required=True, help="extracted Quantself restic root")
    parser.add_argument("--atlas-ledger", type=Path, help="private ledger of the promoted Atlas writers")
    parser.add_argument("--atlas-ledger-sha256", help="ledger SHA-256 recorded at promotion")
    parser.add_argument("--atlas-frozen-at", help="recorded write freeze timestamp, including offset")
    parser.add_argument("--atlas-complete-sha256", help="complete manifest SHA-256 recorded for the Atlas capture")
    args = parser.parse_args()
    try:
        atlas_args = (args.atlas_ledger, args.atlas_ledger_sha256, args.atlas_frozen_at, args.atlas_complete_sha256)
        ledger = None
        if any(value is not None for value in atlas_args):
            require(all(value is not None for value in atlas_args), "Expected all four Atlas failback inputs")
            ledger = pinned_json(private_read(args.atlas_ledger, 256 * 1024), args.atlas_ledger_sha256,
                                 "Atlas ledger differs from the fingerprint recorded at promotion")
            require(isinstance(ledger, dict), "Atlas promotion ledger must be a JSON object")
        result = audit_pair(args.complete_manifest, {"files": args.files, "quantself": args.quantself},
                            atlas_ledger=ledger, atlas_frozen_at=args.atlas_frozen_at,
                            atlas_complete_sha256=args.atlas_complete_sha256)
    except AuditError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (InventoryError, MonitorError, OSError, TypeError, ValueError, KeyError, AttributeError):
        print("Recovery inventory or manifest could not be verified; inspect privately", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
