"""Synthetic coordinator results and Healthchecks responses only."""
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location("backup_monitor", Path(__file__).with_name("backup_monitor.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
ROOT = Path("/synthetic-backup")
RUN_ID = "20261114T030000Z-0123456789ab"
URL = "https://hc-ping.com/01234567-89ab-4def-8abc-0123456789ab"


def pair():
    manifest = {"restore_id": RUN_ID, "format": 1, "completed_at": "2026-11-14T03:15:00+00:00",
                "pbs": {}, "offsite": {}}
    for index, (role, vmid) in enumerate(backup.ROLES.items()):
        manifest["pbs"][role] = {"volid": f"backup:backup/vm/{vmid}/2026-11-14T03:00:00Z",
                                 "encryption_fingerprint": ("ab:" * 31) + "ab"}
        manifest["offsite"][role] = {"snapshot": "a" * 64,
                                    "repository": str(index) * 64,
                                    "manifest": {"role": role, "restore_id": RUN_ID}}
    return manifest


def completed(code=0):
    return subprocess.CompletedProcess([], code, json.dumps({"status": "complete", "restore_id": RUN_ID}).encode())


class MonitorTest(unittest.TestCase):
    def setUp(self):
        self.report = Mock()
        self.state = {}
        self.read = lambda path, optional=False: self.state.get(path.relative_to(ROOT).as_posix())
        blocked = patch.object(backup, "build_opener", side_effect=AssertionError("No network allowed"))
        blocked.start()
        self.addCleanup(blocked.stop)

    def finish(self, value):
        self.state.pop("active.json", None)
        self.state["last-success.json"] = value
        self.state[f"runs/{RUN_ID}/complete.json"] = value
        return completed()

    def monitor(self, run):
        return backup.monitor(ROOT, run=run, report=self.report, read=self.read, pause=lambda _: None)

    def test_pending_recovers_same_run_then_reports_verified_success(self):
        calls = []

        def run(action, observation, timeout):
            calls.append(action)
            self.assertLessEqual(observation, 120)
            self.assertLessEqual(timeout, 300)
            if action == "run":
                self.state["active.json"] = {"restore_id": RUN_ID}
                return completed(75)
            self.report.assert_not_called()
            return self.finish(pair())

        self.assertEqual(self.monitor(run), 0)
        self.assertEqual(calls, ["run", "recover"])
        self.report.assert_called_once_with(True)

    def test_partial_or_stale_evidence_cannot_report_success(self):
        partial = pair()
        partial["offsite"].pop("files")
        with self.assertRaises(backup.MonitorError):
            self.monitor(lambda *_: self.finish(partial))
        self.report.assert_called_once_with(False)

        self.report.reset_mock()
        with self.assertRaises(backup.MonitorError):
            self.monitor(lambda *_: self.finish(pair()))
        self.report.assert_called_once_with(False)

    def test_terminal_failure_reports_once(self):
        self.assertEqual(self.monitor(lambda *_: completed(1)), 1)
        self.report.assert_called_once_with(False)

    def test_shared_repository_id_cannot_report_success(self):
        manifest = pair()
        manifest["offsite"]["files"]["repository"] = manifest["offsite"]["quantself"]["repository"]
        with self.assertRaises(backup.MonitorError):
            self.monitor(lambda *_: self.finish(manifest))
        self.report.assert_called_once_with(False)

    def test_observer_timeout_or_killed_child_sends_no_ping(self):
        for outcome in (-15, subprocess.TimeoutExpired(["coordinator"], 1)):
            def run(*_):
                if isinstance(outcome, Exception):
                    raise outcome
                return completed(outcome)

            with self.subTest(outcome=outcome):
                self.assertEqual(self.monitor(run), 75)
                self.report.assert_not_called()

    def test_pending_budget_expires_without_heartbeat(self):
        now = [0]
        self.state["active.json"] = {"restore_id": RUN_ID}
        run = Mock(return_value=completed(75))

        def pause(seconds):
            now[0] += seconds

        self.assertEqual(backup.monitor(ROOT, run=run, report=self.report, read=self.read,
                                        clock=lambda: now[0], pause=pause, max_seconds=20), 75)
        self.assertEqual([call.args[0] for call in run.call_args_list], ["recover", "recover"])
        self.report.assert_not_called()

    def test_healthchecks_validates_body_and_hides_token_on_rejection(self):
        class Reply(io.BytesIO):
            status = 200

        opener = Mock()
        with patch.object(backup, "build_opener", return_value=opener):
            opener.open.return_value = Reply(b"OK")
            backup.ping(URL, False)
            request = opener.open.call_args.args[0]
            self.assertEqual(request.get_full_url(), URL + "/fail")
            self.assertEqual(request.get_method(), "POST")
            opener.open.return_value = Reply(b"not found")
            with self.assertRaises(backup.MonitorError) as error:
                backup.ping(URL, True)
            self.assertNotIn(URL, str(error.exception))
            opener.open.side_effect = HTTPError(URL, 302, URL, {}, None)
            with self.assertRaises(backup.MonitorError) as error:
                backup.ping(URL, True)
            self.assertNotIn(URL, str(error.exception))

    def test_healthchecks_file_rejects_suffixes_and_wrong_hosts(self):
        for url in (URL + "/fail", URL + "?key=secret", URL.replace("hc-ping.com", "evil.invalid")):
            with patch.object(backup, "private_read", return_value=url.encode()):
                with self.assertRaises(backup.MonitorError) as error:
                    backup.healthcheck_url()
                self.assertNotIn(url, str(error.exception))
        with patch.object(backup, "private_read", return_value=(URL + "\n").encode()):
            self.assertEqual(backup.healthcheck_url(), URL)

    def test_growth_reports_aggregate_and_leaves_backup_result_independent(self):
        def collect(vmid):
            return {"format": 1, "prefix_role": "vault" if vmid == 2540 else "quantself",
                    "sample_start": "2026-11-14T03:00:00+00:00", "sample_end": "2026-11-14T03:01:00+00:00",
                    "retained_bytes": 40, "retained_versions": 2, "unfinished_bytes": 10, "unfinished_uploads": 1,
                    "unexpected": "discarded"}

        sample = backup.growth_sample(RUN_ID, 100, collect=collect)
        self.assertEqual(sample["total_bytes"], 100)
        self.assertTrue(sample["at_or_over_target"])
        self.assertNotIn("discarded", json.dumps(sample))
        with patch.object(backup, "healthcheck_url", return_value=URL):
            report = Mock()
            backup.report_growth(RUN_ID, sample=lambda *_: sample, report=report)
            report.assert_called_once_with(URL, False)

    def test_incomplete_growth_does_not_emit_threshold_signal(self):
        def incomplete(*_):
            raise subprocess.TimeoutExpired(["qm"], 1)

        with patch.object(backup, "healthcheck_url", return_value=URL):
            backup.report_growth(RUN_ID, sample=incomplete, report=self.report)
        self.report.assert_not_called()


class RetentionMonitorTest(unittest.TestCase):
    def test_retention_policy_disabled_skips_cleanup(self):
        with patch("backup_retention.automatic_enabled", return_value=False), \
             patch("backup_retention.retain") as retain:
            backup.report_retention(RUN_ID)
        retain.assert_not_called()

    def test_growth_finishes_before_optional_cleanup_and_cleanup_error_is_separate(self):
        with patch("backup_retention.automatic_enabled", return_value=True), \
             patch.object(backup, "report_growth") as growth, \
             patch("sys.stderr", new_callable=io.StringIO) as errors:
            def failed_cleanup(*args, **kwargs):
                growth.assert_called_once_with(RUN_ID, backup_url=URL)
                raise OSError("fixture")

            with patch("backup_retention.retain", side_effect=failed_cleanup) as retain:
                backup.after_verified_pair(RUN_ID, URL)
        retain.assert_called_once_with(backup.STATE, automatic=True, expected_latest=RUN_ID)
        self.assertIn("backup pair remains verified", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
