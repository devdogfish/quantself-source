from contextlib import redirect_stdout
from datetime import datetime, timedelta
import hashlib
from io import StringIO
import json
from pathlib import Path
import re
from time import monotonic
import subprocess
import sys
import unittest
from unittest.mock import patch

import atlas_keep_receipt_handoff as handoff
import atlas_postgres_restore_drill as drill
import atlas_postgres_restore_point as producer
import backup_pair_proof as proof
from backup_guest import BackupError, Busy, locked, write_json
from backup_monitor import state_file
import test_atlas_postgres_restore_drill as fixtures


@unittest.skipUnless(handoff.os.geteuid() == 0, "Private handoff fixture requires root")
class KeepReceiptHandoffTest(unittest.TestCase):
    def setUp(self):
        self.atlas = fixtures.AtlasRestoreTest("test_entrypoint_previews_and_runs_the_single_verified_clone")
        self.addCleanup(self.atlas.doCleanups)
        self.atlas.setUp()
        self.keep = self.atlas.root / "keep"
        self.keep.mkdir(mode=0o700)
        lock = self.keep / "coordinator.lock"
        lock.touch(mode=0o600)
        self.pair = state_file(self.atlas.complete)
        self.invocation = "a" * 32
        self.exit_code = 0
        self.logged = f"Verified Keep backup {self.atlas.restore_id}."
        self.reader_calls = []
        self.steps = []
        self.scratch = []
        self.after_image = None
        self.tamper_envelope = None
        self.keyfile = self.atlas.root / "reader.key"
        self.password = self.atlas.root / "reader.password"
        for path in (self.keyfile, self.password):
            write_json(path, {"synthetic": True})
        self.raw = self.publish(self.pair)
        self.enterContext(patch.object(handoff, "STATE", self.keep))
        self.enterContext(patch.object(proof, "command", side_effect=self.systemd))
        self.enterContext(patch.object(producer, "pbs_read", side_effect=self.pbs))
        self.enterContext(patch.object(producer, "GIB", 1))
        self.enterContext(patch.object(handoff, "read_receipt_frame", side_effect=self.ssh_frame))
        self.enterContext(patch.object(handoff.subprocess, "run", side_effect=self.subprocess))

    def publish(self, pair):
        run = self.keep / "runs" / pair["restore_id"]
        run.mkdir(parents=True, exist_ok=True)
        raw = (json.dumps(pair, indent=2) + "\n").encode()
        path = run / "complete.json"
        path.write_bytes(raw)
        path.chmod(0o600)
        write_json(self.keep / "last-success.json", pair)
        return raw

    def systemd(self, *args, timeout):
        if args[0] == "systemctl":
            self.assertEqual(args[-1], proof.BACKUP)
            return (f"Id={proof.BACKUP}\nInvocationID={self.invocation}\nActiveState=inactive\n"
                    f"Result=success\nExecMainCode=1\nExecMainStatus={self.exit_code}\n")
        self.assertEqual(args[0], "journalctl")
        self.assertIn(f"_SYSTEMD_INVOCATION_ID={self.invocation}", args)
        if args[-3] != f"--grep=^{re.escape(self.logged)}$":
            return ""
        completed = datetime.fromisoformat(state_file(self.keep / "last-success.json")["completed_at"])
        return json.dumps({"MESSAGE": self.logged, "_SYSTEMD_UNIT": proof.BACKUP,
                           "_SYSTEMD_INVOCATION_ID": self.invocation,
                           "__REALTIME_TIMESTAMP": str(int(completed.timestamp() * 1_000_000))})

    def pbs(self, repository, namespace, keyfile, env, snapshot, archive, consume):
        self.assertEqual(snapshot, f"vm/2541/{self.atlas.archive_time}")
        self.reader_calls.append(archive)
        if archive == producer.SYSTEM_IMAGE:
            if self.after_image:
                self.after_image()
            return consume([self.atlas.raw])
        manifest = {"backup-type": "vm", "backup-id": "2541",
                    "backup-time": int(datetime.fromisoformat(self.atlas.archive_time).timestamp()),
                    "signature": "a" * 64, "unprotected": {"key-fingerprint": self.atlas.fingerprint},
                    "files": [{"filename": producer.SYSTEM_IMAGE, "crypt-mode": "encrypt", "size": 52,
                               "csum": "b" * 64}]}
        return consume([json.dumps(manifest).encode()])

    def ssh_frame(self, args):
        self.assertEqual(args[0], "/usr/bin/ssh")
        output = StringIO()
        self.steps.append("fetch")
        for option in ("BatchMode=yes", "IdentityAgent=none", "PreferredAuthentications=publickey",
                       "StrictHostKeyChecking=yes", "UpdateHostKeys=no", "GlobalKnownHostsFile=/dev/null"):
            self.assertIn(option, args)
        self.assertIn(f"UserKnownHostsFile={self.atlas.root / 'known_hosts'}", args)
        self.assertEqual(args[-3:], ["--", "atlas-receipt@keep.fixture.invalid", handoff.EXPORT_COMMAND])
        self.atlas.host_node = "keep"
        try:
            with patch.object(sys, "argv", [handoff.__file__, "export"]), redirect_stdout(output):
                handoff.main()
        finally:
            self.atlas.host_node = "atlas"
        value = json.loads(output.getvalue())
        if self.tamper_envelope:
            value = value | self.tamper_envelope
        return json.dumps(value).encode()

    def subprocess(self, args, **kwargs):
        self.assertIs(kwargs["check"], False)
        output = StringIO()
        self.assertEqual(args[:2], [sys.executable, "-B"])
        helper = Path(args[2]).name
        self.steps.append(helper)
        option = "--complete" if helper == "atlas_postgres_restore_point.py" else "--point"
        path = Path(args[args.index(option) + 1])
        self.scratch.append(path.parent)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(args[args.index("--complete-sha256") + 1], hashlib.sha256(self.raw).hexdigest())
        self.assertNotIn("--apply", args)
        if option == "--complete":
            self.assertEqual(path.read_bytes(), self.raw)
        action = producer.main if option == "--complete" else drill.main
        with patch.object(sys, "argv", args[2:]), redirect_stdout(output):
            action()
        return subprocess.CompletedProcess(args, 0, output.getvalue().encode())

    def invoke(self):
        argv = [handoff.__file__, "preview", "--keep-host", "keep.fixture.invalid", "--keep-known-hosts",
                str(self.atlas.root / "known_hosts"), "--keep-identity-file", str(self.atlas.root / "ssh.key"),
                "--policy", str(self.atlas.policy_path), "--policy-sha256", self.atlas.policy_sha,
                "--keyfile", str(self.keyfile), "--password-file", str(self.password)]
        output = StringIO()
        with patch.object(sys, "argv", argv), redirect_stdout(output):
            handoff.main()
        return json.loads(output.getvalue())

    def advance_keep(self):
        next_pair = json.loads(json.dumps(self.pair))
        started = self.atlas.now - timedelta(minutes=1)
        archived = started + timedelta(seconds=1)
        next_pair["restore_id"] = started.strftime("%Y%m%dT%H%M%SZ") + "-fedcbafedcba"
        for role in ("quantself", "files"):
            next_pair["offsite"][role]["manifest"]["restore_id"] = next_pair["restore_id"]
            group = next_pair["pbs"][role]["volid"].rsplit("/", 1)[0]
            next_pair["pbs"][role]["volid"] = group + "/" + archived.strftime("%Y-%m-%dT%H:%M:%SZ")
        self.publish(next_pair)
        self.invocation = "b" * 32
        self.logged = f"Verified Keep backup {next_pair['restore_id']}."

    def test_exact_receipt_through_producer_and_atlas_preview(self):
        write_json(self.keep / "postgres-restore-active.json", {"phase": "restore_requested"})
        self.assertEqual(self.invoke(), {"status": "preview", "restore_id": self.atlas.restore_id, "vmid": 901})
        self.assertEqual(self.steps, ["fetch", "atlas_postgres_restore_point.py",
                                      "fetch", "atlas_postgres_restore_drill.py"])
        self.assertEqual(self.reader_calls, ["index.json", producer.SYSTEM_IMAGE, "index.json"])
        self.assertEqual(self.atlas.events, [])
        self.assertTrue(all(not path.exists() for path in self.scratch))

    def test_pending_failed_or_stale_backup_never_runs_producer(self):
        for status in (75, 1):
            self.exit_code = status
            with self.assertRaisesRegex(BackupError, "no settled exit-zero result"):
                self.invoke()
        self.exit_code = 0
        self.invocation = "b" * 32
        self.logged = "Verified Keep backup 20200101T000000Z-000000000000."
        with self.assertRaisesRegex(BackupError, "no unique success marker"):
            self.invoke()
        self.assertEqual(self.steps, ["fetch"] * 3)
        self.assertEqual(self.reader_calls, [])

    def test_new_backup_during_image_read_stops_before_admission(self):
        self.after_image = self.advance_keep
        with self.assertRaisesRegex(BackupError, "selected a different receipt"):
            self.invoke()
        self.assertEqual(self.steps, ["fetch", "atlas_postgres_restore_point.py", "fetch"])
        self.assertEqual(self.atlas.events, [])
        self.assertTrue(all(not path.exists() for path in self.scratch))

    def test_changed_or_unresolved_receipt_is_not_exported(self):
        with locked(self.keep / "coordinator.lock"):
            with self.assertRaisesRegex(Busy, "coordinator is busy"):
                self.invoke()
        write_json(self.keep / "active.json", {})
        with self.assertRaisesRegex(BackupError, "retention is unresolved"):
            self.invoke()
        (self.keep / "active.json").unlink()
        write_json(self.keep / "runs" / self.atlas.restore_id / "complete.json", self.pair | {"extra": True})
        with self.assertRaisesRegex(BackupError, "differs from the durable complete receipt"):
            self.invoke()
        self.assertEqual(self.reader_calls, [])

    def test_tampered_envelope_and_failed_reader_use_no_previous_point(self):
        self.tamper_envelope = {"complete_sha256": "e" * 64}
        with self.assertRaisesRegex(BackupError, "bytes differ from the exported SHA-256"):
            self.invoke()
        self.tamper_envelope = None
        with (patch.object(producer, "pbs_read", side_effect=BackupError("synthetic reader refused")),
              self.assertRaisesRegex(BackupError, "synthetic reader refused")):
            self.invoke()
        self.assertEqual(self.steps, ["fetch", "fetch", "atlas_postgres_restore_point.py"])
        self.assertEqual(self.atlas.events, [])
        self.assertTrue(all(not path.exists() for path in self.scratch))


class ReceiptFrameTest(unittest.TestCase):
    def test_oversize_kills_child_before_eof(self):
        command = [sys.executable, "-c", "import os, time; os.write(1, b'x' * 129); time.sleep(4)"]
        started = monotonic()
        with (patch.object(handoff, "FRAME_LIMIT", 128),
              patch.object(handoff.subprocess, "Popen", wraps=subprocess.Popen) as spawn,
              self.assertRaisesRegex(BackupError, "exceeds its size limit")):
            handoff.read_receipt_frame(command)
        self.assertLess(monotonic() - started, 2)
        self.assertEqual(spawn.call_args.kwargs["stderr"], subprocess.DEVNULL)

    def test_absolute_deadline_applies_before_eof_even_with_progress(self):
        script = "import os, time\nfor i in range(100):\n os.write(1, b'x')\n time.sleep(0.04)"
        started = monotonic()
        with (patch.object(handoff, "FETCH_TIMEOUT", 0.2),
              self.assertRaisesRegex(BackupError, "fetch timed out")):
            handoff.read_receipt_frame([sys.executable, "-c", script])
        self.assertLess(monotonic() - started, 2)

    def test_deadline_also_bounds_wait_after_eof(self):
        command = [sys.executable, "-c", "import os, time; os.close(1); time.sleep(4)"]
        with (patch.object(handoff, "FETCH_TIMEOUT", 0.2),
              self.assertRaisesRegex(BackupError, "fetch timed out")):
            handoff.read_receipt_frame(command)

    def test_exact_cap_requires_exit_zero(self):
        with patch.object(handoff, "FRAME_LIMIT", 128):
            output = handoff.read_receipt_frame([sys.executable, "-c", "import os; os.write(1, b'x' * 128)"])
            self.assertEqual(output, b"x" * 128)
            with self.assertRaisesRegex(BackupError, "Unable to fetch the current Keep receipt"):
                handoff.read_receipt_frame([sys.executable, "-c",
                                            "import os, sys; os.write(1, b'x' * 128); sys.exit(1)"])
