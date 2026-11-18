from contextlib import closing, contextmanager
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest


CHECK = Path(__file__).parent / "server/restore-proof.py"
ITEM = "210add50-851b-4d56-9afd-967e866071a9"
ATTACHMENT = "0123456789abcdef0123"
DATA = b"fixture encrypted attachment"


@contextmanager
def fixture_in_wal(data):
    path = data / "attachments" / ITEM / ATTACHMENT
    path.parent.mkdir(parents=True)
    path.write_bytes(DATA)
    (data / "rsa_key.pem").write_bytes(b"fixture signing key")
    with closing(sqlite3.connect(data / "db.sqlite3")) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA wal_autocheckpoint=0")
        connection.executescript("""
            CREATE TABLE ciphers (uuid TEXT PRIMARY KEY, name TEXT, data TEXT, deleted_at TEXT);
            CREATE TABLE attachments (id TEXT PRIMARY KEY, cipher_uuid TEXT, file_name TEXT,
                                      file_size INTEGER, akey TEXT);
        """)
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        connection.execute("INSERT INTO ciphers VALUES (?, ?, ?, NULL)",
                           (ITEM, "fixture encrypted name", "fixture encrypted data"))
        connection.execute("INSERT INTO attachments VALUES (?, ?, ?, ?, ?)",
                           (ATTACHMENT, ITEM, "fixture encrypted filename", len(DATA), "fixture encrypted key"))
        connection.commit()
        yield path


def check(*args):
    return subprocess.run([sys.executable, "-I", str(CHECK), *map(str, args)],
                          capture_output=True, text=True, timeout=10)


class RestoreProofTest(unittest.TestCase):
    def test_accepts_restored_wal_and_rejects_same_size_attachment_corruption(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            receipt = root / "fixture.json"
            source = root / "source"
            with fixture_in_wal(source) as attachment:
                result = check("capture", source, ITEM, ATTACHMENT, receipt)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(stat.S_IMODE(receipt.stat().st_mode), 0o600)
                restored = root / "restored"
                shutil.copytree(source, restored)
            result = check("verify", restored, receipt)
            self.assertEqual(result.returncode, 0, result.stderr)
            saved_attachment = restored / attachment.relative_to(source)
            saved_attachment.write_bytes(b"!" * len(DATA))
            result = check("verify", restored, receipt)
            self.assertEqual(result.returncode, 1)
            self.assertIn("differs", result.stderr)
            saved_attachment.write_bytes(DATA)
            (restored / "db.sqlite3-wal").unlink()
            self.assertEqual(check("verify", restored, receipt).returncode, 1)
