#!/usr/bin/env python3
"""Produce a pinned Atlas drill point from an independent, read-only PBS client."""

import argparse
from datetime import datetime
import hashlib
from ipaddress import IPv6Address
import json
import os
from pathlib import Path
import re
from select import select
import subprocess
import sys
from tempfile import TemporaryDirectory

from atlas_postgres_restore_drill import pinned_json, verify_pbs_identity, verify_source_pair
from backup_guest import BackupError, GIB, private, require
from backup_monitor import MonitorError
from backup_retention import HEX


CLIENT = "/usr/bin/proxmox-backup-client"
SYSTEM_IMAGE = "drive-scsi0.img.fidx"
MANIFEST_LIMIT = 256 * 1024
CHUNK_BYTES = 1024 * 1024
READ_IDLE_SECONDS = 120


def read_chunks(stream):
    while True:
        ready, _, _ = select([stream], [], [], READ_IDLE_SECONDS)
        require(ready, "PBS restore reader stalled before EOF")
        chunk = stream.read(CHUNK_BYTES)
        if not chunk:
            return
        yield chunk


def pbs_read(repository, namespace, keyfile, env, snapshot, archive, consume):
    args = [CLIENT, "restore", snapshot, archive, "-", "--repository", repository, "--keyfile", str(keyfile)]
    if namespace is not None:
        args.extend(("--ns", namespace))
    with subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0,
                          start_new_session=True, env=env) as process:
        try:
            result = consume(read_chunks(process.stdout))
            require(process.wait(timeout=30) == 0, "PBS restore reader did not finish successfully")
            return result
        finally:
            if process.poll() is None:
                process.kill()


def read_manifest(chunks):
    raw = bytearray()
    for chunk in chunks:
        require(len(raw) + len(chunk) <= MANIFEST_LIMIT, "PBS manifest exceeds its size limit")
        raw.extend(chunk)
    return json.loads(raw)


def hash_image(chunks, expected_bytes):
    digest = hashlib.sha256()
    total = 0
    for chunk in chunks:
        total += len(chunk)
        require(total <= expected_bytes, "PBS system image exceeds the approved geometry")
        digest.update(chunk)
    require(total == expected_bytes, "PBS system image byte count differs from the approved geometry")
    return digest.hexdigest()


def build_point(policy, pair, complete_sha256, atlas_complete, keyfile, password_file, key_password_file=None):
    verify_source_pair(pair)
    require(atlas_complete.is_absolute(), "Expected an absolute Atlas complete-receipt path")
    disk_gib = policy["system_disk_gib"]
    require(type(disk_gib) is int and disk_gib > 0, "Invalid approved Atlas system disk geometry")
    pbs = policy["pbs"]
    verify_pbs_identity(pbs)
    server = pbs["server"]
    if ":" in server:
        server = f"[{IPv6Address(server)}]"
    else:
        require(re.fullmatch(r"[A-Za-z0-9.-]+", server), "Invalid PBS server name")
    require(re.fullmatch(r"[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+(?:![A-Za-z0-9_.-]+)?", pbs["username"]),
            "Invalid PBS restore principal")
    port = f":{pbs['port']}" if pbs["port"] is not None else ""
    repository = f"{pbs['username']}@{server}{port}:{pbs['datastore']}"
    for path in (keyfile, password_file, key_password_file):
        if path is not None:
            private(path, 0o600)

    records = pair["pbs"]["quantself"]
    snapshot = records["volid"].removeprefix("backup:backup/")
    archive_time = datetime.fromisoformat(snapshot.rsplit("/", 1)[1])
    with TemporaryDirectory(prefix="atlas-pbs-reader-") as home:
        # The PBS client otherwise accepts a CA-valid certificate before consulting the pin.
        env = {"HOME": home, "PATH": "/usr/bin:/bin", "PBS_FINGERPRINT": pbs["fingerprint"],
               "PBS_PASSWORD_FILE": str(password_file.absolute()), "PBS_LOG": "error",
               "SSL_CERT_FILE": "/dev/null", "SSL_CERT_DIR": home}
        if key_password_file is not None:
            env["PBS_ENCRYPTION_PASSWORD_FILE"] = str(key_password_file.absolute())

        def read(archive, consume):
            return pbs_read(repository, pbs["namespace"], keyfile, env, snapshot, archive, consume)

        manifest = read("index.json", read_manifest)
        require(manifest.get("backup-type") == "vm" and manifest.get("backup-id") == "2541"
                and type(manifest.get("backup-time")) is int and manifest["backup-time"] == int(archive_time.timestamp())
                and re.fullmatch(HEX, manifest.get("signature") or "")
                and manifest.get("unprotected", {}).get("key-fingerprint", "").lower()
                == records["encryption_fingerprint"].lower(), "PBS signed manifest differs from the pinned archive")
        systems = [item for item in manifest["files"] if item.get("filename") == SYSTEM_IMAGE]
        expected_bytes = disk_gib * GIB
        require(len(systems) == 1 and systems[0].get("crypt-mode") == "encrypt"
                and type(systems[0].get("size")) is int and systems[0]["size"] == expected_bytes
                and re.fullmatch(HEX, systems[0].get("csum") or ""),
                "PBS signed system-image geometry or encryption differs")
        digest = read(SYSTEM_IMAGE, lambda chunks: hash_image(chunks, expected_bytes))
        after = read("index.json", read_manifest)
        require({key: value for key, value in after.items() if key != "unprotected"}
                == {key: value for key, value in manifest.items() if key != "unprotected"},
                "PBS signed manifest changed during the image read")
    verify_source_pair(pair)
    return {"complete": str(atlas_complete), "complete_sha256": complete_sha256,
            "system_disk_gib": disk_gib, "system_disk_sha256": digest}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", type=Path, required=True)
    parser.add_argument("--policy-sha256", required=True)
    parser.add_argument("--complete", type=Path, required=True)
    parser.add_argument("--complete-sha256", required=True)
    parser.add_argument("--atlas-complete", type=Path, required=True)
    parser.add_argument("--keyfile", type=Path, required=True)
    parser.add_argument("--password-file", type=Path, required=True)
    parser.add_argument("--key-password-file", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    require(os.geteuid() == 0, "Run the independent reader as root")
    policy = pinned_json(args.policy, args.policy_sha256)
    pair = pinned_json(args.complete, args.complete_sha256)
    print(json.dumps(build_point(policy, pair, args.complete_sha256, args.atlas_complete, args.keyfile,
                                 args.password_file, args.key_password_file)))


if __name__ == "__main__":
    try:
        main()
    except (BackupError, MonitorError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.TimeoutExpired):
        print("Unable to verify the pinned PBS system image", file=sys.stderr)
        sys.exit(1)
