import io
import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

# The installer copies the shared reader alongside jobs_mail_service.py.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "vaultwarden"))
import jobs_mail_service as service


class JobsMailServiceTests(unittest.TestCase):
    @unittest.skipUnless(hasattr(socket, "SO_PEERCRED"), "Linux socket credentials")
    def test_only_the_expected_peer_uid_can_read(self):
        client, accepted = socket.socketpair()
        with client, accepted, accepted.makefile("rb") as stream:
            self.assertTrue(service.peer_allowed(stream, os.getuid()))
            self.assertFalse(service.peer_allowed(stream, os.getuid() + 1))

    def test_fixed_mailbox_and_revocation(self):
        with tempfile.TemporaryDirectory() as folder:
            credential = Path(folder) / "imap"
            credential.write_text("synthetic app password\n")
            reader = Mock(return_value={"status": "ok"})
            request = b'{"uid":99,"uidvalidity":345}\n'
            self.assertEqual(service.handle(io.BytesIO(request), credential, reader), {"status": "ok"})
            reader.assert_called_once_with(
                "luigi@luigigirke.com", "synthetic app password", {"uid": 99, "uidvalidity": 345},
                jobs_reply_headers=True,
            )

            credential.unlink()
            self.assertEqual(service.handle(io.BytesIO(request), credential, reader), {"status": "unavailable"})
            self.assertEqual(reader.call_count, 1)

    def test_write_attempts_and_mailbox_overrides_stop_before_imap(self):
        reader = Mock()
        for request in [
            b'{"limit":1,"command":"STORE"}\n',
            b'{"uid":1,"uidvalidity":1,"folder":"Trash"}\n',
            b'{"limit":1,"username":"tyler@dawnshiftagency.com"}\n',
            b'{"limit":1,"smtp":"send"}\n',
            b'{"limit":1,"limit":2}\n',
            b'{"limit":true}\n',
            b'{"limit":1}',
            b'{"limit":1}' + b' ' * service.MAX_REQUEST_BYTES + b'\n',
        ]:
            with self.subTest(request=request):
                self.assertEqual(service.handle(io.BytesIO(request), None, reader), {"status": "unavailable"})
        reader.assert_not_called()
