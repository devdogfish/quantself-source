"""Bounded, read-only IMAP observation for an exact Jobs Message-ID."""

import hashlib
import hmac
import imaplib
import re
import time
from contextlib import suppress

from mail import MAX_UID, _fetch_responses, _has_parameter, _parameters, _parse_number, _uidvalidity


SECTION = "HEADER.FIELDS (MESSAGE-ID)"
HEADER_LIMIT = 320
MAX_CANDIDATES = 8
WIRE_LIMIT = 8192
LINE_LIMIT = 1024
STRUCTURE_LINE_LIMIT = 4096
MAX_ATTACHMENT_PARTS = 16
MAX_PART_DEPTH = 8
LOOKUP_SECONDS = 3
ATOM = r"[!#$%&'*+/=?^_`{|}~A-Za-z0-9-]+"
MESSAGE_ID = re.compile(rf"<{ATOM}(?:\.{ATOM})*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*>", re.ASCII)
HEADER = re.compile(rb"(?i:Message-ID):[ \t]*(<[!-~]+>)[ \t]*\r\n\r\n")
PIN = re.compile(r"[0-9a-f]{64}")
CHALLENGE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
MIME_TOKEN = re.compile(rb'[^\x00-\x20\x7f-\xff()<>@,;:\\"/\[\]?=]+')


def validate_query(query):
    required = {"challenge", "folder", "messageId"}
    if not isinstance(query, dict):
        raise ValueError("Invalid IMAP observation query")
    resolving = query.get("mode") == "resolve"
    allowed = query.keys() == required | {"mode"} if resolving else (
        required | {"uidValidity"} <= query.keys() <= required | {"uidValidity", "attachmentUid"}
    )
    if (not allowed
            or not isinstance(query["challenge"], str) or not CHALLENGE.fullmatch(query["challenge"])
            or query["folder"] != "INBOX"
            or ("uidValidity" in query and (type(query["uidValidity"]) is not int
                or not 1 <= query["uidValidity"] <= MAX_UID))
            or not isinstance(query["messageId"], str) or len(query["messageId"]) > 254
            or not MESSAGE_ID.fullmatch(query["messageId"])
            or ("attachmentUid" in query and ("uidValidity" not in query or type(query["attachmentUid"]) is not int
                or not 1 <= query["attachmentUid"] <= MAX_UID))):
        raise ValueError("Invalid IMAP observation query")


class PinnedIMAP(imaplib.IMAP4_SSL):
    """Use one receive buffer for both imaplib lines and literals."""

    def __init__(self, host, port, tls, pin, include_structure=False):
        if not tls.check_hostname or not PIN.fullmatch(pin):
            raise ValueError("Invalid IMAP trust configuration")
        self.pin = pin
        self.deadline = time.monotonic() + LOOKUP_SECONDS
        self.remaining = WIRE_LIMIT
        self.line_limit = STRUCTURE_LINE_LIMIT if include_structure else LINE_LIMIT
        self.buffer = bytearray()
        super().__init__(host, port, ssl_context=tls, timeout=LOOKUP_SECONDS)

    def _create_socket(self, timeout):
        transport = super()._create_socket(timeout)
        if not hmac.compare_digest(hashlib.sha256(transport.getpeercert(binary_form=True)).hexdigest(), self.pin):
            transport.close()
            raise ValueError("IMAP TLS pin mismatch")
        return transport

    def _remaining_time(self):
        seconds = self.deadline - time.monotonic()
        if seconds <= 0:
            raise TimeoutError("IMAP observation deadline")
        return seconds

    def _receive(self):
        if not self.remaining:
            raise self.abort("IMAP response budget exhausted")
        self.sock.settimeout(self._remaining_time())
        data = self.sock.recv(min(LINE_LIMIT, self.remaining))
        if not data:
            raise self.abort("Incomplete IMAP response")
        self.remaining -= len(data)
        self.buffer.extend(data)

    def send(self, data):
        self.sock.settimeout(self._remaining_time())
        super().send(data)

    def read(self, size):
        if not 0 <= size <= HEADER_LIMIT:
            raise self.abort("IMAP literal exceeds projection limit")
        while len(self.buffer) < size:
            self._receive()
        data = bytes(self.buffer[:size])
        del self.buffer[:size]
        return data

    def readline(self):
        while True:
            end = self.buffer.find(b"\n") + 1
            if end:
                if end > self.line_limit or self.buffer[end - 2:end] != b"\r\n":
                    raise self.abort("Invalid IMAP response line")
                data = bytes(self.buffer[:end])
                del self.buffer[:end]
                return data
            if len(self.buffer) >= self.line_limit:
                raise self.abort("IMAP line exceeds response limit")
            self._receive()


def _require_stable(client, epoch):
    if (_uidvalidity(client) not in (None, epoch)
            or {"EXPUNGE", "VANISHED", "EXISTS", "READ-WRITE"}.intersection(client.untagged_responses)):
        raise ValueError("IMAP mailbox changed during observation")


def _mime_token(value):
    if not isinstance(value, bytes) or not MIME_TOKEN.fullmatch(value):
        raise ValueError("Invalid MIME token")
    return value.upper()


def _disposition(value):
    if value is None:
        return None, {}
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError("Invalid MIME disposition")
    return _mime_token(value[0]), _parameters(value[1])


def _attachment_parts(structure):
    parts = []

    def visit(node, path, discoverable):
        if not isinstance(node, list) or not node or len(path) > MAX_PART_DEPTH:
            raise ValueError("Invalid MIME structure")
        if isinstance(node[0], list):
            split = next((index for index, field in enumerate(node) if not isinstance(field, list)), len(node))
            if split == len(node):
                raise ValueError("Missing multipart subtype")
            _mime_token(node[split])
            params = _parameters(node[split + 1] if len(node) > split + 1 else None)
            disposition, fields = _disposition(node[split + 2] if len(node) > split + 2 else None)
            visible = (discoverable and disposition in (None, b"INLINE")
                       and not _has_parameter(params, b"NAME") and not _has_parameter(fields, b"FILENAME"))
            for index, child in enumerate(node[:split], 1):
                visit(child, (*path, index), visible)
            return

        if len(node) < 7:
            raise ValueError("Incomplete MIME body fields")
        media, subtype = map(_mime_token, node[:2])
        if media == b"MULTIPART":
            raise ValueError("Multipart body lacks children")
        _parameters(node[2])
        if any(field is not None and not isinstance(field, bytes) for field in node[3:5]):
            raise ValueError("Invalid MIME body fields")
        _mime_token(node[5])
        _parse_number(node[6], 0)
        extensions = 7
        if media == b"TEXT":
            if len(node) < 8:
                raise ValueError("Missing MIME text line count")
            _parse_number(node[7], 0)
            extensions = 8
        elif media == b"MESSAGE" and subtype == b"RFC822":
            if len(node) < 10 or not isinstance(node[7], list) or len(node[7]) != 10:
                raise ValueError("Invalid encapsulated message")
            visit(node[8], (*path, 1), False)
            _parse_number(node[9], 0)
            extensions = 10
        if len(node) > extensions and node[extensions] is not None and not isinstance(node[extensions], bytes):
            raise ValueError("Invalid MIME digest")
        disposition, _ = _disposition(node[extensions + 1] if len(node) > extensions + 1 else None)
        if discoverable and media != b"MESSAGE" and disposition == b"ATTACHMENT":
            if len(parts) == MAX_ATTACHMENT_PARTS:
                raise ValueError("Attachment part budget exceeded")
            parts.append(".".join(map(str, path or (1,))))

    visit(structure, (), True)
    return parts


def _examine(client, query):
    code, counts = client.select("INBOX", readonly=True)
    if code != "OK" or "READ-ONLY" not in client.untagged_responses or len(counts) != 1:
        raise ValueError("IMAP INBOX was not examined read-only")
    count = _parse_number(counts[0], 0)
    client.response("EXISTS")
    epoch = _uidvalidity(client, required=True)
    if "uidValidity" in query and epoch != query["uidValidity"]:
        raise ValueError("IMAP epoch mismatch")
    _require_stable(client, epoch)
    if any(client.response(code)[1] != [None] for code in ("SEARCH", "FETCH")):
        raise ValueError("Unexpected IMAP results before search")

    expected = query["messageId"].encode("ascii")
    code, results = client.uid("SEARCH", None, "HEADER", "Message-ID", b'"' + expected + b'"')
    _require_stable(client, epoch)
    if code != "OK" or len(results) != 1 or results[0] is None or client.response("FETCH")[1] != [None]:
        raise ValueError("Incomplete IMAP search")
    raw_uids = results[0].split()
    if len(raw_uids) > min(MAX_CANDIDATES, count):
        raise ValueError("IMAP candidate budget exceeded")
    uids = {_parse_number(value, 1) for value in raw_uids}
    if len(uids) != len(raw_uids):
        raise ValueError("Duplicate IMAP search result")
    attachment_uid = query.get("attachmentUid")
    if attachment_uid is not None and attachment_uid not in uids:
        raise ValueError("Attachment message not found")
    if not uids:
        return epoch, []

    key = f"BODY[{SECTION}]<0>".encode("ascii")
    projection = {b"UID", key}
    structure = ""
    if attachment_uid is not None:
        projection.add(b"BODYSTRUCTURE")
        structure = " BODYSTRUCTURE"
    code, fragments = client.uid("FETCH", ",".join(map(str, sorted(uids))),
                                 f"(UID BODY.PEEK[{SECTION}]<0.{HEADER_LIMIT}>{structure})")
    _require_stable(client, epoch)
    if code != "OK" or client.response("SEARCH")[1] != [None]:
        raise ValueError("Incomplete IMAP fetch")
    seen = set()
    matches = []
    for fields in _fetch_responses(fragments):
        if set(fields) != projection:
            raise ValueError("Unexpected IMAP fetch projection")
        uid = _parse_number(fields[b"UID"], 1)
        if uid in seen or uid not in uids:
            raise ValueError("Unexpected IMAP fetch UID")
        seen.add(uid)
        raw = fields[key]
        header = HEADER.fullmatch(raw) if isinstance(raw, bytes) else None
        if header is None:
            raise ValueError("Incomplete or ambiguous Message-ID header")
        parts = _attachment_parts(fields[b"BODYSTRUCTURE"]) if attachment_uid is not None else None
        if header[1] == expected:
            match = {"uid": uid, "messageId": query["messageId"]}
            if uid == attachment_uid:
                match["attachmentParts"] = parts
            matches.append(match)
    if seen != uids:
        raise ValueError("Missing IMAP fetch result")
    if attachment_uid is not None and (len(matches) != 1 or matches[0]["uid"] != attachment_uid):
        raise ValueError("Attachment message did not match uniquely")
    return epoch, matches


def observe(query, *, account, password, host, port, tls, pin):
    try:
        validate_query(query)
        if not re.fullmatch(r"[a-z0-9._+%-]{1,64}@[a-z0-9.-]{1,189}", account) or not re.fullmatch(r"[ -~]{1,256}", password):
            return None
        client = PinnedIMAP(host, port, tls, pin, include_structure="attachmentUid" in query)
        try:
            if client.state != "NONAUTH" or client.login(account, password)[0] != "OK":
                return None
            epoch, matches = _examine(client, query)
            client._remaining_time()
            return {
                "challenge": query["challenge"], "account": account, "folder": "INBOX",
                "uidValidity": epoch, "observedAt": int(time.time()), "matches": matches,
            }
        finally:
            with suppress(OSError):
                client.shutdown()
    except (OSError, imaplib.IMAP4.error, ValueError, TypeError):
        return None
