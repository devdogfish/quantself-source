import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
RELEASE = runpy.run_path(HERE / "atlas-release.py")
REVISION = "2" * 40


def checksum(data):
    return hashlib.sha256(data).hexdigest()


def write_sums(output):
    (output / "SHA256SUMS").write_text("".join(
        f"{checksum((output / name).read_bytes())}  {name}\n"
        for name in ("image.tar.gz", "image.json")
    ))


def image_fixture(
    output, revision, *, architecture="amd64", label=None, defect="", layout="oci", compress=False,
    moby_metadata=False,
):
    layer = io.BytesIO()
    with tarfile.open(fileobj=layer, mode="w") as archive:
        data = b"fixture layer\n" * (100_000 if compress else 1)
        member = tarfile.TarInfo("app.txt")
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
    layer_bytes = layer.getvalue()
    diff_id = checksum(layer_bytes)
    config = json.dumps({
        "os": "linux", "architecture": architecture,
        "config": {"Labels": {"org.opencontainers.image.revision": label or revision}},
        "rootfs": {"type": "layers", "diff_ids": ["sha256:" + diff_id]},
    }).encode()
    config_id = checksum(config)
    prefix = "blobs/sha256/"
    named_id = "a" * 64 if defect == "forged_config_blob" else config_id
    config_name = prefix + named_id if layout == "oci" else named_id + ".json"
    payload = gzip.compress(layer_bytes) if compress else layer_bytes
    if defect == "layer":
        payload += b"extra layer bytes"
    layer_id = checksum(payload)
    layer_name = prefix + layer_id if layout == "oci" else diff_id + "/layer.tar"
    manifest = json.dumps([{"Config": config_name, "Layers": [layer_name]}]).encode()
    entries = [(config_name, config), (layer_name, payload), ("manifest.json", manifest)]
    if layout == "oci":
        selected_config = config
        if defect == "alternate_index":
            selected_config = config.replace(REVISION.encode(), ("9" * 40).encode())
            entries.append((prefix + checksum(selected_config), selected_config))
        index_manifest = json.dumps({
            "schemaVersion": 2,
            "config": {"digest": "sha256:" + checksum(selected_config), "size": len(selected_config)},
            "layers": [{"digest": "sha256:" + layer_id, "size": len(payload)}],
        }).encode()
        entries += [
            ("oci-layout", b'{"imageLayoutVersion":"1.0.0"}'),
            ("index.json", json.dumps({"schemaVersion": 2, "manifests": [{
                "digest": "sha256:" + checksum(index_manifest), "size": len(index_manifest),
            }]}).encode()),
            (prefix + checksum(index_manifest), index_manifest),
        ]
        if moby_metadata or defect == "broken_legacy_chain":
            legacy = {
                "id": "b" * 64, "created": "2026-11-15T18:00:00Z", "container_config": {},
                "os": "linux", "architecture": "amd64", "config": {"Labels": {}},
            }
            if defect == "broken_legacy_chain":
                legacy["parent"] = "c" * 64
            legacy_bytes = json.dumps(legacy).encode()
            entries.append((prefix + checksum(legacy_bytes), legacy_bytes))
        if defect == "unrelated_config":
            unreferenced = config.replace(REVISION.encode(), ("9" * 40).encode())
            entries.append((prefix + checksum(unreferenced), unreferenced))
    if defect == "duplicate":
        entries.append(("manifest.json", manifest))
    if defect == "unsafe_path":
        entries.append(("../manifest.json", manifest))
    if defect == "missing_layer":
        entries = [entry for entry in entries if entry[0] != layer_name]
    with tarfile.open(output / "image.tar.gz", "w:gz") as archive:
        for name, content in entries:
            member = tarfile.TarInfo(name)
            member.size = len(content)
            archive.addfile(member, io.BytesIO(content))
    if defect == "truncated_gzip":
        image = output / "image.tar.gz"
        image.write_bytes(image.read_bytes()[:-4])
    declared_id = named_id if defect != "substituted_config" else "a" * 64
    (output / "image.json").write_text(json.dumps({
        "revision": revision, "os": "linux", "architecture": "amd64",
        "id": "sha256:" + declared_id, "size": 23,
    }))
    write_sums(output)


class AtlasReleaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.state = self.root / "state"
        self.state.mkdir()
        self.work = self.root / "work"
        self.work.mkdir()
        self.source = self.root / "source checkout"
        for name in ("WORKFLOW", "VERIFICATION_RECIPE"):
            relative = RELEASE[name]
            pinned = self.source / relative
            pinned.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / relative, pinned)
        self.key = self.root / "fixture-key"
        self.generate_key(self.key)
        self.allowed = self.root / "allowed-signers"
        self.pin(self.key)
        self.calls = []

    def generate_key(self, key):
        subprocess.run(
            ["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key)],
            check=True, capture_output=True,
        )

    def pin(self, key):
        self.allowed.write_text(f"{RELEASE['PRINCIPAL']} {key.with_suffix('.pub').read_text()}")

    def gate(self, source, workspace):
        self.calls.append(("gate", source, workspace.name))

    def build(self, source, workspace, revision):
        self.calls.append(("build+smoke", source, workspace.name, revision))
        output = workspace / "app-image"
        output.mkdir(parents=True)
        image_fixture(output, revision)
        return output

    def confirm_main(self, revision):
        self.calls.append(("main", revision))

    def prepare(self, *, gate=None, build=None, confirm_main=None):
        return RELEASE["prepare_candidate"](
            self.source, REVISION, self.state, self.work,
            gate or self.gate, build or self.build, confirm_main or self.confirm_main, self.key,
        )

    def verify(self, bundle, revision=REVISION):
        return RELEASE["verify_bundle"](bundle, revision, self.allowed)

    def test_pipeline_signs_the_exact_candidate_and_refuses_to_replace_it(self):
        bundle = self.prepare()
        self.assertEqual(bundle, self.state / REVISION)
        self.assertEqual(self.calls, [
            ("gate", self.source, "verify"),
            ("build+smoke", self.source, "build", REVISION),
            ("main", REVISION),
        ])
        proof = self.verify(bundle)
        self.assertEqual(proof["revision"], REVISION)
        self.assertEqual(proof["platform"], "linux/amd64")
        self.assertEqual(proof["ref"], "refs/heads/main")
        self.assertEqual(set(proof["sha256"]), set(RELEASE["IMAGE_FILES"]))
        (self.work / "build/app-image/image.tar.gz").write_bytes(b"later worker mutation")
        self.assertEqual(self.verify(bundle), proof)
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.prepare()

    def test_gate_failure_prevents_build_and_publication(self):
        def failure(*args):
            raise subprocess.CalledProcessError(1, "verification fixture")

        with self.assertRaises(subprocess.CalledProcessError):
            self.prepare(gate=failure)
        self.assertEqual(self.calls, [])
        self.assertEqual(list(self.state.iterdir()), [])

    def test_build_failure_and_stale_main_leave_no_release(self):
        def build_failure(*args):
            raise subprocess.CalledProcessError(1, "smoke fixture")

        def stale(revision):
            raise ValueError("canonical main moved")

        with self.assertRaises(subprocess.CalledProcessError):
            self.prepare(build=build_failure)
        self.assertEqual(list(self.state.iterdir()), [])
        with self.assertRaisesRegex(ValueError, "main moved"):
            self.prepare(confirm_main=stale)
        self.assertEqual(list(self.state.iterdir()), [])

    def test_upstream_gate_drift_blocks_before_execution(self):
        with (self.source / RELEASE["WORKFLOW"]).open("a") as policy:
            policy.write("\n# workflow changed\n")
        with self.assertRaisesRegex(ValueError, "Verify workflow changed"):
            self.prepare()
        self.assertEqual(self.calls, [])

    def test_verification_recipe_drift_blocks_before_execution(self):
        with (self.source / RELEASE["VERIFICATION_RECIPE"]).open("a") as recipe:
            recipe.write("\n# recipe changed\n")
        with self.assertRaisesRegex(ValueError, "Atlas verification recipe changed"):
            self.prepare()
        self.assertEqual(self.calls, [])

    def test_prepare_cli_requires_an_explicit_expected_sha(self):
        result = subprocess.run(
            [sys.executable, "-I", "-B", str(HERE / "atlas-release.py"), "prepare",
             "--state", str(self.state), "--worker-root", str(self.work), "--worker-user", "fixture",
             "--credential-helper", str(self.root / "no-helper"), "--signing-key", str(self.key)],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("required: --expected-sha", result.stderr)

    def test_consumer_rejects_wrong_revision_key_receipt_and_image_bytes(self):
        bundle = self.prepare()
        with self.assertRaisesRegex(ValueError, "expected revision"):
            self.verify(bundle, "3" * 40)
        other_key = self.root / "other-key"
        self.generate_key(other_key)
        self.pin(other_key)
        with self.assertRaisesRegex(ValueError, "signature rejected"):
            self.verify(bundle)
        self.pin(self.key)
        receipt = bundle / "release.json"
        original = receipt.read_bytes()
        receipt.write_bytes(original + b" ")
        with self.assertRaisesRegex(ValueError, "signature rejected"):
            self.verify(bundle)
        receipt.write_bytes(original)
        (bundle / "app-image/image.tar.gz").write_bytes(b"wrong archive")
        with self.assertRaisesRegex(ValueError, "checksum manifest differs"):
            self.verify(bundle)

    def test_worker_cannot_hand_off_linked_or_incomplete_archive(self):
        def linked(*args):
            output = self.build(*args)
            archive = output / "image.tar.gz"
            archive.rename(self.root / "outside")
            archive.symlink_to(self.root / "outside")
            return output

        with self.assertRaises(OSError):
            self.prepare(build=linked)
        self.assertEqual(list(self.state.iterdir()), [])

    def test_archive_must_match_worker_metadata_before_signing(self):
        for options, message in (
            ({"defect": "substituted_config"}, "config digest differs"),
            ({"defect": "forged_config_blob"}, "blob digest differs"),
            ({"architecture": "arm64"}, "not Linux amd64"),
            ({"label": "3" * 40}, "revision differs"),
            ({"defect": "layer"}, "layer digests differ"),
            ({"defect": "duplicate"}, "Duplicate or excessive"),
            ({"defect": "unsafe_path"}, "Unsafe or unexpected"),
            ({"defect": "truncated_gzip"}, "Malformed Docker archive"),
            ({"defect": "alternate_index"}, "OCI and Docker archive image references differ"),
            ({"defect": "missing_layer"}, "references an absent file"),
            ({"defect": "unrelated_config"}, "Unrecognized legacy layer metadata"),
            ({"defect": "broken_legacy_chain"}, "not one complete parent chain"),
        ):
            with self.subTest(options=options):
                def dishonest_build(source, workspace, revision):
                    output = workspace / "app-image"
                    output.mkdir(parents=True)
                    image_fixture(output, revision, **options)
                    return output

                try:
                    with self.assertRaisesRegex(ValueError, message):
                        self.prepare(build=dishonest_build)
                    self.assertEqual(list(self.state.iterdir()), [])
                    self.assertEqual(self.calls, [("gate", self.source, "verify")])
                finally:
                    self.calls.clear()
                    shutil.rmtree(self.state / REVISION, ignore_errors=True)
                    shutil.rmtree(self.work / "build", ignore_errors=True)

    def test_validates_legacy_paths_and_streams_compressed_oci_layers(self):
        for layout, compress in (("legacy", False), ("oci", True)):
            with self.subTest(layout=layout):
                output = self.work / layout
                output.mkdir()
                image_fixture(output, REVISION, layout=layout, compress=compress)
                result = RELEASE["release_record"](output, REVISION)
                self.assertEqual(result["revision"], REVISION)
                self.assertEqual(result["platform"], "linux/amd64")

    def test_accepts_moby_legacy_metadata_beside_one_modern_image(self):
        output = self.work / "moby"
        output.mkdir()
        image_fixture(output, REVISION, moby_metadata=True)
        self.assertEqual(RELEASE["release_record"](output, REVISION)["revision"], REVISION)

    def test_credential_probe_uses_build_identity_and_workers_have_no_terminal(self):
        worker = SimpleNamespace(pw_name="quantself-build", pw_dir="/home/quantself-build")
        helper = self.root / "credential-helper"
        helper.touch()
        policy = RELEASE["require_private_credential_helper"]
        with (
            patch.dict(policy.__globals__, {"trusted_path": lambda path: path}),
            patch.object(subprocess, "Popen") as spawn,
        ):
            for mode in (0o755, 0o744, 0o710, 0o701):
                helper.chmod(mode)
                with self.subTest(mode=oct(mode)), self.assertRaisesRegex(ValueError, "root-only"):
                    policy(helper, worker, self.work)
            spawn.assert_not_called()
            child = spawn.return_value.__enter__.return_value
            child.stdout.read1.return_value = b""
            child.wait.return_value = 0
            helper.chmod(0o700)
            policy(helper, worker, self.work)
            args = spawn.call_args.args[0]
            self.assertEqual(args[:4], ["/usr/sbin/runuser", "-u", "quantself-build", "--"])
            self.assertEqual(args[-3:], ['test ! -r "$1" && test ! -x "$1"', "check-helper", str(helper)])
            self.assertEqual(spawn.call_args.kwargs["stdin"], subprocess.DEVNULL)
            self.assertEqual(spawn.call_args.kwargs["stdout"], subprocess.PIPE)
            self.assertEqual(spawn.call_args.kwargs["stderr"], subprocess.STDOUT)
            self.assertTrue(spawn.call_args.kwargs["start_new_session"])
            self.assertEqual(spawn.call_args.kwargs["umask"], 0o022)
            child.wait.return_value = 1
            with self.assertRaises(subprocess.CalledProcessError):
                policy(helper, worker, self.work)

    def test_worker_root_requires_exact_mode_and_group(self):
        private_root = RELEASE["private_root"]
        with patch.dict(private_root.__globals__, {"trusted_path": lambda path: path}):
            for mode in (0o700, 0o711, 0o755, 0o770):
                self.work.chmod(mode)
                with self.subTest(mode=oct(mode)), self.assertRaisesRegex(ValueError, "mode 750"):
                    private_root(self.work, 0o750, self.work.stat().st_gid)
            self.work.chmod(0o750)
            gid = self.work.stat().st_gid
            with self.assertRaisesRegex(ValueError, "group ID"):
                private_root(self.work, 0o750, gid + 1)
            self.assertEqual(private_root(self.work, 0o750, gid), self.work)

    def test_prepare_reuses_ssh_auth_for_fetch_and_final_main_check(self):
        prepare = RELEASE["prepare"]
        worker = SimpleNamespace(pw_name="quantself-build", pw_uid=1001, pw_gid=1001)
        args = SimpleNamespace(
            expected_sha=REVISION, state=self.state, worker_root=self.work,
            signing_key=self.key, worker_user=worker.pw_name,
            credential_helper=None, deploy_key=self.root / "deploy-key",
        )

        self.generate_key(args.deploy_key)
        duplicate = self.root / "duplicate-signing-key"
        shutil.copy2(self.key, duplicate)
        admissions = []

        def confirm_main(_source, revision, _state, work, _gate, _build, confirm, _key):
            self.assertEqual(stat.S_IMODE(work.stat().st_mode), 0o750)
            chown.assert_called_once_with(work, 0, worker.pw_gid)
            directory_check.assert_any_call(work, 0o750, worker.pw_gid)
            confirm(revision)

        def run(argv):
            admissions.append(argv)
            result = {"commit": REVISION}
            if "--checkout-root" in argv:
                result["checkout"] = str(self.work)
            return result

        probe = Mock()
        directory_check = Mock(side_effect=lambda path, *_: path)
        with (
            patch.dict(prepare.__globals__, {
                "private_root": directory_check,
                "trusted_path": lambda path: path,
                "prepare_candidate": confirm_main,
                "run_admission": run,
                "run_as_worker": probe,
            }),
            patch("os.geteuid", return_value=0),
            patch("os.chown") as chown,
            patch("platform.system", return_value="Linux"),
            patch("platform.machine", return_value="x86_64"),
            patch("pwd.getpwnam", return_value=worker),
            patch("grp.getgrgid", return_value=SimpleNamespace(gr_name=worker.pw_name)),
            patch("os.getgrouplist", return_value=[worker.pw_gid]),
        ):
            prepare(args)
            args.deploy_key = duplicate
            with self.assertRaisesRegex(ValueError, "must be distinct"):
                prepare(args)
            args.deploy_key = self.root / "deploy-key"
        directory_check.assert_any_call(self.work, 0o750, worker.pw_gid)
        directory_check.assert_any_call(self.state, 0o700)
        self.assertEqual(probe.call_count, 2)
        probe.assert_any_call(worker, self.work, "/bin/bash", "-c", 'test ! -r "$1"',
                                      "check-deploy-key", args.deploy_key)
        fetch, late_check = admissions
        for argv in (fetch, late_check):
            self.assertEqual(argv[3:5], ["--deploy-key", str(args.deploy_key)])
            self.assertEqual(argv[-2:], ["--expected-sha", REVISION])
        self.assertEqual(fetch[5], "--checkout-root")
        self.assertEqual(late_check[5], "--check-only")

    def test_admission_terminates_descendants_even_when_the_leader_has_exited(self):
        argv = ["python3", "-I", "atlas-admit.py"]
        for error in (SystemExit(143), subprocess.TimeoutExpired(argv, 180)):
            with (
                self.subTest(error=type(error)),
                patch.object(subprocess, "Popen") as spawn,
                patch.object(os, "killpg") as kill,
            ):
                child = spawn.return_value.__enter__.return_value
                child.pid = 234
                child.communicate.side_effect = error
                child.wait.return_value = 143
                with self.assertRaises(type(error)):
                    RELEASE["run_admission"](argv)
                self.assertTrue(spawn.call_args.kwargs["start_new_session"])
                self.assertEqual(spawn.call_args.kwargs["stdin"], subprocess.DEVNULL)
                child.communicate.assert_called_once_with(timeout=180)
                self.assertEqual([call.args for call in kill.call_args_list],
                                 [(234, signal.SIGTERM), (234, signal.SIGKILL)])

    def test_interrupted_launch_terminates_the_detached_worker_group(self):
        worker = SimpleNamespace(pw_name="quantself-build", pw_dir="/home/quantself-build")
        with patch.object(subprocess, "Popen") as spawn, patch.object(os, "killpg") as kill:
            child = spawn.return_value.__enter__.return_value
            child.pid = 234
            child.stdout.read1.side_effect = SystemExit(128 + signal.SIGTERM)
            child.wait.side_effect = [subprocess.TimeoutExpired("runuser fixture", 10), 143]
            with self.assertRaises(SystemExit):
                RELEASE["run_as_worker"](worker, self.work, "/bin/bash", "fixture.sh")
        self.assertEqual([call.args for call in kill.call_args_list], [(234, signal.SIGTERM), (234, signal.SIGKILL)])


if __name__ == "__main__":
    unittest.main()
