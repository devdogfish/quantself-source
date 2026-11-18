import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
from threading import Event
import unittest
from unittest.mock import patch

from backup_guest import ANALYTICS_WRITERS, INVENTORY_WORKERS, BackupError, Busy, Guest, locked, StopUnconfirmed, read_json, restic, snapshot_digest, unit_status, verify_app_image_archive, verify_image_pin, verify_production_release, write_json


def write_image_fixture(archive, *, platform="amd64", forged_blob=None, revision=None):
    config = json.dumps({"os": "linux", "architecture": platform}).encode()
    digest = hashlib.sha256(config).hexdigest()
    image = "sha256:" + digest
    config_name = "blobs/sha256/" + digest
    with tarfile.open(archive / "image.tar.gz", "w:gz") as output:
        members = {"manifest.json": json.dumps([{"Config": config_name, "Layers": []}]).encode(),
                   config_name: config if forged_blob is None else forged_blob}
        for name, data in members.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            output.addfile(member, io.BytesIO(data))
    (archive / "image.json").write_text(json.dumps({
        "id": image, "os": "linux", "architecture": "amd64", "revision": revision,
    }))
    (archive / "SHA256SUMS").write_text("".join(
        f"{snapshot_digest(archive / name)}  {name}\n" for name in ("image.tar.gz", "image.json")
    ))
    return image


class GuestTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.guest = Guest("quantself", "20261114T100000Z-abcdefabcdef", self.root)
        self.guest.run.mkdir(parents=True)

    def production_guest(self, *, native=False):
        lock = patch("backup_guest.PRODUCTION_LOCK", self.root / "production.lock")
        lock.start()
        self.addCleanup(lock.stop)
        profile = self.root / "profile.json"
        config = {"format": 2 if native else 1, "app_path": str(self.root)}
        if not native:
            config["analytics_path"] = str(self.root / "analytics")
            (self.root / "analytics").mkdir()
        profile.write_text(json.dumps(config))
        for filename in ("compose.prod.yaml", "compose.home.yaml"):
            (self.root / filename).write_text("services: {}")
        with patch("backup_guest.PRODUCTION_PROFILE", profile), patch("backup_guest.private") as private:
            guest = Guest("quantself", self.guest.restore_id, self.root)
            private.assert_called_once_with(profile, 0o600)
        return guest

    def test_native_profile_preserves_exact_production_services(self):
        from backup_guest import PRODUCTION_APP, PRODUCTION_NATIVE_PROFILE
        guest = self.production_guest(native=True)
        self.assertEqual(guest.production_profile, PRODUCTION_NATIVE_PROFILE)
        self.assertEqual(guest.services, tuple(PRODUCTION_APP))
        self.assertIsNone(guest.analytics)
        self.assertEqual(guest.container_name("api"), "quantself-api")

    def test_native_blue_backup_uses_exact_slot_and_rejects_pending_switch(self):
        profile = self.root / "profile.json"
        profile.write_text(json.dumps({"format": 2, "app_path": str(self.root)}))
        releases = self.root / "releases"
        (releases / "blue").mkdir(parents=True)
        (releases / "active").write_text("blue\nlegacy\n")
        with patch("backup_guest.PRODUCTION_PROFILE", profile), patch("backup_guest.RELEASE_STATE", releases), \
             patch("backup_guest.private"), patch("backup_guest.inspect") as inspect:
            guest = Guest("quantself", self.guest.restore_id, self.root)
            self.assertEqual(guest.bundle, releases / "blue")
            self.assertEqual(guest.container_name("gateway"), "quantself-blue-gateway-1")
            self.assertEqual(guest.container_name("postgres"), "quantself-postgres")
            self.assertIn("api-workers", guest.services)
            (releases / "pending").touch()
            with self.assertRaisesRegex(BackupError, "Release transition"):
                guest.services_now()
            inspect.assert_not_called()

    def test_blue_backup_pauses_api_workers_after_web_and_api_drain(self):
        guest = self.production_guest(native=True)
        prior = dict.fromkeys((*guest.services, "api-workers"), object())
        with patch.object(guest, "stop") as stop:
            guest.pause_app_writers(prior, "now")
        self.assertEqual([call.args[0] for call in stop.call_args_list], [
            *INVENTORY_WORKERS, "app", "api", "api-workers",
        ])

    def test_native_profile_rejects_extra_analytics_path(self):
        path = self.root / "profile.json"
        path.write_text(json.dumps({"format": 2, "app_path": str(self.root), "analytics_path": str(self.root)}))
        with patch("backup_guest.PRODUCTION_PROFILE", path), patch("backup_guest.private"):
            with self.assertRaisesRegex(BackupError, "Invalid production backup profile"):
                Guest("quantself", self.guest.restore_id, self.root)

    def test_native_profile_rejects_retired_projects_even_when_stopped(self):
        guest = self.production_guest(native=True)
        for results in (["", "", "", "", "exited-umami"], ["", "", "", "", "", "exited-synthetic"]):
            with self.subTest(results=results), \
                 patch("backup_guest.inspect", side_effect=lambda name: {"id": name, "state": {"Running": False}}), \
                 patch("backup_guest.docker", side_effect=results):
                with self.assertRaisesRegex(BackupError, "requires retired project containers"):
                    guest.services_now()

    def test_native_pause_keeps_marker_and_inventory_fence_without_umami(self):
        guest = self.production_guest(native=True)
        states = {name: {"id": name, "image": "fixture",
                         "state": {"Running": name != "gateway", "StartedAt": "1"}}
                  for name in guest.services}
        with patch.object(guest, "check_host"), patch.object(guest, "services_now", return_value=states), \
             patch.object(guest, "verify_app_images"), patch.object(guest, "jobs_outbox", return_value=None), \
             patch.object(guest, "stop") as stop:
            guest.pause()
        self.assertEqual(read_json(guest.maintenance), {"restore_id": guest.restore_id})
        self.assertEqual([call.args[0] for call in stop.call_args_list], [*INVENTORY_WORKERS, "app", "api"])
        with patch("backup_guest.private"), patch.object(guest, "resume_services", side_effect=BackupError("bad health")):
            with self.assertRaisesRegex(BackupError, "bad health"):
                guest.resume()
        self.assertTrue(guest.maintenance.exists())

    def test_native_requires_the_two_analytics_tables_in_the_application_database(self):
        guest = self.production_guest(native=True)
        with patch.object(guest, "pg_query", return_value="1") as query:
            with self.assertRaisesRegex(BackupError, "analytics schema is incomplete"):
                guest.verify_native_schema({"id": "app-postgres"})
        self.assertIn("website_event", query.call_args.args[1])
        self.assertIn("website_inquiry", query.call_args.args[1])

    @unittest.skipUnless(os.geteuid() == 0 and hasattr(os, "listxattr"),
                         "Archive fixture requires Linux root")
    def test_native_capture_includes_release_and_outbox_without_umami(self):
        from backup_guest import JOBS_OUTBOX_TREE, JOBS_OUTBOX_VOLUME, PRODUCTION_NATIVE_PROFILE
        guest = self.production_guest(native=True)
        for filename in ("compose.yaml", "Caddyfile", "Caddyfile.home"):
            (self.root / filename).write_text("fixture")
        for filename in (".env", "deploy.env", "profile.json"):
            path = self.root / filename
            if filename != "profile.json":
                path.write_text("fixture")
            path.chmod(0o600)
        seed_image = self.root / "seed-image"
        seed_image.mkdir()
        image = write_image_fixture(seed_image)
        release = self.root / "releases" / image.removeprefix("sha256:")
        release.mkdir(parents=True)
        archive = release / "app-image"
        seed_image.rename(archive)
        proof = release / "web-drain.json"
        write_json(proof, {"format": 1, "image": image, "contract": "next-sigterm-deferred-request-v1"})
        outbox = self.root / "outbox"
        outbox.mkdir()
        (outbox / "pending.json").write_text("{}")
        states = {name: {"id": name, "image": image} for name in guest.services}

        def dump(*_, output, **__):
            output.write(b"synthetic dump")

        with patch("backup_guest.PRODUCTION_PROFILE", self.root / "profile.json"), \
             patch("backup_guest.PRODUCTION_DEPLOY_ENV", self.root / "deploy.env"), \
             patch.object(guest, "assert_paused", return_value=states), \
             patch.object(guest, "database_bytes", return_value=1024), \
             patch.object(guest, "sources", return_value={JOBS_OUTBOX_TREE: outbox, "deployment/app-image": archive}), \
             patch.object(guest, "pg_query", side_effect=["2", "native_migration"]), \
             patch.object(guest, "capture_analytics") as capture_analytics, \
             patch("backup_guest.available_disk"), patch("backup_guest.docker", side_effect=dump) as docker:
            manifest = guest.capture()
        self.assertEqual(manifest["profile"], PRODUCTION_NATIVE_PROFILE)
        self.assertEqual(manifest["jobs_codex_outbox"], JOBS_OUTBOX_VOLUME)
        self.assertEqual(manifest["schema_migrations"], ["native_migration"])
        self.assertEqual(set(manifest["images"]), set(guest.services))
        docker.assert_called_once()
        capture_analytics.assert_not_called()
        self.assertTrue((guest.frozen / "tree/deployment/web-drain.json").is_file())
        self.assertTrue((guest.frozen / "tree" / JOBS_OUTBOX_TREE / "pending.json").is_file())
        self.assertFalse((guest.frozen / "tree/analytics").exists())
        self.assertFalse((guest.frozen / "tree/deployment/analytics").exists())

    def test_production_rejects_an_untracked_analytics_writer(self):
        guest = self.production_guest()
        with patch("backup_guest.inspect", side_effect=lambda name: {"id": name, "state": {"Running": True}}), \
             patch("backup_guest.docker", side_effect=[
                 "\n".join(guest.container_name(name) for name in guest.services if not name.startswith("analytics-")),
                 "\n".join([*(guest.container_name(name) for name in guest.services if name.startswith("analytics-")),
                            "untracked"]),
                 "",
             ]):
            with self.assertRaisesRegex(BackupError, "Unexpected running Compose container"):
                guest.services_now()

    def test_production_freezes_workers_before_api_and_analytics(self):
        guest = self.production_guest()
        states = {name: {"id": name, "image": "fixture",
                         "state": {"Running": name != "gateway", "StartedAt": "1"}}
                  for name in guest.services}
        with patch.object(guest, "check_host"), patch.object(guest, "services_now", return_value=states), \
             patch.object(guest, "verify_app_images"), patch.object(guest, "jobs_outbox", return_value=None), \
             patch.object(guest, "stop") as stop:
            guest.pause()
        self.assertEqual([call.args[0] for call in stop.call_args_list],
                         [*INVENTORY_WORKERS, "app", "api", *ANALYTICS_WRITERS])

    def test_production_pause_cannot_race_deployment_lock(self):
        guest = self.production_guest()
        with locked(self.root / "production.lock"), patch.object(guest, "pause_services") as pause:
            with self.assertRaises(Busy):
                guest.pause()
            pause.assert_not_called()
        self.assertFalse(guest.maintenance.exists())

    def test_production_maintenance_persists_through_failed_resume(self):
        guest = self.production_guest()
        write_json(guest.maintenance, {"restore_id": guest.restore_id})
        write_json(guest.state_path, {})
        with patch("backup_guest.private"), patch.object(guest, "resume_services") as resume:
            resume.side_effect = BackupError("failed health")
            with self.assertRaisesRegex(BackupError, "failed health"):
                guest.resume()
            self.assertTrue(guest.maintenance.exists())
            resume.side_effect = None
            resume.return_value = {}
            guest.resume()
        self.assertFalse(guest.maintenance.exists())

    def test_production_maintenance_refuses_other_restore_id(self):
        guest = self.production_guest()
        write_json(guest.maintenance, {"restore_id": "another"})
        with patch("backup_guest.private"), patch.object(guest, "resume_services") as resume:
            with self.assertRaisesRegex(BackupError, "different backup"):
                guest.resume()
            resume.assert_not_called()
        self.assertTrue(guest.maintenance.exists())

    def test_production_relay_and_workers_require_current_drain_markers(self):
        guest = self.production_guest()
        prior = {"id": "fixture", "started": "1", "running": True}
        stopped = {"state": {"Status": "exited", "ExitCode": 0, "OOMKilled": False,
                             "Error": "", "StartedAt": "1", "FinishedAt": "3"}}
        with patch("backup_guest.docker"), patch("backup_guest.inspect", return_value=stopped), \
             patch("backup_guest.subprocess.run") as run:
            for name, marker in (
                ("analytics-relay", b"Analytics relay drain complete"),
                *((name, b"Inventory worker drain complete") for name in INVENTORY_WORKERS),
            ):
                run.return_value = subprocess.CompletedProcess([], 0, b"old/other log")
                with self.assertRaisesRegex(BackupError, "cleanup marker"):
                    guest.stop(name, prior, "2")
                run.return_value = subprocess.CompletedProcess([], 0, marker)
                guest.stop(name, prior, "2")

    def test_production_captures_codex_and_mounted_legacy_media(self):
        guest = self.production_guest()

        def volume(destination, source):
            return {"Destination": destination, "Source": source, "Type": "volume"}

        image = "sha256:" + "a" * 64
        states = {"app": {"image": image, "mounts": []}, "api": {"mounts": [
                      volume("/app/storage/todo-captures", "/captures"),
                      volume("/run/quantself", "/auth"),
                      volume("/app/storage/inventory-audio", "/legacy-audio"),
                  ]},
                  "inventory-codex-enrichment-worker": {"mounts": [volume("/codex-home", "/codex")]}}
        with patch.object(guest, "jobs_outbox", return_value=None):
            self.assertEqual(guest.sources(states), {
                "captures": Path("/captures"), "auth": Path("/auth"), "legacy/audio": Path("/legacy-audio"),
                "codex": Path("/codex"), "deployment/app-image": self.root / "releases" / ("a" * 64) / "app-image",
            })
        states["api"]["mounts"].append(volume("/unexpected", "/unexpected"))
        with self.assertRaisesRegex(BackupError, "Unexpected application data volume"):
            guest.sources(states)

    @unittest.skipUnless(os.geteuid() == 0 and hasattr(os, "listxattr"),
                         "Jobs private-file fixture requires Linux root")
    def test_production_accepts_only_the_complete_private_jobs_bind_pair(self):
        from backup_guest import JOBS_BINDS, jobs_file_record

        guest = self.production_guest()
        with tempfile.TemporaryDirectory(dir="/root") as directory:
            root = Path(directory)
            services = {}
            for role, relative in JOBS_BINDS.items():
                source = root / relative
                source.parent.mkdir(mode=0o700)
                source.write_text("{}")
                source.chmod(0o600)
                services[role] = {"mounts": [{
                    "Type": "bind", "Source": str(source),
                    "Destination": f"/run/quantself-jobs/{source.name}", "RW": False,
                }]}
            with patch("backup_guest.JOBS_CONFIG", root):
                expected = {f"deployment/jobs/{relative}": root / relative
                            for relative in JOBS_BINDS.values()}
                self.assertEqual(guest.jobs_sources(services), expected)
                for source in expected.values():
                    self.assertEqual(jobs_file_record(source)["size"], 2)
                api_mount = services["api"]["mounts"][0]
                api_mount["RW"] = True
                with self.assertRaisesRegex(BackupError, "bind mount differs"):
                    guest.jobs_sources(services)
                api_mount["RW"] = False
                api_source = Path(api_mount["Source"])
                api_mount["Source"] = services["app"]["mounts"][0]["Source"]
                with self.assertRaisesRegex(BackupError, "bind mount differs"):
                    guest.jobs_sources(services)
                api_mount["Source"] = str(api_source)
                runner_only = root / "applicant-profile.json"
                runner_only.write_text("{}")
                self.assertEqual(guest.jobs_sources(services), expected)
                api_source.unlink()
                with self.assertRaises(FileNotFoundError):
                    guest.jobs_sources(services)
                api_source.write_text("{}")
                api_source.chmod(0o644)
                with self.assertRaisesRegex(BackupError, "permissions differ"):
                    guest.jobs_sources(services)
                api_source.chmod(0o600)
                alias = api_source.with_suffix(".real")
                api_source.rename(alias)
                api_source.symlink_to(alias)
                with self.assertRaisesRegex(BackupError, "path is not canonical"):
                    guest.jobs_sources(services)
                services["api"]["mounts"].clear()
                with self.assertRaisesRegex(BackupError, "must be paired"):
                    guest.jobs_sources(services)
                services["app"]["mounts"].clear()
                self.assertEqual(guest.jobs_sources(services), {})

    def test_production_rejects_unknown_api_bind(self):
        guest = self.production_guest()
        services = {"api": {"mounts": [
            {"Type": "bind", "Destination": "/unexpected", "Source": "/unknown", "RW": False},
        ]}, "app": {"mounts": []}}
        with self.assertRaisesRegex(BackupError, "bind mount differs"):
            guest.jobs_sources(services)

    def test_production_requires_one_shot_removal_before_pause(self):
        guest = self.production_guest()
        with patch("backup_guest.inspect", side_effect=lambda name: {"id": name, "state": {"Running": False}}), \
             patch("backup_guest.docker", side_effect=["", "", "", "exited-one-shot"]):
            with self.assertRaisesRegex(BackupError, "one-shot has not exited and been removed"):
                guest.services_now()

    def test_jobs_outbox_is_required_for_declared_release_and_optional_for_legacy(self):
        from backup_guest import JOBS_OUTBOX_KEY
        guest = self.production_guest()
        compose = self.root / "compose.prod.yaml"
        with patch("backup_guest.docker", return_value=""):
            self.assertIsNone(guest.jobs_outbox())
            compose.write_text(f"volumes:\n  {JOBS_OUTBOX_KEY}:\n")
            with self.assertRaisesRegex(BackupError, "outbox volume is absent"):
                guest.jobs_outbox()

    @unittest.skipUnless(os.geteuid() == 0, "Outbox mount proof requires root ownership")
    def test_stopped_jobs_outbox_uses_exact_named_storage_and_owner(self):
        from backup_guest import JOBS_OUTBOX_KEY, JOBS_OUTBOX_VOLUME
        guest = self.production_guest()
        volumes = self.root / "volumes"
        path = volumes / JOBS_OUTBOX_VOLUME / "_data"
        path.mkdir(parents=True)
        labels = {"com.docker.compose.project": "quantself", "com.docker.compose.volume": JOBS_OUTBOX_KEY}
        def volume_data():
            return " ".join(json.dumps(value) for value in
                            (JOBS_OUTBOX_VOLUME, "local", "local", str(path), labels, None, "created"))
        with patch("backup_guest.DOCKER_VOLUMES", volumes), patch("backup_guest.docker") as docker:
            docker.side_effect = [JOBS_OUTBOX_VOLUME, volume_data()]
            self.assertEqual(guest.jobs_outbox()["mountpoint"], str(path))
            labels["com.docker.compose.project"] = "other"
            docker.side_effect = [JOBS_OUTBOX_VOLUME, volume_data()]
            with self.assertRaisesRegex(BackupError, "volume identity differs"):
                guest.jobs_outbox()

    def test_paused_profile_rejects_outbox_replacement(self):
        guest = self.production_guest()
        write_json(guest.run / "pause.json", {"status": "ok"})
        write_json(guest.state_path, {})
        write_json(guest.run / "jobs-outbox.json", {"inode": 1})
        with patch.object(guest, "verify_maintenance"), patch.object(guest, "services_now", return_value={}), \
             patch.object(guest, "jobs_outbox", return_value={"inode": 2}):
            with self.assertRaisesRegex(BackupError, "outbox volume changed during pause"):
                guest.assert_paused()

    @unittest.skipUnless(os.geteuid() == 0 and hasattr(os, "listxattr"),
                         "Jobs template fixture requires Linux root")
    def test_templates_require_api_only_exact_private_file_set(self):
        from backup_guest import JOBS_TEMPLATE_FILES, JOBS_TEMPLATE_TARGET
        guest = self.production_guest()
        with tempfile.TemporaryDirectory(dir="/root") as directory:
            source = Path(directory) / "api" / "resume-templates"
            source.mkdir(mode=0o700, parents=True)
            for name in JOBS_TEMPLATE_FILES:
                path = source / name
                path.write_text("# Synthetic")
                path.chmod(0o600)
            mount = {"Type": "bind", "Source": str(source), "Destination": JOBS_TEMPLATE_TARGET, "RW": False}
            services = {"api": {"mounts": [mount]}, "app": {"mounts": []}}
            with patch("backup_guest.JOBS_CONFIG", Path(directory)):
                self.assertEqual(set(guest.jobs_sources(services).values()),
                                 {source / name for name in JOBS_TEMPLATE_FILES})
                extra = source / "runner-only.json"
                extra.write_text("{}")
                with self.assertRaisesRegex(BackupError, "template file set differs"):
                    guest.jobs_sources(services)
                extra.unlink()
                services["app"]["mounts"].append(mount)
                with self.assertRaisesRegex(BackupError, "API-only"):
                    guest.jobs_sources(services)

    def test_production_analytics_dump_requires_writer_quiescence(self):
        guest = self.production_guest()
        services = {"analytics-postgres": {"id": "analytics-db"}}
        failed = self.root / "failed"
        failed.mkdir()
        with patch("backup_guest.docker", return_value="1") as docker:
            with self.assertRaisesRegex(BackupError, "Unexpected analytics database session"):
                guest.capture_analytics(services, failed)
            docker.assert_called_once()
        output = self.root / "fresh"
        output.mkdir()

        def capture(*args, output=None, **kwargs):
            if output is None:
                return "0"
            output.write(b"fixture")

        with patch("backup_guest.docker", side_effect=capture) as docker:
            guest.capture_analytics(services, output)
        self.assertEqual({path.name for path in (output / "analytics").iterdir()}, {"roles.sql", "umami.dump"})
        self.assertEqual(docker.call_args_list[1].args[2:5], ("pg_dump", "--format=custom", "--dbname=umami"))
        self.assertEqual(docker.call_args_list[2].args[2:4], ("pg_dumpall", "--roles-only"))

    def test_worker_record_visible_only_after_original_unit_settles(self):
        record = self.guest.run / "capture-1.json"
        write_json(record, {"status": "ok", "result": {}})
        with patch("backup_guest.subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess(
                [], 0, "LoadState=loaded\nActiveState=active\nSubState=running\n"
            )
            self.assertEqual(unit_status("fixture.service", record), {"status": "running"})
            run.return_value = subprocess.CompletedProcess(
                [], 1, "LoadState=not-found\nActiveState=inactive\nSubState=dead\n"
            )
            self.assertEqual(unit_status("fixture.service", record)["status"], "ok")
            self.assertEqual(unit_status("fixture.service", record.with_suffix(".missing"))["status"], "unknown")

    def test_web_exit_143_requires_its_current_cleanup_marker(self):
        prior = {"id": "web", "started": "1", "running": True}
        since = "2"
        stopped = {"state": {"Status": "exited", "ExitCode": 143, "OOMKilled": False,
                             "Error": "", "StartedAt": "1", "FinishedAt": "3"}}
        with patch("backup_guest.docker"), patch("backup_guest.inspect", return_value=stopped), \
             patch("backup_guest.subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, b"web received signal")
            with self.assertRaisesRegex(BackupError, "cleanup marker"):
                self.guest.stop("app", prior, since)
            run.return_value = subprocess.CompletedProcess(
                [], 0, b"2026-11-14 next:start-server start-server process cleanup finished"
            )
            self.guest.stop("app", prior, since)
            self.assertEqual(run.call_args.args[0], ["docker", "logs", "--since", since, "web"])
            stopped["state"]["OOMKilled"] = True
            with self.assertRaisesRegex(BackupError, "did not exit cleanly"):
                self.guest.stop("app", prior, since)

    def test_gateway_requires_pinned_shutdown_marker_even_with_exit_zero(self):
        prior = {"id": "gateway", "started": "1", "running": True}
        state = {"state": {"Status": "exited", "ExitCode": 0, "OOMKilled": False,
                           "Error": "", "StartedAt": "1", "FinishedAt": "3"}}
        with patch("backup_guest.docker") as docker, \
             patch("backup_guest.inspect", return_value=state), \
             patch("backup_guest.subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, b"SIGTERM received")
            with self.assertRaisesRegex(BackupError, "cleanup marker"):
                self.guest.stop("gateway", prior, "2")
            run.return_value = subprocess.CompletedProcess(
                [], 0, b'{"msg":"servers shutting down with eternal grace period"}'
            )
            self.guest.stop("gateway", prior, "2")
            self.assertEqual(docker.call_args.args, ("stop", "--time", "1920", "gateway"))

    @unittest.skipUnless(os.geteuid() == 0, "App archive fixture requires root ownership")
    def test_image_archive_preflight_hashes_payload_and_rejects_extra_files(self):
        archive = self.root / "app-image"
        archive.mkdir(mode=0o700)
        image = write_image_fixture(archive)
        verify_app_image_archive(archive, image)
        (archive / "image.tar.gz").write_bytes(b"changed payload")
        with self.assertRaisesRegex(BackupError, "archive checksum differs"):
            verify_app_image_archive(archive, image)
        (archive / "unexpected").touch()
        with self.assertRaisesRegex(BackupError, "archive file set differs"):
            verify_app_image_archive(archive, image)

    @unittest.skipUnless(os.geteuid() == 0, "App archive fixture requires root ownership")
    def test_archive_rejects_forged_config_and_wrong_platform_with_valid_checksums(self):
        archive = self.root / "app-image"
        archive.mkdir(mode=0o700)
        image = write_image_fixture(archive, forged_blob=b"wrong image")
        with self.assertRaisesRegex(BackupError, "config digest differs"):
            verify_app_image_archive(archive, image)
        image = write_image_fixture(archive, platform="arm64")
        with self.assertRaisesRegex(BackupError, "config platform differs"):
            verify_app_image_archive(archive, image)

    @unittest.skipUnless(os.geteuid() == 0, "Release fixture requires root ownership")
    def test_production_release_requires_same_image_for_drain_and_archive(self):
        release = self.root / "releases" / "test"
        archive = release / "app-image"
        archive.mkdir(parents=True, mode=0o700)
        revision = "a" * 40
        image = write_image_fixture(archive, revision=revision)
        proof = release / "web-drain.json"
        data = {"format": 1, "image": image, "contract": "next-sigterm-deferred-request-v1"}
        write_json(proof, data)
        proof.chmod(0o600)
        verify_production_release(release, image, revision)
        with self.assertRaisesRegex(BackupError, "archive revision differs"):
            verify_production_release(release, image, "b" * 40)
        write_json(proof, {**data, "image": "sha256:" + "b" * 64})
        with self.assertRaisesRegex(BackupError, "matching drain proof"):
            verify_production_release(release, image, revision)

    def test_image_pin_requires_exact_id(self):
        pin = self.root / "image-id"
        image = "sha256:" + "a" * 64
        pin.write_text(image + "\n")
        verify_image_pin(pin, image)
        pin.write_text(image + " ")
        with self.assertRaisesRegex(BackupError, "image pin differs"):
            verify_image_pin(pin, image)

    def test_mixed_app_and_api_images_cannot_begin_pause(self):
        services = {
            name: {"id": name, "image": "old-api" if name == "api" else "proved-app",
                   "state": {"StartedAt": "1", "Running": True}}
            for name in self.guest.services
        }
        with patch.object(self.guest, "check_host"), \
             patch.object(self.guest, "services_now", return_value=services), \
             patch.object(self.guest, "pause_app") as pause:
            with self.assertRaisesRegex(BackupError, "Web and API image IDs differ"):
                self.guest.pause()
        self.assertFalse(self.guest.state_path.exists())
        pause.assert_not_called()

    def test_pause_journals_then_gates_next_and_api_while_gateway_stop_is_pending(self):
        prior = {"id": "x", "image": "image",
                 "state": {"Status": "running", "Pid": 12, "StartedAt": "1", "Running": True}}
        gateway_stopping = Event()
        api_drained = Event()
        order = []

        def stop(name, state, since):
            self.assertEqual(read_json(self.guest.state_path)[name], state)
            order.append(name)
            if name == "gateway":
                gateway_stopping.set()
                self.assertTrue(api_drained.wait(2))
                order.append("gateway-exit")
            if name == "api":
                api_drained.set()

        def wait_ingress(state, stopped):
            self.assertTrue(gateway_stopping.wait(2))
            self.assertFalse(stopped.done())
            order.append("ingress-closed")

        with patch.object(self.guest, "check_host"), patch.object(self.guest, "web_proof"), \
             patch.object(self.guest, "services_now", return_value=dict.fromkeys(self.guest.services, prior)), \
             patch("backup_guest.inspect", return_value=prior), \
             patch.object(self.guest, "ingress_listeners", return_value="LISTEN"), \
             patch.object(self.guest, "wait_ingress_closed", side_effect=wait_ingress), \
             patch.object(self.guest, "stop", side_effect=stop):
            self.guest.pause()
        self.assertEqual(order, ["gateway", "ingress-closed", "app", "api", "gateway-exit"])

    def test_gateway_ingress_probe_requires_same_process_and_no_listening_socket(self):
        prior = {"id": "gateway", "started": "1"}
        running = {"state": {"Status": "running", "Pid": 12, "StartedAt": "1"}}
        stopped = unittest.mock.Mock()
        stopped.done.return_value = False
        with patch("backup_guest.inspect", return_value=running), \
             patch("backup_guest.command", side_effect=["LISTEN", ""]) as command, \
             patch("backup_guest.time.sleep"):
            self.guest.wait_ingress_closed(prior, stopped)
        self.assertEqual(command.call_count, 2)
        self.assertEqual(command.call_args.args,
                         ("nsenter", "--target", "12", "--net", "--", "ss", "-H", "-ltn", "sport = :3000"))

    def test_fast_gateway_exit_can_remove_namespace_during_probe(self):
        prior = {"id": "gateway", "started": "1"}
        running = {"state": {"Status": "running", "Pid": 12, "StartedAt": "1"}}
        exited = {"state": {"Status": "exited", "Pid": 0, "StartedAt": "1"}}
        stopped = unittest.mock.Mock()
        stopped.done.side_effect = [False, True]
        with patch("backup_guest.inspect", side_effect=[running, exited]), \
             patch.object(self.guest, "ingress_listeners", side_effect=BackupError("namespace gone")), \
             patch("backup_guest.time.sleep"):
            self.guest.wait_ingress_closed(prior, stopped)
        stopped.result.assert_called_once_with()

    def test_unconfirmed_docker_stop_remains_unknown_after_pause_worker_exits(self):
        with patch.object(self.guest, "check_host"), \
             patch.object(self.guest, "pause", side_effect=StopUnconfirmed("fixture stop lost")):
            self.guest.worker("pause", 1)
        result = read_json(self.guest.run / "pause-1.json")
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(read_json(self.guest.run / "pause.json"), result)

    def test_gateway_failure_cannot_mask_unconfirmed_app_stop(self):
        prior = {name: {"id": name, "started": "1", "running": True}
                 for name in ("gateway", "app", "api")}
        gateway = {"state": {"Status": "running", "Pid": 12, "StartedAt": "1"}}

        def stop(name, state, since):
            if name == "app":
                raise StopUnconfirmed("app stop reply lost")
            raise BackupError("gateway exited unsuccessfully")

        with patch("backup_guest.inspect", return_value=gateway), \
             patch.object(self.guest, "ingress_listeners", return_value="LISTEN"), \
             patch.object(self.guest, "wait_ingress_closed"), \
             patch.object(self.guest, "stop", side_effect=stop):
            with self.assertRaisesRegex(StopUnconfirmed, "app stop reply lost"):
                self.guest.pause_app(prior, "2")

    def test_timed_out_docker_start_records_unknown_resume(self):
        write_json(self.guest.state_path, {name: {"id": name, "running": True}
                                          for name in self.guest.services})
        with patch.object(self.guest, "check_host"), \
             patch("backup_guest.inspect", return_value={"id": "postgres", "state": {"Running": False}}), \
             patch("backup_guest.subprocess.run", side_effect=subprocess.TimeoutExpired(["docker"], 60)) as run:
            self.guest.worker("resume", 1)
        run.assert_called_once()
        self.assertEqual(run.call_args.args[0], ("docker", "start", "postgres"))
        self.assertEqual(read_json(self.guest.run / "resume-1.json"),
                         {"status": "unknown", "error": "postgres start outcome is unconfirmed"})

    def test_vault_preflight_requires_readiness_file_before_inspecting_services(self):
        guest = Guest("files", self.guest.restore_id, self.root)
        with patch.object(guest, "check_host"), \
             patch("backup_guest.private", side_effect=FileNotFoundError), \
             patch.object(guest, "services_now") as services:
            with self.assertRaises(FileNotFoundError):
                guest.preflight()
        services.assert_not_called()

    def test_vault_resume_opens_gateway_only_after_backend_readiness(self):
        guest = Guest("files", self.guest.restore_id, self.root)
        prior = {name: {"id": name, "running": True} for name in reversed(guest.services)}
        write_json(guest.state_path, prior)
        running = {name: False for name in guest.services}
        order = []

        def inspect(name):
            name = name.removeprefix("keep-vault-").removesuffix("-1")
            return {"id": name, "state": {"Running": running[name]}}

        def docker(action, name):
            self.assertEqual(action, "start")
            running[name] = True
            order.append(name)

        def ready(*, trusted):
            order.append("trusted" if trusted else "backend")

        with patch("backup_guest.inspect", side_effect=inspect), \
             patch("backup_guest.docker", side_effect=docker), \
             patch.object(guest, "verify_vault_gateway"), patch.object(guest, "verify_vault_ingress"), \
             patch.object(guest, "wait_vault_ready", side_effect=ready):
            guest.resume()
        self.assertEqual(order, ["opencloud", "backend", "vault-gateway", "trusted"])

    def test_vault_backend_readiness_requires_five_exact_http_200s_and_issuer(self):
        origin = "https://fixture-vault.fixture.ts.net"
        issuer = json.dumps({"issuer": origin + "/"})
        wrong_issuer = json.dumps({"issuer": "https://other-vault.fixture.ts.net/"})
        with patch("backup_guest.read_vault_origin", return_value=origin), \
             patch("backup_guest.command", side_effect=["200", "503", *["200"] * 5, wrong_issuer, *["200"] * 5, issuer]) as command, \
             patch("backup_guest.time.sleep"):
            self.guest.wait_vault_ready(trusted=False)
        urls = [call.args[-1] for call in command.call_args_list]
        self.assertEqual(urls[:2], ["http://127.0.0.1:9159/readyz", "http://127.0.0.1:9119/readyz"])
        ready_urls = [f"http://127.0.0.1:{port}/readyz" for port in (9159, 9119, 9141, 9205, 9134)]
        oidc_url = "http://127.0.0.1:9200/.well-known/openid-configuration"
        self.assertEqual(urls[2:], [*ready_urls, oidc_url, *ready_urls, oidc_url])
        discovery = [call.args for call in command.call_args_list if call.args[-1] == oidc_url]
        self.assertTrue(all("Host: fixture-vault.fixture.ts.net" in args for args in discovery))

    def test_vault_waits_for_two_consecutive_empty_unfiltered_session_samples(self):
        image = "sha256:" + "a" * 64
        prior = {"id": "vault", "image": image, "running": True, "started": "1"}
        samples = ["[]", '[{"processing":false}]', "null", "[]"]
        state = {"state": {"Status": "running", "StartedAt": "1"}}
        with patch("backup_guest.docker", side_effect=[image, *samples]) as docker, \
             patch("backup_guest.inspect", return_value=state), patch("backup_guest.time.sleep"), \
             patch.object(self.guest, "verify_vault_gateway"), patch.object(self.guest, "verify_vault_ingress"), \
             patch.object(self.guest, "stop") as stop:
            self.guest.pause_vault(prior, "2", {"id": "vault-gateway"})
        self.assertEqual(docker.call_count, 5)
        self.assertEqual(docker.call_args.args, ("exec", "vault", "opencloud", "storage-users",
                                                 "uploads", "sessions", "--json"))
        stop.assert_called_once_with("opencloud", prior, "2")

    def test_vault_cli_error_or_invalid_json_never_stops(self):
        image = "sha256:" + "a" * 64
        prior = {"id": "vault", "image": image, "running": True, "started": "1"}
        for output in (BackupError("fixture failed"), "invalid", "{}", "[null]"):
            with self.subTest(output=output), patch("backup_guest.docker", side_effect=[image, output]), \
                 patch.object(self.guest, "verify_vault_ingress"), patch.object(self.guest, "stop") as stop:
                with self.assertRaisesRegex(BackupError, "listing"):
                    self.guest.pause_vault(prior, "2", {"id": "vault-gateway"})
                stop.assert_not_called()

    def test_vault_nonempty_sessions_at_deadline_never_stop(self):
        image = "sha256:" + "a" * 64
        prior = {"id": "vault", "image": image, "running": True, "started": "1"}
        with patch("backup_guest.docker", side_effect=[image, '[{"processing":false}]']), \
             patch("backup_guest.time.monotonic", side_effect=[0, 119, 119, 120, 120]), \
             patch("backup_guest.time.sleep"), patch.object(self.guest, "verify_vault_ingress"), \
             patch.object(self.guest, "stop") as stop:
            with self.assertRaisesRegex(BackupError, "did not clear"):
                self.guest.pause_vault(prior, "2", {"id": "vault-gateway"})
        stop.assert_not_called()

    def test_resume_does_not_start_originally_stopped_container_and_attempts_others(self):
        state = {name: {"id": name, "running": name not in ("postgres", "app")}
                 for name in self.guest.services}
        write_json(self.guest.state_path, state)
        running = {"api": False, "app": False, "gateway": False, "postgres": False}

        def inspect(name):
            name = name.removeprefix("keep-quantself-").removesuffix("-1")
            return {"id": name, "state": {"Running": running[name]}}

        def docker(action, name):
            if name == "api":
                raise BackupError("failed start")
            running[name] = True

        with patch("backup_guest.inspect", side_effect=inspect), patch("backup_guest.docker", side_effect=docker):
            with self.assertRaisesRegex(BackupError, "api"):
                self.guest.resume()
        self.assertTrue(running["gateway"])
        self.assertFalse(running["app"])

    @unittest.skipUnless(hasattr(os, "setxattr"), "Linux native xattrs required")
    def test_frozen_vault_copy_preserves_xattrs_and_hardlinks(self):
        guest = Guest("files", self.guest.restore_id, self.root)
        source = self.root / "opencloud-source"
        config = source / "config"
        data = source / "data"
        config.mkdir(parents=True)
        data.mkdir()
        (config / "opencloud.yaml").write_text("synthetic")
        fixture = data / "original.pdf"
        fixture.write_bytes(b"synthetic content")
        os.setxattr(data, "user.test-directory", b"directory")
        os.setxattr(fixture, "user.test-id", b"fixture-id")
        os.link(fixture, data / "original-link")
        (data / "relative-link").symlink_to("original.pdf")
        bundle = self.root / "bundle"
        bundle.mkdir()
        (bundle / "compose.yaml").write_text("synthetic")
        sources = {"opencloud/config": config, "opencloud/data": data}
        with patch("backup_guest.VAULT", bundle), \
             patch.object(guest, "assert_paused", return_value={"opencloud": {"image": "fixture"}}), \
             patch.object(guest, "sources", return_value=sources), patch("backup_guest.available_disk"):
            manifest = guest.capture()
        frozen = guest.frozen / "tree" / "opencloud" / "data"
        self.assertEqual(os.getxattr(frozen, "user.test-directory"), b"directory")
        self.assertEqual(os.getxattr(frozen / fixture.name, "user.test-id"), b"fixture-id")
        self.assertEqual((frozen / fixture.name).stat().st_ino, (frozen / "original-link").stat().st_ino)
        self.assertEqual(manifest["inventory_entries"], 10)
        self.assertFalse((guest.run / "staging").exists())

    def test_upload_rejects_changed_repository_before_dispatch(self):
        self.guest.frozen.mkdir()
        manifest = {"restore_id": self.guest.restore_id, "role": self.guest.role}
        write_json(self.guest.frozen / "manifest.json", manifest)
        write_json(self.guest.run / "preflight-1.json", {"result": {"repository": "a" * 64}})
        with patch.object(self.guest, "repository_id", return_value="b" * 64), \
             patch("backup_guest.restic") as restic_call:
            with self.assertRaisesRegex(BackupError, "changed after preflight"):
                self.guest.upload()
            restic_call.assert_not_called()

    def test_upload_validates_exact_tag_and_full_snapshot(self):
        self.guest.frozen.mkdir()
        manifest = {"restore_id": self.guest.restore_id, "role": self.guest.role}
        write_json(self.guest.frozen / "manifest.json", manifest)
        repo = "a" * 64
        write_json(self.guest.run / "preflight-1.json", {"result": {"repository": repo}})
        snapshot = "b" * 64
        summary = json.dumps({"message_type": "summary", "snapshot_id": snapshot})
        listing = json.dumps([{"id": snapshot, "hostname": "quantself",
                               "tags": ["quantself", self.guest.restore_id],
                               "paths": [str(self.guest.frozen)]}])
        with patch.object(self.guest, "repository_id", return_value=repo), \
             patch("backup_guest.restic", side_effect=[summary, listing]) as restic_call:
            self.assertEqual(self.guest.upload(), {"snapshot": snapshot, "repository": repo, "manifest": manifest})
        self.assertEqual(restic_call.call_args_list[0].kwargs["cwd"], self.guest.frozen)

    def test_env_parser_rejects_shell_directive_and_wrong_prefix(self):
        password = self.root / "password"
        config = self.root / "repository.env"
        password.write_text("synthetic")
        fields = ("RESTIC_REPOSITORY=s3:https://s3.ca-east-006.backblazeb2.com/test/quantself\n"
                  f"RESTIC_PASSWORD_FILE={password}\nAWS_ACCESS_KEY_ID=fixture\n"
                  "AWS_SECRET_ACCESS_KEY=fixture\nAWS_DEFAULT_REGION=ca-east-006\n")
        config.write_text(fields)
        with patch("backup_guest.RESTIC_DIR", self.root), patch("backup_guest.private"), \
             patch("backup_guest.command") as command:
            with self.assertRaisesRegex(BackupError, "prefix"):
                restic("files", "cat", "config")
            config.write_text(fields + "touch should-not-exist\n")
            with self.assertRaisesRegex(BackupError, "settings"):
                restic("quantself", "cat", "config")
            command.assert_not_called()
            config.write_text(fields)
            restic("quantself", "cat", "config")
            self.assertEqual(command.call_args.args[0], "/usr/local/bin/restic")


if __name__ == "__main__":
    unittest.main()
