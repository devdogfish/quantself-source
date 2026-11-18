from contextlib import redirect_stdout
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
from pathlib import Path
from select import select
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import MagicMock, patch

import atlas_postgres_restore_point as point
from backup_guest import BackupError, write_json


POPEN = subprocess.Popen


@unittest.skipUnless(point.os.geteuid() == 0, "Private proof fixture requires root")
class RestorePointTest(unittest.TestCase):
    def setUp(self):
        root = Path(self.enterContext(TemporaryDirectory())).resolve()
        self.complete = root / "complete.json"
        self.policy = root / "atlas-policy.json"
        self.keyfile = root / "independent.key"
        self.password = root / "reader.password"
        self.atlas_complete = Path("/private/atlas/complete.json")
        for path in (self.keyfile, self.password):
            path.write_text("synthetic credential\n")
            path.chmod(0o600)
        self.tls_pin = ":".join(["12"] * 32)
        self.key_pin = ":".join(["ab"] * 32)
        self.disk = b"proof" + bytes(47)
        started = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(minutes=1)
        archived = started + timedelta(seconds=15)
        restore_id = started.strftime("%Y%m%dT%H%M%SZ") + "-123456abcdef"
        archive_time = archived.strftime("%Y-%m-%dT%H:%M:%SZ")
        self.snapshot = f"vm/2541/{archive_time}"
        pair = {"format": 1, "restore_id": restore_id, "completed_at": (archived + timedelta(seconds=1)).isoformat(),
                "pbs": {}, "offsite": {}}
        for role, vmid, char in (("quantself", 2541, "a"), ("files", 2540, "b")):
            pair["pbs"][role] = {"volid": f"backup:backup/vm/{vmid}/{archive_time}",
                                 "encryption_fingerprint": self.key_pin}
            pair["offsite"][role] = {"snapshot": char * 64, "repository": char * 64, "manifest": {
                "format": 1, "restore_id": restore_id, "role": role, "inventory_sha256": char * 64,
            }}
        write_json(self.complete, pair)
        write_json(self.policy, {"system_disk_gib": 52, "pbs": {
            "server": "pbs.fixture.invalid", "port": 8008, "datastore": "main", "namespace": "keep",
            "username": "reader@pbs!fixture", "fingerprint": self.tls_pin,
        }})
        self.complete_sha = self.sha(self.complete)
        self.policy_sha = self.sha(self.policy)
        self.manifest = {"backup-type": "vm", "backup-id": "2541", "backup-time": int(archived.timestamp()),
                         "signature": "a" * 64, "unprotected": {"key-fingerprint": self.key_pin}, "files": [{
                             "filename": point.SYSTEM_IMAGE, "crypt-mode": "encrypt", "size": len(self.disk),
                             "csum": "b" * 64,
                         }]}
        self.archives = []
        self.enterContext(patch.object(point, "GIB", 1))
        self.enterContext(patch.object(point, "CHUNK_BYTES", 16))
        self.enterContext(patch.object(point, "select", side_effect=self.select_stdout))
        self.enterContext(patch.object(point.subprocess, "Popen", side_effect=self.spawn))
        self.image = self.disk
        self.image_exit = 0
        self.after = deepcopy(self.manifest)
        self.output = io.StringIO()

    def sha(self, path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def select_stdout(self, reads, writes, failures, timeout):
        if isinstance(reads[0], io.BytesIO):
            return reads, [], []
        return select(reads, writes, failures, timeout)

    def spawn(self, args, *, stdin, stdout, stderr, start_new_session, env, bufsize):
        archive = args[3]
        self.assertEqual(args, [point.CLIENT, "restore", self.snapshot, archive, "-", "--repository",
                                "reader@pbs!fixture@pbs.fixture.invalid:8008:main",
                                "--keyfile", str(self.keyfile), "--ns", "keep"])
        self.assertEqual((stdin, stdout, stderr), (subprocess.DEVNULL, subprocess.PIPE, subprocess.DEVNULL))
        self.assertTrue(start_new_session)
        self.assertEqual(bufsize, 0)
        self.assertEqual(env["PBS_FINGERPRINT"], self.tls_pin)
        self.assertEqual(env["PBS_PASSWORD_FILE"], str(self.password))
        self.assertEqual(env["SSL_CERT_FILE"], "/dev/null")
        self.assertEqual(env["SSL_CERT_DIR"], env["HOME"])
        self.assertTrue(Path(env["HOME"]).is_dir())
        self.assertNotIn("PBS_PASSWORD", env)
        if archive == "index.json":
            body = json.dumps(self.after if self.archives else self.manifest).encode()
            exit_code = 0
        elif archive == point.SYSTEM_IMAGE:
            body, exit_code = self.image, self.image_exit
        else:
            self.fail(f"Unexpected archive {archive}")
        self.archives.append(archive)
        process = MagicMock(stdout=io.BytesIO(body))
        process.__enter__.return_value = process
        process.wait.return_value = exit_code
        process.poll.return_value = exit_code
        return process

    def invoke(self):
        argv = ["atlas_postgres_restore_point.py", "--policy", str(self.policy), "--policy-sha256", self.policy_sha,
                "--complete", str(self.complete), "--complete-sha256", self.complete_sha,
                "--atlas-complete", str(self.atlas_complete), "--keyfile", str(self.keyfile),
                "--password-file", str(self.password)]
        with patch.object(sys, "argv", argv), redirect_stdout(self.output):
            point.main()
        return json.loads(self.output.getvalue())

    def test_verified_full_stream_produces_exact_drill_input(self):
        self.assertEqual(self.invoke(), {"complete": str(self.atlas_complete), "complete_sha256": self.complete_sha,
                                         "system_disk_gib": 52,
                                         "system_disk_sha256": hashlib.sha256(self.disk).hexdigest()})
        self.assertEqual(self.archives, ["index.json", point.SYSTEM_IMAGE, "index.json"])
        self.assertNotEqual(self.manifest["files"][0]["csum"], hashlib.sha256(self.disk).hexdigest())

    def test_untrusted_manifest_or_wrong_geometry_stops_before_image_read(self):
        for mutate in (
            lambda: self.manifest.update(signature=None),
            lambda: self.manifest.update({"backup-id": "2540"}),
            lambda: self.manifest["unprotected"].update({"key-fingerprint": self.tls_pin}),
            lambda: self.manifest["files"][0].update(size=51),
            lambda: self.manifest["files"][0].update({"crypt-mode": "sign-only"}),
        ):
            with self.subTest(case=mutate):
                self.manifest = deepcopy(self.after)
                self.archives.clear()
                mutate()
                with self.assertRaisesRegex(BackupError, "manifest differs|geometry or encryption differs"):
                    self.invoke()
                self.assertEqual(self.archives, ["index.json"])
                self.assertEqual(self.output.getvalue(), "")

    def test_short_overlong_nonzero_and_changing_streams_publish_no_point(self):
        for image, code, pattern in (
            (self.disk[:-1], 0, "byte count"),
            (self.disk + b"x", 0, "exceeds"),
            (self.disk, 1, "did not finish"),
        ):
            with self.subTest(size=len(image), exit=code):
                self.image, self.image_exit = image, code
                self.archives.clear()
                with self.assertRaisesRegex(BackupError, pattern):
                    self.invoke()
                self.assertEqual(self.archives, ["index.json", point.SYSTEM_IMAGE])
                self.assertEqual(self.output.getvalue(), "")
        self.image_exit = 0
        self.archives.clear()
        self.after["signature"] = "c" * 64
        with self.assertRaisesRegex(BackupError, "manifest changed"):
            self.invoke()
        self.assertEqual(self.output.getvalue(), "")

    def test_changed_local_receipt_fails_before_any_pbs_read(self):
        self.complete.write_bytes(self.complete.read_bytes() + b" ")
        with self.assertRaisesRegex(BackupError, "Pinned restore input has changed"):
            self.invoke()
        self.assertEqual(self.archives, [])

    def test_real_pipe_stall_is_killed_before_eof_without_publishing(self):
        processes = []

        def spawn(args, **kwargs):
            if args[3] != point.SYSTEM_IMAGE:
                return self.spawn(args, **kwargs)
            script = f"import os, time; os.write(1, {self.image!r}); time.sleep(4)"
            child = POPEN([sys.executable, "-u", "-c", script], **kwargs)
            processes.append(child)
            return child

        for image in (self.disk[:5], self.disk):
            with self.subTest(bytes_written=len(image)):
                self.image = image
                self.archives.clear()
                started = time.monotonic()
                with (patch.object(point, "READ_IDLE_SECONDS", 0.2),
                      patch.object(point.subprocess, "Popen", side_effect=spawn),
                      self.assertRaisesRegex(BackupError, "stalled before EOF")):
                    self.invoke()
                self.assertLess(time.monotonic() - started, 3)
                self.assertLess(processes[-1].poll(), 0)
                self.assertEqual(self.output.getvalue(), "")
        self.assertEqual(len(processes), 2)

    def test_real_pipe_can_keep_streaming_past_one_idle_interval(self):
        def spawn(args, **kwargs):
            if args[3] != point.SYSTEM_IMAGE:
                return self.spawn(args, **kwargs)
            payload = repr(self.disk)
            script = (f"import os, time; data={payload}\n"
                      "for offset in range(0, len(data), 8):\n"
                      "    os.write(1, data[offset:offset+8])\n"
                      "    time.sleep(0.09)\n")
            self.archives.append(point.SYSTEM_IMAGE)
            return POPEN([sys.executable, "-u", "-c", script], **kwargs)

        started = time.monotonic()
        with (patch.object(point, "READ_IDLE_SECONDS", 0.45),
              patch.object(point.subprocess, "Popen", side_effect=spawn)):
            self.assertEqual(self.invoke()["system_disk_sha256"], hashlib.sha256(self.disk).hexdigest())
        self.assertGreater(time.monotonic() - started, 0.45)
