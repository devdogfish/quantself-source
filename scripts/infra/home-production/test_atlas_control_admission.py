"""Synthetic assertions for the current broker and proposed private control admission."""

from contextlib import contextmanager, redirect_stderr, redirect_stdout
from copy import deepcopy
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import re
import runpy
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from test_atlas_deploy_journal import ACTION, Claim, DeployJournal, Receipt, ReconciliationRequired
from test_atlas_release import RELEASE, image_fixture


HERE = Path(__file__).resolve().parent
SOURCE_REPO = "devdogfish/quantself"
SOURCE_SHA = "a" * 40
IMAGE_ID = "sha256:" + "b" * 64
CONTROL_REPO = "fixture/quantself-control"
CONTROL_SHA = "c" * 40
CONTROL_REPO_ID = 42
CONTROL_WORKFLOW_ID = 84
CONTROL_WORKFLOW_PATH = ".github/workflows/promote-keep.yml"
OWNER_ID = 21
RUN_ID = 123
ATTEMPT = 2
CONTROL_SCRIPT = HERE / "atlas-control-admit.py"
CONTROL = runpy.run_path(CONTROL_SCRIPT)
POLICY = CONTROL["ControlPolicy"](
    CONTROL_REPO, CONTROL_REPO_ID, CONTROL_WORKFLOW_PATH, CONTROL_WORKFLOW_ID, OWNER_ID, CONTROL_SHA,
)
REQUEST = CONTROL["Request"](SOURCE_SHA, str(RUN_ID), str(ATTEMPT))
NOW = datetime(2026, 11, 15, 17, 0, tzinfo=timezone.utc)


def run_fixture(
    repo=CONTROL_REPO, commit=CONTROL_SHA, workflow=CONTROL_WORKFLOW_PATH, repo_id=CONTROL_REPO_ID,
):
    return {
        "id": RUN_ID,
        "event": "workflow_dispatch",
        "path": workflow,
        "workflow_id": CONTROL_WORKFLOW_ID,
        "head_branch": "main",
        "head_sha": commit,
        "run_attempt": ATTEMPT,
        "status": "in_progress",
        "run_started_at": "2026-11-15T16:59:00Z",
        "display_title": f"Promote Quantself {SOURCE_SHA}",
        "repository": {"id": repo_id, "full_name": repo, "private": True},
        "head_repository": {"id": repo_id, "full_name": repo},
        "actor": {"id": OWNER_ID},
        "triggering_actor": {"id": OWNER_ID},
    }


def current_broker_accepts(run, source_sha=SOURCE_SHA):
    # Run the actual jq filter only. The live shell broker opens locks and can deploy.
    source = (HERE / "quantself-deploy").read_text()
    match = re.search(r"--argjson attempt \"\$run_attempt\" '(.+?)' <<< \"\$run\"", source, re.S)
    if not match:
        raise AssertionError("Could not find deployed broker's run identity predicate")
    result = subprocess.run(
        ["jq", "--exit-status", "--arg", "repo", SOURCE_REPO,
         "--arg", "workflow", ".github/workflows/deploy.yml", "--arg", "revision", source_sha,
         "--arg", "id", str(RUN_ID), "--argjson", "attempt", str(ATTEMPT), match[1]],
        input=json.dumps(run), text=True, capture_output=True, check=False,
    )
    if result.returncode not in (0, 1):
        raise AssertionError(result.stderr)
    return result.returncode == 0


def synthetic_control_admission(
    run, *, control_main=CONTROL_SHA, source_sha=SOURCE_SHA, source_main=SOURCE_SHA, backup_ready_sha=SOURCE_SHA,
    backup_ready_image=IMAGE_ID, verified_atlas=None, release_proof_ok=True,
    maintenance_clear=True, attempt_unused=True,
):
    """Model only the admission predicates. No credentials, GitHub calls or deployment."""
    verified_atlas = verified_atlas or {}
    request = CONTROL["Request"](source_sha, str(RUN_ID), str(ATTEMPT))
    return (
        CONTROL["run_matches"](POLICY, request, run, control_main, NOW)
        and source_sha == source_main == backup_ready_sha == verified_atlas.get("revision")
        and verified_atlas.get("repository") == SOURCE_REPO
        and verified_atlas.get("ref") == "refs/heads/main"
        and verified_atlas.get("platform") == "linux/amd64"
        and verified_atlas.get("image_id") == backup_ready_image
        and release_proof_ok and maintenance_clear and attempt_unused
    )


class ControlAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.run = run_fixture()
        self.receipt = {
            "repository": SOURCE_REPO, "ref": "refs/heads/main", "revision": SOURCE_SHA,
            "platform": "linux/amd64", "image_id": IMAGE_ID,
        }

    def test_current_broker_accepts_exact_quantself_run_independently_of_runner_type(self):
        run = run_fixture(SOURCE_REPO, SOURCE_SHA, ".github/workflows/deploy.yml", 1168864504)
        self.assertTrue(current_broker_accepts(run))
        run["runner_environment"] = "self-hosted"
        self.assertTrue(current_broker_accepts(run))
        run["event"] = "pull_request_target"
        self.assertFalse(current_broker_accepts(run))

    def test_current_broker_rejects_control_repo_even_for_the_same_source_sha_and_path(self):
        run = run_fixture(commit=SOURCE_SHA, workflow=".github/workflows/deploy.yml")
        self.assertFalse(current_broker_accepts(run))

    def test_private_control_contract_accepts_separate_exact_control_and_source_commits(self):
        self.assertNotEqual(CONTROL_SHA, SOURCE_SHA)
        for path in (CONTROL_WORKFLOW_PATH, f"{CONTROL_WORKFLOW_PATH}@main"):
            with self.subTest(path=path):
                run = {**self.run, "path": path}
                self.assertTrue(synthetic_control_admission(run, verified_atlas=self.receipt))
                wrong_branch = {**run, "head_branch": "other"}
                self.assertFalse(synthetic_control_admission(wrong_branch, verified_atlas=self.receipt))

    def test_private_control_contract_rejects_ineligible_run_identity(self):
        for field, value in {
            "event": ("pull_request", "pull_request_target", "workflow_call", "push"),
            "path": (".github/workflows/other.yml", f"{CONTROL_WORKFLOW_PATH}@feature",
                     f"{CONTROL_WORKFLOW_PATH}@refs/heads/main", f"{CONTROL_WORKFLOW_PATH}@{CONTROL_SHA}"),
            "workflow_id": (85,), "head_branch": ("feature",), "head_sha": (SOURCE_SHA,),
            "run_attempt": (1, 3), "status": ("completed", "queued"), "id": (RUN_ID + 1,),
            "display_title": (f"Promote Quantself {CONTROL_SHA}",),
            "run_started_at": (None, "2026-11-15T16:44:59Z", "2026-11-15T17:00:06Z", "yesterday"),
        }.items():
            for wrong in value:
                with self.subTest(field=field, actual=wrong):
                    run = {**self.run, field: wrong}
                    self.assertFalse(synthetic_control_admission(run, verified_atlas=self.receipt))

        for outer, inner, wrong in (
            ("head_repository", "full_name", "fork/quantself-control"),
            ("repository", "id", CONTROL_REPO_ID + 1),
            ("repository", "private", False),
            ("actor", "id", OWNER_ID + 1),
            ("triggering_actor", "id", OWNER_ID + 1),
        ):
            with self.subTest(field=f"{outer}.{inner}"):
                run = deepcopy(self.run)
                run[outer][inner] = wrong
                self.assertFalse(synthetic_control_admission(run, verified_atlas=self.receipt))
        self.assertFalse(synthetic_control_admission(
            {**self.run, "head_repository": None}, verified_atlas=self.receipt,
        ))

    def test_private_control_contract_requires_fresh_source_backup_and_verified_atlas_receipt(self):
        for field, wrong in {
            "control_main": SOURCE_SHA, "source_main": CONTROL_SHA, "backup_ready_sha": CONTROL_SHA,
            "backup_ready_image": "sha256:" + "f" * 64,
            "release_proof_ok": False, "maintenance_clear": False, "attempt_unused": False,
        }.items():
            with self.subTest(field=field):
                self.assertFalse(synthetic_control_admission(
                    self.run, verified_atlas=self.receipt, **{field: wrong},
                ))
        self.assertFalse(synthetic_control_admission(self.run))
        for field, wrong in {
            "repository": CONTROL_REPO, "ref": "refs/heads/feature", "revision": CONTROL_SHA,
            "platform": "linux/arm64", "image_id": "sha256:" + "d" * 64,
        }.items():
            with self.subTest(receipt_field=field):
                self.assertFalse(synthetic_control_admission(
                    self.run, verified_atlas={**self.receipt, field: wrong},
                ))


class ControlGitHubTests(unittest.TestCase):
    token = "ghs_fixture-secret"
    base = f"/repos/{CONTROL_REPO}"
    run_path = f"{base}/actions/runs/{RUN_ID}"
    ref_path = f"{base}/git/ref/heads/main"

    def request(self, *, run=None, ref=None, statuses=None):
        verify = CONTROL["verify_request"]
        run = run_fixture() if run is None else run
        ref = {"ref": "refs/heads/main", "object": {"type": "commit", "sha": CONTROL_SHA}} if ref is None else ref
        data = {self.run_path: run, self.ref_path: ref}
        statuses = statuses or {}
        observed = []

        class Connection:
            def __init__(self, host, timeout, context):
                self.host = host
                self.timeout = timeout

            def request(self, method, path, headers):
                self.path = path
                observed.append((self.host, self.timeout, method, path, headers))

            def getresponse(self):
                response = Mock(status=statuses.get(self.path, 200))
                response.read.side_effect = lambda limit: json.dumps(data[self.path]).encode()[:limit]
                return response

            def close(self):
                pass

        clock = Mock(wraps=datetime)
        clock.now.return_value = NOW
        with (
            patch.dict(verify.__globals__, {"datetime": clock}),
            patch("http.client.HTTPSConnection", Connection),
        ):
            verify(POLICY, REQUEST, self.token)
        return observed

    def test_fetches_only_the_authenticated_run_and_canonical_main_from_github(self):
        observed = self.request()
        self.assertCountEqual([entry[3] for entry in observed], [self.run_path, self.ref_path])
        for host, timeout, method, _path, headers in observed:
            self.assertEqual((host, timeout, method), ("api.github.com", 8, "GET"))
            self.assertEqual(headers["Authorization"], f"Bearer {self.token}")

    def test_ref_mismatch_and_redirects_fail_closed(self):
        for ref in (
            {"ref": "refs/heads/other", "object": {"type": "commit", "sha": CONTROL_SHA}},
            {"ref": "refs/heads/main", "object": {"type": "tag", "sha": CONTROL_SHA}},
            {"ref": "refs/heads/main", "object": {"type": "commit", "sha": SOURCE_SHA}},
        ):
            with self.subTest(ref=ref), self.assertRaisesRegex(ValueError, "identity rejected"):
                self.request(ref=ref)
        with self.assertRaisesRegex(ValueError, "lookup failed"):
            self.request(statuses={self.run_path: 302})

    def test_promotion_verifier_cannot_admit_a_rollback_title(self):
        run = run_fixture()
        run["display_title"] = f"Rollback Quantself {SOURCE_SHA} {CONTROL_SHA} {IMAGE_ID} blue"
        with self.assertRaisesRegex(ValueError, "Control run identity rejected"):
            self.request(run=run)

    def test_cli_rejects_without_echoing_credentials_or_api_errors(self):
        main = CONTROL["main"]
        stdout, stderr = io.StringIO(), io.StringIO()
        argv = [SOURCE_SHA, str(RUN_ID), str(ATTEMPT)]
        verify = Mock(side_effect=OSError(f"private transport diagnostic: {self.token}"))
        with (
            patch.dict(main.__globals__, {
                "load_policy": lambda: POLICY,
                "read_token": lambda: self.token,
                "verify_request": verify,
            }),
            redirect_stdout(stdout), redirect_stderr(stderr),
        ):
            self.assertEqual(main(argv), 1)
            self.assertEqual(main([*argv, self.token]), 1)
        verify.assert_called_once_with(POLICY, REQUEST, self.token)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "Control admission rejected.\n" * 2)

    def test_cli_exits_when_an_api_worker_never_returns(self):
        harness = """
import runpy
import sys
import time
from pathlib import Path

script, marker, source, run_id, attempt = sys.argv[1:]
helper = runpy.run_path(script)
policy = helper["ControlPolicy"](
    "fixture/quantself-control", 42, ".github/workflows/promote-keep.yml", 84, 21, "c" * 40,
)

def stalled_request(_path, token):
    assert token == "ghs_fixture-secret"
    Path(marker).touch()
    time.sleep(30)

entry = helper["run_cli"]
entry.__globals__.update(ADMISSION_TIMEOUT=0.5, load_policy=lambda: policy, get_json=stalled_request)
sys.argv = [script, source, run_id, attempt]
sys.exit(entry())
"""
        with tempfile.TemporaryDirectory() as scratch:
            marker = Path(scratch) / "started"
            result = subprocess.run(
                [sys.executable, "-I", "-B", "-c", harness, str(CONTROL_SCRIPT), str(marker),
                 SOURCE_SHA, str(RUN_ID), str(ATTEMPT)],
                input=self.token + "\n", text=True, capture_output=True, timeout=5,
            )
            self.assertTrue(marker.exists())
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "Control admission rejected.\n")

    def test_policy_rejects_group_writable_files(self):
        load = CONTROL["load_policy"]
        stat_file = os.fstat
        stat_path = Path.stat

        def file_info(fd):
            return SimpleNamespace(st_uid=0, st_mode=stat_file(fd).st_mode)

        def parent_info(path, **kwargs):
            info = stat_path(path, **kwargs)
            return SimpleNamespace(st_uid=0, st_mode=info.st_mode & ~0o022)

        with tempfile.TemporaryDirectory() as scratch:
            policy = Path(scratch).resolve() / "control-policy.json"
            policy.write_text(json.dumps(vars(POLICY)))
            policy.chmod(0o600)
            with (
                patch.dict(load.__globals__, {"POLICY_PATH": policy}),
                patch("os.fstat", side_effect=file_info),
                patch.object(Path, "stat", parent_info),
            ):
                self.assertEqual(load(), POLICY)
                policy.chmod(0o660)
                with self.assertRaisesRegex(ValueError, "root-controlled control policy"):
                    load()

    def test_token_input_is_bounded_and_rejects_extra_lines(self):
        for text in (b"ghs_fixture-secret\n", b"ghs_valid\nextra\n", b"ghs_" + b"x" * 4096 + b"\n"):
            with self.subTest(size=len(text)):
                reader, writer = os.pipe()
                try:
                    os.write(writer, text)
                    os.close(writer)
                    if text == b"ghs_fixture-secret\n":
                        self.assertEqual(CONTROL["read_token"](reader), self.token)
                    else:
                        with self.assertRaisesRegex(ValueError, "^Invalid control credential$"):
                            CONTROL["read_token"](reader)
                finally:
                    os.close(reader)


class RelayTemplateTests(unittest.TestCase):
    def setUp(self):
        scratch = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(scratch)
        template = (HERE / "atlas-control-relay.yml").read_text()
        self.script = "\n".join(line[10:] for line in template.split("        run: |\n", 1)[1].splitlines())
        self.receiver = HERE / "atlas-relay-canary.py"
        self.harness = self.root / "receiver.py"
        self.harness.write_text("""
import runpy
import sys

entry = runpy.run_path(sys.argv[1])["main"]
entry.__globals__.update(VERIFIER=sys.argv[2], READ_TIMEOUT=0.3, VERIFY_TIMEOUT=1)
sys.exit(entry())
""")
        self.verifier = self.root / "verifier.py"
        self.verifier_called = self.root / "verifier-called"
        self.verifier_mode = self.root / "verifier-mode"
        self.verifier.write_text("""
import os
from pathlib import Path
import sys
import time

root = Path(__file__).parent
assert sys.argv[1:] == ["a" * 40, "123", "2"]
assert not {"CANARY_JOB_TOKEN", "CANARY_SSH_KEY", "SSH_ORIGINAL_COMMAND", "FIXTURE_ENV_SECRET"} & os.environ.keys()
token = sys.stdin.buffer.read()
assert token == b"ghs_fixture-secret\\n"
(root / "verifier-called").touch()
mode = (root / "verifier-mode").read_text()
if mode == "timeout":
    time.sleep(30)
if mode == "diagnostic":
    print(token.decode(), file=sys.stderr)
    print("private verifier diagnostic", file=sys.stdout)
if mode == "nonzero":
    print("Control run admitted.")
    sys.exit(1)
else:
    print("Control run admitted.")
""")
        self.verifier_mode.write_text("valid")
        fake_timeout = self.root / "timeout"
        fake_timeout.write_text(
            '#!/bin/sh\n[ "$1 $2" = "--kill-after=2s 35s" ] || exit 70\nshift 2\nexec "$@"\n'
        )
        fake_ssh = self.root / "ssh"
        fake_ssh.write_text(f"#!{sys.executable}\n" + """
import os
from pathlib import Path
import subprocess
import sys

args = sys.argv[1:]
env = os.environ
assert not {'CANARY_JOB_TOKEN', 'CANARY_SSH_KEY', 'token', 'ssh_key'} & env.keys()
assert 'ghs_fixture-secret' not in ' '.join(args)
assert args[:4] == ['-F', '/dev/null', '-T', '-x']
assert args[-2:] == ['quantself-canary@relay.example.test', 'atlas-relay-canary']
assert {'BatchMode=yes', 'IdentityAgent=none', 'StrictHostKeyChecking=yes',
        'HostKeyAlgorithms=ssh-ed25519', 'GlobalKnownHostsFile=/dev/null'} <= set(args)
key = Path(args[args.index('-i') + 1])
pin = Path(next(item.split('=', 1)[1] for item in args if item.startswith('UserKnownHostsFile=')))
assert key.stat().st_mode & 0o777 == 0o600 == pin.stat().st_mode & 0o777
assert key.read_text() == 'fixture ephemeral key\\n'
assert pin.read_text() == env['CANARY_SSH_KNOWN_HOST'] + '\\n'

frame = sys.stdin.buffer.read()
Path(env['FIXTURE_FRAME']).write_bytes(frame)
assert frame == (
    f"promote-atlas {env['SOURCE_SHA']} {env['GITHUB_RUN_ID']} {env['GITHUB_RUN_ATTEMPT']}\\n"
    "ghs_fixture-secret\\n"
).encode()
result = subprocess.run(
    [sys.executable, '-I', '-B', env['FIXTURE_HARNESS'], env['FIXTURE_RECEIVER'], env['FIXTURE_VERIFIER']],
    input=frame, capture_output=True, env={**env, 'SSH_ORIGINAL_COMMAND': args[-1]}, timeout=3,
)
if result.returncode:
    assert result.stdout == b'' and result.stderr == b'Atlas relay canary rejected.\\n'
    sys.stderr.buffer.write(result.stderr)
    sys.exit(result.returncode)
assert result.stderr == b''
ack = result.stdout
mode = env['FIXTURE_ACK']
if mode == 'error':
    print('remote diagnostics must be ignored: ghs_fixture-secret', file=sys.stderr)
    sys.exit(22)
sys.stdout.buffer.write({
    'valid': ack, 'duplicate': ack + ack, 'extra-blank': ack + b'\\n',
    'wrong': ack.replace(b' 123 ', b' 124 '), 'missing': b'',
}[mode])
""")
        fake_timeout.chmod(0o700)
        fake_ssh.chmod(0o700)
        self.frame = self.root / "frame"
        self.environment = {
            "PATH": f"{self.root}:/usr/bin:/bin",
            "GITHUB_SERVER_URL": "https://github.com",
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_REF_PROTECTED": "true",
            "GITHUB_REPOSITORY": CONTROL_REPO,
            "GITHUB_REPOSITORY_ID": str(CONTROL_REPO_ID),
            "CANARY_REPOSITORY_ID": str(CONTROL_REPO_ID),
            "SOURCE_SHA": SOURCE_SHA,
            "GITHUB_RUN_ID": str(RUN_ID),
            "GITHUB_RUN_ATTEMPT": str(ATTEMPT),
            "CANARY_JOB_TOKEN": "ghs_fixture-secret",
            "CANARY_SSH_HOST": "relay.example.test",
            "CANARY_SSH_KNOWN_HOST": "relay.example.test ssh-ed25519 " + "A" * 68,
            "CANARY_SSH_KEY": "fixture ephemeral key",
            "FIXTURE_FRAME": str(self.frame),
            "FIXTURE_ACK": "valid",
            "FIXTURE_RECEIVER": str(self.receiver),
            "FIXTURE_HARNESS": str(self.harness),
            "FIXTURE_VERIFIER": str(self.verifier),
            "FIXTURE_ENV_SECRET": "fixture environment secret",
        }

    def send(self, **overrides):
        self.frame.unlink(missing_ok=True)
        return subprocess.run(["/bin/bash", "-c", self.script], env={**self.environment, **overrides},
                              capture_output=True, text=True, timeout=5)

    def receiver_args(self):
        return [sys.executable, "-I", "-B", str(self.harness), str(self.receiver), str(self.verifier)]

    def test_exact_frame_and_one_bound_acknowledgement(self):
        result = self.send()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "Atlas relay rehearsal acknowledged.\n")
        self.assertTrue(self.verifier_called.exists())
        self.assertEqual(self.frame.read_bytes(), (
            f"promote-atlas {SOURCE_SHA} {RUN_ID} {ATTEMPT}\nghs_fixture-secret\n"
        ).encode())
        for mode in ("duplicate", "extra-blank", "wrong", "missing", "error"):
            with self.subTest(mode=mode):
                result = self.send(FIXTURE_ACK=mode)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, "")
                self.assertEqual(result.stderr, "Atlas relay rehearsal rejected.\n")

    def test_receiver_failures_are_redacted_through_the_sender(self):
        for mode in ("diagnostic", "nonzero", "timeout"):
            with self.subTest(mode=mode):
                self.verifier_mode.write_text(mode)
                self.verifier_called.unlink(missing_ok=True)
                result = self.send()
                self.assertTrue(self.verifier_called.exists())
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, "")
                self.assertEqual(result.stderr, "Atlas relay rehearsal rejected.\n")

    def test_receiver_rejects_wrong_command_and_trailing_bytes_before_verifying(self):
        frame = f"promote-atlas {SOURCE_SHA} {RUN_ID} {ATTEMPT}\nghs_fixture-secret\n".encode()
        for command, data in (
            ("atlas-relay-canary; sh", frame), ("", frame), ("atlas-relay-canary", frame + b"\n"),
            ("atlas-relay-canary", frame + b"\0"), ("atlas-relay-canary", frame[:-1]),
            ("atlas-relay-canary", frame + b"x" * 4256),
        ):
            with self.subTest(command=command, size=len(data)):
                result = subprocess.run(self.receiver_args(), input=data, capture_output=True, timeout=3,
                                        env={"SSH_ORIGINAL_COMMAND": command})
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, b"")
                self.assertEqual(result.stderr, b"Atlas relay canary rejected.\n")
                self.assertFalse(self.verifier_called.exists())

    def test_receiver_requires_eof_before_its_read_deadline(self):
        with subprocess.Popen(
            self.receiver_args(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={"SSH_ORIGINAL_COMMAND": "atlas-relay-canary"},
        ) as receiver:
            receiver.stdin.write(f"promote-atlas {SOURCE_SHA} {RUN_ID} {ATTEMPT}\nghs_fixture-secret\n".encode())
            receiver.stdin.flush()
            self.assertEqual(receiver.wait(timeout=3), 1)
            self.assertEqual(receiver.stdout.read(), b"")
            self.assertEqual(receiver.stderr.read(), b"Atlas relay canary rejected.\n")
        self.assertFalse(self.verifier_called.exists())

    def test_invalid_origin_ref_frame_and_pin_never_invoke_ssh(self):
        for field, value in {
            "GITHUB_EVENT_NAME": "pull_request_target",
            "GITHUB_REF": "refs/heads/feature",
            "GITHUB_REF_PROTECTED": "false",
            "GITHUB_REPOSITORY": "devdogfish/quantself",
            "GITHUB_REPOSITORY_ID": "43",
            "SOURCE_SHA": SOURCE_SHA + "\n",
            "GITHUB_RUN_ATTEMPT": "02",
            "CANARY_JOB_TOKEN": "ghs_" + "x" * 4096,
            "CANARY_SSH_HOST": "-oProxyCommand",
            "CANARY_SSH_KNOWN_HOST": "other.example.test ssh-ed25519 " + "A" * 68,
        }.items():
            with self.subTest(field=field):
                result = self.send(**{field: value})
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stderr, "Atlas relay rehearsal rejected.\n")
                self.assertFalse(self.frame.exists())


class PrivateRelayChainTests(unittest.TestCase):
    def setUp(self):
        scratch = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(scratch)
        self.lock = self.root / "shared.lock"
        self.lock.touch(mode=0o600)
        self.journal_path = self.root / "journal.sqlite"
        self.open_journal().initialize()

        self.bundle = self.root / "candidate"
        self.image = self.bundle / "app-image"
        self.image.mkdir(parents=True)
        image_fixture(self.image, SOURCE_SHA)
        record = RELEASE["release_record"](self.image, SOURCE_SHA)
        signer = self.signer("atlas")
        self.allowed = self.root / "allowed-signers"
        self.allowed.write_text(f"{RELEASE['PRINCIPAL']} {signer.with_suffix('.pub').read_text()}")
        RELEASE["sign_bundle"](self.bundle, record, signer)
        self.claim = Claim(str(CONTROL_REPO_ID), str(RUN_ID), str(ATTEMPT), SOURCE_SHA, record["image_id"])
        self.identity = [*self.claim.key, self.claim.source_sha, self.claim.image_id]

    def signer(self, name):
        key = self.root / name
        subprocess.run(
            ["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key)],
            check=True, capture_output=True,
        )
        return key

    def open_journal(self):
        return DeployJournal(self.lock, self.journal_path)

    def submit(self, *, run=None, reply_lost=False, **readiness):
        journal = self.open_journal()
        lock = journal._lock
        observed_run = run_fixture() if run is None else run
        expected = {"backup_ready_image": self.claim.image_id, **readiness}

        @contextmanager
        def admit_under_shared_lock():
            # The fixture supplies synthetic GitHub and readiness facts. The actual
            # journal holds the same lock through verified admission and the callback.
            with lock() as descriptor:
                record = RELEASE["verify_bundle"](self.bundle, self.claim.source_sha, self.allowed)
                if not synthetic_control_admission(observed_run, verified_atlas=record, **expected):
                    raise PermissionError("Private relay admission rejected")
                yield descriptor

        def command(bound):
            return [sys.executable, "-I", "-B", "-c", ACTION, str(self.root), "success",
                    *bound.key, bound.source_sha, bound.image_id]

        with patch.object(journal, "_lock", admit_under_shared_lock):
            receipt = journal.submit(self.claim, command)
        if reply_lost:
            raise ConnectionError("Synthetic reply lost after durable receipt")
        return receipt

    def invocations(self):
        marker = self.root / "invocations"
        return [json.loads(line) for line in marker.read_text().splitlines()] if marker.exists() else []

    def test_signed_exact_run_deploys_once_when_the_reply_is_lost(self):
        with self.assertRaisesRegex(ConnectionError, "reply lost"):
            self.submit(reply_lost=True)
        expected = Receipt(self.claim, "succeeded", "deploy-and-smoke-exit-zero")
        self.assertEqual(self.submit(), expected)
        self.assertEqual(self.open_journal().reconcile(self.claim, lambda _: None), expected)
        self.assertEqual(self.invocations(), [self.identity])
        self.assertEqual(json.loads((self.root / "smoke-complete").read_text()), self.identity)

    def test_invalid_run_receipt_and_readiness_never_create_a_claim(self):
        fork = run_fixture()
        fork["head_repository"] = {"id": CONTROL_REPO_ID + 1, "full_name": "fork/quantself-control"}
        for inputs in (
            {"run": fork},
            {"run": {**run_fixture(), "event": "pull_request_target"}},
            {"source_main": CONTROL_SHA},
            {"backup_ready_sha": None},
            {"backup_ready_image": IMAGE_ID},
            {"release_proof_ok": False},
        ):
            with self.subTest(inputs=inputs), self.assertRaises(PermissionError):
                self.submit(**inputs)
        signature = self.bundle / "release.sig"
        good_signature = signature.read_bytes()
        signature.unlink()
        record = json.loads((self.bundle / "release.json").read_text())
        RELEASE["sign_bundle"](self.bundle, record, self.signer("untrusted"))
        with self.assertRaisesRegex(ValueError, "signature rejected"):
            self.submit()
        signature.write_bytes(good_signature)
        archive = self.image / "image.tar.gz"
        with archive.open("ab") as contents:
            contents.write(b"substituted archive")
        with self.assertRaisesRegex(ValueError, "checksum"):
            self.submit()
        self.assertEqual(self.invocations(), [])
        with self.assertRaisesRegex(ReconciliationRequired, "No claim found"):
            self.open_journal().reconcile(self.claim, lambda _: None)

    def test_missing_receipt_fences_retry_until_smoke_is_reconciled(self):
        with patch.object(DeployJournal, "_finish", side_effect=sqlite3.OperationalError("fixture receipt write")):
            with self.assertRaisesRegex(sqlite3.OperationalError, "fixture receipt write"):
                self.submit()
        with self.assertRaisesRegex(ReconciliationRequired, "unresolved deploy"):
            self.submit()
        with self.assertRaisesRegex(ReconciliationRequired, "outcome is still unknown"):
            self.open_journal().reconcile(self.claim, lambda _: None)
        self.assertEqual(self.invocations(), [self.identity])

        def observe(bound):
            evidence = json.loads((self.root / "smoke-complete").read_text())
            if evidence == [*bound.key, bound.source_sha, bound.image_id]:
                return Receipt(bound, "succeeded", "fixture:exact-smoke-record")
            return None

        recovered = self.open_journal().reconcile(self.claim, observe)
        self.assertEqual(recovered, Receipt(self.claim, "succeeded", "fixture:exact-smoke-record"))
        self.assertEqual(self.submit(), recovered)
        self.assertEqual(self.invocations(), [self.identity])


if __name__ == "__main__":
    unittest.main()
