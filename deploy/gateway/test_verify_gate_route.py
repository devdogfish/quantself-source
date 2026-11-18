import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from verify_gate_route import GATEWAY, POLICIES


ATLAS = "100.64.0.20"
KEEP = "100.64.0.21"
CADDY = shutil.which("caddy")
INGRESS = {
    "funnel": {"QUANTSELF_FUNNEL_HOST": "gate.fixture.ts.net"},
    "legacy": {"GATE_TAILNET_IP": "100.64.0.22", "HOSTINGER_TAILNET_IP": "100.64.0.23"},
}


@unittest.skipUnless(CADDY, "requires the pinned Caddy binary")
class VerifyGateRouteTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        for name in ("webhooks.caddy", "owner-headers.caddy"):
            shutil.copyfile(GATEWAY / name, self.root / name)

    def verify(self, mode, *, env_changes=None, rewrite=lambda value: value,
               approval_edit=lambda value: value, file_mode=0o600, approval_kind="file"):
        filename, _ = POLICIES[mode]
        candidate = self.root / "staged.Caddyfile"
        candidate.write_text(rewrite((GATEWAY / filename).read_text()))
        expected = {"QUANTSELF_TAILNET_IP": ATLAS, **INGRESS[mode]}
        env = expected | (env_changes or {})
        approval = self.root / "approval.json"
        approval.unlink(missing_ok=True)
        if approval_kind != "missing":
            source = approval if approval_kind == "file" else self.root / "approval-source.json"
            source.write_text(approval_edit(json.dumps(expected | {"FENCED_KEEP_TAILNET_IP": KEEP})))
            source.chmod(file_mode)
            if approval_kind == "symlink":
                approval.symlink_to(source)
        process = subprocess.run(
            [sys.executable, "-B", str(GATEWAY / "verify_gate_route.py"), mode, str(candidate),
             str(approval), "--caddy", CADDY],
            env=env, capture_output=True, text=True, timeout=10,
        )
        self.assertNotIn(KEEP, process.stderr)
        self.assertNotIn("secret-fixture", process.stderr)
        return process

    def test_exact_atlas_funnel_and_optional_legacy_route_pass(self):
        for mode in POLICIES:
            with self.subTest(mode=mode):
                result = self.verify(mode)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), {"verified_relays": 1})

    def test_stale_origin_missing_origin_and_same_ip_are_denied(self):
        for origin in (KEEP, ""):
            with self.subTest(origin=origin):
                self.assertEqual(self.verify("funnel", env_changes={"QUANTSELF_TAILNET_IP": origin}).returncode, 1)
        self.assertEqual(self.verify("funnel", approval_edit=lambda value: value.replace(KEEP, ATLAS)).returncode, 1)
        self.assertEqual(self.verify("funnel", env_changes={"QUANTSELF_FUNNEL_HOST": "stale.fixture.ts.net"}).returncode, 1)

    def test_refuses_absent_malformed_duplicate_or_shared_approval(self):
        for options in (
            {"approval_kind": "missing"},
            {"approval_kind": "symlink"},
            {"file_mode": 0o644},
            {"approval_edit": lambda _: "secret-fixture"},
            {"approval_edit": lambda value: value[:-1] + ', "QUANTSELF_TAILNET_IP": "100.64.0.30"}'},
            {"approval_edit": lambda value: value.replace("gate.fixture.ts.net", "https://example.test/")},
            {"approval_edit": lambda value: value.replace(ATLAS, "192.0.2.1")},
        ):
            with self.subTest(options=options):
                result = self.verify("funnel", **options)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(json.loads(result.stderr), {"verified_relays": 0})
                self.assertEqual(result.stdout, "")

    def test_literal_keep_fallback_and_alternate_port_are_denied(self):
        for upstream in (f"http://{KEEP}:8443", f"http://{ATLAS}:8443 http://{KEEP}:8443", f"http://{ATLAS}:443"):
            with self.subTest(upstream=upstream):
                result = self.verify("funnel", rewrite=lambda text: text.replace("http://{$QUANTSELF_TAILNET_IP}:8443", upstream))
                self.assertEqual(result.returncode, 1, result.stdout)

    def test_modified_allowlist_or_legacy_source_is_denied(self):
        allowlist = self.root / "webhooks.caddy"
        allowlist.write_text(allowlist.read_text().replace('"/api/v1/meetings/cancel"', '"/api/internal/jobs/work/claim"'))
        self.assertEqual(self.verify("funnel").returncode, 1)
        self.assertEqual(self.verify("legacy", env_changes={"HOSTINGER_TAILNET_IP": "100.64.0.24"}).returncode, 1)

    def test_malformed_caddyfile_has_sanitized_error(self):
        result = self.verify("funnel", rewrite=lambda _: "{\nsecret-fixture\n}\n")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
