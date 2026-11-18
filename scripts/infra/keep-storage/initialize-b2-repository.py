#!/usr/bin/env python3
"""Initialize or verify this guest's explicitly approved B2 restic repository."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys

from backup_growth import pages
from verify_b2_access import B2, DIRECTORY, RESTIC, ROLES, Transport, VerifyError, guest_env, private_file, require

APPROVED_BUCKET_FILE = "approved-b2-bucket"
PIN = "20d4142678d0d95ec11a4759def1b73fd9190abc9ca19e4b62d067c0b387e639"
INTENT = "initialization-intent.json"


def check_binary():
    binary = Path(RESTIC)
    meta = binary.lstat()
    require(stat.S_ISREG(meta.st_mode) and meta.st_uid == meta.st_gid == 0
            and stat.S_IMODE(meta.st_mode) == 0o755, "Unexpected restic executable metadata.")
    with binary.open("rb") as source:
        require(hashlib.file_digest(source, "sha256").hexdigest() == PIN, "Restic executable differs from pinned release.")


def restic(env, *args):
    return subprocess.run(
        [RESTIC, "--no-cache", *args],
        env={**env, "PATH": "/usr/bin:/bin", "HOME": "/root", "LANG": "C", "AWS_EC2_METADATA_DISABLED": "true"},
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        timeout=45, check=False,
    )


def authenticated_id(env, run=restic):
    result = run(env, "--no-lock", "cat", "config")
    if result.returncode != 0:
        return None
    config = json.loads(result.stdout)
    identity = config.get("id")
    require(config.get("version") in (1, 2) and isinstance(identity, str)
            and re.fullmatch(r"[0-9a-f]{64}", identity), "Unexpected authenticated repository config.")
    return identity


def require_empty(b2, role):
    prefix = role + "/"
    synthetic = prefix + "_verify/"
    for operation, cursors, fields in (
        ("b2_list_file_versions", {"nextFileName": "startFileName", "nextFileId": "startFileId"},
         {"prefix": prefix, "maxFileCount": 1000}),
        ("b2_list_unfinished_large_files", {"nextFileId": "startFileId"},
         {"namePrefix": prefix, "maxFileCount": 100}),
    ):
        for item in pages(b2.call, operation, "files", cursors, bucketId=b2.bucket_id, **fields):
            require(item["bucketId"] == b2.bucket_id and item["fileName"].startswith(synthetic),
                    "Repository prefix already has a current, historical or unfinished object.")


def save_intent(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as target:
        json.dump(value, target)
        target.flush()
        os.fsync(target.fileno())
    directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def initialize(env, b2, role, directory, run=restic):
    path = directory / INTENT
    binding = {"format": 1, "repository": env["RESTIC_REPOSITORY"], "bucketId": b2.bucket_id}
    try:
        saved = json.loads(private_file(path))
    except FileNotFoundError:
        saved = None
    require(saved is None or saved == binding, "Initialization intent belongs to a different repository.")
    identity = authenticated_id(env, run)
    if identity is not None:
        return identity
    require(saved is None, "Earlier initialization is unresolved. Inspect the original repository before any retry.")
    require_empty(b2, role)
    save_intent(path, binding)
    result = run(env, "init", "--repository-version", "2")
    require(result.returncode == 0, "Initialization outcome unresolved. Rerun only to inspect authenticated repository state.")
    identity = authenticated_id(env, run)
    require(identity is not None, "Initialization returned without authenticated repository evidence.")
    return identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", required=True, help="Exact Owner-approved B2 bucket")
    args = parser.parse_args()
    role = ROLES.get(socket.gethostname().split(".")[0])
    require(os.geteuid() == 0 and role, "Run as root on the quantself or files guest.")
    os.umask(0o077)
    fd = os.open(DIRECTORY, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise VerifyError("Another credential or repository operation holds the guest directory lock.") from None
        try:
            approved_bucket = private_file(DIRECTORY / APPROVED_BUCKET_FILE).removesuffix("\n")
        except FileNotFoundError:
            raise VerifyError("Stage the Owner-approved B2 bucket file before initialization.") from None
        require(approved_bucket and args.bucket == approved_bucket, "Bucket argument does not match the private approval.")
        env, endpoint, bucket = guest_env(role)
        require(bucket == approved_bucket, "Installed repository does not match the approved B2 bucket.")
        require(shutil.disk_usage(DIRECTORY).free >= 2 * 1024**3, "Guest requires 2 GiB free for repository setup.")
        check_binary()
        b2 = B2(Transport(seconds=120, max_response_bytes=16 * 1024 * 1024), env, endpoint, bucket, role)
        print(initialize(env, b2, role, DIRECTORY))
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print(str(error) if isinstance(error, VerifyError) else
              "Repository setup stopped. Inspect existing state before retrying.", file=sys.stderr)
        sys.exit(1)
