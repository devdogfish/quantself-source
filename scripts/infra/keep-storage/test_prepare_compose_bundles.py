import json
import ipaddress
import shutil
from pathlib import Path
import stat
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

RENDERER = Path(__file__).with_name("prepare-compose-bundles.py")
INPUTS = {
    "KEEP_BETTER_AUTH_URL": "https://app.example.invalid",
    "KEEP_BETTER_AUTH_RP_ID": "app.example.invalid",
    "KEEP_OPENCLOUD_URL": "https://files.example.invalid",
}

APP_TEMPLATE = """\
x-auth: &auth
  BETTER_AUTH_URL: ${KEEP_BETTER_AUTH_URL:?required}
  BETTER_AUTH_RP_ID: ${KEEP_BETTER_AUTH_RP_ID:?required}
services:
  app:
    environment:
      <<: *auth
  api:
    environment:
      <<: *auth
      QUANTSELF_OPENCLOUD_URL: ${KEEP_OPENCLOUD_URL:?required}
      DATABASE_URL: ${DATABASE_URL:?required}
"""
VAULT_TEMPLATE = """\
services:
  opencloud:
    environment:
      OC_URL: ${KEEP_OPENCLOUD_URL:?required}
"""

STATIC_FIXTURES = {
    "Caddyfile": b"# app gateway fixture\n",
    "scripts/infra/keep-storage/app.env.example": b"EXAMPLE_FLAG=fixture\n",
    "scripts/infra/keep-storage/vault.Caddyfile": b"# vault gateway fixture\n",
}


class PrepareComposeBundlesTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        self.repo_root = root / "repo"
        self.templates = self.repo_root / "scripts/infra/keep-storage"
        self.staging = root / "staging"
        self.input_path = root / "endpoints.json"
        self.templates.mkdir(parents=True)
        self.staging.mkdir()
        (self.templates / "app.compose.yaml").write_text(APP_TEMPLATE)
        (self.templates / "vault.compose.yaml").write_text(VAULT_TEMPLATE)
        for relative, content in STATIC_FIXTURES.items():
            (self.repo_root / relative).write_bytes(content)

    def write_inputs(self, values):
        self.input_path.write_text(json.dumps(values))
        self.input_path.chmod(0o600)

    def invoke(self, input_path=None, package=False):
        source = ["--repo-root", str(self.repo_root)] if package else ["--templates-dir", str(self.templates)]
        return subprocess.run(
            [sys.executable, str(RENDERER), *source, "--input", str(input_path or self.input_path),
             "--staging-parent", str(self.staging)],
            capture_output=True,
            text=True,
            timeout=10,
        )

    def assert_rejected(self, input_path=None, package=False):
        result = self.invoke(input_path, package=package)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(list(self.staging.iterdir()), [])
        return result.stderr

    def test_prepares_both_private_compose_files(self):
        self.write_inputs(INPUTS)
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        output = Path(result.stdout.strip())
        self.assertEqual(output.parent, self.staging)
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)

        app = output / "app" / "compose.yaml"
        vault = output / "vault" / "compose.yaml"
        for file in (app, vault):
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
        self.assertEqual(
            app.read_text(),
            APP_TEMPLATE.replace("${KEEP_BETTER_AUTH_URL:?required}", '"https://app.example.invalid"')
            .replace("${KEEP_BETTER_AUTH_RP_ID:?required}", '"app.example.invalid"')
            .replace("${KEEP_OPENCLOUD_URL:?required}", '"https://files.example.invalid"'),
        )
        self.assertEqual(
            vault.read_text(),
            VAULT_TEMPLATE.replace("${KEEP_OPENCLOUD_URL:?required}", '"https://files.example.invalid"'),
        )

    def test_packages_installed_files_without_overwriting_earlier_builds(self):
        self.write_inputs(INPUTS)
        legacy = self.invoke()
        self.assertEqual(legacy.returncode, 0, legacy.stderr)
        legacy_dir = Path(legacy.stdout.strip())
        builds = []
        for _ in range(2):
            result = self.invoke(package=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            builds.append(Path(result.stdout.strip()))

        self.assertEqual(len({legacy_dir, *builds}), 3)
        for directory in builds:
            files = {p.relative_to(directory).as_posix(): p.read_bytes()
                     for p in directory.rglob("*") if p.is_file()}
            self.assertEqual(files, {
                "app/compose.yaml": (legacy_dir / "app/compose.yaml").read_bytes(),
                "app/Caddyfile": STATIC_FIXTURES["Caddyfile"],
                "app/env.example": STATIC_FIXTURES["scripts/infra/keep-storage/app.env.example"],
                "vault/compose.yaml": (legacy_dir / "vault/compose.yaml").read_bytes(),
                "vault/vault.Caddyfile": STATIC_FIXTURES["scripts/infra/keep-storage/vault.Caddyfile"],
            })

    def test_full_package_requires_private_input_and_static_files(self):
        self.assert_rejected(package=True)
        self.write_inputs(INPUTS)
        (self.templates / "vault.Caddyfile").unlink()
        self.assert_rejected(package=True)

    def test_stages_only_the_validated_backup_origin(self):
        origin = "https://fixture-vault.fixture.ts.net"
        command = [
            sys.executable, str(RENDERER), "--repo-root", str(self.repo_root), "--vault-backup-identity",
            "--input", str(self.input_path), "--staging-parent", str(self.staging),
        ]
        for invalid in ("https://vault.fixture.invalid", origin + "/path", origin + ":443"):
            with self.subTest(invalid=invalid):
                self.write_inputs({**INPUTS, "KEEP_OPENCLOUD_URL": invalid})
                result = subprocess.run(command, capture_output=True, text=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(invalid, result.stderr)
                self.assertEqual(list(self.staging.iterdir()), [])
        self.write_inputs({**INPUTS, "KEEP_OPENCLOUD_URL": origin})
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        stage = Path(result.stdout.strip())
        identity = stage / "backup" / "vault-identity.json"
        self.assertEqual(json.loads(identity.read_text()), {"KEEP_OPENCLOUD_URL": origin})
        self.assertEqual(stat.S_IMODE(identity.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(identity.parent.stat().st_mode), 0o700)
        self.assertNotIn(origin, result.stdout + result.stderr)

    def test_requires_all_inputs_before_writing_either_bundle(self):
        self.assert_rejected()
        for key in INPUTS:
            for label, values in (
                ("absent", {name: value for name, value in INPUTS.items() if name != key}),
                ("empty", {**INPUTS, key: ""}),
            ):
                with self.subTest(key=key, label=label):
                    self.write_inputs(values)
                    self.assertIn(key, self.assert_rejected())

    def test_rejects_unsafe_values_and_input_paths(self):
        self.write_inputs({**INPUTS, "KEEP_OPENCLOUD_URL": "http://files.example.invalid"})
        self.assert_rejected()
        self.write_inputs(INPUTS)
        duplicate = json.dumps(INPUTS)[:-1] + ', "KEEP_OPENCLOUD_URL": ""}'
        self.input_path.write_text(duplicate)
        self.assert_rejected()
        self.write_inputs(INPUTS)
        self.input_path.chmod(0o644)
        self.assert_rejected()
        self.input_path.chmod(0o600)
        link = self.input_path.with_name("linked.json")
        link.symlink_to(self.input_path)
        self.assert_rejected(link)

    def invoke_firewall(self, role, repo_root):
        return subprocess.run(
            [sys.executable, str(RENDERER), "--repo-root", str(repo_root), "--firewall-role", role,
             "--input", str(self.input_path), "--staging-parent", str(self.staging)],
            capture_output=True, text=True, timeout=10,
        )

    def test_firewall_renders_exact_roles_and_rolls_back(self):
        repo = Path(__file__).resolve().parents[3]
        values = [str(ipaddress.IPv4Address((192 << 24) | (2 << 8) | n)) for n in (10, 11)]
        for role, relative, key in (
            ("gateway", "deploy/gateway/gate-firewall.nft", "GATE_PEER_IPV4"),
            ("guest", "scripts/infra/keep-storage/guest-firewall.nft", "KEEP_GUEST_DNS_IPV4"),
        ):
            with self.subTest(role=role):
                source = repo / relative
                template = source.read_bytes()
                token = f"@{key}@".encode()
                renders = []
                for value in values:
                    self.write_inputs({key: value})
                    result = self.invoke_firewall(role, repo)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    output = Path(result.stdout.strip())
                    rendered = output / role / source.name
                    self.assertEqual(list(output.iterdir()), [output / role])
                    self.assertEqual(list(rendered.parent.iterdir()), [rendered])
                    self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)
                    self.assertEqual(stat.S_IMODE(rendered.stat().st_mode), 0o600)
                    self.assertTrue(rendered.read_bytes() == template.replace(token, value.encode()))
                    renders.append(rendered)
                installed = self.staging / source.name
                shutil.copyfile(renders[0], installed)
                before = installed.read_bytes()
                shutil.copyfile(renders[1], installed)
                self.assertNotEqual(installed.read_bytes(), before)
                shutil.copyfile(renders[0], installed)
                self.assertTrue(installed.read_bytes() == before)
                self.assertTrue(source.read_bytes() == template)

    def test_firewall_refuses_unsafe_or_missing_private_input(self):
        repo = Path(__file__).resolve().parents[3]
        for values in ({}, {"GATE_PEER_IPV4": "input / 24"}, {"GATE_PEER_IPV4": "7\naccept"}, INPUTS):
            self.write_inputs(values)
            result = self.invoke_firewall("gateway", repo)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            self.assertEqual(list(self.staging.iterdir()), [])

    def test_rejects_misplaced_target_before_writing_app_bundle(self):
        self.write_inputs(INPUTS)
        (self.templates / "vault.compose.yaml").write_text(
            "x-wrong:\n  OC_URL: https://other.example.invalid\n" + VAULT_TEMPLATE
        )
        self.assertIn("OC_URL", self.assert_rejected())


if __name__ == "__main__":
    unittest.main()
