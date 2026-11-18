import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
MOCK_DOCKER = r'''
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile

workspace = Path(__file__).resolve().parent.parent
config = json.loads((workspace / "fixture.json").read_text())
revision = config["revision"]
mode = config["mode"]
args = sys.argv[1:]
with (workspace / "commands.jsonl").open("a") as out:
    out.write(json.dumps(args) + "\n")

assert os.environ["DOCKER_HOST"] == f"unix:///run/user/{os.getuid()}/docker.sock"
assert os.environ["DOCKER_DEFAULT_PLATFORM"] == "linux/amd64"
assert "GH_TOKEN" not in os.environ
assert not (Path.home() / ".docker" / "config.json").exists()

config_blob = json.dumps({"os": "linux", "architecture": "amd64", "config": {"Labels": {
    "org.opencontainers.image.revision": revision,
}}}).encode()
digest = hashlib.sha256(config_blob).hexdigest()
inspect_id = "sha256:" + "1" * 64
tag_file = workspace / "image-tag"

if args[0] == "info":
    print(json.dumps([] if mode == "rootful" else ["name=rootless"]))
elif args[:2] == ["buildx", "build"]:
    tag = args[args.index("--tag") + 1]
    assert args == ["buildx", "build", "--builder", "default", "--platform", "linux/amd64",
                    "--load", "--provenance=false", "--sbom=false", "--tag", tag, "--label", f"org.opencontainers.image.revision={revision}",
                    "--build-arg", "QUANTSELF_SKIP_NEXT_TYPECHECK=1", "."]
    tag_file.write_text(tag)
    assert Path("Dockerfile").read_text() == "FROM scratch\n"
    assert not Path(".git").exists() and not Path(".env").exists()
elif args[:2] == ["image", "inspect"]:
    assert args[2] == tag_file.read_text()
    print(json.dumps({"id": inspect_id, "size": 1024, "architecture": "arm64" if mode == "arch" else "amd64",
                      "os": "linux", "revision": "1" * 40 if mode == "revision" else revision}))
elif args[0] == "size-fixture":
    assert args[1:] == [tag_file.read_text()]
elif args[0] == "smoke-fixture":
    assert args[1:] == [tag_file.read_text(), revision]
    if mode == "smoke":
        sys.exit(1)
elif args[0] == "save":
    assert args[1:] == [tag_file.read_text()]
    if mode == "save":
        print("partial export")
        sys.exit(1)
    config_name = f"{digest}.json" if mode == "legacy-config" else f"blobs/sha256/{digest}"
    rows = [{"Config": "../" + config_name if mode == "unsafe-config" else config_name}]
    if mode == "multi-image":
        rows *= 2
    manifest = json.dumps(rows).encode()
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as out:
        for name, data in [("manifest.json", manifest), (config_name, config_blob)]:
            if name == config_name and mode == "digest":
                data += b" "
            member = tarfile.TarInfo(name)
            member.size = len(data)
            out.addfile(member, io.BytesIO(data))
elif args[:2] == ["image", "rm"]:
    assert args[2:] == [tag_file.read_text()]
    tag_file.unlink()
else:
    sys.exit(f"Unexpected Docker command: {args!r}")
'''


class AtlasBuildTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.source = self.root / "source checkout"
        self.source.mkdir()
        self.git("init", "-q")
        (self.source / "Dockerfile").write_text("FROM scratch\n")
        (self.source / ".gitignore").write_text(".env\n")
        (self.source / ".env").write_text("GH_TOKEN=fixture")
        scripts = self.source / "scripts"
        (scripts / "ci").mkdir(parents=True)
        (scripts / "ci/image-size.sh").write_text('docker size-fixture "$@"\n')
        (scripts / "ci/smoke-image.sh").write_text('docker smoke-fixture "$@"\n')
        keep = scripts / "infra/keep-storage"
        keep.mkdir(parents=True)
        for name in ("backup_guest.py", "backup_inventory.py"):
            shutil.copyfile(HERE.parent / "keep-storage" / name, keep / name)
        self.git("add", ".")
        self.git("-c", "user.name=test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false",
                 "commit", "-qm", "image fixture")
        self.revision = self.git("rev-parse", "HEAD").strip()
        self.git("checkout", "--detach", "-q")
        executable = self.root / "bin/docker"
        executable.parent.mkdir()
        executable.write_text(f"#!{shutil.which('python3')}\n{MOCK_DOCKER}")
        executable.chmod(0o700)
        self.output = self.root / "artifact dir"

    def git(self, *args):
        return subprocess.check_output(["git", "-C", self.source, *args], text=True)

    def recipe(self, *, revision=None, mode="ok"):
        (self.root / "fixture.json").write_text(json.dumps({"revision": self.revision, "mode": mode}))
        (self.root / "commands.jsonl").write_text("")
        return subprocess.run(["bash", HERE / "atlas-build.sh", self.source, revision or self.revision, self.output],
                              env={**os.environ, "PATH": f"{self.root / 'bin'}:{os.environ['PATH']}",
                                   "GH_TOKEN": "fixture", "DOCKER_HOST": "tcp://unexpected.invalid:1234"},
                              capture_output=True, text=True)

    def commands(self):
        return [json.loads(line) for line in (self.root / "commands.jsonl").read_text().splitlines()]

    def assert_no_export(self):
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.glob(".atlas-build.*")), [])
        self.assertFalse((self.root / "image-tag").exists())

    def test_exports_exact_archive_after_size_and_runtime_checks(self):
        result = self.recipe()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), str(self.output.resolve()))
        self.assertEqual([args[0] for args in self.commands()],
                         ["info", "buildx", "image", "size-fixture", "smoke-fixture", "save", "image"])
        self.assertEqual({path.name for path in self.output.iterdir()}, {"image.json", "image.tar.gz", "SHA256SUMS"})
        metadata = json.loads((self.output / "image.json").read_text())
        self.assertEqual(metadata["revision"], self.revision)
        config_blob = json.dumps({"os": "linux", "architecture": "amd64", "config": {"Labels": {
            "org.opencontainers.image.revision": self.revision,
        }}}).encode()
        self.assertEqual(metadata["id"], "sha256:" + hashlib.sha256(config_blob).hexdigest())
        self.assertNotEqual(metadata["id"], "sha256:" + "1" * 64)
        self.assertEqual(self.commands()[4][1], self.commands()[5][1])
        self.assertEqual((self.output / "SHA256SUMS").read_text(), "".join(
            f"{hashlib.sha256((self.output / name).read_bytes()).hexdigest()}  {name}\n"
            for name in ("image.tar.gz", "image.json")
        ))
        for entry in [self.output, *self.output.iterdir()]:
            self.assertEqual(entry.stat().st_mode & 0o077, 0)
        self.assertFalse((self.root / "image-tag").exists())

    def test_accepts_legacy_digest_addressed_config(self):
        result = self.recipe(mode="legacy-config")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_wrong_revision_dirty_and_attached_checkouts_before_docker(self):
        result = self.recipe(revision="0" * 40)
        self.assertIn("Source revision differs", result.stderr)
        self.assertEqual(self.commands(), [])
        (self.source / "Dockerfile").write_text("FROM other\n")
        result = self.recipe()
        self.assertIn("Source checkout must be clean", result.stderr)
        self.assertEqual(self.commands(), [])
        self.git("restore", "Dockerfile")
        self.git("switch", "-qc", "untrusted")
        result = self.recipe()
        self.assertIn("detached HEAD", result.stderr)
        self.assertEqual(self.commands(), [])
        self.assert_no_export()

    def test_rejects_existing_output_without_touching_it(self):
        self.output.mkdir()
        (self.output / "existing.txt").write_text("keep")
        result = self.recipe()
        self.assertIn("Output directory already exists", result.stderr)
        self.assertEqual((self.output / "existing.txt").read_text(), "keep")
        self.assertEqual(self.commands(), [])

    def test_cleans_up_failed_builds_and_exports(self):
        for mode in ("rootful", "arch", "revision", "smoke", "save", "digest", "unsafe-config", "multi-image"):
            with self.subTest(mode=mode):
                result = self.recipe(mode=mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                self.assert_no_export()
                if mode in ("rootful", "arch", "revision", "smoke"):
                    self.assertNotIn("save", [args[0] for args in self.commands()])


if __name__ == "__main__":
    unittest.main()
