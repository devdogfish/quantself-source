"""Exercise the real capture commands with loopback HTTP and CLI/journal doubles."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
from threading import Thread
import time
import unittest


ROOT = Path(__file__).resolve().parents[3]
DOC = ROOT / "docs/home-production-timing.md"
SUMMARY = Path(__file__).with_name("summarize-live-timing.py")
LANES = ("web", "api", "deny")
SOURCE = "a" * 40
IMAGE = "sha256:" + "c" * 64
BOOT_ID = "fb49316d-0615-4c9e-8a1f-015a05ce2f3a"
INVOCATION_ID = "c2df028454dc404482989e297c908301"


class TimingCaptureIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.failed = False
        fixture = self

        class HTTP(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                status = 502 if self.path == "/favicon.ico" and fixture.failed else 200
                self.send_response(status)
                self.end_headers()
                if self.path == "/api/health":
                    self.wfile.write(b'{"service":"quantself-api","status":"ok"}')

            def do_POST(self):
                self.send_response(404)
                self.end_headers()

        server = self.enterContext(ThreadingHTTPServer(("127.0.0.1", 0), HTTP))
        Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        self.env = os.environ | {
            "evidence": str(self.root), "keep": "fixture-keep",
            "ORIGIN": f"http://127.0.0.1:{server.server_port}",
            "FIXTURE_BOOT_ID": BOOT_ID,
            "PATH": str(self.root) + os.pathsep + os.environ["PATH"],
        }
        blocks = re.findall(r"\x60{3}bash\n(.*?)\x60{3}", DOC.read_text(), re.S)
        probe, = (block for block in blocks if "probe() {" in block)
        self.observer, = (block for block in blocks if "--after-cursor=" in block)
        self.command, = (block for block in blocks if 'execvp("bun"' in block)
        (self.root / "probe.sh").write_text(probe)
        self.write_doubles()

    def write_doubles(self):
        cli = self.root / "fake-cli.ts"
        cli.write_text(r"""
import { runProd } from "OPS_IMPORT";
const source = "a".repeat(40), control = "b".repeat(40);
const scenario = process.env.FIXTURE_SCENARIO;
const success = ["42", scenario === "rerun" ? "2" : "1", "1459341623", control, "workflow_dispatch", "main",
  "Promote Quantself " + source, "completed", "success"].join("\t");
const expected = [
  ["git branch --show-current", "main"], ["git status --porcelain", ""],
  ["git rev-parse HEAD", source], ["gh --version", ""], ["gh auth status", ""],
  ["git/ref/heads/main", source], ["/dispatches", scenario === "ambiguous" ? "42\n43" : "42"], ["--attempt 1", ""],
  ["/attempts/1 --jq", success], ["/attempts/1/jobs", "success"], ["curl", ""],
  ["curl", ""], ["curl", ""], ["ssh -t", ""],
];
await runProd({
  env: {
    QUANTSELF_DEPLOY_CONTROL_REPO: "devdogfish/quantself-atlas-control", QUANTSELF_ATLAS_RELAY_AUTO: "1",
    QUANTSELF_ATLAS_RELAY_CONTROL_SHA: control, QUANTSELF_ATLAS_RELAY_SSH_TARGET: "fake-relay",
    QUANTSELF_SSH_TARGET: "fake-keep", QUANTSELF_DEPLOY_PATH: "/fixture",
    QUANTSELF_PRODUCTION_URL: "https://qs.girke.dev",
  },
  runner: {
    interrupt() {},
    async run(command) {
      const next = expected.shift();
      if (!next || !command.join(" ").includes(next[0])) throw Error("Unhandled offline command: " + command.join(" "));
      if (next[0] === "--attempt 1") {
        const start = Number(await Bun.file(process.env.evidence + "/command-us").text());
        const phases = ["provision_started", "admitted", "runner_issued", "launcher_acknowledged", "assignment_observed"];
        for (const [index, phase] of phases.entries()) {
          const worker = phase === "launcher_acknowledged"
            ? { launch_id: "d".repeat(32), worker_mode: "--worker-template", selection_ms: 80 } : {};
          console.error("Atlas relay timing: " + JSON.stringify({
            phase, run_id: "42", attempt: "1", monotonic_us: start + index + 1, ...worker,
          }));
        }
      }
      if (next[0] === "/attempts/1 --jq") {
        while (!(await Bun.file(process.env.evidence + "/allow-ack").exists())) await Bun.sleep(20);
      }
      return { exitCode: 0, stdout: next[1], stderr: "" };
    },
  },
});
if (expected.length) throw Error("Offline CLI skipped steps");
""".replace("OPS_IMPORT", str(ROOT / "scripts/ops.ts")))
        bun = self.root / "bun"
        bun.write_text(
            '#!/bin/sh\n[ "$*" = "run prod" ] || exit 2\nexec '
            + shlex.quote(shutil.which("bun")) + " " + shlex.quote(str(cli)) + "\n"
        )
        bun.chmod(0o700)
        ssh = self.root / "ssh"
        ssh.write_text(f"#!{sys.executable}\n" + r"""
import os, sys, time
from pathlib import Path
root = Path(os.environ["evidence"])
assert sys.argv[1:3] == ["-T", "fixture-keep"]
command = sys.argv[3]
cursor = "s=30e7c17dfa6e4a6ca3effe3df25837ce;i=1a;b=fb49316d06154c9e8a1f015a05ce2f3a;m=2fb;t=649c1a10eaa10;x=4878b1bf945ea19f"
if "boot_id" in command:
    print(os.environ["FIXTURE_BOOT_ID"])
elif "--after-cursor=" not in command:
    assert "__CURSOR" in command
    print(cursor)
else:
    assert "--after-cursor='" + cursor + "'" in command
    for event in ("switch-record", "receipt-record"):
        path = root / event
        while not path.exists():
            time.sleep(.01)
        print(path.read_text(), flush=True)
    while True:
        time.sleep(1)
""")
        ssh.chmod(0o700)

    def process(self, script, output=None, stderr=None):
        process = subprocess.Popen(
            ["bash", "-c", script], env=self.env, stdout=output, stderr=stderr, start_new_session=True,
        )

        def cleanup():
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)

        self.addCleanup(cleanup)
        return process

    def wait_for(self, predicate):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.02)
        self.fail("Offline timing fixture did not capture the expected evidence")

    def record(self, filename, message, stamp):
        data = {
            "MESSAGE": message, "_SYSTEMD_UNIT": "quantself-atlas-deploy@fixture.service",
            "_SYSTEMD_INVOCATION_ID": INVOCATION_ID, "_BOOT_ID": BOOT_ID.replace("-", ""),
            "__MONOTONIC_TIMESTAMP": str(stamp),
        }
        pending = self.root / (filename + ".tmp")
        pending.write_text(json.dumps(data))
        pending.rename(self.root / filename)

    def capture(self, *, fail_probe):
        self.process(self.observer, subprocess.DEVNULL)
        for lane in LANES:
            self.process(f'bash "$evidence/probe.sh" {lane} > "$evidence/{lane}.tsv"', subprocess.DEVNULL)

        def lines(name):
            path = self.root / name
            return path.read_text().splitlines() if path.exists() else []

        self.wait_for(lambda: all(lines(lane + ".tsv") for lane in LANES))
        cli = self.process(self.command, subprocess.DEVNULL)
        self.wait_for(lambda: lines("command-us"))
        self.failed = fail_probe
        self.record("switch-record", "Keep ingress switched to blue.", 1000)
        self.wait_for(lambda: len(lines("confirm.tsv")) == 3)
        self.failed = False
        self.record("receipt-record", f"Atlas promotion receipt 1459341623 42 1 {SOURCE} {IMAGE}", 2000)
        self.wait_for(lambda: lines("receipt.tsv"))
        (self.root / "allow-ack").touch()
        self.assertEqual(cli.wait(timeout=5), 0)
        handoff = int((self.root / "handoff-observed-us").read_text())

        def after_handoff(lane):
            return sum(int(row.split("\t")[1]) >= handoff for row in lines(lane + ".tsv"))

        self.wait_for(lambda: all(after_handoff(lane) >= 5 for lane in LANES))
        (self.root / "relay-worker.jsonl").write_text("\n".join(json.dumps({
            "MESSAGE": f"Atlas relay worker timing: {'d' * 32} --worker-template {state}",
            "_SYSTEMD_UNIT": "quantself-atlas-control-jit.service",
            "_SYSTEMD_INVOCATION_ID": "e" * 32, "_BOOT_ID": "f" * 32,
            "__MONOTONIC_TIMESTAMP": str(stamp),
        }) for state, stamp in (("started", 9000000), ("finished", 9360000))))
        result = subprocess.run(
            [sys.executable, "-B", SUMMARY, self.root], check=False, text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, int(fail_probe), result.stderr)
        sample = json.loads(result.stdout)
        self.assertEqual(sample["release"]["image_id"], IMAGE)
        self.assertEqual(sample["release"]["attempt"], "1")
        self.assertEqual(sample["switch_invocation"], INVOCATION_ID)
        self.assertEqual(sample["relay"]["runner_preparation"]["materialization_ms"], 360)
        self.assertEqual(sample["relay"]["assignment_observed_since_command_ms"], .005)
        return sample

    def test_exact_attempt_capture_reaches_summary(self):
        sample = self.capture(fail_probe=False)
        self.assertGreater(sample["command_to_confirmed_live_upper_bound_ms"], 0)
        self.assertEqual(sample["confirmation_failures"], 0)

    def test_loopback_outage_remains_failed_after_recovery(self):
        sample = self.capture(fail_probe=True)
        self.assertIsNone(sample["command_to_confirmed_live_upper_bound_ms"])
        self.assertEqual(sample["confirmation_failures"], 1)

    def assert_no_attempt_evidence(self, scenario, error):
        self.env["FIXTURE_SCENARIO"] = scenario
        (self.root / "allow-ack").touch()
        with tempfile.TemporaryFile(mode="w+") as output:
            cli = self.process(self.command, output)
            self.assertNotEqual(cli.wait(timeout=5), 0)
            output.seek(0)
            self.assertIn(error, output.read())
        self.assertTrue((self.root / "command-us").exists())
        self.assertFalse((self.root / "attempt.json").exists())
        self.assertFalse((self.root / "handoff-observed-us").exists())

    def test_rerun_cannot_produce_attempt_one_evidence(self):
        self.assert_no_attempt_evidence("rerun", "attempt identity changed")

    def test_ambiguous_dispatch_cannot_produce_attempt_evidence(self):
        self.assert_no_attempt_evidence("ambiguous", "dispatch returned no valid run ID")
