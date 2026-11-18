"""Qualify the Jobs reply journal and SES packet with a fixture-only review gate."""

import json
import hashlib
import os
import sqlite3
import ssl
import subprocess
import sys
import uuid
from contextlib import closing
from pathlib import Path
from time import perf_counter
from unittest.mock import patch
from urllib.parse import urlsplit
from urllib.request import HTTPSHandler, ProxyHandler, build_opener

from rehearse_match import MESSAGE_ID, RECRUITER, SUBJECT, UIDVALIDITY, VERIFIED_UID, TLSMailTest, literal, verified_reply_headers
import jobs_mail_reply as reply


APPROVED_BODY = "Thank you. I can attend the synthetic interview."
CHANGED_BODY = "Thank you. I can attend at a different time."
RECEIPT = "fixture-jobs-reply-102"
PASSWORD = "synthetic-imap-password"


def read_and_send(fixture, address, invoke):
    headers = literal(reply.SECTION, 40, VERIFIED_UID, verified_reply_headers(address), uid_first=True)
    command = f"UID FETCH {VERIFIED_UID} (UID BODY.PEEK[{reply.SECTION}]<0.{reply.MAX_HEADERS}>)".encode()
    with fixture.fixture(metadata_reply=headers, uid=VERIFIED_UID, metadata_command=command) as imap:
        result = invoke()
        login = f'LOGIN {reply.MAILBOX} "{PASSWORD}"'.encode()
        expected = [b"CAPABILITY", login, b"EXAMINE INBOX", command]
        refreshed = [*expected[:2], b"CAPABILITY", *expected[2:]]
        if imap.commands not in (expected, refreshed) or imap.flags:
            raise RuntimeError("Unexpected reply IMAP traffic")
        return result, len(imap.commands)


def main():
    data = json.load(sys.stdin)
    origin = os.environ["QUANTSELF_API_URL"]
    url = urlsplit(origin)
    if url.scheme != "https" or not url.port or url.netloc != f"127.0.0.1:{url.port}" or url.path or url.query or url.fragment:
        raise ValueError("Use the disposable loopback TLS Jobs API")
    if data["ref"] != {"folder": "INBOX", "uid": VERIFIED_UID, "uidvalidity": UIDVALIDITY}:
        raise ValueError("Use the verified synthetic message reference")
    address = data["address"]
    state = Path(data["state"])
    approved = {"from": address, "to": RECRUITER, "subject": SUBJECT, "inReplyTo": MESSAGE_ID, "body": APPROVED_BODY}
    credential = state / "synthetic-credential-marker"
    credential.touch(mode=0o600)
    trusted = ssl.create_default_context(cafile=os.environ["QS_FIXTURE_TLS_CERT"])
    https = build_opener(ProxyHandler({}), HTTPSHandler(context=trusted), reply.NoRedirect())
    cases = []

    def attempt(label, command_id, body, *, reviewed=False, read=True):
        request = {"action": "reply", "uid": VERIFIED_UID, "uidvalidity": UIDVALIDITY,
                   "command_id": command_id, "body": body, "api_key": os.environ["QUANTSELF_API_KEY"]}
        calls = 0
        worker_ms = None
        reached_transport = False
        started = perf_counter()

        def transport(packet, _credential):
            nonlocal calls, reached_transport, worker_ms
            reached_transport = True
            with closing(sqlite3.connect(state / "actions.db")) as db:
                reservation = db.execute("SELECT application_id, uidvalidity, uid, result FROM reply_delivery WHERE id=?",
                                         (command_id,)).fetchone()
            if reservation != (data["applicationId"], UIDVALIDITY, VERIFIED_UID, None):
                raise RuntimeError("Reply transport ran without the matching committed reservation")
            # The deployed reply path carries no per-draft Owner approval. Enforce review only in the fixture.
            if not reviewed or packet != approved:
                return {"status": "not_sent"}
            worker = subprocess.run([data["bun"], "--no-env-file", "scripts/jobs/fixtures/synthetic-threaded-reply.ts"],
                                    input=json.dumps({"packet": packet, "approved": approved, "messageId": RECEIPT}).encode(),
                                    capture_output=True, env={}, timeout=5, check=True)
            report = json.loads(worker.stdout)
            calls, worker_ms = report["calls"], report["elapsedMs"]
            if report["result"] != {"kind": "accepted", "messageId": RECEIPT} or calls != 1:
                raise RuntimeError("Unexpected fixture SES result")
            return {"status": "sent", "message_id": RECEIPT}

        def invoke():
            return reply.send_reply(state, PASSWORD, request, origin, credential, transport=transport)

        if read:
            result, imap_commands = read_and_send(fixture, address, invoke)
        else:
            with patch.object(reply, "BoundedIMAP", side_effect=AssertionError("Replay opened the mailbox")):
                result = invoke()
            imap_commands = 0
        cases.append({"case": label, "status": result["status"], "reachedTransport": reached_transport,
                      "imapCommands": imap_commands, "providerCalls": calls, "workerMs": worker_ms,
                      "elapsedMs": round((perf_counter() - started) * 1000)})
        return result

    fixture = TLSMailTest()
    fixture.setUpClass()
    try:
        with patch.object(reply, "TRANSPORT", credential), patch.object(reply, "build_opener", return_value=https):
            command_id = data["commandId"]
            receipt = {"status": "sent", "message_id": RECEIPT}
            if data["mode"] == "dispatch":
                if attempt("unapproved", str(uuid.uuid4()), APPROVED_BODY) != {"status": "not_sent"}:
                    raise RuntimeError("The fixture passed an unreviewed reply to SES")
                if attempt("edited-before-send", str(uuid.uuid4()), CHANGED_BODY, reviewed=True) != {"status": "not_sent"}:
                    raise RuntimeError("The fixture passed changed content to SES")
                if attempt("approved", command_id, APPROVED_BODY, reviewed=True) != receipt:
                    raise RuntimeError("The approved reply did not commit")
                # Drop the service response after it commits. A fresh process must recover the journal entry.
                print(json.dumps({"pid": os.getpid(), "cases": cases, "ackDropped": True,
                                  "draftSha256": hashlib.sha256(APPROVED_BODY.encode()).hexdigest()}))
            elif data["mode"] == "restart":
                replay = attempt("exact-replay", command_id, APPROVED_BODY, read=False)
                edited = attempt("edited-replay", command_id, CHANGED_BODY, read=False)
                duplicate = attempt("fresh-command", str(uuid.uuid4()), CHANGED_BODY)
                if replay != receipt or edited != {"status": "conflict"} or duplicate != {"status": "already_sent", "message_id": RECEIPT}:
                    raise RuntimeError("Unexpected durable reply replay")
                print(json.dumps({"pid": os.getpid(), "cases": cases, "receipt": replay, "inReplyTo": MESSAGE_ID}))
            else:
                raise ValueError("Invalid synthetic reply mode")
    finally:
        fixture.doClassCleanups()


if __name__ == "__main__":
    main()
