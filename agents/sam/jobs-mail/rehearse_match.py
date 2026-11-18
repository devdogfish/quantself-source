"""Read three synthetic messages through the existing loopback TLS IMAP fixture."""

import asyncio
import io
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from time import perf_counter
from unittest.mock import patch
from urllib.parse import urlsplit

# The installer places this shared mailbox reader alongside the Jobs service.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "vaultwarden"))
import jobs_mail_service as service
import plugin
from test_mail import JOBS_METADATA_COMMAND, ROOT_TEXT_COMMAND, TLSMailTest, literal, mail

VERIFIED_UID = 102
UIDVALIDITY = 345
RECRUITER = "hiring@recruiter.example"
SUBJECT = "Re: Editor at Synthetic Studio"
MESSAGE_ID = "<synthetic-editor-102@recruiter.example>"


def reply_headers(address, alias, extra):
    return (
        "Received: from recruiter.example (EHLO recruiter.example) ([192.0.2.20]) "
        "by smtp.purelymail.com (Purelymail SMTP) with ESMTPS id -112111539 "
        f"for <{address}>; Tue, 17 Nov 2026 12:06:48 +0000 (UTC)\r\n"
        f"X-Pm-Original-To: {alias}\r\n"
        f"To: {alias}\r\n"
        f"From: Synthetic Recruiter <{RECRUITER}>\r\n"
        f"Subject: {SUBJECT}\r\n"
        "Date: Tue, 17 Nov 2026 12:06:48 +0000\r\n"
        f"{extra}\r\n"
    ).encode("ascii")


def verified_reply_headers(address):
    return (f"Authentication-Results: purelymail.com; dmarc=pass header.from={RECRUITER}\r\n".encode("ascii")
            + reply_headers(address, address, f"Message-ID: {MESSAGE_ID}\r\n"))


async def read_fixture(fixture, credential, uid, header):
    body = b"Synthetic invitation for the Editor role.\r\n"
    structure = b'("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" %d 1)' % len(body)
    metadata = literal(mail.REPLY_HEADER_SECTION, 40, uid, header, uid_first=True, extra=b" BODYSTRUCTURE " + structure)
    body_reply = literal("1", 40, uid, body, uid_first=True)

    async def request(args):
        data = io.BytesIO(json.dumps(args).encode() + b"\n")
        result = await asyncio.to_thread(service.handle, data, credential)
        return json.dumps(result)

    read_started = perf_counter()
    with fixture.fixture(metadata_reply=metadata, body_reply=body_reply, uid=uid) as imap:
        with patch.object(plugin, "_request", request):
            response = json.loads(await plugin.read_jobs_mail({"uid": uid, "uidvalidity": UIDVALIDITY}))
        password = credential.read_text().strip()
        login = f'LOGIN {service.MAILBOX} "{password}"'.encode()
        fetch = [JOBS_METADATA_COMMAND.replace(b" 99 ", f" {uid} ".encode(), 1),
                 ROOT_TEXT_COMMAND.replace(b" 99 ", f" {uid} ".encode(), 1)]
        # Python 3.15 refreshes capabilities after authentication.
        expected = [b"CAPABILITY", login, b"EXAMINE INBOX", *fetch]
        refreshed = [*expected[:2], b"CAPABILITY", *expected[2:]]
        if imap.commands not in (expected, refreshed) or imap.flags:
            raise RuntimeError("Unexpected synthetic IMAP traffic")
        commands = [command.split(b" ", 1)[0].decode("ascii") for command in imap.commands[:-2]]
    if response.get("status") != "ok" or response["message"]["uid"] != uid or response["message"]["text"].strip() != body.decode().strip():
        raise RuntimeError("Synthetic IMAP message did not survive parsing")
    return {"uid": uid, "uidvalidity": response["uidvalidity"], "match": response["match"],
            "imapCommands": [*commands, "UID FETCH headers", "UID FETCH text"],
            "elapsedMs": round((perf_counter() - read_started) * 1000)}


async def main():
    address, executable = sys.argv[1:]
    origin = urlsplit(os.environ["QUANTSELF_API_URL"])
    if origin.scheme != "http" or origin.hostname != "127.0.0.1" or not origin.port or origin.netloc != f"127.0.0.1:{origin.port}" \
            or origin.path or origin.query or origin.fragment or not re.fullmatch(plugin.APP_ADDRESS, address):
        raise ValueError("Use the disposable loopback Jobs API and synthetic Application Address")
    cases = [
        (100, service.MAILBOX, ""),
        (101, address, "In-Reply-To: <first@email.amazonses.com> <second@email.amazonses.com>\r\n"),
        (VERIFIED_UID, address, ""),
    ]
    fixture = TLSMailTest()
    fixture.setUpClass()
    try:
        with tempfile.TemporaryDirectory() as directory, patch.object(plugin, "QUANTSELF", executable):
            credential = Path(directory) / "imap"
            credential.write_text("synthetic-imap-password\n")
            results = [await read_fixture(fixture, credential, uid, verified_reply_headers(address) if uid == VERIFIED_UID
                                          else reply_headers(recipient, address, extra))
                       for uid, recipient, extra in cases]
        print(json.dumps(results))
    finally:
        fixture.doClassCleanups()


if __name__ == "__main__":
    asyncio.run(main())
