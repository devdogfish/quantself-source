"""Bind a Jobs reply to stored inbound evidence and reserve one SES dispatch."""

import contextlib
import fcntl
import hashlib
import imaplib
import json
import re
import sqlite3
import subprocess
import uuid
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from mail import BoundedIMAP, MAX_UID, _by_uid, _jobs_smtp_recipient, _uidvalidity


SECTION = "HEADER.FIELDS (RECEIVED X-PM-ORIGINAL-TO AUTHENTICATION-RESULTS FROM REPLY-TO MESSAGE-ID IN-REPLY-TO REFERENCES AUTO-SUBMITTED SUBJECT)"
MAX_HEADERS = 8192
MAX_BODY = 16_000
MAILBOX = "luigi@luigigirke.com"
TRANSPORT = Path("/usr/local/libexec/quantself-jobs-mail/send-reply.js")
RECIPIENT = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+", re.ASCII)
MESSAGE_ID = re.compile(r"<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+>", re.ASCII)
SES_REFERENCE = re.compile(r"<[A-Za-z0-9-]{1,256}@email\.amazonses\.com>")
PASS = re.compile(r"^dmarc=pass(?: \([^()]*\))? header\.from=([^\s;]+)$", re.I)
KEY = re.compile(r"[A-Za-z0-9._~+/=-]{8,4096}", re.ASCII)
UNCERTAIN = {"status": "outcome_uncertain"}


def validate_reply(request):
    if not isinstance(request, dict) or set(request) != {"action", "uid", "uidvalidity", "command_id", "body", "api_key"}:
        raise ValueError("invalid reply request")
    if request["action"] != "reply" or not all(
        type(request[key]) is int and 1 <= request[key] <= MAX_UID for key in ("uid", "uidvalidity")
    ):
        raise ValueError("invalid reply reference")
    if type(request["command_id"]) is not str or str(uuid.UUID(request["command_id"])) != request["command_id"]:
        raise ValueError("invalid command ID")
    if type(request["body"]) is not str or not request["body"].strip() or len(request["body"].encode()) > MAX_BODY:
        raise ValueError("invalid reply text")
    if type(request["api_key"]) is not str or not KEY.fullmatch(request["api_key"]):
        raise ValueError("missing scoped Jobs client")


def _single_address(message, name):
    values = message.get_all(name, [])
    if len(values) != 1 or values[0].defects or len(values[0].addresses) != 1:
        return None
    address = values[0].addresses[0].addr_spec
    return address if len(address) <= 254 and RECIPIENT.fullmatch(address) else None


def reply_evidence(raw):
    if not raw.endswith((b"\r\n\r\n", b"\n\n")):
        return None
    msg = BytesParser(policy=policy.default).parsebytes(raw, headersonly=True)
    envelope = _jobs_smtp_recipient(msg)
    if envelope["kind"] != "application_address":
        return None
    recipient = _single_address(msg, "From")
    if not recipient or recipient.lower().endswith(("@luigigirke.com", "@dawnshiftagency.com")):
        return None
    local, domain = recipient.lower().rsplit("@", 1)
    if re.fullmatch(r"(?:do[._-]?not[._-]?reply|no[._-]?reply|mailer-daemon|postmaster)(?:[+._-].*)?", local):
        return None
    if msg.get_all("Reply-To", []) and _single_address(msg, "Reply-To") != recipient:
        return None
    auto_submitted = [str(value).strip().lower() for value in msg.get_all("Auto-Submitted", [])]
    if auto_submitted and auto_submitted != ["no"]:
        return None

    # On the qualified SMTP path Purelymail adds its authentication result
    # ahead of its first Received field. Ignore any lower lookalike.
    ordered = [(name.lower(), str(value)) for name, value in msg.items()]
    top = next(index for index, (name, _) in enumerate(ordered) if name == "received")
    authentication = [value for name, value in ordered[:top] if name == "authentication-results"]
    if len(authentication) != 1:
        return None
    authority, *results = " ".join(authentication[0].split()).split(";")
    if authority.lower() != "purelymail.com":
        return None
    dmarc = [text.strip() for text in results if text.strip().lower().startswith("dmarc=")]
    match = PASS.fullmatch(dmarc[0]) if len(dmarc) == 1 else None
    if not match or match[1].lower() not in {recipient.lower(), domain}:
        return None
    ids = list(map(str, msg.get_all("Message-ID", [])))
    subjects = list(map(str, msg.get_all("Subject", [])))
    if len(ids) != 1 or len(ids[0]) > 255 or not MESSAGE_ID.fullmatch(ids[0]) or len(subjects) != 1:
        return None
    subject = subjects[0] if subjects[0].lower().startswith("re:") else f"Re: {subjects[0]}"
    if not subjects[0].strip() or len(subject) > 200 or any(char in subject for char in "\r\n\0"):
        return None
    direct_references = set(SES_REFERENCE.findall(" ".join(map(str, msg.get_all("In-Reply-To", [])))))
    if len(direct_references) > 1:
        return None
    references = SES_REFERENCE.findall(" ".join(map(str, msg.get_all("References", []))))
    application_reference = next(iter(direct_references), references[-1] if references else None)
    result = {"from": envelope["address"], "to": recipient, "subject": subject, "inReplyTo": ids[0]}
    if application_reference:
        result["application_reference"] = application_reference
    return result


def read_evidence(password, request):
    client = BoundedIMAP()
    try:
        client.login(MAILBOX, password)
        if client.select("INBOX", readonly=True)[0] != "OK":
            return {"status": "mail_unavailable"}
        if _uidvalidity(client, required=True) != request["uidvalidity"]:
            return {"status": "stale_mailbox"}
        row = _by_uid(client, request["uid"], f"(UID BODY.PEEK[{SECTION}]<0.{MAX_HEADERS}>)", SECTION, MAX_HEADERS)
        if _uidvalidity(client) not in (None, request["uidvalidity"]):
            return {"status": "stale_mailbox"}
        if row is None:
            return {"status": "message_missing"}
        return reply_evidence(row[0]) or {"status": "recipient_unverified"}
    except (OSError, ValueError, imaplib.IMAP4.error):
        return {"status": "mail_unavailable"}
    finally:
        with contextlib.suppress(OSError):
            client.shutdown()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def jobs_application(origin, token, address, reference=None):
    url = urlsplit(origin)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.path not in ("", "/") or url.query or url.fragment:
        return {"status": "jobs_unavailable"}
    api = build_opener(NoRedirect)
    base = origin.rstrip("/") + "/api/v1/jobs/applications"
    headers = {"X-API-Key": token, "Content-Type": "application/json"}

    def fetch(path, data=None):
        with api.open(Request(path, data=data, headers=headers), timeout=5) as res:
            return json.loads(res.read(131073))

    try:
        evidence = {"address": address}
        if reference:
            evidence["inReplyTo"] = reference
        matched = fetch(base + "/resolve-reply", json.dumps(evidence).encode())["id"]
        if str(uuid.UUID(matched)) != matched:
            return {"status": "jobs_unavailable"}
        application = fetch(f"{base}/{matched}/lifecycle")["application"]
        if application["id"] != matched or not application.get("appliedAt"):
            return {"status": "application_not_submitted"}
        updated = datetime.fromisoformat(application["updatedAt"])
        if updated.tzinfo is None or (datetime.now(timezone.utc) - updated).total_seconds() < 180:
            return {"status": "application_edit_hold"}
        return {"application_id": matched}
    except HTTPError as error:
        if error.code == 409:
            return {"status": "conflicting_match"}
        if error.code == 404:
            return {"status": "unissued_or_missing_application"}
        return {"status": "jobs_unavailable"}
    except (OSError, ValueError, TypeError, KeyError):
        return {"status": "jobs_unavailable"}


def send_packet(packet, credential):
    # The per-request systemd credential is only available to the service UID.
    try:
        result = subprocess.run(["/usr/local/bin/bun", str(TRANSPORT), str(credential)], input=json.dumps(packet).encode(),
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=38, check=True)
        reply = json.loads(result.stdout)
        if reply == {"kind": "not_sent"}:
            return {"status": "not_sent"}
        receipt = reply.get("messageId")
        if reply.get("kind") == "accepted" and isinstance(receipt, str) and re.fullmatch(r"[A-Za-z0-9-]{1,256}", receipt):
            return {"status": "sent", "message_id": receipt}
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        pass
    return UNCERTAIN


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def send_reply(state, password, request, origin, credential, *, evidence=read_evidence,
               lookup=jobs_application, transport=send_packet):
    validate_reply(request)
    command = request["command_id"]
    # Persist an intent hash, with no email content or API key in the journal.
    intent = _hash({key: request[key] for key in ("uidvalidity", "uid", "body")})
    with (state / "reply.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"status": "busy"}
        with contextlib.closing(sqlite3.connect(state / "actions.db")) as db:
            db.execute("""CREATE TABLE IF NOT EXISTS reply_delivery (
                id TEXT PRIMARY KEY, intent TEXT NOT NULL, inbound TEXT NOT NULL,
                application_id TEXT NOT NULL, uidvalidity INTEGER NOT NULL, uid INTEGER NOT NULL,
                result TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )""")
            db.execute("CREATE INDEX IF NOT EXISTS reply_delivery_inbound ON reply_delivery (inbound)")
            previous = db.execute("SELECT intent, result FROM reply_delivery WHERE id=?", (command,)).fetchone()
            if previous:
                if previous[0] != intent:
                    return {"status": "conflict"}
                return json.loads(previous[1]) if previous[1] else UNCERTAIN
            if not credential.is_file() or not TRANSPORT.is_file():
                return {"status": "sender_unconfigured"}
            packet = evidence(password, request)
            if "status" in packet:
                return packet
            inbound = _hash({key: packet[key] for key in ("from", "to", "inReplyTo")})
            previous = db.execute("SELECT result FROM reply_delivery WHERE inbound=?", (inbound,)).fetchall()
            for (result,) in previous:
                parsed = json.loads(result) if result else UNCERTAIN
                if parsed["status"] != "not_sent":
                    return {"status": "already_sent", "message_id": parsed["message_id"]} if parsed["status"] == "sent" else UNCERTAIN
            reply_reference = packet.pop("application_reference", None)
            application = lookup(origin, request["api_key"], packet["from"], reply_reference)
            if "status" in application:
                return application
            with db:
                db.execute("INSERT INTO reply_delivery (id,intent,inbound,application_id,uidvalidity,uid) VALUES (?,?,?,?,?,?)",
                           (command, intent, inbound, application["application_id"], request["uidvalidity"], request["uid"]))
            result = transport({**packet, "body": request["body"]}, credential)
            with db:
                db.execute("UPDATE reply_delivery SET result=? WHERE id=?", (json.dumps(result), command))
            return result
