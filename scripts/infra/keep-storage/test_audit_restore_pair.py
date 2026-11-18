from contextlib import redirect_stderr, redirect_stdout
import hashlib
from io import StringIO
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from audit_restore_pair import AuditError, audit_pair, main
from backup_guest import (ANALYTICS_BUNDLE, JOBS_BACKUP, JOBS_BINDS, PRODUCTION_APP,
                          PRODUCTION_COMPOSE, PRODUCTION_IMAGES, PRODUCTION_NATIVE_PROFILE)
from backup_inventory import InventoryError, write_inventory
from test_backup_guest import write_image_fixture


class RestorePairTests(unittest.TestCase):
    def setUp(self):
        if not hasattr(os, "listxattr"):
            # macOS Python lacks Linux's xattr API. Keep real file and stat
            # comparisons here. Native xattrs are covered on Linux.
            attributes = patch("backup_inventory.attributes", return_value={})
            attributes.start()
            self.addCleanup(attributes.stop)
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        parent = Path(scratch.name)
        self.complete_path = parent / "complete.json"
        self.roots = {role: parent / role for role in ("files", "quantself")}
        restore_id = "20261114T053000Z-123456abcdef"
        self.complete = {"format": 1, "restore_id": restore_id,
                         "completed_at": "2026-11-14T05:31:00+00:00", "pbs": {}, "offsite": {}}
        for index, (role, root) in enumerate(self.roots.items()):
            files = role == "files"
            image = "sha256:" + "a" * 64
            directories = ("opencloud/config", "opencloud/data") if files else ("captures", "auth", "postgres")
            for directory in (*directories, "deployment"):
                (root / "tree" / directory).mkdir(parents=True)
            (root / "tree/deployment/compose.yaml").write_text("services: {}")
            if files:
                (root / "tree/deployment/vault.Caddyfile").write_text("synthetic")
            else:
                for path in ("deployment/.env", "deployment/Caddyfile", "deployment/image-id", "auth/auth-secret"):
                    (root / "tree" / path).write_text("synthetic" * 4)
                    (root / "tree" / path).chmod(0o600)
                (root / "tree/postgres/quantself.dump").write_bytes(b"synthetic dump")
                archive = root / "tree/deployment/app-image"
                archive.mkdir()
                image = write_image_fixture(archive)
                (root / "tree/deployment/image-id").write_text(image + "\n")
            inventory_path = root / "inventory.json"
            inventory = write_inventory(root / "tree", inventory_path)
            manifest = {
                "format": 1, "restore_id": restore_id, "role": role,
                "images": {service: image for service in
                           (("opencloud", "vault-gateway") if files else ("gateway", "app", "api", "postgres"))},
                "inventory_sha256": hashlib.sha256(inventory_path.read_bytes()).hexdigest(),
                "inventory_entries": len(inventory["entries"]),
            }
            if not files:
                manifest["schema_migrations"] = ["20261114010000_original_files"]
            (root / "manifest.json").write_text(json.dumps(manifest))
            self.complete["offsite"][role] = {
                "snapshot": str(index + 2) * 64, "repository": str(index) * 64, "manifest": manifest,
            }
            self.complete["pbs"][role] = {
                "volid": f"backup:backup/vm/{2540 + index}/2026-11-14T05:30:00Z",
                "encryption_fingerprint": ":".join(["ab"] * 32),
            }
        self.save()

    def save(self):
        self.complete_path.write_text(json.dumps(self.complete))

    def atlas_capture(self):
        for role, vmid in (("files", 902), ("quantself", 901)):
            self.complete["pbs"][role]["volid"] = f"backup:backup/vm/{vmid}/2026-11-14T05:30:02Z"
        self.save()
        return {"atlas_ledger": {"records": {"vmid": 901}, "originals": {"vmid": 902}},
                "atlas_frozen_at": "2026-11-14T05:29:00Z",
                "atlas_complete_sha256": hashlib.sha256(self.complete_path.read_bytes()).hexdigest()}

    @unittest.skipUnless(os.geteuid() == 0, "App image archive fixture requires root ownership")
    def test_atlas_capture_audits_exact_promoted_roles_and_fresh_pair(self):
        args = self.atlas_capture()
        with self.assertRaisesRegex(AuditError, "PBS source identity"):
            audit_pair(self.complete_path, self.roots)
        result = audit_pair(self.complete_path, self.roots, **args)
        self.assertEqual(result["status"], "atlas_failback_pair_verified")
        self.assertEqual(result["restore_id"], self.complete["restore_id"])
        swapped = {"records": {"vmid": 902}, "originals": {"vmid": 901}}
        with self.assertRaisesRegex(AuditError, "PBS source identity"):
            audit_pair(self.complete_path, self.roots, **(args | {"atlas_ledger": swapped}))

    def test_atlas_rejects_stale_capture_or_archive_despite_fresh_completion(self):
        args = self.atlas_capture()
        self.complete["completed_at"] = "2026-11-14T05:40:00+00:00"
        self.save()
        args["atlas_complete_sha256"] = hashlib.sha256(self.complete_path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(AuditError, "outside the recorded write freeze"):
            audit_pair(self.complete_path, self.roots, **(args | {"atlas_frozen_at": "2026-11-14T05:31:00Z"}))
        self.complete["pbs"]["files"]["volid"] = "backup:backup/vm/902/2026-11-14T05:28:00Z"
        self.save()
        with self.assertRaisesRegex(AuditError, "differs from the recorded Atlas point"):
            audit_pair(self.complete_path, self.roots, **args)
        args["atlas_complete_sha256"] = hashlib.sha256(self.complete_path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(AuditError, "outside its coordinated recovery run"):
            audit_pair(self.complete_path, self.roots, **args)

    @unittest.skipUnless(os.geteuid() == 0, "App image archive fixture requires root ownership")
    def test_atlas_cli_requires_independent_promotion_ledger_fingerprint(self):
        atlas = self.atlas_capture()
        raw = json.dumps(atlas["atlas_ledger"]).encode()
        args = ["audit_restore_pair.py", str(self.complete_path),
                "--files", str(self.roots["files"]), "--quantself", str(self.roots["quantself"]),
                "--atlas-ledger", "fixture.json", "--atlas-ledger-sha256", hashlib.sha256(raw).hexdigest(),
                "--atlas-frozen-at", atlas["atlas_frozen_at"], "--atlas-complete-sha256", atlas["atlas_complete_sha256"]]
        with (patch("sys.argv", args), patch("audit_restore_pair.private_read", return_value=raw),
              redirect_stdout(StringIO()) as output):
            self.assertEqual(main(), 0)
            self.assertEqual(json.loads(output.getvalue())["status"], "atlas_failback_pair_verified")
        with (patch("sys.argv", args), patch("audit_restore_pair.private_read", return_value=raw + b"\n"),
              redirect_stderr(StringIO()) as error, redirect_stdout(StringIO()) as output):
            self.assertEqual(main(), 1)
            self.assertIn("differs from the fingerprint recorded at promotion", error.getvalue())
            self.assertEqual(output.getvalue(), "")

    def production_fixture(self, *, native=False):
        tree = self.roots["quantself"] / "tree"
        manifest = self.complete["offsite"]["quantself"]["manifest"]
        manifest["profile"] = PRODUCTION_NATIVE_PROFILE if native else "production"
        manifest["legacy_sources"] = ["legacy/audio"]
        manifest["images"] = dict.fromkeys(PRODUCTION_APP if native else PRODUCTION_IMAGES, manifest["images"]["app"])
        for directory in ("codex", "legacy/audio"):
            (tree / directory).mkdir(parents=True)
        files = [*(f"deployment/{name}" for name in PRODUCTION_COMPOSE),
                 "deployment/production-profile.json", "deployment/deploy.env.recovery-reference"]
        if native:
            files.append("deployment/web-drain.json")
        else:
            files.extend([*(f"deployment/analytics/{name}" for name in ANALYTICS_BUNDLE),
                          "analytics/umami.dump", "analytics/roles.sql"])
        for file in files:
            path = tree / file
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture")
            path.chmod(0o600)
        if native:
            (tree / "deployment/production-profile.json").write_text(json.dumps({"format": 2, "app_path": "/opt/quantself"}))
            (tree / "deployment/web-drain.json").write_text(json.dumps({
                "format": 1, "image": manifest["images"]["app"], "contract": "next-sigterm-deferred-request-v1",
            }))
        return tree, manifest

    @unittest.skipUnless(os.geteuid() == 0, "Native production archive fixture requires root ownership")
    def test_native_pair_requires_exact_release_without_umami(self):
        tree, manifest = self.production_fixture(native=True)
        self.refresh_quantself_inventory()
        self.assertEqual(audit_pair(self.complete_path, self.roots)["status"], "verified")
        manifest["images"]["analytics-postgres"] = manifest["images"]["postgres"]
        self.refresh_quantself_inventory()
        with self.assertRaisesRegex(AuditError, "unexpected service images"):
            audit_pair(self.complete_path, self.roots)
        del manifest["images"]["analytics-postgres"]
        (tree / "deployment/analytics").mkdir()
        self.refresh_quantself_inventory()
        with self.assertRaisesRegex(AuditError, "stale Umami tree"):
            audit_pair(self.complete_path, self.roots)
        (tree / "deployment/analytics").rmdir()
        proof = tree / "deployment/web-drain.json"
        proof.write_text("{}")
        self.refresh_quantself_inventory()
        with self.assertRaisesRegex(AuditError, "no matching drain proof"):
            audit_pair(self.complete_path, self.roots)

    def test_production_pair_requires_analytics_role_and_dump_and_codex(self):
        tree, _ = self.production_fixture()
        self.refresh_quantself_inventory()
        with patch("audit_restore_pair.verify_app_image_archive"):
            self.assertEqual(audit_pair(self.complete_path, self.roots)["status"], "verified")
        (tree / "analytics/roles.sql").unlink()
        self.refresh_quantself_inventory()
        with self.assertRaisesRegex(AuditError, "permissions differ"):
            audit_pair(self.complete_path, self.roots)

    @unittest.skipUnless(os.geteuid() == 0, "Jobs recovery fixture requires root ownership")
    def test_production_jobs_recovery_requires_matching_private_pair(self):
        tree, manifest = self.production_fixture()
        manifest["jobs_binds"] = sorted(f"{JOBS_BACKUP}/{relative}" for relative in JOBS_BINDS.values())
        for name in manifest["jobs_binds"]:
            path = tree / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("{}")
            path.chmod(0o600)
        self.refresh_quantself_inventory()
        self.assertEqual(audit_pair(self.complete_path, self.roots)["status"], "verified")
        manifest["jobs_binds"].pop()
        self.refresh_quantself_inventory()
        with self.assertRaisesRegex(AuditError, "Invalid Jobs configuration recovery pair"):
            audit_pair(self.complete_path, self.roots)
        manifest["jobs_binds"] = sorted(f"{JOBS_BACKUP}/{relative}" for relative in JOBS_BINDS.values())
        runner_file = tree / JOBS_BACKUP / "applicant-profile.json"
        runner_file.write_text("{}")
        self.refresh_quantself_inventory()
        with self.assertRaisesRegex(AuditError, "Invalid Jobs configuration recovery pair"):
            audit_pair(self.complete_path, self.roots)
        runner_file.unlink()
        path.chmod(0o644)
        self.refresh_quantself_inventory()
        with self.assertRaisesRegex(AuditError, "Invalid recovered Jobs configuration file"):
            audit_pair(self.complete_path, self.roots)
        path.unlink()
        self.refresh_quantself_inventory()
        with self.assertRaisesRegex(AuditError, "Invalid Jobs configuration recovery pair"):
            audit_pair(self.complete_path, self.roots)

    @unittest.skipUnless(os.geteuid() == 0, "Jobs recovery fixture requires root ownership")
    def test_declared_jobs_outbox_and_templates_must_be_recoverable(self):
        from backup_guest import (JOBS_OUTBOX_KEY, JOBS_OUTBOX_TREE, JOBS_OUTBOX_VOLUME,
                                  JOBS_TEMPLATE_FILES, JOBS_TEMPLATE_TARGET, JOBS_TEMPLATES)
        tree, manifest = self.production_fixture()
        (tree / "deployment/compose.prod.yaml").write_text(f"volumes:\n  {JOBS_OUTBOX_KEY}:\n")
        self.refresh_quantself_inventory()
        with self.assertRaisesRegex(AuditError, "outbox is missing"):
            audit_pair(self.complete_path, self.roots)
        outbox = tree / JOBS_OUTBOX_TREE
        outbox.mkdir(mode=0o700)
        (outbox / "synthetic-result.json").write_text("{}")
        manifest["jobs_codex_outbox"] = JOBS_OUTBOX_VOLUME
        (tree / "deployment/compose.home.yaml").write_text(f"        target: {JOBS_TEMPLATE_TARGET}\n")
        self.refresh_quantself_inventory()
        with self.assertRaisesRegex(AuditError, "templates differ"):
            audit_pair(self.complete_path, self.roots)
        manifest["jobs_templates"] = [f"{JOBS_BACKUP}/{JOBS_TEMPLATES}/{name}" for name in JOBS_TEMPLATE_FILES]
        for name in manifest["jobs_templates"]:
            file = tree / name
            file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            file.write_text("# Synthetic")
            file.chmod(0o600)
        self.refresh_quantself_inventory()
        self.assertEqual(audit_pair(self.complete_path, self.roots)["status"], "verified")
        file.parent.chmod(0o755)
        self.refresh_quantself_inventory()
        with self.assertRaisesRegex(AuditError, "Invalid recovered Jobs template directory"):
            audit_pair(self.complete_path, self.roots)
        file.parent.chmod(0o700)
        file.unlink()
        self.refresh_quantself_inventory()
        with self.assertRaisesRegex(AuditError, "Invalid Jobs configuration recovery pair"):
            audit_pair(self.complete_path, self.roots)

    def test_verified_pair_emits_counts_only(self):
        if os.geteuid() != 0:
            self.skipTest("App archive fixture requires root ownership")
        result = audit_pair(self.complete_path, self.roots)
        self.assertEqual(result, {"status": "verified", "inventory_entries": {"files": 7, "quantself": 15}})

    @unittest.skipUnless(os.geteuid() == 0, "App archive fixture requires root ownership")
    def test_wrong_app_image_is_rejected_even_with_valid_inventory_and_archive_checksums(self):
        role = "quantself"
        root = self.roots[role]
        archive = root / "tree/deployment/app-image"
        metadata = archive / "image.json"
        metadata.write_text(json.dumps({"id": "sha256:" + "b" * 64, "os": "linux", "architecture": "amd64"}))
        (archive / "SHA256SUMS").write_text("".join(
            f"{hashlib.sha256((archive / name).read_bytes()).hexdigest()}  {name}\n"
            for name in ("image.tar.gz", "image.json")
        ))
        self.refresh_quantself_inventory()
        with self.assertRaisesRegex(AuditError, "archive identity differs"):
            audit_pair(self.complete_path, self.roots)

    def refresh_quantself_inventory(self):
        role = "quantself"
        root = self.roots[role]
        inventory_path = root / "inventory.json"
        inventory_path.unlink()
        inventory = write_inventory(root / "tree", inventory_path)
        manifest = self.complete["offsite"][role]["manifest"]
        manifest["inventory_sha256"] = hashlib.sha256(inventory_path.read_bytes()).hexdigest()
        manifest["inventory_entries"] = len(inventory["entries"])
        (root / "manifest.json").write_text(json.dumps(manifest))
        self.save()

    def test_stale_image_pin_rejected_with_matching_inventory(self):
        (self.roots["quantself"] / "tree/deployment/image-id").write_text("sha256:" + "f" * 64)
        self.refresh_quantself_inventory()
        with self.assertRaisesRegex(AuditError, "image pin differs"):
            audit_pair(self.complete_path, self.roots)

    def test_changed_dump_fails_native_inventory(self):
        (self.roots["quantself"] / "tree/postgres/quantself.dump").write_bytes(b"corrupt dump")
        with self.assertRaises(InventoryError):
            audit_pair(self.complete_path, self.roots)

    def test_swapped_tree_rejects_role(self):
        swapped = {role: self.roots[peer] for role, peer in (("files", "quantself"), ("quantself", "files"))}
        with self.assertRaisesRegex(AuditError, "manifest does not match"):
            audit_pair(self.complete_path, swapped)

    def test_wrong_pbs_group_rejected(self):
        self.complete["pbs"]["files"]["volid"] = self.complete["pbs"]["quantself"]["volid"]
        self.save()
        with self.assertRaisesRegex(AuditError, "PBS source identity"):
            audit_pair(self.complete_path, self.roots)
