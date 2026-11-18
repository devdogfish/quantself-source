#!/usr/bin/env python3
"""Prepare and authenticate an exact-main Atlas release candidate."""

import argparse
from contextlib import contextmanager, suppress
import fcntl
import grp
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import zlib
from typing import NamedTuple


TOOLS = Path(__file__).resolve().parent
ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LC_ALL": "C", "SSH_ASKPASS_REQUIRE": "never"}
REPOSITORY = "devdogfish/quantself"
MAIN_REF = "refs/heads/main"
WORKFLOW = ".github/workflows/verify.yml"
WORKFLOW_DIGEST = "fb03b653e67ea136fdf5d0d1bc698f53819aace6983c4159960511edef0d6019"
VERIFICATION_RECIPE = "scripts/ci/verify-atlas.sh"
VERIFICATION_RECIPE_DIGEST = "9e9302bb5b2632ba2a2d5c2e761fe8bba0bc16483b5501e6e8fbffefe75f860b"
PRINCIPAL = "quantself-atlas"
NAMESPACE = "quantself-atlas-release-v2"
IMAGE_FILES = ("image.tar.gz", "image.json", "SHA256SUMS")
FULL_SHA = re.compile(r"[0-9a-f]{40}")
HEX_DIGEST = r"[0-9a-f]{64}"
BLOB_DIR = "blobs/sha256/"
BLOB_PATH = re.compile(BLOB_DIR + HEX_DIGEST)
LAYER_PATH = re.compile(f"(?:{BLOB_DIR}{HEX_DIGEST}|{HEX_DIGEST}/layer\\.tar)")
ROOT_METADATA = {"manifest.json", "oci-layout", "index.json", "repositories"}
# Moby's V1Image keys. Modern Docker and containerd select the validated manifests above these blobs.
LEGACY_CONFIG_KEYS = {
    "id", "parent", "comment", "created", "container", "container_config", "docker_version",
    "author", "config", "architecture", "variant", "os", "Size", "size",
}
CHUNK = 1024 * 1024
MAX_ARCHIVE_BYTES = 16 * 1024**3
MAX_EXPANDED_BYTES = 32 * 1024**3


class ArchiveFile(NamedTuple):
    size: int
    digest: str
    diff_id: str
    metadata: bytes | None


def require(condition, message):
    if not condition:
        raise ValueError(message)


@contextmanager
def image_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        require(set(os.listdir(descriptor)) == set(IMAGE_FILES), "Unexpected app-image file set")
        yield descriptor
    finally:
        os.close(descriptor)


@contextmanager
def regular_file(path, *, directory=None, max_bytes=None):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    with os.fdopen(descriptor, "rb") as file:
        info = os.fstat(file.fileno())
        require(stat.S_ISREG(info.st_mode), f"Expected a regular file: {path}")
        if max_bytes is not None:
            require(0 < info.st_size <= max_bytes, f"Unexpected metadata size: {path}")
        yield file


def digest(file):
    checksum = hashlib.sha256()
    for block in iter(lambda: file.read(1024 * 1024), b""):
        checksum.update(block)
    return checksum.hexdigest()


def archive_json(data):
    require(data is not None, "Missing or oversized archive metadata")

    def unique_keys(pairs):
        result = {}
        seen = set()
        for key, value in pairs:
            # Docker's JSON decoder matches known field names case-insensitively.
            require(key.casefold() not in seen, "Ambiguous archive JSON key")
            seen.add(key.casefold())
            result[key] = value
        return result

    def reject_constant(_):
        raise ValueError("Malformed archive JSON")

    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=unique_keys, parse_constant=reject_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise ValueError("Malformed archive JSON") from None


def read_exact(stream, size):
    result = stream.read(size)
    require(len(result) == size, "Truncated Docker archive")
    return result


def read_archive_member(stream, size, metadata_hint, expanded_budget):
    first = read_exact(stream, min(size, CHUNK))
    keep_metadata = size <= CHUNK and (metadata_hint or first.lstrip().startswith(b"{"))
    raw_hash = hashlib.sha256()
    unpacked_hash = hashlib.sha256()
    unpacked_size = 0
    gzip_body = first.startswith(b"\x1f\x8b")
    inflater = zlib.decompressobj(16 + zlib.MAX_WBITS) if gzip_body else None

    chunk = first
    remaining = size
    while chunk:
        raw_hash.update(chunk)
        remaining -= len(chunk)
        if inflater is not None:
            while chunk:
                unpacked = inflater.decompress(chunk, CHUNK)
                unpacked_size += len(unpacked)
                require(unpacked_size <= expanded_budget and not inflater.unused_data,
                        "Invalid or oversized compressed image layer")
                unpacked_hash.update(unpacked)
                chunk = inflater.unconsumed_tail
        chunk = read_exact(stream, min(remaining, CHUNK))
    if inflater is not None:
        require(inflater.eof, "Truncated compressed image layer")
    raw_digest = raw_hash.hexdigest()
    diff_id = unpacked_hash.hexdigest() if gzip_body else raw_digest
    return raw_digest, "sha256:" + diff_id, first if keep_metadata else None, unpacked_size


def archive_members(file):
    files = {}
    seen = set()
    tar_bytes = metadata_bytes = unpacked_bytes = 0
    try:
        with gzip.GzipFile(fileobj=file, mode="rb") as stream:
            while True:
                header = read_exact(stream, tarfile.BLOCKSIZE)
                if not any(header):
                    require(not any(read_exact(stream, tarfile.BLOCKSIZE)), "Invalid Docker tar ending")
                    tail = stream.read(CHUNK + 1)
                    require(len(tail) <= CHUNK and not any(tail), "Unexpected data after Docker tar ending")
                    return files

                # Parse each fixed header ourselves. tarfile's iterator processes PAX,
                # long-name and sparse records before the caller can cap allocations.
                member = tarfile.TarInfo.frombuf(header, "utf-8", "strict")
                name = member.name.removeprefix("./")
                require(name not in seen and len(seen) < 1024, "Duplicate or excessive Docker archive members")
                seen.add(name)
                if member.type == tarfile.DIRTYPE:
                    require(member.size == 0 and (name in {".", "", "blobs", "blobs/sha256"}
                            or re.fullmatch(HEX_DIGEST, name)), "Unexpected Docker archive directory")
                    continue
                require(member.type in (tarfile.REGTYPE, tarfile.AREGTYPE) and not member.linkname,
                        "Unsupported Docker archive member type")
                require(name in ROOT_METADATA or BLOB_PATH.fullmatch(name)
                        or re.fullmatch(rf"{HEX_DIGEST}(?:\.json|/(?:VERSION|json|layer\.tar))", name),
                        "Unsafe or unexpected Docker archive path")
                padding = -member.size % tarfile.BLOCKSIZE
                tar_bytes += member.size + padding + tarfile.BLOCKSIZE
                require(member.size > 0 and tar_bytes <= MAX_EXPANDED_BYTES, "Invalid or oversized Docker archive")
                actual, diff_id, metadata, expanded = read_archive_member(
                    stream, member.size, name in ROOT_METADATA or name.endswith(".json"),
                    MAX_EXPANDED_BYTES - unpacked_bytes,
                )
                unpacked_bytes += expanded
                if BLOB_PATH.fullmatch(name):
                    require(name == BLOB_DIR + actual, "Archive blob digest differs from its path")
                if metadata is not None:
                    metadata_bytes += len(metadata)
                    require(metadata_bytes <= 8 * CHUNK, "Excessive Docker archive metadata")
                files[name] = ArchiveFile(member.size, actual, diff_id, metadata)
                require(not any(read_exact(stream, padding)), "Invalid Docker archive padding")
    except (tarfile.TarError, EOFError, OSError, UnicodeError, zlib.error):
        raise ValueError("Malformed Docker archive") from None


def object_field(value, key):
    require(isinstance(value, dict), "Expected an archive JSON object")
    return value.get(key)


def verify_legacy_metadata(entries, layer_count):
    """Recognize Moby's digest-addressed V1 metadata, one parent-chain entry per layer."""
    if not entries:
        return
    require(len(entries) == layer_count, "Unexpected number of legacy layer metadata blobs")
    children = {}
    identities = set()
    for entry in entries:
        require(entry.metadata is not None and entry.size <= 64 * 1024, "Oversized legacy layer metadata")
        legacy = archive_json(entry.metadata)
        identity = object_field(legacy, "id")
        parent = legacy.get("parent", "")
        require(
            set(legacy) <= LEGACY_CONFIG_KEYS
            and isinstance(identity, str) and re.fullmatch(HEX_DIGEST, identity) and identity not in identities
            and isinstance(parent, str) and (not parent or re.fullmatch(HEX_DIGEST, parent))
            and parent not in children and legacy.get("os") == "linux"
            and legacy.get("architecture", "amd64") == "amd64"
            and isinstance(legacy.get("container_config"), dict)
            and ("config" not in legacy or isinstance(legacy["config"], dict))
            and "created" in legacy and (legacy["created"] is None or isinstance(legacy["created"], str)),
            "Unrecognized legacy layer metadata",
        )
        children[parent] = identity
        identities.add(identity)
    identity = ""
    for _ in entries:
        require(identity in children, "Legacy layer metadata is not one complete parent chain")
        identity = children.pop(identity)


def verify_archive(file, image_id, revision):
    files = archive_members(file)

    def member(name):
        require(isinstance(name, str) and name in files, "Archive references an absent file")
        return files[name]

    def metadata(name):
        return archive_json(member(name).metadata)

    def descriptor_path(descriptor):
        identity = object_field(descriptor, "digest")
        require(isinstance(identity, str) and re.fullmatch("sha256:" + HEX_DIGEST, identity),
                "Invalid OCI archive descriptor")
        name = BLOB_DIR + identity.removeprefix("sha256:")
        size = object_field(descriptor, "size")
        require(type(size) is int and size == member(name).size, "OCI archive descriptor size differs")
        return name

    manifest = metadata("manifest.json")
    require(isinstance(manifest, list) and len(manifest) == 1, "Expected one Docker archive image")
    config_name = object_field(manifest[0], "Config")
    expected = image_id.removeprefix("sha256:")
    require(config_name in (BLOB_DIR + expected, expected + ".json") and member(config_name).digest == expected,
            "Archive config digest differs from the approved image ID")
    config = metadata(config_name)
    require(object_field(config, "os") == "linux" and config.get("architecture") == "amd64",
            "Archive image is not Linux amd64")
    labels = object_field(config.get("config"), "Labels")
    require(object_field(labels, "org.opencontainers.image.revision") == revision,
            "Archive image revision differs from the admitted SHA")
    layers = object_field(manifest[0], "Layers")
    rootfs = object_field(config, "rootfs")
    require(isinstance(layers, list) and layers and object_field(rootfs, "type") == "layers"
            and all(isinstance(name, str) and LAYER_PATH.fullmatch(name) for name in layers),
            "Invalid Docker archive layer layout")
    require([member(name).diff_id for name in layers] == rootfs.get("diff_ids"), "Archive layer digests differ")

    referenced = {config_name, *layers}
    if "oci-layout" in files or "index.json" in files:
        require(object_field(metadata("oci-layout"), "imageLayoutVersion") == "1.0.0",
                "Unsupported OCI archive layout")
        index = metadata("index.json")
        descriptors = object_field(index, "manifests")
        require(index.get("schemaVersion") == 2 and isinstance(descriptors, list) and descriptors,
                "Invalid OCI archive index")
        paths = {descriptor_path(item) for item in descriptors}
        require(len(paths) == 1, "Expected one OCI archive image")
        selected = paths.pop()
        referenced.add(selected)
        oci_manifest = metadata(selected)
        oci_layers = object_field(oci_manifest, "layers")
        require(oci_manifest.get("schemaVersion") == 2
                and descriptor_path(oci_manifest.get("config")) == config_name
                and isinstance(oci_layers, list) and [descriptor_path(item) for item in oci_layers] == layers,
                "OCI and Docker archive image references differ")
    legacy_metadata = []
    for name in files.keys() - ROOT_METADATA - referenced:
        if "index.json" in files and BLOB_PATH.fullmatch(name):
            legacy_metadata.append(files[name])
            continue
        legacy_layer = name.rsplit("/", 1)[0] + "/layer.tar"
        require(name.endswith(("/VERSION", "/json")) and legacy_layer in layers,
                "Unexpected unreferenced Docker archive member")
    verify_legacy_metadata(legacy_metadata, len(layers))


def snapshot_image(source, target):
    """Copy a worker bundle into controller-only storage before signing."""
    target.mkdir(mode=0o700)
    with image_directory(source) as directory:
        for name in IMAGE_FILES:
            limit = MAX_ARCHIVE_BYTES if name == "image.tar.gz" else 4096
            with regular_file(name, directory=directory, max_bytes=limit) as original:
                with (target / name).open("xb") as copy:
                    copied = 0
                    for block in iter(lambda: original.read(CHUNK), b""):
                        copied += len(block)
                        require(copied <= limit, "Oversized worker output")
                        copy.write(block)


def release_record(image, revision):
    require(FULL_SHA.fullmatch(revision), "Expected a full lowercase commit SHA")
    with image_directory(image) as directory:
        with regular_file("image.json", directory=directory, max_bytes=4096) as file:
            metadata = json.load(file)
        require(
            isinstance(metadata, dict)
            and metadata.get("revision") == revision
            and metadata.get("architecture") == "amd64"
            and metadata.get("os") == "linux"
            and type(metadata.get("size")) is int and metadata["size"] > 0
            and re.fullmatch(r"sha256:[0-9a-f]{64}", str(metadata.get("id"))),
            "Image metadata differs from the admitted revision or platform",
        )
        with regular_file("SHA256SUMS", directory=directory, max_bytes=4096) as file:
            sums = file.read()
        hashes = {"SHA256SUMS": hashlib.sha256(sums).hexdigest()}
        for name in ("image.tar.gz", "image.json"):
            limit = MAX_ARCHIVE_BYTES if name == "image.tar.gz" else 4096
            with regular_file(name, directory=directory, max_bytes=limit) as file:
                hashes[name] = digest(file)
        expected = {f"{hashes[name]}  {name}".encode() for name in ("image.tar.gz", "image.json")}
        lines = sums.splitlines()
        require(len(lines) == 2 and set(lines) == expected, "Image checksum manifest differs")
        with regular_file("image.tar.gz", directory=directory, max_bytes=MAX_ARCHIVE_BYTES) as file:
            verify_archive(file, metadata["id"], revision)
    return {
        "format": 2,
        "repository": REPOSITORY,
        "ref": MAIN_REF,
        "revision": revision,
        "verification_workflow_sha256": WORKFLOW_DIGEST,
        "verification_recipe_sha256": VERIFICATION_RECIPE_DIGEST,
        "platform": "linux/amd64",
        "image_id": metadata["id"],
        "sha256": hashes,
    }


def sign_bundle(bundle, record, key):
    receipt = json.dumps(record, sort_keys=True, separators=(",", ":")).encode() + b"\n"
    (bundle / "release.json").write_bytes(receipt)
    with (bundle / "release.sig").open("xb") as signature:
        subprocess.run(
            ["/usr/bin/ssh-keygen", "-Y", "sign", "-f", str(key), "-n", NAMESPACE],
            input=receipt, stdout=signature, env=ENV, check=True, timeout=15,
        )


def verify_bundle(bundle, revision, allowed_signers):
    with regular_file(bundle / "release.json", max_bytes=4096) as file:
        receipt = file.read()
    with regular_file(bundle / "release.sig", max_bytes=4096) as file:
        signature = file.read()
    with tempfile.TemporaryDirectory(prefix="quantself-atlas-verify-") as scratch:
        signature_path = Path(scratch) / "release.sig"
        signature_path.write_bytes(signature)
        completed = subprocess.run(
            ["/usr/bin/ssh-keygen", "-Y", "verify", "-f", str(allowed_signers), "-I", PRINCIPAL,
             "-n", NAMESPACE, "-s", str(signature_path)],
            input=receipt, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env=ENV, timeout=15,
        )
    require(completed.returncode == 0, "Atlas release signature rejected")
    record = json.loads(receipt)
    require(isinstance(record, dict) and record.get("revision") == revision,
            "Signed release differs from the expected revision")
    require(record == release_record(bundle / "app-image", revision), "Signed release contents differ")
    return record


def prepare_candidate(source, revision, state, work, gate, build, confirm_main, key):
    """Run the existing gate, build and smoke before admitting a candidate."""
    require(FULL_SHA.fullmatch(revision), "Expected a full lowercase commit SHA")
    with regular_file(source / WORKFLOW, max_bytes=64 * 1024) as file:
        require(digest(file) == WORKFLOW_DIGEST, "Verify workflow changed. Review Atlas gate parity.")
    with regular_file(source / VERIFICATION_RECIPE, max_bytes=64 * 1024) as file:
        require(digest(file) == VERIFICATION_RECIPE_DIGEST, "Atlas verification recipe changed. Review gate parity.")
    destination = state / revision
    require(not os.path.lexists(destination), "A candidate for this revision already exists")
    gate(source, work / "verify")
    output = build(source, work / "build", revision)
    with tempfile.TemporaryDirectory(prefix=".release-", dir=state) as scratch:
        bundle = Path(scratch) / "candidate"
        bundle.mkdir(mode=0o700)
        snapshot_image(output, bundle / "app-image")
        record = release_record(bundle / "app-image", revision)
        confirm_main(revision)
        sign_bundle(bundle, record, key)
        bundle.rename(destination)
    return destination


def trusted_path(path):
    require(path.is_absolute() and path.resolve(strict=True) == path, f"Expected a resolved path: {path}")
    for entry in (path, *path.parents):
        info = entry.stat()
        require(info.st_uid == 0 and not info.st_mode & 0o022, f"Path must be root-controlled: {entry}")
    return path


def private_root(path, mode, gid=None):
    info = trusted_path(path).stat()
    require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == mode,
            f"Expected a root-owned directory with mode {mode:o}: {path}")
    require(gid is None or info.st_gid == gid, f"Expected directory group ID {gid}: {path}")
    return path


def worker_checkout(source, workspace, worker):
    workspace.mkdir(mode=0o700)
    checkout = workspace / "source"
    shutil.copytree(source, checkout, symlinks=True)
    for parent, directories, files in os.walk(checkout, topdown=False):
        for name in (*directories, *files):
            os.lchown(Path(parent) / name, worker.pw_uid, worker.pw_gid)
    os.chown(checkout, worker.pw_uid, worker.pw_gid)
    os.chown(workspace, worker.pw_uid, worker.pw_gid)
    return checkout


def stop_process_group(child):
    with suppress(ProcessLookupError):
        os.killpg(child.pid, signal.SIGTERM)
    with suppress(subprocess.TimeoutExpired):
        child.wait(timeout=10)
    # The session leader can exit while a descendant is still alive.
    with suppress(ProcessLookupError):
        os.killpg(child.pid, signal.SIGKILL)
    child.wait()


def run_admission(argv):
    with subprocess.Popen(
        argv, env=ENV, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, text=True,
        start_new_session=True,
    ) as child:
        try:
            output, _ = child.communicate(timeout=180)
            if child.returncode:
                raise subprocess.CalledProcessError(child.returncode, argv)
            return json.loads(output)
        except BaseException:
            stop_process_group(child)
            raise


def run_as_worker(worker, work_root, *command):
    argv = [
        "/usr/sbin/runuser", "-u", worker.pw_name, "--", "/usr/bin/env", "-i",
        f"HOME={worker.pw_dir}", f"PATH={ENV['PATH']}", *map(str, command),
    ]
    # Match the hosted worker umask and keep the controller's private umask.
    # Forward diagnostics through a pipe so the worker inherits no terminal descriptors.
    with subprocess.Popen(
        argv, cwd=work_root, env=ENV, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True, umask=0o022,
    ) as child:
        try:
            for block in iter(lambda: child.stdout.read1(CHUNK), b""):
                sys.stderr.buffer.write(block)
                sys.stderr.buffer.flush()
            status = child.wait()
        except BaseException:
            stop_process_group(child)
            raise
    if status:
        raise subprocess.CalledProcessError(status, argv)


def require_private_credential_helper(path, worker, work_root):
    mode = trusted_path(path).stat().st_mode
    require(stat.S_ISREG(mode) and stat.S_IMODE(mode) in (0o500, 0o700),
            "Credential helper must be root-only executable (0500 or 0700)")
    run_as_worker(
        worker, work_root, "/bin/bash", "-c", 'test ! -r "$1" && test ! -x "$1"', "check-helper", path,
    )


def require_private_deploy_key(path, worker, work_root):
    info = trusted_path(path).stat()
    require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600,
            "Deploy key must be a root-owned regular file with mode 0600")
    run_as_worker(worker, work_root, "/bin/bash", "-c", 'test ! -r "$1"', "check-deploy-key", path)


def key_identity(path):
    result = subprocess.run(
        ["/usr/bin/ssh-keygen", "-y", "-P", "", "-f", str(path)],
        env=ENV, stdin=subprocess.DEVNULL, capture_output=True, text=True, check=True, timeout=10,
    )
    algorithm, public_key, *_ = result.stdout.split()
    return algorithm, public_key


def interrupt_preparation(signum, _frame):
    raise SystemExit(128 + signum)


def prepare(args):
    require(FULL_SHA.fullmatch(args.expected_sha), "Expected the full lowercase SHA approved for this run")
    require(os.geteuid() == 0 and platform.system() == "Linux" and platform.machine() == "x86_64",
            "Run the controller as root on the isolated Linux amd64 builder VM")
    state = private_root(args.state, 0o700)
    key = trusted_path(args.signing_key)
    require(key.is_file() and stat.S_IMODE(key.stat().st_mode) == 0o600,
            "Signing key must be a root-owned regular file with mode 0600")
    worker = pwd.getpwnam(args.worker_user)
    require(
        worker.pw_uid > 0 and worker.pw_gid > 0
        and grp.getgrgid(worker.pw_gid).gr_name == worker.pw_name
        and set(os.getgrouplist(worker.pw_name, worker.pw_gid)) == {worker.pw_gid},
        "Expected a dedicated unprivileged build user with a private primary group",
    )
    work_root = private_root(args.worker_root, 0o750, worker.pw_gid)
    admission_script = trusted_path(TOOLS / "atlas-admit.py")
    build_script = trusted_path(TOOLS / "atlas-build.sh")
    if args.deploy_key is None:
        require_private_credential_helper(args.credential_helper, worker, work_root)
        auth = ("--credential-helper", str(args.credential_helper))
    else:
        require_private_deploy_key(args.deploy_key, worker, work_root)
        require(key_identity(args.deploy_key) != key_identity(key), "Deploy and signing keys must be distinct")
        auth = ("--deploy-key", str(args.deploy_key))

    def admission(*argv):
        return run_admission([sys.executable, "-I", str(admission_script), *auth, *argv])

    def gate(source, workspace):
        checkout = worker_checkout(source, workspace, worker)
        run_as_worker(worker, work_root, "/bin/bash", checkout / VERIFICATION_RECIPE, checkout)

    def build(source, workspace, revision):
        checkout = worker_checkout(source, workspace, worker)
        output = workspace / "app-image"
        run_as_worker(worker, work_root, "/bin/bash", build_script, checkout, revision, output)
        return output

    def confirm_main(revision):
        require(admission("--check-only", "--expected-sha", revision) == {"commit": revision},
                "Canonical main recheck differs")

    with (state / ".prepare.lock").open("ab") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        with (
            tempfile.TemporaryDirectory(prefix=".source-", dir=state) as checkout_root,
            tempfile.TemporaryDirectory(prefix="run-", dir=work_root) as workspace,
        ):
            result = admission("--checkout-root", checkout_root, "--expected-sha", args.expected_sha)
            work = Path(workspace)
            # Bun needs read access to the ancestors of its working directory.
            os.chown(work, 0, worker.pw_gid)
            work.chmod(0o750)
            private_root(work, 0o750, worker.pw_gid)
            return prepare_candidate(
                Path(result["checkout"]), result["commit"], state, work, gate, build, confirm_main, key,
            )


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    commands = parser.add_subparsers(dest="command", required=True)
    producer = commands.add_parser("prepare", allow_abbrev=False)
    producer.add_argument("--state", type=Path, required=True)
    producer.add_argument("--worker-root", type=Path, required=True)
    producer.add_argument("--worker-user", required=True)
    auth = producer.add_mutually_exclusive_group(required=True)
    auth.add_argument("--credential-helper", type=Path)
    auth.add_argument("--deploy-key", type=Path)
    producer.add_argument("--signing-key", type=Path, required=True)
    producer.add_argument("--expected-sha", required=True)
    consumer = commands.add_parser("verify", allow_abbrev=False)
    consumer.add_argument("--bundle", type=Path, required=True)
    consumer.add_argument("--allowed-signers", type=Path, required=True)
    consumer.add_argument("--expected-sha", required=True)
    args = parser.parse_args()
    try:
        os.umask(0o077)
        if args.command == "prepare":
            signal.signal(signal.SIGTERM, interrupt_preparation)
            print(prepare(args))
        else:
            print(json.dumps(verify_bundle(args.bundle, args.expected_sha, args.allowed_signers)))
    except (KeyError, OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Atlas release rejected: {error}\n")


if __name__ == "__main__":
    main()
