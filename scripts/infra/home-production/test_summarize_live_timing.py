import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("summarize-live-timing.py")
SUMMARIZE = runpy.run_path(SCRIPT)["summarize"]
KERNEL_BOOT_ID = "fb49316d-0615-4c9e-8a1f-015a05ce2f3a"
JOURNAL_BOOT_ID = "fb49316d06154c9e8a1f015a05ce2f3a"
INVOCATION_ID = "c2df028454dc404482989e297c908301"
OTHER_BOOT_ID = "30e7c17dfa6e4a6ca3effe3df25837ce"


class SummarizeLiveTimingTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.marker = {"slot": "blue", "invocation": INVOCATION_ID, "boot": JOURNAL_BOOT_ID, "keep_us": "2000"}
        self.attempt = {"repo_id": "1459341623", "run_id": "42", "attempt": "1", "source_sha": "a" * 40}
        self.receipt = self.attempt | {
            "image_id": "sha256:" + "b" * 64, "invocation": INVOCATION_ID, "boot": JOURNAL_BOOT_ID,
            "keep_us": "3000",
        }
        self.write("boot-id", f"{KERNEL_BOOT_ID}\n")
        self.write("command-us", "1000000\n")
        self.write("push-us", "800000\n")
        self.write("handoff-observed-us", "2400000\n")
        self.write("switch.tsv", f"1700000\t{json.dumps(self.marker)}\n")
        self.write("receipt.tsv", f"2300000\t{json.dumps(self.receipt)}\n")
        self.write("attempt.json", json.dumps(self.attempt))
        self.status = {"web": 200, "api": 200, "deny": 404}
        self.write("confirm.tsv", "".join(
            self.row(lane, 1700000 + index * 10000) for index, lane in enumerate(self.status)
        ))
        for lane in self.status:
            self.write(f"{lane}.tsv", "".join(self.row(lane, time) for time in range(750000, 3650000, 250000)))

    def row(self, lane, start, *, status=None, rc=0, verdict="ok"):
        return f"{lane}\t{start}\t{start + 5000}\t{rc}\t{self.status[lane] if status is None else status}\t{verdict}\n"

    def write(self, name, value):
        (self.root / name).write_text(value)

    def test_reports_exact_mac_intervals_and_probe_gaps(self):
        result = SUMMARIZE(self.root)
        self.assertEqual(result["command_to_marker_receipt_ms"], 700)
        self.assertEqual(result["command_to_confirmed_live_upper_bound_ms"], 725)
        self.assertEqual(result["push_to_confirmed_live_upper_bound_ms"], 925)
        self.assertEqual(result["monitor_lanes"]["api"]["max_start_gap_us"], 250000)
        self.assertEqual(result["monitor_lanes"]["deny"]["failures"], 0)
        self.assertEqual(result["release"]["image_id"], self.receipt["image_id"])

    def test_preserves_probe_failures_and_rejects_failed_confirmation(self):
        with (self.root / "api.tsv").open("a") as logfile:
            logfile.write(self.row("api", 3750000, status=0, rc=28, verdict="fail"))
        self.write("confirm.tsv", "".join([
            self.row("web", 1700000),
            self.row("api", 1710000),
            self.row("deny", 1720000, status=401),
        ]))
        run = subprocess.run(
            [sys.executable, "-B", SCRIPT, self.root], capture_output=True, text=True, check=False,
        )
        self.assertEqual(run.returncode, 1)
        result = json.loads(run.stdout)
        self.assertIsNone(result["command_to_confirmed_live_upper_bound_ms"])
        self.assertEqual(result["confirmation_failures"], 1)
        self.assertEqual(result["monitor_lanes"]["api"]["failures"], 1)

    def test_rejects_duplicate_marker_pre_switch_probe_and_missing_post_handoff_coverage(self):
        marker = (self.root / "switch.tsv").read_text()
        self.write("switch.tsv", marker * 2)
        with self.assertRaises(ValueError):
            SUMMARIZE(self.root)
        self.write("switch.tsv", marker)
        self.write("confirm.tsv", "".join(self.row(lane, 1699999) for lane in self.status))
        with self.assertRaisesRegex(ValueError, "Confirmation started before"):
            SUMMARIZE(self.root)
        self.write("confirm.tsv", "".join(self.row(lane, 1700000) for lane in self.status))
        self.write("web.tsv", self.row("web", 750000))
        with self.assertRaisesRegex(ValueError, "Incomplete or out-of-order monitor coverage for web"):
            SUMMARIZE(self.root)

    def test_rejects_receipt_drift_and_silent_gap_with_eventual_recovery(self):
        self.write("receipt.tsv", f"2300000\t{json.dumps(self.receipt | {'attempt': '2'})}\n")
        with self.assertRaisesRegex(ValueError, "do not identify the same switch"):
            SUMMARIZE(self.root)
        self.write("receipt.tsv", f"2300000\t{json.dumps(self.receipt)}\n")
        self.write("api.tsv", self.row("api", 750000) + "".join(
            self.row("api", time) for time in range(2500000, 3800000, 250000)
        ))
        with self.assertRaisesRegex(ValueError, "idle for more than one second in api"):
            SUMMARIZE(self.root)

    def test_rejects_switch_or_receipt_from_another_boot(self):
        self.write("switch.tsv", f"1700000\t{json.dumps(self.marker | {'boot': OTHER_BOOT_ID})}\n")
        with self.assertRaisesRegex(ValueError, "wrong identity"):
            SUMMARIZE(self.root)
        self.write("switch.tsv", f"1700000\t{json.dumps(self.marker)}\n")
        self.write("receipt.tsv", f"2300000\t{json.dumps(self.receipt | {'boot': OTHER_BOOT_ID})}\n")
        with self.assertRaisesRegex(ValueError, "do not identify the same switch"):
            SUMMARIZE(self.root)
        self.write("boot-id", "not-a-uuid\n")
        with self.assertRaisesRegex(ValueError, "Malformed journal boot ID"):
            SUMMARIZE(self.root)

    def test_checks_keep_order_and_mac_observations_on_separate_clocks(self):
        self.write("handoff-observed-us", "1600000\n")
        self.write("switch.tsv", f"1700000\t{json.dumps(self.marker | {'keep_us': '8000000000'})}\n")
        self.write("receipt.tsv", f"2300000\t{json.dumps(self.receipt | {'keep_us': '8000000001'})}\n")
        self.assertEqual(SUMMARIZE(self.root)["command_to_confirmed_live_upper_bound_ms"], 725)
        self.write("receipt.tsv", f"2300000\t{json.dumps(self.receipt | {'keep_us': '7999999999'})}\n")
        with self.assertRaisesRegex(ValueError, "do not identify the same switch"):
            SUMMARIZE(self.root)
        self.write("receipt.tsv", f"2300000\t{json.dumps(self.receipt | {'keep_us': 8000000001})}\n")
        with self.assertRaisesRegex(ValueError, "Malformed journal monotonic timestamp"):
            SUMMARIZE(self.root)

    def test_joins_exact_relay_phases_and_guest_invocation_without_mixing_clocks(self):
        launch_id = "d" * 32
        phases = ("provision_started", "admitted", "runner_issued", "launcher_acknowledged", "assignment_observed")
        events = [
            {"phase": phase, "run_id": "42", "attempt": "1", "monotonic_us": 1100000 + index * 150000}
            for index, phase in enumerate(phases)
        ]
        events[3].update(launch_id=launch_id, worker_mode="--worker-template", selection_ms=80)
        self.write("relay-timing.jsonl", "\n".join(map(json.dumps, events)))
        self.write("dispatch-observed.tsv", "1101000\tStarting the exact Atlas relay for production deploy run 42, attempt 1.\n")
        worker = [{
            "MESSAGE": f"Atlas relay worker timing: {launch_id} --worker-template {state}",
            "_SYSTEMD_UNIT": "quantself-atlas-control-jit.service",
            "_SYSTEMD_INVOCATION_ID": "e" * 32, "_BOOT_ID": OTHER_BOOT_ID,
            "__MONOTONIC_TIMESTAMP": str(stamp),
        } for state, stamp in (("started", 8000000000), ("finished", 8000360000))]
        self.write("relay-worker.jsonl", "\n".join(map(json.dumps, worker)))
        relay = SUMMARIZE(self.root)["relay"]
        self.assertEqual(relay["dispatch_observed_since_command_ms"], 101)
        self.assertEqual(relay["provision_started_since_command_ms"], 100)
        self.assertEqual(relay["assignment_observed_since_command_ms"], 700)
        self.assertEqual(relay["runner_preparation"], {
            "mode": "template", "selection_ms": 80, "materialization_ms": 360,
        })
        for key, wrong, error in (
            ("MESSAGE", worker[1]["MESSAGE"].replace(launch_id, "f" * 32), "do not match"),
            ("_SYSTEMD_INVOCATION_ID", "f" * 32, "do not belong"),
            ("_BOOT_ID", JOURNAL_BOOT_ID, "do not belong"),
        ):
            with self.subTest(key=key):
                self.write("relay-worker.jsonl", "\n".join(map(json.dumps, (worker[0], worker[1] | {key: wrong}))))
                with self.assertRaisesRegex(ValueError, error):
                    SUMMARIZE(self.root)
        events[-1]["attempt"] = "2"
        self.write("relay-timing.jsonl", "\n".join(map(json.dumps, events)))
        with self.assertRaisesRegex(ValueError, "do not identify the exact attempt"):
            SUMMARIZE(self.root)
