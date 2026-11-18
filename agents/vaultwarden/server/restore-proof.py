"""Capture and verify a synthetic Vaultwarden restore fixture on stopped data."""

import argparse
from contextlib import closing
from hashlib import file_digest, sha256
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
from uuid import UUID


class ProofError(Exception):
    pass


def digest_row(row):
    return sha256(json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def checked_path(path, kind):
    metadata = path.lstat()
    if not kind(metadata.st_mode):
        raise ProofError("Unexpected file type in the fixture data")
    return metadata


def file_receipt(path):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size == 0:
            raise ProofError("Fixture file must be a nonempty regular file")
        return {
            "bytes": metadata.st_size, "sha256": file_digest(stream, "sha256").hexdigest(),
            "uid": metadata.st_uid, "gid": metadata.st_gid, "mode": stat.S_IMODE(metadata.st_mode),
        }


def inspect_fixture(data, item_id, attachment_id):
    if not isinstance(item_id, str) or str(UUID(item_id)) != item_id:
        raise ProofError("The fixture item ID must be a canonical UUID")
    if not isinstance(attachment_id, str) or not re.fullmatch(r"[a-f0-9]{20}", attachment_id):
        raise ProofError("The fixture needs a Vaultwarden attachment ID")
    checked_path(data, stat.S_ISDIR)
    database = data / "db.sqlite3"
    checked_path(database, stat.S_ISREG)
    for suffix in ("-wal", "-shm", "-journal"):
        sidecar = data / (database.name + suffix)
        try:
            checked_path(sidecar, stat.S_ISREG)
        except FileNotFoundError:
            pass
    with closing(sqlite3.connect(database.absolute().as_uri() + "?mode=ro", uri=True)) as connection:
        connection.execute("PRAGMA trusted_schema=OFF")
        connection.execute("BEGIN")
        if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ProofError("SQLite integrity check failed")
        item = connection.execute(
            "SELECT * FROM ciphers WHERE uuid = ? AND deleted_at IS NULL", (item_id,),
        ).fetchone()
        attachment = connection.execute(
            "SELECT file_name, file_size, akey FROM attachments WHERE cipher_uuid = ? AND id = ?",
            (item_id, attachment_id),
        ).fetchone()
    if item is None or attachment is None:
        raise ProofError("The active fixture item or its attachment record is missing")
    checked_path(data / "attachments", stat.S_ISDIR)
    attachment_dir = data / "attachments" / item_id
    checked_path(attachment_dir, stat.S_ISDIR)
    attachment_file = file_receipt(attachment_dir / attachment_id)
    if attachment_file["bytes"] != attachment[1]:
        raise ProofError("Attachment file length differs from its database record")
    return {
        "format": 1, "item_id": item_id, "attachment_id": attachment_id,
        "item_sha256": digest_row(item), "attachment_record_sha256": digest_row(attachment),
        "attachment": attachment_file, "rsa_key": file_receipt(data / "rsa_key.pem"),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    capture = actions.add_parser("capture", help="Write a pre-backup fixture receipt")
    capture.add_argument("data", type=Path)
    capture.add_argument("item_id")
    capture.add_argument("attachment_id")
    capture.add_argument("receipt", type=Path)
    verify = actions.add_parser("verify", help="Verify a cold restore against that receipt")
    verify.add_argument("data", type=Path)
    verify.add_argument("receipt", type=Path)
    args = parser.parse_args()
    try:
        if args.action == "capture":
            result = inspect_fixture(args.data, args.item_id, args.attachment_id)
            fd = os.open(args.receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as stream:
                json.dump(result, stream, sort_keys=True)
                stream.write("\n")
        else:
            expected = json.loads(args.receipt.read_text())
            if not isinstance(expected, dict) or expected.get("format") != 1:
                raise ProofError("Unsupported fixture receipt")
            result = inspect_fixture(args.data, expected.get("item_id"), expected.get("attachment_id"))
            if result != expected:
                raise ProofError("The restored item, attachment, signing key or file metadata differs")
    except ProofError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except (OSError, ValueError, sqlite3.Error):
        print("Unable to read the fixture, SQLite data or receipt; inspect privately on the recovery host", file=sys.stderr)
        return 1
    print(json.dumps({"action": args.action, "sqlite_integrity": "ok", "fixture": "ok"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
