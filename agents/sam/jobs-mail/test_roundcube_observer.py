"""Offline fixture for the real TLS observer and its one-request Unix socket protocol."""

import argparse
import contextlib
import hashlib
import io
import json
import socketserver
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "vaultwarden"))
from jobs_roundcube_observer import MAILBOX, handle
from roundcube_imap import HEADER_LIMIT, MAX_ATTACHMENT_PARTS, SECTION, STRUCTURE_LINE_LIMIT


SECRET = b"synthetic app password"
ID = b"<roundcube-proof@example.test>"
SEARCH = b'UID SEARCH HEADER Message-ID "' + ID + b'"'
FETCH = f"UID FETCH 42 (UID BODY.PEEK[{SECTION}]<0.{HEADER_LIMIT}>)".encode("ascii")
FETCH_PARTS = FETCH[:-1] + b" BODYSTRUCTURE)"
QUERY = {"challenge": str(uuid.uuid4()), "folder": "INBOX", "uidValidity": 120, "messageId": ID.decode("ascii")}
ATTACHMENT_QUERY = {**QUERY, "attachmentUid": 42}
TEXT = b'("TEXT" "PLAIN" NIL NIL NIL "7BIT" 37 1 NIL NIL)'
FILE = b'("APPLICATION" "PDF" NIL NIL NIL "BASE64" 64 NIL ("ATTACHMENT" ("FILENAME" "fixture.pdf")))'
INLINE = FILE.replace(b'"ATTACHMENT"', b'"INLINE"')
ENCAPSULATED = (b'("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 128 (NIL NIL NIL NIL NIL NIL NIL NIL NIL NIL) '
                + FILE + b' 3 NIL ("ATTACHMENT" NIL))')
MIME = b'(' + TEXT + b'(' + INLINE + FILE + b' "MIXED" NIL NIL)' + FILE + ENCAPSULATED + b' "MIXED" NIL NIL)'


def row(uid, value=ID, *, raw=None, uid_first=True, structure=None):
    if raw is None:
        raw = b"Message-ID: " + value + b"\r\n\r\n"
    uid_item = f"UID {uid}".encode("ascii")
    section = f"BODY[{SECTION}]<0> {{{len(raw)}}}".encode("ascii")
    mime = b"" if structure is None else b" BODYSTRUCTURE " + structure
    if uid_first:
        return b"* 1 FETCH (" + uid_item + b" " + section + b"\r\n" + raw + mime + b")\r\n"
    return b"* 2 FETCH (" + section + b"\r\n" + raw + mime + b" " + uid_item + b")\r\n"


class TLSPeer(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            with self.server.tls.wrap_socket(self.request, server_side=True) as transport:
                transport.settimeout(4)
                greeting = b"* PREAUTH fixture\r\n" if self.server.mode == "preauth" else b"* OK fixture\r\n"
                transport.sendall(greeting)
                with transport.makefile("rb") as wire:
                    for line in wire:
                        tag, command = line.removesuffix(b"\r\n").split(b" ", 1)
                        self.server.commands.append(command)
                        if self.server.mode == "slow" and command == SEARCH:
                            for _ in range(4):
                                time.sleep(0.2)
                                transport.sendall(b"* OK still searching\r\n")
                        payload, status = self.reply(command)
                        transport.sendall(payload + tag + b" " + status + b"\r\n")
        except OSError:
            pass

    def reply(self, command):
        mode = self.server.mode
        ok = b"OK fixture"
        if command == b"CAPABILITY":
            return b"* CAPABILITY IMAP4rev1\r\n", ok
        if command.startswith(b"LOGIN "):
            expected = (f'LOGIN {MAILBOX} "'.encode("ascii") + SECRET + b'"')
            return b"", ok if command == expected and mode != "wrong-account" else b"NO account denied"
        if command == b"EXAMINE INBOX":
            flags = b"[READ-WRITE]" if mode == "writeable" else b"[READ-ONLY]"
            return b"* 10 EXISTS\r\n* OK [UIDVALIDITY 120] fixture\r\n", b"OK " + flags + b" fixture"
        if command == SEARCH:
            responses = {
                "duplicate": b"* SEARCH 42 43\r\n",
                "partial": b"* SEARCH 42 43\r\n",
                "substring": b"* SEARCH 42 43\r\n",
                "empty": b"* SEARCH\r\n",
                "no-search": b"",
                "two-search": b"* SEARCH 42\r\n* SEARCH 43\r\n",
                "expunge": b"* SEARCH 42\r\n* 1 EXPUNGE\r\n",
                "early-row": row(42) + b"* SEARCH 42\r\n",
                "too-many": b"* SEARCH 1 2 3 4 5 6 7 8 9\r\n",
                "wire-limit": b"* OK " + b"x" * 900 + b"\r\n",
                "epoch-search": b"* SEARCH 42\r\n* OK [UIDVALIDITY 121] changed\r\n",
            }
            payload = responses.get(mode, b"* SEARCH 42\r\n")
            if mode == "wire-limit":
                payload *= 10
            return payload, ok
        if command in (FETCH, FETCH.replace(b"42 ", b"42,43 ")):
            responses = {
                "duplicate": row(42) + row(43, uid_first=False),
                "substring": row(42) + row(43, ID.upper(), uid_first=False),
                "wrong-uid": row(43),
                "duplicate-row": row(42) + row(42),
                "duplicate-header": row(42, raw=b"Message-ID: " + ID + b"\r\nMessage-ID: " + ID + b"\r\n\r\n"),
                "oversize": row(42, raw=b"x" * (HEADER_LIMIT + 1)),
                "truncated": row(42, raw=b"Message-ID: " + ID + b"\r\n"),
                "epoch-fetch": row(42) + b"* OK [UIDVALIDITY 121] changed\r\n",
                "arrival": row(42) + b"* 11 EXISTS\r\n",
            }
            return responses.get(mode, row(42)), b"NO rejected" if mode == "rejected-fetch" else ok
        if command in (FETCH_PARTS, FETCH_PARTS.replace(b"42 ", b"42,43 ")):
            valid = row(42, structure=MIME, uid_first=False)
            responses = {
                "no-parts": row(42, structure=TEXT),
                "single-part": row(42, structure=FILE),
                "duplicate": valid + row(43, structure=MIME),
                "substring": valid + row(43, ID.upper(), structure=MIME),
                "wrong-id": row(42, ID.upper(), structure=MIME),
                "wrong-uid": row(43, structure=MIME),
                "epoch-fetch": valid + b"* OK [UIDVALIDITY 121] changed\r\n",
                "missing-structure": row(42),
                "unbalanced-structure": row(42, structure=MIME[:-1]),
                "invalid-disposition": row(42, structure=FILE.replace(b'("ATTACHMENT" ("FILENAME" "fixture.pdf"))', b'"ATTACHMENT"')),
                "invalid-body-size": row(42, structure=FILE.replace(b" 64 ", b" -1 ")),
                "duplicate-structure": row(42, structure=MIME + b" BODYSTRUCTURE " + MIME),
                "oversize-line": row(42, structure=MIME.replace(b"fixture.pdf", b"x" * STRUCTURE_LINE_LIMIT)),
                "oversize-total": (b"* OK " + b"x" * 900 + b"\r\n") * 10 + valid,
                "oversize-literal": row(42, structure=FILE.replace(b'"fixture.pdf"', b"{321}\r\n" + b"x" * 321)),
                "too-many-parts": row(42, structure=b"(" + FILE * (MAX_ATTACHMENT_PARTS + 1) + b' "MIXED")'),
                "too-deep": row(42, structure=b"(" * 9 + FILE + b' "MIXED")' * 9),
            }
            return responses.get(mode, valid), ok
        return b"", b"BAD unexpected command"


def certificates(directory):
    key = directory / "key.pem"
    cert = directory / "certificate.pem"
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
        "-addext", "subjectAltName=DNS:localhost", "-keyout", key, "-out", cert,
    ], check=True, capture_output=True)
    server = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server.load_cert_chain(cert, key)
    client = ssl.create_default_context(cafile=cert)
    pin = hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert.read_text())).hexdigest()
    return server, client, pin


@contextlib.contextmanager
def tls_peer(tls, mode):
    with socketserver.ThreadingTCPServer(("127.0.0.1", 0), TLSPeer) as peer:
        peer.tls, peer.mode, peer.commands = tls, mode, []
        thread = threading.Thread(target=peer.serve_forever, kwargs={"poll_interval": 0.01})
        thread.start()
        try:
            yield peer
        finally:
            peer.shutdown()
            thread.join()


def observe_fixture(request, credential, peer, trust, pin, host="localhost"):
    return handle(request, credential, pin=pin, host=host, port=peer.server_address[1], tls_context=lambda: trust)


class ObservationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        scratch = tempfile.TemporaryDirectory()
        cls.addClassCleanup(scratch.cleanup)
        root = Path(scratch.name)
        cls.tls, cls.trust, cls.pin = certificates(root)
        cls.credential = root / "imap"
        cls.credential.write_bytes(SECRET + b"\n")

    def run_peer(self, mode="ok", *, tls=None, pin=None, host="localhost", query=QUERY):
        with tls_peer(self.tls, mode) as peer:
            incoming = io.BytesIO(json.dumps(query).encode("ascii") + b"\n")
            observed = observe_fixture(incoming, self.credential, peer, tls or self.trust, pin or self.pin, host)
        return observed, peer.commands

    def test_exact_and_complete(self):
        result, commands = self.run_peer()
        stamp = result["observedAt"]
        self.assertLessEqual(abs(int(time.time()) - stamp), 1)
        self.assertEqual(result, {"challenge": QUERY["challenge"], "folder": "INBOX", "uidValidity": 120,
                                 "observedAt": stamp, "account": MAILBOX,
                                 "matches": [{"uid": 42, "messageId": QUERY["messageId"]}]})
        self.assertEqual([command for command in commands if command != b"CAPABILITY"], [
            f'LOGIN {MAILBOX} "'.encode("ascii") + SECRET + b'"', b"EXAMINE INBOX", SEARCH, FETCH,
        ])
        empty, commands = self.run_peer("empty")
        self.assertEqual(empty["matches"], [])
        self.assertNotIn(FETCH, commands)
        duplicate, commands = self.run_peer("duplicate")
        self.assertEqual([item["uid"] for item in duplicate["matches"]], [42, 43])
        self.assertEqual([item for item in commands if item.startswith(b"UID FETCH")], [FETCH.replace(b"42 ", b"42,43 ")])
        substring, _ = self.run_peer("substring")
        self.assertEqual([item["uid"] for item in substring["matches"]], [42])

    def test_tls_requires_chain_hostname_and_pin_before_login(self):
        for options in ({"pin": "0" * 64}, {"host": "127.0.0.1"}, {"tls": ssl.create_default_context()}):
            with self.subTest(options=options):
                result, commands = self.run_peer(**options)
                self.assertIsNone(result)
                self.assertEqual(commands, [])

    def test_attachment_discovery_uses_the_existing_uid_fetch(self):
        for mode, expected in (("ok", ["2.2", "3"]), ("no-parts", []), ("single-part", ["1"]),
                               ("substring", ["2.2", "3"])):
            with self.subTest(mode=mode):
                result, commands = self.run_peer(mode, query=ATTACHMENT_QUERY)
                self.assertEqual(result["matches"], [
                    {"uid": 42, "messageId": QUERY["messageId"], "attachmentParts": expected},
                ])
                fetch = FETCH_PARTS.replace(b"42 ", b"42,43 ") if mode == "substring" else FETCH_PARTS
                self.assertEqual([command for command in commands if command != b"CAPABILITY"], [
                    f'LOGIN {MAILBOX} "'.encode("ascii") + SECRET + b'"', b"EXAMINE INBOX", SEARCH, fetch,
                ])

    def test_exact_id_resolve_captures_epoch_and_rejects_epoch_drift(self):
        query = {key: value for key, value in QUERY.items() if key != "uidValidity"}
        result, commands = self.run_peer(query={**query, "mode": "resolve"})
        self.assertEqual(result["uidValidity"], QUERY["uidValidity"])
        self.assertEqual(result["matches"], [{"uid": 42, "messageId": QUERY["messageId"]}])
        self.assertEqual([command for command in commands if command != b"CAPABILITY"], [
            f'LOGIN {MAILBOX} "'.encode("ascii") + SECRET + b'"', b"EXAMINE INBOX", SEARCH, FETCH,
        ])
        result, _ = self.run_peer("epoch-fetch", query={**query, "mode": "resolve"})
        self.assertIsNone(result)
        for invalid in (query, {**QUERY, "mode": "resolve"}, {**query, "mode": "resolve", "attachmentUid": 42}):
            result, commands = self.run_peer(query=invalid)
            self.assertIsNone(result)
            self.assertEqual(commands, [])

    def test_attachment_discovery_rejects_invalid_or_wrong_message_evidence(self):
        for mode in ("wrong-id", "wrong-uid", "duplicate", "epoch-fetch", "missing-structure",
                     "unbalanced-structure", "invalid-disposition", "invalid-body-size", "duplicate-structure",
                     "oversize-line", "oversize-total", "oversize-literal", "too-many-parts", "too-deep"):
            with self.subTest(mode=mode):
                result, commands = self.run_peer(mode, query=ATTACHMENT_QUERY)
                self.assertIsNone(result)
                self.assertEqual(sum(command.startswith(b"UID FETCH ") for command in commands), 1)
        result, commands = self.run_peer(query={**ATTACHMENT_QUERY, "attachmentUid": 43})
        self.assertIsNone(result)
        self.assertIn(SEARCH, commands)
        self.assertFalse(any(command.startswith(b"UID FETCH ") for command in commands))

    def test_exact_account_requires_login_and_readonly_examine(self):
        for mode in ("preauth", "wrong-account", "writeable"):
            with self.subTest(mode=mode):
                result, commands = self.run_peer(mode)
                self.assertIsNone(result)
                self.assertNotIn(SEARCH, commands)
                if mode == "preauth":
                    self.assertFalse(any(command.startswith(b"LOGIN") for command in commands))

    def test_incomplete_or_mutating_transcripts_fail_closed(self):
        for mode in ("no-search", "two-search", "expunge", "early-row", "too-many", "wire-limit", "epoch-search",
                     "partial", "wrong-uid", "duplicate-row", "duplicate-header", "oversize", "truncated",
                     "epoch-fetch", "arrival", "rejected-fetch"):
            with self.subTest(mode=mode):
                result, _ = self.run_peer(mode)
                self.assertIsNone(result)

    def test_bad_query_never_opens_imap(self):
        for query in ({**QUERY, "account": MAILBOX}, {**QUERY, "messageId": "<x@y>\r\n"},
                      {**QUERY, "challenge": "old"}, {**QUERY, "uidValidity": True},
                      *({**QUERY, "attachmentUid": invalid} for invalid in (0, True, None, "42", 4294967296))):
            with self.subTest(query=query):
                result, commands = self.run_peer(query=query)
                self.assertIsNone(result)
                self.assertEqual(commands, [])
        repeated = io.BytesIO(b'{"folder":"INBOX","folder":"INBOX"}\n')
        self.assertIsNone(handle(repeated, self.credential, pin=self.pin))
        oversized = io.BytesIO(b" " * 1024 + json.dumps(QUERY).encode("ascii") + b"\n")
        self.assertIsNone(handle(oversized, self.credential, pin=self.pin))

    def test_deadline_does_not_reset_when_peer_sends_progress(self):
        with tls_peer(self.tls, "slow") as peer, patch("roundcube_imap.LOOKUP_SECONDS", 0.5):
            incoming = io.BytesIO(json.dumps(QUERY).encode("ascii") + b"\n")
            started = time.monotonic()
            result = observe_fixture(incoming, self.credential, peer, self.trust, self.pin)
            self.assertIsNone(result)
            self.assertLess(time.monotonic() - started, 0.75)
            self.assertIn(SEARCH, peer.commands)


def bridge(path, requests, epoch_drift_last):
    """Fixture-only socket serving the production handler over actual local TLS."""
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        tls, trust, pin = certificates(root)
        credential = root / "imap"
        credential.write_bytes(SECRET + b"\n")
        with tls_peer(tls, "ok") as peer:
            class Request(socketserver.StreamRequestHandler):
                def handle(self):
                    self.connection.settimeout(4)
                    result = observe_fixture(self.rfile, credential, peer, trust, pin)
                    self.wfile.write(json.dumps(result).encode("ascii") + b"\n")

            with socketserver.UnixStreamServer(path, Request) as server:
                print("ready", flush=True)
                for attempt in range(requests):
                    if epoch_drift_last and attempt == requests - 1:
                        peer.mode = "epoch-fetch"
                    server.handle_request()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--bridge":
        parser = argparse.ArgumentParser()
        parser.add_argument("--bridge", required=True)
        parser.add_argument("--requests", type=int, default=1, choices=range(1, 6))
        parser.add_argument("--epoch-drift-last", action="store_true")
        args = parser.parse_args()
        bridge(args.bridge, args.requests, args.epoch_drift_last)
    else:
        unittest.main()
