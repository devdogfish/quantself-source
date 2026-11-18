"""Vault ingress gates using synthetic service state, without Docker."""
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import backup_guest
from backup_coordinator import Coordinator, OperationFailed
from backup_guest import BackupError, Guest, write_json
from test_backup_coordinator import FakeKeep

VAULT_HOST = "fixture-vault.fixture.ts.net"
RUN_ID = "20261114T100000Z-abcdefabcdef"
IMAGE = "sha256:" + "a" * 64


class VaultIdentityTests(unittest.TestCase):
    def test_identity_requires_one_private_root_owned_origin(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "vault-identity.json"
            origin = f"https://{VAULT_HOST}"
            identity = json.dumps({"KEEP_OPENCLOUD_URL": origin})
            original_fstat = os.fstat

            def as_root(fd):
                info = original_fstat(fd)
                return SimpleNamespace(st_mode=info.st_mode, st_nlink=info.st_nlink, st_uid=0, st_gid=0)

            with patch.object(backup_guest, "VAULT_IDENTITY", path), patch("backup_guest.os.fstat", side_effect=as_root):
                with self.assertRaises(BackupError):
                    backup_guest.read_vault_origin()
                path.write_text(identity)
                path.chmod(0o644)
                with self.assertRaises(BackupError):
                    backup_guest.read_vault_origin()
                path.chmod(0o600)
                self.assertEqual(backup_guest.read_vault_origin(), origin)
                path.write_text(identity[:-1] + ', "KEEP_OPENCLOUD_URL": "duplicate"}')
                with self.assertRaises(BackupError):
                    backup_guest.read_vault_origin()
                path.write_text(identity)
                link = path.with_name("symlink.json")
                link.symlink_to(path)
                with patch.object(backup_guest, "VAULT_IDENTITY", link), self.assertRaises(BackupError):
                    backup_guest.read_vault_origin()


class VaultGatewayTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.guest = Guest("files", RUN_ID, self.root)
        self.guest.run.mkdir(parents=True)
        self.proof = self.root / "vault-gateway.json"
        self.addCleanup(patch.stopall)
        patch.object(backup_guest, "VAULT_GATEWAY_PROOF", self.proof).start()
        patch.object(self.guest, "check_host").start()
        patch.object(backup_guest, "read_vault_origin", return_value=f"https://{VAULT_HOST}").start()

    def coordinator_preflight(self, expected_error):
        guest = self.guest
        errors = []

        class TestKeep(FakeKeep):
            def guest(self, action, role, restore_id, operation, attempt):
                if (action, role, operation) == ("status", "files", "preflight"):
                    try:
                        return {"status": "ok", "result": guest.preflight()}
                    except (BackupError, FileNotFoundError) as error:
                        errors.append(str(error))
                        return {"status": "failed", "error": "Vault preflight failed"}
                return super().guest(action, role, restore_id, operation, attempt)

        host = TestKeep(self.root)
        with self.assertRaises(OperationFailed):
            Coordinator(host, 1).run_backup("run")
        self.assertFalse(any(len(event) == 3 and event[1] == "pause" for event in host.events))
        self.assertEqual(len(errors), 1)
        self.assertIn(expected_error, errors[0])

    def test_missing_gateway_marker_blocks_both_guest_pauses(self):
        self.coordinator_preflight("vault-gateway.json")

    def test_serve_routes_are_bound_to_the_pinned_vault_identity(self):
        config = self.root / "vault.Caddyfile"
        config.write_text("synthetic Caddyfile")
        digest = backup_guest.snapshot_digest(config)
        write_json(self.proof, {"format": 1, "config_sha256": digest, "contract": "vault-loopback-gateway-v1"})
        services = {
            "opencloud": {"state": {"Status": "running", "Running": True}},
            "vault-gateway": {"state": {"Status": "running", "Running": True}, "image": IMAGE,
                              "mounts": [{"Type": "bind", "Source": str(config), "RW": False,
                                          "Destination": "/etc/caddy/Caddyfile"}]},
        }
        atlas_hostname = "files-atlas.fixture.ts.net"
        keep_route = f"{VAULT_HOST}:443"
        atlas_route = f"{atlas_hostname}:443"
        serve = {"TCP": {"443": {"HTTPS": True}}, "Web": {atlas_route: {
            "Handlers": {"/": {"Proxy": "http://127.0.0.1:9201"}}}}}
        original_lstat = type(config).lstat

        def lstat(path):
            if path == config:
                return Mock(st_mode=0o100644, st_uid=0, st_gid=0)
            return original_lstat(path)

        with patch.object(backup_guest, "VAULT", self.root), \
             patch.object(backup_guest, "VAULT_GATEWAY_SHA", digest), \
             patch.object(backup_guest, "private"), \
             patch.object(type(config), "lstat", lstat), \
             patch.object(self.guest, "services_now", return_value=services), \
             patch.object(backup_guest, "docker", return_value=IMAGE), \
             patch.object(backup_guest, "command", return_value=json.dumps(serve)) as command:
            self.coordinator_preflight("Serve routes differ")
            atlas_guest = Guest("files", RUN_ID, self.root, vault_hostname=atlas_hostname)
            atlas_guest.verify_vault_gateway(services["vault-gateway"])
            serve["Web"][keep_route] = serve["Web"][atlas_route]
            command.return_value = json.dumps(serve)
            with self.assertRaisesRegex(BackupError, "Serve routes differ"):
                atlas_guest.verify_vault_gateway(services["vault-gateway"])
            del serve["Web"][atlas_route]
            serve["Web"][keep_route]["Handlers"]["/"]["Proxy"] = "http://127.0.0.1:9200"
            command.return_value = json.dumps(serve)
            self.coordinator_preflight("Serve routes differ")
        self.assertEqual(command.call_count, 4)
        with patch.object(atlas_guest, "check_host"), patch.object(backup_guest, "command") as command:
            atlas_guest.start("preflight", 1)
        self.assertEqual(command.call_args.args[-2:], ("--vault-hostname", atlas_hostname))

    def test_atlas_readiness_uses_the_pinned_issuer_without_reading_keep(self):
        hostname = "atlas-vault-fixture.tailnet.ts.net"
        origin = f"https://{hostname}"
        guest = Guest("files", RUN_ID, self.root, vault_hostname=hostname)
        with (patch.object(backup_guest, "read_vault_origin", side_effect=AssertionError("Unexpected Keep identity read")),
              patch.object(backup_guest, "command", return_value=json.dumps({"issuer": origin})) as command):
            guest.wait_vault_ready(trusted=True)
        self.assertEqual(command.call_args.args[-1], origin + "/.well-known/openid-configuration")

    def test_resume_keeps_gateway_closed_until_backend_ready_then_reopens(self):
        running = {"opencloud": False, "vault-gateway": False}
        events = []
        write_json(self.guest.state_path, {name: {"id": name, "running": True} for name in running})

        def inspect(name):
            name = name.removeprefix("keep-vault-").removesuffix("-1")
            return {"id": name, "state": {"Running": running[name]}}

        def docker(action, name):
            self.assertEqual(action, "start")
            running[name] = True
            events.append(("start", name))

        ready = False

        def probe(*, trusted):
            events.append(("ready", trusted))
            self.assertTrue(running["opencloud"])
            self.assertEqual(running["vault-gateway"], trusted)
            if not ready:
                raise BackupError("Storage not ready")

        with patch.object(backup_guest, "inspect", side_effect=inspect), \
             patch.object(backup_guest, "docker", side_effect=docker), \
             patch.object(self.guest, "verify_vault_gateway"), \
             patch.object(self.guest, "verify_vault_ingress"), \
             patch.object(self.guest, "wait_vault_ready", side_effect=probe):
            with self.assertRaisesRegex(BackupError, "vault-gateway"):
                self.guest.resume()
            self.assertFalse(running["vault-gateway"])
            ready = True
            self.guest.resume()
        self.assertEqual(events, [("start", "opencloud"), ("ready", False), ("ready", False),
                                  ("start", "vault-gateway"), ("ready", True)])

    def test_vault_route_reopened_during_quiescence_prevents_opencloud_stop(self):
        prior = {"id": "opencloud", "image": IMAGE, "running": True, "started": "original"}
        gateway = {"id": "vault-gateway", "running": True}
        state = {"state": {"Status": "running", "StartedAt": "original"}}
        with patch.object(backup_guest, "docker", side_effect=[IMAGE, "[]", "[]"]), \
             patch.object(backup_guest, "inspect", return_value=state), \
             patch.object(backup_guest.time, "sleep"), \
             patch.object(self.guest, "verify_vault_gateway", side_effect=BackupError("Serve route reopened")), \
             patch.object(self.guest, "verify_vault_ingress"), \
             patch.object(self.guest, "stop") as stop:
            with self.assertRaisesRegex(BackupError, "Serve route reopened"):
                self.guest.pause_vault(prior, "timestamp", gateway)
        stop.assert_not_called()


if __name__ == "__main__":
    unittest.main()
