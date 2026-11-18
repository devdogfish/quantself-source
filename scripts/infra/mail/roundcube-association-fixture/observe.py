"""Disposable IMAP lookup through the same parser used by the Jobs mailbox worker."""

import contextlib
import imaplib
import json
import re
import sys
import tempfile
from pathlib import Path
from socketserver import ThreadingTCPServer
from threading import Thread
from time import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "roundcube-http-fixture"))
sys.path.insert(0, str(HERE.parents[3] / "agents" / "vaultwarden"))
from imap_peer import FixturePeer, UIDVALIDITY
from mail import _fetch_responses, _parse_number, _uidvalidity

SECTION = "HEADER.FIELDS (MESSAGE-ID)"
LIMIT = 320
LINE_LIMIT = 1024


class FixtureIMAP(imaplib.IMAP4):
    def __init__(self, *args, **kwargs):
        self.remaining_bytes = 8192
        super().__init__(*args, **kwargs)

    def read(self, size):
        if not 0 <= size <= min(LIMIT, self.remaining_bytes):
            raise ValueError("IMAP literal exceeds response budget")
        data = super().read(size)
        if len(data) != size:
            raise ValueError("Incomplete IMAP literal")
        self.remaining_bytes -= size
        return data

    def readline(self):
        limit = min(LINE_LIMIT, self.remaining_bytes)
        if not limit:
            raise ValueError("IMAP response budget exhausted")
        # Use imaplib's buffer for lines and literals on all supported Python versions.
        line = super().readline()
        if len(line) > limit or not line.endswith(b"\r\n"):
            raise ValueError("Incomplete or oversize IMAP line")
        self.remaining_bytes -= len(line)
        return line


def observe(client, account, query):
    expected = query["messageId"].encode("ascii")
    if query["folder"] != "INBOX" or not re.fullmatch(rb"<[!-~]+@[A-Za-z0-9.-]+>", expected) or b'"' in expected or b"\\" in expected:
        return None

    if client.select("INBOX", readonly=True)[0] != "OK":
        return None
    epoch = _uidvalidity(client, required=True)
    if epoch != query["uidValidity"]:
        return None

    code, candidates = client.uid("SEARCH", None, "HEADER", "Message-ID", b'"' + expected + b'"')
    if code != "OK" or len(candidates) != 1 or candidates[0] is None or _uidvalidity(client) not in (None, epoch):
        return None
    uids = [_parse_number(value, 1) for value in candidates[0].split()]
    if len(set(uids)) != len(uids) or len(uids) > 8:
        return None

    matches = []
    if uids:
        code, data = client.uid("FETCH", ",".join(map(str, uids)), f"(UID BODY.PEEK[{SECTION}]<0.{LIMIT}>)")
        if code != "OK" or _uidvalidity(client) not in (None, epoch):
            return None
        key = f"BODY[{SECTION}]<0>".encode("ascii")
        seen = set()
        for fields in _fetch_responses(data):
            if set(fields) != {b"UID", key}:
                return None
            uid = _parse_number(fields[b"UID"], 1)
            if uid in seen or uid not in uids:
                return None
            seen.add(uid)
            text = re.fullmatch(rb"(?i:Message-ID):[ \t]*(<[!-~]+>)[ \t]*\r\n\r\n", fields[key])
            if not text:
                return None
            if text[1] == expected:
                matches.append({"uid": uid, "messageId": query["messageId"]})
        if seen != set(uids):
            return None

    return {"challenge": query["challenge"], "account": account, "folder": "INBOX",
            "uidValidity": epoch, "observedAt": int(time()), "matches": matches}


def run(query, mode):
    with tempfile.TemporaryDirectory() as tmp, ThreadingTCPServer(("127.0.0.1", 0), FixturePeer) as server:
        server.epoch = UIDVALIDITY
        server.fetch_fault = mode
        server.command_log = Path(tmp) / "commands"
        thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
        thread.start()
        try:
            account = "other@example.test" if mode == "other-account" else "jobs@example.test"
            with FixtureIMAP(*server.server_address, timeout=3) as client:
                client.login(account, "fixture-only")
                result = observe(client, account, query)
        finally:
            server.shutdown()
            thread.join()
        return {"observation": result, "commands": server.command_log.read_text().splitlines()}


if __name__ == "__main__":
    imaplib._MAXLINE = LINE_LIMIT
    request = json.load(sys.stdin)
    with contextlib.redirect_stdout(sys.stderr):
        result = run(request, sys.argv[1])
    print(json.dumps(result))
