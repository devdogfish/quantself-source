from contextlib import redirect_stdout
import io
import os
from pathlib import Path
import runpy
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch


rehearse = runpy.run_path(
    Path(__file__).with_name("roundcube-http-fixture") / "native-cutover.py"
)["rehearse"]


class NativeCutoverRecoveryTest(unittest.TestCase):
    def fail_at(self, should_fail):
        calls = []

        def execute(command, *, env, **kwargs):
            args = command[1:]
            upstream = env.get("QS_ROUNDCUBE_ACTIVE_UPSTREAM")
            calls.append((args, upstream))
            if should_fail(args, upstream):
                raise subprocess.CalledProcessError(1, command)
            return subprocess.CompletedProcess(command, 0, stdout="exited 0\n" if args[0] == "ps" else "")

        with TemporaryDirectory() as state, patch.dict(os.environ, {
            "QS_ROUNDCUBE_FIXTURE_NATIVE_PRIOR": "1.7.5",
            "QS_ROUNDCUBE_FIXTURE_NATIVE_CANDIDATE": "1.7.6",
            "QS_ROUNDCUBE_FIXTURE_STATE": state,
            "QS_ROUNDCUBE_ACTIVE_UPSTREAM": "roundcube",
        }), patch.object(subprocess, "run", side_effect=execute), \
                patch.dict(rehearse.__globals__, {"sleep": lambda _: None}), redirect_stdout(io.StringIO()):
            with self.assertRaises(subprocess.CalledProcessError):
                rehearse(["compose"])
        return calls

    def test_failed_promotion_may_have_exposed_candidate_and_never_restores_prior(self):
        calls = self.fail_at(lambda args, upstream: args[-1] == "edge" and upstream == "roundcube-candidate")
        self.assertEqual([upstream for args, upstream in calls if args[-1] == "edge"],
                         ["freeze", "roundcube-candidate", "freeze"])
        self.assertFalse(any(args[0] == "up" and args[-1] == "roundcube" for args, _ in calls))
        self.assertIn((["stop", "--timeout", "5", "roundcube-candidate"], "roundcube"), calls)

    def test_failure_before_promotion_recovers_prior_runtime(self):
        calls = self.fail_at(lambda args, _: args[-1] == "candidate-only-schema")
        self.assertEqual([upstream for args, upstream in calls if args[-1] == "edge"], ["freeze", "roundcube"])
        self.assertTrue(any(args[0] == "up" and args[-1] == "roundcube" for args, _ in calls))
        self.assertTrue(any(args[-2:] == ["roundcube-snapshot", "prior"] for args, _ in calls))


if __name__ == "__main__":
    unittest.main()
