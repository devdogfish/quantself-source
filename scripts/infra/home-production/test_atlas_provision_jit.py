from contextlib import redirect_stderr
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


DIRECTORY = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("atlas_provision_jit", DIRECTORY / "atlas-provision-jit.py")
JIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(JIT)


class RelayProvisioningTest(unittest.TestCase):
    def setUp(self):
        home = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.object(JIT.Path, "home", return_value=home))
        self.args = SimpleNamespace(
            role="relay", repository="devdogfish/private-control", repository_id=123, label="quantself-atlas-control",
            run_id="23", attempt="1", source_sha="a" * 40, control_sha="b" * 40, output=None,
            relay_ssh_target="root@atlas-relay",
        )
        self.prefix = f"repos/{self.args.repository}"
        actor = {"id": JIT.OWNER_ID}
        repo = {
            "id": 123, "full_name": self.args.repository, "private": True, "fork": False,
            "allow_forking": True, "default_branch": "main",
        }
        run = {
            "id": 23, "run_attempt": 1, "head_branch": "main", "head_sha": self.args.control_sha,
            "status": "in_progress", "event": "workflow_dispatch", "path": JIT.CONTROL_WORKFLOW,
            "actor": actor, "triggering_actor": actor, "repository": repo, "head_repository": repo,
            "display_title": f"Promote Quantself {self.args.source_sha}",
        }
        self.job = {
            "id": 42, "run_id": 23, "head_sha": self.args.control_sha, "name": "relay",
            "status": "queued", "runner_id": None,
            "labels": ["self-hosted", "linux", "x64", self.args.label, f"{self.args.label}-23-1"],
        }
        self.gets = {
            "": repo,
            "/branches/main": {"protected": True, "commit": {"sha": self.args.control_sha}},
            "/collaborators": [{"id": JIT.OWNER_ID, "role_name": "admin"}],
            "/actions/permissions/fork-pr-workflows-private-repos": {
                "run_workflows_from_fork_pull_requests": False, "send_write_tokens_to_workflows": False,
                "send_secrets_and_variables": False,
            },
            "/actions/runs/23/attempts/1": run,
            "/actions/runs/23/attempts/1/jobs": {"total_count": 1, "jobs": [self.job]},
            "/actions/runners?per_page=100": {"total_count": 0, "runners": []},
            "/actions/jobs/42": self.job | {"status": "in_progress", "runner_id": 29},
        }
        self.posts = []

    def api(self, path, payload=None, *, timeout=20):
        if payload is None:
            return self.gets[path.removeprefix(self.prefix)]
        self.assertEqual(path, self.prefix + "/actions/runners/generate-jitconfig")
        self.posts.append(payload)
        return {"runner": {"id": 29, "name": payload["name"]}, "encoded_jit_config": "JIT_fixture="}

    def test_transfers_only_the_exact_job_runner_configuration_to_pinned_ssh(self):
        launched = subprocess.CompletedProcess([], 0, stdout="Atlas relay runner started.\n")
        with patch.object(JIT, "api", side_effect=self.api), \
                patch.object(JIT.subprocess, "run", return_value=launched) as ssh, \
                patch.dict(os.environ, {"GH_TOKEN": "admin-fixture", "GITHUB_TOKEN": "admin-fixture"}):
            JIT.provision(self.args)
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(self.posts[0]["labels"], self.job["labels"])
        command, options = ssh.call_args
        self.assertEqual(command[0][-3:], ["--", "root@atlas-relay", "/usr/local/sbin/quantself-atlas-control-jit"])
        self.assertIn("StrictHostKeyChecking=yes", command[0])
        self.assertIn("ForwardAgent=no", command[0])
        self.assertNotIn("JIT_fixture=", command[0])
        self.assertEqual(options["input"], "JIT_fixture=\n")
        self.assertNotIn("GH_TOKEN", options["env"])
        self.assertNotIn("GITHUB_TOKEN", options["env"])

    def test_rejects_wrong_actor_attempt_or_label_before_issuing_runner(self):
        run = self.gets["/actions/runs/23/attempts/1"]
        cases = [
            (run, "triggering_actor", {"id": 1}),
            (run, "run_attempt", 2),
            (run, "id", 24),
            (run, "head_sha", "c" * 40),
            (run, "head_repository", run["head_repository"] | {"full_name": "devdogfish/fork"}),
            (run, "display_title", "Promote Quantself " + "c" * 40),
            (self.gets[""], "fork", True),
            (self.job, "labels", [*self.job["labels"][:-1], f"{self.args.label}-24-1"]),
            (self.job, "runner_id", 1),
            (self.gets["/actions/permissions/fork-pr-workflows-private-repos"], "send_secrets_and_variables", True),
        ]
        for target, field, invalid in cases:
            with self.subTest(field=field), patch.dict(target, {field: invalid}):
                with patch.object(JIT, "api", side_effect=self.api), patch.object(JIT.subprocess, "run") as ssh:
                    with self.assertRaises(ValueError):
                        JIT.provision(self.args)
                ssh.assert_not_called()
        self.assertEqual(self.posts, [])

    def test_auto_waits_only_for_missing_job_and_refreshes_admission_before_issue(self):
        self.args.wait_for_job = True
        queried = []
        job_path = self.prefix + "/actions/runs/23/attempts/1/jobs"

        def fetch(path, payload=None, *, timeout=20):
            queried.append((path, timeout))
            if path == job_path and sum(item == job_path for item, _ in queried) == 1:
                return {"total_count": 0, "jobs": []}
            return self.api(path, payload)

        launched = subprocess.CompletedProcess([], 0, stdout="Atlas relay runner started.\n")
        with (
            patch.object(JIT, "api", side_effect=fetch),
            patch.object(JIT.subprocess, "run", return_value=launched) as ssh,
            patch.object(JIT.time, "sleep"),
        ):
            JIT.provision(self.args)
        reads = [timeout for item, timeout in queried if item == job_path]
        self.assertEqual(len(reads), 3)
        self.assertGreater(reads[1], 0)
        self.assertLessEqual(reads[1], JIT.RELAY_JOB_WAIT_SECONDS)
        self.assertEqual([path for path, _ in queried].count(self.prefix + "/branches/main"), 2)
        self.assertEqual(len(self.posts), 1)
        ssh.assert_called_once()

    def test_auto_does_not_wait_on_denied_admission_or_claimed_label(self):
        self.args.wait_for_job = True
        runner_list = self.gets["/actions/runners?per_page=100"]
        with (
            patch.object(JIT, "api", side_effect=self.api),
            patch.object(JIT.subprocess, "run") as ssh,
            patch.object(JIT.time, "sleep") as sleep,
        ):
            for changes, expected in (
                ({"total_count": 1, "runners": [{"labels": [{"name": self.job["labels"][-1].upper()}]}]}, "already claimed"),
                ({"total_count": 101, "runners": []}, "complete relay runner inventory"),
            ):
                with patch.dict(runner_list, changes), self.assertRaisesRegex(ValueError, expected):
                    JIT.provision(self.args)
            with patch.dict(self.gets["/actions/runs/23/attempts/1/jobs"], {"jobs": []}):
                with self.assertRaisesRegex(ValueError, "Invalid relay job inventory"):
                    JIT.provision(self.args)
        self.assertEqual(self.posts, [])
        ssh.assert_not_called()
        sleep.assert_not_called()

    def test_missing_job_wait_is_bounded_before_any_issuance(self):
        self.args.wait_for_job = True
        with (
            patch.object(JIT, "api", side_effect=self.api),
            patch.object(JIT.subprocess, "run") as ssh,
            patch.object(JIT, "RELAY_JOB_WAIT_SECONDS", 0),
            patch.dict(self.gets["/actions/runs/23/attempts/1/jobs"], {"total_count": 0, "jobs": []}),
            self.assertRaisesRegex(ValueError, "did not appear"),
        ):
            JIT.provision(self.args)
        self.assertEqual(self.posts, [])
        ssh.assert_not_called()

    def test_unreachable_guest_stops_and_same_attempt_cannot_issue_again(self):
        unreachable = subprocess.CompletedProcess([], 255, stdout="")
        with (
            patch.object(JIT, "api", side_effect=self.api) as api,
            patch.object(JIT.subprocess, "run", return_value=unreachable) as ssh,
        ):
            with self.assertRaisesRegex(ValueError, "launcher did not confirm"):
                JIT.provision(self.args)
            with self.assertRaisesRegex(ValueError, "already started"):
                JIT.provision(self.args)
            self.assertNotIn((self.prefix + "/actions/jobs/42",), [call.args for call in api.call_args_list])
        self.assertEqual(len(self.posts), 1)
        ssh.assert_called_once()

    def test_lost_jit_response_requires_reconciliation_before_retry(self):
        def fetch(path, payload=None, *, timeout=20):
            if payload is not None:
                self.posts.append(payload)
                raise subprocess.TimeoutExpired("fixture JIT issuance", timeout=timeout)
            return self.api(path)

        with patch.object(JIT, "api", side_effect=fetch), patch.object(JIT.subprocess, "run") as ssh:
            with self.assertRaises(subprocess.TimeoutExpired):
                JIT.provision(self.args)
            with self.assertRaisesRegex(ValueError, "already started"):
                JIT.provision(self.args)
        self.assertEqual(len(self.posts), 1)
        ssh.assert_not_called()

    def test_same_mac_cannot_concurrently_issue_for_the_same_attempt(self):
        with (
            JIT.relay_attempt_lock(self.args),
            patch.object(JIT, "api", side_effect=self.api),
            patch.object(JIT.subprocess, "run") as ssh,
            self.assertRaisesRegex(ValueError, "already handling the exact relay attempt"),
        ):
            JIT.provision(self.args)
        self.assertEqual(self.posts, [])
        ssh.assert_not_called()

    def test_rejects_assignment_to_a_different_runner(self):
        self.gets["/actions/jobs/42"]["runner_id"] = 221
        self.args.timing = True
        stderr = io.StringIO()
        launched = subprocess.CompletedProcess([], 0, stdout="Atlas relay runner started.\n")
        with (
            patch.object(JIT, "api", side_effect=self.api),
            patch.object(JIT.subprocess, "run", return_value=launched),
            redirect_stderr(stderr),
        ):
            with self.assertRaisesRegex(ValueError, "not assigned to the issued runner"):
                JIT.provision(self.args)
        self.assertIn('"phase":"launcher_acknowledged"', stderr.getvalue())
        self.assertNotIn('"phase":"assignment_observed"', stderr.getvalue())

    def test_timing_marks_admission_startup_and_assignment_without_credentials(self):
        self.args.timing = True
        stderr = io.StringIO()
        launcher_timing = {"launch_id": "d" * 32, "worker_mode": "--worker-template", "selection_ms": 80}
        launched = subprocess.CompletedProcess(
            [], 0, stdout="Atlas relay runner started.\n",
            stderr=f"discard JIT_fixture=\nAtlas relay launcher timing: {'d' * 32} --worker-template 80\n",
        )
        with (
            patch.object(JIT, "api", side_effect=self.api),
            patch.object(JIT.subprocess, "run", return_value=launched),
            patch.object(JIT.time, "monotonic_ns", side_effect=range(1_000_000, 6_000_000, 1_000_000)),
            redirect_stderr(stderr),
        ):
            JIT.provision(self.args)
        prefix = "Atlas relay timing: "
        events = [json.loads(line.removeprefix(prefix)) for line in stderr.getvalue().splitlines()
                  if line.startswith(prefix)]
        self.assertEqual(events, [
            {"phase": phase, "run_id": "23", "attempt": "1", "monotonic_us": index * 1000}
            | (launcher_timing if phase == "launcher_acknowledged" else {})
            for index, phase in enumerate((
                "provision_started", "admitted", "runner_issued", "launcher_acknowledged", "assignment_observed",
            ), start=1)
        ])
        self.assertNotIn("JIT_fixture=", stderr.getvalue())


class RelayLauncherTest(unittest.TestCase):
    def test_worker_marks_archive_extraction_before_listener_start(self):
        harness = r"""
source "$1"
runtime="$2"
runner_archive="$runtime/archive"
RUNTIME_DIRECTORY="$runtime"
CREDENTIALS_DIRECTORY="$runtime"
export QUANTSELF_ATLAS_TIMING_ID=00112233445566778899aabbccddeeff
id() { printf 'quantself-atlas-relay\n'; }
tar() {
  [[ "$*" == "-xz --no-same-owner -f $runner_archive" ]]
  printf 'fixture extraction\n'
}
run_worker --worker
"""
        with tempfile.TemporaryDirectory() as scratch:
            directory = Path(scratch)
            (directory / "jit-config").write_text("JIT_fixture=\n")
            listener = directory / "run.sh"
            listener.write_text("""#!/bin/bash
[[ "$ACTIONS_RUNNER_INPUT_JITCONFIG" == JIT_fixture= ]] || exit 1
[[ -z ${QUANTSELF_ATLAS_TIMING_ID-} ]] || exit 1
printf 'fixture listener\\n'
""")
            listener.chmod(0o700)
            output = subprocess.check_output([
                "bash", "-c", harness, "worker-test", str(DIRECTORY / "quantself-atlas-control-jit"), scratch,
            ], text=True, timeout=5)
        self.assertEqual(output.splitlines(), [
            "Atlas relay worker timing: 00112233445566778899aabbccddeeff --worker started",
            "Atlas relay archive extraction started.", "fixture extraction",
            "Atlas relay archive extraction finished.",
            "Atlas relay worker timing: 00112233445566778899aabbccddeeff --worker finished",
            "fixture listener",
        ])

    def test_shell_enforces_one_credential_and_only_passes_its_path_to_systemd(self):
        harness = r"""
source "$1"
runner_archive="$2/archive"
id() { printf '0\n'; }
stat() { if [[ $2 == %u ]]; then printf '0\n'; else printf '600\n'; fi; }
sha256sum() { IFS= read -r check; [[ $check == "$runner_digest  $runner_archive" ]]; }
fixture_dir=$2
worker_mode=$3
if [[ $worker_mode == --worker-template ]]; then
  trusted_install_directory() { return 0; }
  verify_template() { return 0; }
fi
mktemp() { command mktemp "$fixture_dir/JIT.XXXXXXXX"; }
systemd-run() {
  [[ " $* " == *" --property=Type=exec "* ]]
  [[ " $* " == *" --property=User=quantself-atlas-relay "* ]]
  [[ " $* " == *" --property=NoNewPrivileges=yes "* ]]
  [[ " $* " != *"JIT_fixture="* ]]
  [[ ${*: -1} == "$worker_mode" ]]
  local argument path
  for argument; do
    if [[ $argument == --property=LoadCredential=jit-config:* ]]; then
      path=${argument#--property=LoadCredential=jit-config:}
      [[ $(cat "$path") == JIT_fixture= ]]
    fi
  done
  if [[ -r /proc/uptime && -r /proc/sys/kernel/random/uuid ]]; then
    [[ " $* " =~ \ --setenv=QUANTSELF_ATLAS_TIMING_ID=([0-9a-f]{32})\  ]]
    printf '%s\n' "${BASH_REMATCH[1]}" > "$fixture_dir/worker-launch-id"
  fi
  [[ -n ${path-} ]]
}
main
"""
        with tempfile.TemporaryDirectory() as scratch:
            Path(scratch, "archive").touch()
            command = ["bash", "-c", harness, "launcher-test", str(DIRECTORY / "quantself-atlas-control-jit"), scratch]
            cases = [
                (b"JIT_fixture=\n", 0, b"Atlas relay runner started.\n"),
                (b"JIT_fixture=", 1, b""),
                (b"JIT_fixture=\nother\n", 1, b""),
                (b"JIT_fi\x00xture=\n", 1, b""),
            ]
            for worker_mode in ("--worker", "--worker-template"):
                for payload, expected_status, expected_stdout in cases:
                    with self.subTest(worker_mode=worker_mode, payload=payload):
                        result = subprocess.run(
                            [*command, worker_mode], input=payload, capture_output=True, timeout=5, check=False,
                        )
                        self.assertEqual(result.returncode, expected_status, result.stderr)
                        self.assertEqual(result.stdout, expected_stdout)
                        self.assertNotIn(b"JIT_fixture", result.stderr)
                        launch_id = Path(scratch) / "worker-launch-id"
                        if expected_status == 0 and sys.platform.startswith("linux"):
                            expected = f"Atlas relay launcher timing: {launch_id.read_text().strip()} {worker_mode} "
                            self.assertRegex(result.stderr.decode(), re.escape(expected) + r"[0-9]+\n")
                            launch_id.unlink()
                        self.assertEqual(list(Path(scratch).glob("JIT.*")), [])


if __name__ == "__main__":
    unittest.main()
