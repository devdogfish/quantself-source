import base64
import contextlib
import json
import socketserver
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import mail


USERNAME = "tyler@dawnshiftagency.com"
PASSWORD = "fake mailbox credential"
HEADER = b"From: Fixture <fixture@example.test>\r\nSubject: Daily update\r\nDate: Tue, 17 Nov 2026 09:00:00 +0000\r\n\r\n"
BODY = b"Plain text fixture. fakemailboxcredential\r\n"
STRUCTURE = (
    b'(("TEXT" "PLAIN" ("NAME" "attachment.txt") NIL NIL "BASE64" 2097152 3 NIL ("ATTACHMENT" NIL))'
    b'(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 42 1 NIL NIL)'
    b'("TEXT" "HTML" NIL NIL NIL "7BIT" 130 4 NIL NIL) "ALTERNATIVE" NIL NIL) "MIXED" NIL NIL)'
)
HEADER_ITEM = b"BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)]<0.2048>"
METADATA_COMMAND = b"UID FETCH 99 (UID " + HEADER_ITEM + b" BODYSTRUCTURE)"
JOBS_METADATA_COMMAND = (
    f"UID FETCH 99 (UID BODY.PEEK[{mail.REPLY_HEADER_SECTION}]<0.{mail.REPLY_HEADER_BYTES}> BODYSTRUCTURE)"
).encode()
ROOT_TEXT_COMMAND = b"UID FETCH 99 (UID BODY.PEEK[1]<0.65536>)"
TEXT_COMMAND = b"UID FETCH 99 (UID BODY.PEEK[2.1]<0.65536>)"


def literal(section, sequence, uid, value, uid_first, extra=b""):
    body = f"BODY[{section}]<0> {{{len(value)}}}".encode()
    uid_item = f"UID {uid}".encode()
    first = uid_item + b" " + body if uid_first else body
    last = b"" if uid_first else b" " + uid_item
    return f"* {sequence} FETCH (".encode() + first + b"\r\n" + value + last + extra + b")\r\n"


def metadata(uid=99, structure=STRUCTURE):
    return literal(mail.HEADER_SECTION, 40, uid, HEADER, uid_first=False, extra=b" BODYSTRUCTURE " + structure)


class IMAPFixture(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            with self.server.tls.wrap_socket(self.request, server_side=True) as transport:
                transport.settimeout(5)
                transport.sendall(b"* OK IMAP test ready\r\n")
                with transport.makefile("rb") as wire:
                    for line in wire:
                        tag, command = line.rstrip(b"\r\n").split(b" ", 1)
                        self.server.commands.append(command)
                        if b"BODY[" in command or b" STORE " in command:
                            self.server.flags.add("seen")
                        reply = self.reply(command)
                        transport.sendall(reply + tag + b" OK fixture\r\n")
        except (OSError, ssl.SSLError):
            pass

    def reply(self, command):
        if command == b"CAPABILITY":
            return b"* CAPABILITY IMAP4rev1\r\n"
        if command == b"EXAMINE INBOX":
            return b"* FLAGS (\\Seen)\r\n* 40 EXISTS\r\n* OK [UIDVALIDITY 345] fixture\r\n* OK [READ-ONLY] fixture\r\n"
        if command == self.server.metadata_command:
            return self.server.metadata_reply
        uid_fetch = f"UID FETCH {self.server.uid} ".encode()
        if command.startswith(uid_fetch):
            command = b"UID FETCH 99 " + command[len(uid_fetch):]
        if command in {METADATA_COMMAND, JOBS_METADATA_COMMAND}:
            return self.server.metadata_reply
        if command in {TEXT_COMMAND, ROOT_TEXT_COMMAND}:
            return self.server.body_reply
        if command.startswith(b"FETCH "):
            return (
                literal(mail.HEADER_SECTION, 39, 94, HEADER, uid_first=True)
                + b"* 1 FETCH (FLAGS (\\Seen))\r\n"
                + literal(mail.HEADER_SECTION, 40, 99, HEADER, uid_first=False)
            )
        return b""


class TLSMailTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(directory.cleanup)
        certificate = Path(directory.name) / "certificate.pem"
        key = Path(directory.name) / "key.pem"
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
            "-keyout", key, "-out", certificate,
        ], check=True, capture_output=True)
        cls.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        cls.tls.load_cert_chain(certificate, key)
        cls.trusted_client = ssl.create_default_context(cafile=certificate)

    @contextlib.contextmanager
    def fixture(self, body_reply=None, metadata_reply=None, host="localhost", trusted=True, uid=99, metadata_command=None):
        with socketserver.TCPServer(("127.0.0.1", 0), IMAPFixture) as server:
            server.timeout = 2
            server.tls = self.tls
            server.commands = []
            server.flags = set()
            server.metadata_reply = metadata_reply if metadata_reply is not None else metadata()
            server.body_reply = body_reply if body_reply is not None else literal("2.1", 40, 99, BODY, uid_first=True)
            server.uid = uid
            server.metadata_command = metadata_command
            thread = threading.Thread(target=server.handle_request, daemon=True)
            thread.start()
            context = patch.object(mail, "_tls_context", return_value=self.trusted_client) if trusted else contextlib.nullcontext()
            with patch.multiple(mail, HOST=host, PORT=server.server_address[1]), context:
                yield server
            thread.join(timeout=6)
            self.assertFalse(thread.is_alive(), "IMAP connection was not closed")

    def assert_commands(self, server, *commands):
        self.assertEqual(server.commands[0], b"CAPABILITY")
        self.assertEqual([command for command in server.commands if command != b"CAPABILITY"], [
            f'LOGIN {USERNAME} "{PASSWORD}"'.encode(), b"EXAMINE INBOX", *commands,
        ])
        self.assertEqual(server.flags, set())

    def test_lists_recent_headers_in_one_read_only_fetch(self):
        with self.fixture() as server:
            result = mail.read_mail(USERNAME, PASSWORD, {"limit": 2})
        self.assertEqual(result, {"status": "ok", "uidvalidity": 345, "messages": [
            {"uid": uid, "from": "Fixture <fixture@example.test>", "subject": "Daily update",
             "date": "Tue, 17 Nov 2026 09:00:00 +0000"} for uid in (99, 94)
        ]})
        self.assert_commands(server, b"FETCH 39:40 (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)]<0.2048>)")

    def test_fetches_only_inline_text_after_large_attachment_and_redacts_password(self):
        with self.fixture() as server:
            result = mail.read_mail(USERNAME, PASSWORD, {"uid": 99, "uidvalidity": 345})
        self.assertEqual(result["message"]["text"], "Plain text fixture. [redacted]")
        self.assertEqual(result["message"]["uid"], 99)
        self.assertEqual(result["uidvalidity"], 345)
        self.assert_commands(server, METADATA_COMMAND, TEXT_COMMAND)

    def test_html_and_named_plain_text_return_headers_without_a_body_fetch(self):
        for structure in (
            b'("TEXT" "HTML" NIL NIL NIL "7BIT" 130 4 NIL NIL)',
            b'("TEXT" "PLAIN" NIL NIL NIL "7BIT" 100 4 NIL ("INLINE" ("FILENAME" "named.txt")))',
            b'("TEXT" "PLAIN" ("NAME*0*" "name.txt") NIL NIL "7BIT" 100 4 NIL NIL)',
        ):
            with self.subTest(structure=structure), self.fixture(metadata_reply=metadata(structure=structure)) as server:
                result = mail.read_mail(USERNAME, PASSWORD, {"uid": 99, "uidvalidity": 345})
            self.assertEqual(result["message"]["text"], "")
            self.assert_commands(server, METADATA_COMMAND)

    def test_reads_base64_root_text_in_its_declared_charset(self):
        text = "Pâté".encode("iso-8859-1")
        structure = b'("TEXT" "PLAIN" ("CHARSET" "ISO-8859-1") NIL NIL "BASE64" 8 1 NIL NIL)'
        with self.fixture(metadata_reply=metadata(structure=structure),
                          body_reply=literal("1", 40, 99, base64.b64encode(text), uid_first=True)) as server:
            result = mail.read_mail(USERNAME, PASSWORD, {"uid": 99, "uidvalidity": 345})
        self.assertEqual(result["message"]["text"], "Pâté")
        self.assert_commands(server, METADATA_COMMAND, ROOT_TEXT_COMMAND)

    def test_jobs_read_keeps_conflicting_recipient_hints_and_uses_only_safe_commands(self):
        headers = HEADER[:-2] + (
            b"X-Pm-Original-To: luigi.k7mq@luigigirke.com\r\n"
            b"X-Pm-Original-To: luigi.z8wx@luigigirke.com\r\n"
            b"In-Reply-To: <fixture-ses-id@email.amazonses.com>\r\n\r\n"
        )
        for complete in [True, False]:
            raw = headers if complete else headers[:-2]
            reply = literal(mail.REPLY_HEADER_SECTION, 40, 99, raw, uid_first=True,
                            extra=b" BODYSTRUCTURE " + STRUCTURE)
            with self.subTest(complete=complete), self.fixture(metadata_reply=reply) as server:
                result = mail.read_mail(USERNAME, PASSWORD, {"uid": 99, "uidvalidity": 345},
                                        jobs_reply_headers=True)
            self.assertEqual(result["status"], "ok")
            hints = result["message"]["reply_header_hints"]
            if complete:
                self.assertEqual(hints["x-pm-original-to"],
                                 ["luigi.k7mq@luigigirke.com", "luigi.z8wx@luigigirke.com"])
                self.assertEqual(hints["in-reply-to"], ["<fixture-ses-id@email.amazonses.com>"])
            else:
                self.assertEqual(hints, {})
            self.assert_commands(server, JOBS_METADATA_COMMAND, TEXT_COMMAND)

    def test_jobs_sender_forgery_cannot_override_the_first_smtp_recipient(self):
        def trace(address):
            return (f"Received: from outbound.example (EHLO outbound.example) ([192.0.2.12]) "
                    f"by smtp.purelymail.com (Purelymail SMTP) with ESMTPS id -112111539 "
                    f"for <{address}> (version=TLSv1.3 cipher=TLS_AES_256_GCM_SHA384); "
                    "Tue, 17 Nov 2026 12:06:48 +0000 (UTC)\r\n").encode()

        real = "luigi.v6qy@luigigirke.com"
        bare = "luigi@luigigirke.com"
        fake = "luigi.z8wx@luigigirke.com"
        for address, initial_trace, original, expected in [
            (real, trace(real), real, {"kind": "application_address", "address": real}),
            (bare, trace(bare), bare, {"kind": "bare_mailbox"}),
            (real, b"Received: from unknown by unknown\r\n", real, {"kind": "unverified"}),
            (real, trace(real), fake, {"kind": "unverified"}),
        ]:
            with self.subTest(address=address, expected=expected):
                headers = HEADER[:-2] + initial_trace + trace(fake) + (
                    f"X-Pm-Original-To: {original}\r\nX-Pm-Original-To: {fake}\r\n\r\n".encode()
                )
                reply = literal(mail.REPLY_HEADER_SECTION, 40, 99, headers, uid_first=True,
                                extra=b" BODYSTRUCTURE " + STRUCTURE)
                with self.fixture(metadata_reply=reply) as server:
                    result = mail.read_mail(USERNAME, PASSWORD, {"uid": 99, "uidvalidity": 345},
                                            jobs_reply_headers=True)
                self.assertEqual(result["message"]["recipient_evidence"], expected)
                self.assert_commands(server, JOBS_METADATA_COMMAND, TEXT_COMMAND)

    def test_refuses_stale_mailbox_before_any_fetch(self):
        with self.fixture() as server:
            result = mail.read_mail(USERNAME, PASSWORD, {"uid": 99, "uidvalidity": 12})
        self.assertEqual(result, {"status": "stale_mailbox"})
        self.assert_commands(server)

    def test_missing_message_and_unexpected_uid_have_safe_results(self):
        request = {"uid": 99, "uidvalidity": 345}
        with self.fixture(metadata_reply=b""):
            self.assertEqual(mail.read_mail(USERNAME, PASSWORD, request), {"status": "message_missing"})
        with self.fixture(metadata_reply=metadata(uid=94)):
            self.assertEqual(mail.read_mail(USERNAME, PASSWORD, request), {"status": "unavailable"})
        with self.fixture(body_reply=b""):
            self.assertEqual(mail.read_mail(USERNAME, PASSWORD, request), {"status": "message_missing"})
        with self.fixture(body_reply=literal("2.1", 39, 94, BODY, uid_first=True)):
            self.assertEqual(mail.read_mail(USERNAME, PASSWORD, request), {"status": "unavailable"})

    def test_refuses_uidvalidity_change_between_fetches(self):
        with self.fixture(metadata_reply=metadata() + b"* OK [UIDVALIDITY 346] changed\r\n") as server:
            self.assertEqual(mail.read_mail(USERNAME, PASSWORD, {"uid": 99, "uidvalidity": 345}), {"status": "stale_mailbox"})
        self.assert_commands(server, METADATA_COMMAND)

    def test_refuses_malformed_structure_before_fetching_parts(self):
        with self.fixture(metadata_reply=metadata(structure=b'(NIL NIL)')) as server:
            self.assertEqual(mail.read_mail(USERNAME, PASSWORD, {"uid": 99, "uidvalidity": 345}), {"status": "unavailable"})
        self.assert_commands(server, METADATA_COMMAND)

    def test_rejects_oversized_literal_and_line(self):
        for reply in (b"* 40 FETCH (UID 99 BODY[2.1]<0> {654321000}\r\n", b"* OK " + b"x" * 8192 + b"\r\n"):
            with self.subTest(size=len(reply)), self.fixture(body_reply=reply):
                self.assertEqual(mail.read_mail(USERNAME, PASSWORD, {"uid": 99, "uidvalidity": 345}), {"status": "unavailable"})

    def test_tls_certificate_and_hostname_checks_precede_authentication(self):
        for options in ({"trusted": False}, {"host": "127.0.0.1"}):
            with self.subTest(options=options), self.fixture(**options) as server:
                self.assertEqual(mail.read_mail(USERNAME, PASSWORD, {"limit": 1}), {"status": "unavailable"})
                self.assertEqual(server.commands, [])


class MailRequestTest(unittest.TestCase):
    def test_rejects_other_mailboxes_commands_out_of_range_and_bool(self):
        invalid = [
            {"limit": 1, "mailbox": "other@example.test"}, {"command": "STORE"}, {"limit": 0},
            {"limit": 21}, {"limit": True}, {"uid": 2}, {"uid": 0, "uidvalidity": 1},
            {"uid": 2**32, "uidvalidity": 1}, {"uid": 1, "uidvalidity": "1"}, None,
        ]
        for request in invalid:
            with self.subTest(request=request), self.assertRaises(ValueError):
                mail.validate_request(request)

    def test_worker_rejects_injected_requests_without_emitting_credentials(self):
        for request in ({"limit": 1, "mailbox": "other@example.test"}, {"limit": "x" * mail.MAX_INPUT_BYTES}):
            with self.subTest():
                run = subprocess.run(
                    [sys.executable, "-IB", mail.__file__],
                    input=json.dumps({"username": USERNAME, "password": PASSWORD, "request": request}).encode(),
                    check=True, capture_output=True, timeout=2,
                )
                self.assertEqual(json.loads(run.stdout), {"status": "unavailable"})
                self.assertEqual(run.stderr, b"")


if __name__ == "__main__":
    unittest.main()
