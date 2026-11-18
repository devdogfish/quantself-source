"""Exercise the scheduler's process boundary with disposable checker scripts."""

import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest


SUPERVISOR = Path(__file__).with_name("run-qualification.py")
FIXTURE = SUPERVISOR.parent.parent / "verify-roundcube-http.sh"
TEST_TIMEOUT = 20


class QualificationSupervisorTest(unittest.TestCase):
    def setUp(self):
        work = TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.root = Path(work.name)
        directory = self.root / "scheduler"
        directory.mkdir()
        supervisor = directory / SUPERVISOR.name
        shutil.copyfile(SUPERVISOR, supervisor)
        self.command = [sys.executable, "-EBs", str(supervisor)]
        self.checker = self.root / "check-roundcube-patch-readiness.py"

    def fixture_env(self, *, fail_down=False):
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        docker = bin_dir / "docker"
        docker.write_text(f"""#!{sys.executable}
from pathlib import Path
import signal
import sys
from time import monotonic, sleep

root = Path({str(self.root)!r})
args = sys.argv[1:]
if args[:2] == ["context", "inspect"]:
    print("unix:///run/docker.sock")
    sys.exit(0)
assert args[:3] == ["--context", "default", "compose"]
project = args[args.index("--project-name") + 1]
if "up" in args:
    (root / "project").write_text(project)
if "down" in args:
    assert args[-2:] == ["--volumes", "--remove-orphans"]
    assert project == (root / "project").read_text()
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    if {fail_down!r}:
        sys.exit(2)
    print("down ready", flush=True)
    deadline = monotonic() + 30
    while not (root / "release").exists():
        assert monotonic() < deadline
        sleep(0.05)
    (root / "down-completed").write_text(project)
""")
        (bin_dir / "bun").write_text("#!/bin/sh\nexit 0\n")
        for executable in bin_dir.iterdir():
            executable.chmod(0o755)
        self.checker.write_text(f"""import os
import signal
import subprocess

def stopped(_signum, _frame):
    os.write(1, b"checker got TERM\\n")
    os._exit(143)

signal.signal(signal.SIGTERM, stopped)
raise SystemExit(subprocess.run(["bash", {str(FIXTURE)!r}]).returncode)
""")
        env = {key: value for key, value in os.environ.items() if not key.startswith("QS_ROUNDCUBE_")}
        return dict(env, PATH=f"{bin_dir}:{env['PATH']}", TMPDIR=str(self.root),
                    ROUNDCUBE_FIXTURE_DOCKER_CONTEXT="default")

    def wait_for_line(self, process, expected):
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(TEST_TIMEOUT), f"Expected {expected}")
        self.assertEqual(process.stdout.readline().strip(), expected)

    def test_exact_checker_arguments_output_and_exit(self):
        for status, code in (("no_candidate", 0), ("review_required", 0), ("fixture_qualified", 0), ("failed", 1)):
            with self.subTest(status=status):
                line = '{"status": "' + status + '"}'
                self.checker.write_text(
                    "import sys\n"
                    "assert sys.argv[1:] == ['--qualification-config', "
                    "'/etc/quantself-roundcube-qualification/qualification.json']\n"
                    f"print({line!r})\n"
                    f"sys.exit({code})\n"
                )
                result = subprocess.run(self.command, capture_output=True, text=True, timeout=TEST_TIMEOUT)
                self.assertEqual(result.returncode, code)
                self.assertEqual(result.stdout, line + "\n")
                self.assertEqual(result.stderr, "")

    def test_waits_for_the_existing_shell_exit_trap_after_checker_stops(self):
        marker = self.root / "torn-down"
        body = """trap 'sleep 0.3; touch "$1"' EXIT
printf 'ready\\n'
sleep 60
"""
        self.checker.write_text(
            "import subprocess\n"
            f"subprocess.run(['bash', '-c', {body!r}, 'fixture', {str(marker)!r}], check=True)\n"
        )
        process = subprocess.Popen(self.command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.wait_for_line(process, "ready")
            process.terminate()
            self.assertEqual(process.wait(timeout=TEST_TIMEOUT), 143)
            self.assertTrue(marker.is_file(), "Supervisor returned before the Compose cleanup stand-in")
        finally:
            if process.poll() is None:
                process.terminate()
            process.communicate(timeout=30)

    def test_term_during_compose_down_preserves_the_running_project_teardown(self):
        env = self.fixture_env()
        release = self.root / "release"
        process = subprocess.Popen(self.command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.wait_for_line(process, "down ready")
            process.terminate()
            self.wait_for_line(process, "checker got TERM")
            self.assertIsNone(process.poll())
            release.touch()
            self.assertEqual(process.wait(timeout=TEST_TIMEOUT), 143)
            self.assertTrue((self.root / "down-completed").is_file(), "Compose down was interrupted")
            self.assertEqual((self.root / "down-completed").read_text(), (self.root / "project").read_text())
        finally:
            release.touch()
            if process.poll() is None:
                process.terminate()
            process.communicate(timeout=30)

    def test_failed_compose_down_reports_the_exact_project(self):
        env = self.fixture_env(fail_down=True)
        result = subprocess.run(self.command, env=env, text=True, capture_output=True, timeout=TEST_TIMEOUT)
        project = (self.root / "project").read_text()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"Roundcube fixture teardown failed for Compose project {project}.", result.stderr)


if __name__ == "__main__":
    unittest.main()
