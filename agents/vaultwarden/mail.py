"""Read one business inbox over verified TLS. Run inside the vault service boundary."""

import contextlib
import imaplib
import ipaddress
import json
import re
import ssl
import sys
from email import policy
from email.errors import MessageError
from email.message import EmailMessage
from email.parser import BytesParser


HOST = "imap.purelymail.com"
PORT = 993
MAX_UID = 4294967295
MAX_MESSAGES = 20
HEADER_BYTES = 2048
MESSAGE_BYTES = 65536
FIELD_BYTES = 256
TEXT_BYTES = 4096
MAX_INPUT_BYTES = 4096
MAX_OUTPUT_BYTES = 30000
HEADER_SECTION = "HEADER.FIELDS (FROM SUBJECT DATE)"
REPLY_HEADER_NAMES = ("to", "cc", "in-reply-to", "references", "x-pm-original-to", "x-pm-known-alias")
REPLY_HEADER_SECTION = "HEADER.FIELDS (FROM SUBJECT DATE RECEIVED " + " ".join(REPLY_HEADER_NAMES).upper() + ")"
REPLY_HEADER_BYTES = 8192
APPLICATION_ADDRESS = re.compile(r"luigi\.[23456789a-hjkmnp-z]{4}@luigigirke\.com", re.ASCII)
SMTP_TRACE = re.compile(
    r"from [A-Za-z0-9.-]+ \(EHLO [A-Za-z0-9.-]+\) \(\[([0-9A-Fa-f:.]+)\]\) "
    r"by smtp\.purelymail\.com \(Purelymail SMTP\) with ESMTPS? id -?[0-9]+ "
    r"for <([a-z0-9.@_-]+)>(?: \(version=[A-Za-z0-9.]+ cipher=[A-Za-z0-9_-]+\))?; "
    r"[A-Za-z]{3}, [0-9]{1,2} [A-Za-z]{3} [0-9]{4} [0-9:]{8} \+0000 \(UTC\)",
    re.ASCII,
)
FETCH_TOKEN = re.compile(rb' +|[()]|"(?:[^"\\\r\n]|\\["\\])*"|BODY\[[^\]\r\n]*\]<0>|\{[0-9]+\}|[^ ()"{}\[\]\r\n]+', re.I)
OPEN = object()
CLOSE = object()


def validate_request(request):
    if isinstance(request, dict):
        if request.keys() == {"limit"} and type(request["limit"]) is int and 1 <= request["limit"] <= MAX_MESSAGES:
            return
        if request.keys() == {"uid", "uidvalidity"} and all(
            type(value) is int and 1 <= value <= MAX_UID for value in request.values()
        ):
            return
    raise ValueError("invalid business mail request")


def _tls_context():
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_default_certs()
    return context


class BoundedIMAP(imaplib.IMAP4_SSL):
    def __init__(self):
        self.remaining_bytes = 128 * 1024
        self.remaining_lines = 128
        super().__init__(HOST, PORT, ssl_context=_tls_context(), timeout=5)

    def read(self, size):
        if not 0 <= size <= min(MESSAGE_BYTES, self.remaining_bytes):
            raise self.abort("oversized IMAP literal")
        data = super().read(size)
        if len(data) != size:
            raise self.abort("truncated IMAP literal")
        self.remaining_bytes -= size
        return data

    def readline(self):
        if not self.remaining_lines or not self.remaining_bytes:
            raise self.abort("IMAP reply limit reached")
        data = super().readline()
        if len(data) > min(8192, self.remaining_bytes):
            raise self.abort("oversized IMAP line")
        self.remaining_lines -= 1
        self.remaining_bytes -= len(data)
        return data


def _parse_number(raw, minimum):
    if not isinstance(raw, bytes) or not re.fullmatch(rb"[0-9]{1,10}", raw):
        raise ValueError("invalid IMAP number")
    parsed = int(raw)
    if not minimum <= parsed <= MAX_UID:
        raise ValueError("IMAP number out of range")
    return parsed


def _tokens(line, literal):
    position = 0
    for match in FETCH_TOKEN.finditer(line):
        if match.start() != position:
            raise ValueError("invalid FETCH token")
        position = match.end()
        token = match[0]
        if token == b"(":
            yield OPEN
        elif token == b")":
            yield CLOSE
        elif token.startswith(b"{"):
            if literal is None or position != len(line) or _parse_number(token[1:-1], 0) != len(literal):
                raise ValueError("invalid FETCH literal")
            yield literal
            literal = None
        elif token.startswith(b'"'):
            yield re.sub(rb'\\(["\\])', rb'\1', token[1:-1])
        elif not token.startswith(b" "):
            yield None if token.upper() == b"NIL" else token
    if position != len(line) or literal is not None:
        raise ValueError("incomplete FETCH fragment")


def _fetch_responses(data):
    # imaplib separates each literal from the surrounding response line.
    stack = [[]]
    for fragment in data:
        if fragment is None:
            continue
        if isinstance(fragment, tuple):
            if len(fragment) != 2 or not all(isinstance(value, bytes) for value in fragment):
                raise ValueError("invalid FETCH literal fragment")
            line, literal = fragment
        else:
            line, literal = fragment, None
            if not isinstance(line, bytes):
                raise ValueError("invalid FETCH line")
        for token in _tokens(line, literal):
            if token is OPEN:
                if len(stack) >= 24:
                    raise ValueError("FETCH nesting limit")
                nested = []
                stack[-1].append(nested)
                stack.append(nested)
            elif token is CLOSE:
                if len(stack) == 1:
                    raise ValueError("unexpected FETCH close")
                stack.pop()
            else:
                stack[-1].append(token)
        if literal is not None:
            continue
        if len(stack) != 1 or len(stack[0]) != 2 or not isinstance(stack[0][1], list):
            raise ValueError("incomplete FETCH response")
        sequence, fields = stack[0]
        _parse_number(sequence, 1)
        yield _field_map(fields)
        stack = [[]]
    if stack != [[]]:
        raise ValueError("unfinished FETCH response")


def _field_map(fields):
    if len(fields) % 2 or not all(isinstance(field, bytes) for field in fields[::2]):
        raise ValueError("invalid field pairs")
    result = dict(zip((field.upper() for field in fields[::2]), fields[1::2]))
    if len(result) * 2 != len(fields):
        raise ValueError("duplicate fields")
    return result


def _fetch_rows(reply, section, max_rows, max_bytes, include_structure=False):
    status, data = reply
    if status != "OK":
        raise ValueError("IMAP fetch failed")
    section_key = f"BODY[{section}]<0>".encode("ascii")
    rows = {}
    for fields in _fetch_responses(data or ()):
        if section_key not in fields:
            if set(fields) - {b"UID", b"FLAGS"}:
                raise ValueError("unexpected FETCH section")
            continue  # Unsolicited flag update.
        uid = _parse_number(fields.get(b"UID"), 1)
        raw = fields[section_key]
        structure = fields.get(b"BODYSTRUCTURE")
        if (uid in rows or len(rows) >= max_rows or not isinstance(raw, bytes) or len(raw) > max_bytes
                or (include_structure and not isinstance(structure, list))):
            raise ValueError("unexpected FETCH row")
        rows[uid] = (raw, structure)
    return rows


def _display(value, password, max_bytes):
    value = str(value).replace(password, "[redacted]")
    compact_password = password.replace(" ", "")
    if compact_password and compact_password != password:
        value = value.replace(compact_password, "[redacted]")
    value = value.replace("\r\n", "\n")
    value = "".join(char if char.isprintable() or char in "\n\t" else " " for char in value)
    return value.encode("utf-8")[:max_bytes].decode("utf-8", errors="ignore").strip()


def _headers(message, password, uid):
    return {"uid": uid} | {name: _display(message.get(name, ""), password, FIELD_BYTES) for name in ("from", "subject", "date")}


def _parameters(params):
    if params is None:
        return {}
    if not isinstance(params, list) or not all(isinstance(value, bytes) for value in params):
        raise ValueError("invalid MIME parameters")
    return _field_map(params)


def _has_parameter(params, name):
    return any(key == name or key.startswith(name + b"*") for key in params)


def _inline(disposition):
    if disposition is None:
        return True
    return (isinstance(disposition, list) and len(disposition) == 2
            and isinstance(disposition[0], bytes) and disposition[0].upper() == b"INLINE"
            and not _has_parameter(_parameters(disposition[1]), b"FILENAME"))


def _plain_part(structure, path=()):
    if not structure:
        raise ValueError("missing MIME structure")
    if isinstance(structure[0], list):
        split = next((index for index, field in enumerate(structure) if not isinstance(field, list)), len(structure))
        children = list(enumerate(structure[:split], start=1))
        subtype, params, disposition = (structure[split:] + [None, None, None])[:3]
        if not isinstance(subtype, bytes):
            raise ValueError("missing multipart subtype")
        params = _parameters(params)
        if not _inline(disposition) or _has_parameter(params, b"NAME"):
            return None
        if subtype.upper() == b"RELATED":
            start = params.get(b"START")
            # Only the related root is visible text. Other parts are resources for it.
            children = children[:1] if not start else [
                (index, child) for index, child in children
                if len(child) > 3 and isinstance(child[0], bytes) and child[3] == start
            ]
        for index, child in children:
            plain = _plain_part(child, path + (index,))
            if plain is not None:
                return plain
        return None

    if len(structure) < 7 or not all(isinstance(field, bytes) for field in structure[:2]):
        raise ValueError("invalid MIME body structure")
    if tuple(field.upper() for field in structure[:2]) != (b"TEXT", b"PLAIN"):
        return None
    if len(structure) < 8 or not isinstance(structure[5], bytes):
        raise ValueError("invalid plain text structure")
    params = _parameters(structure[2])
    disposition = structure[9] if len(structure) > 9 else None
    if _has_parameter(params, b"NAME") or not _inline(disposition):
        return None
    encoding = structure[5].upper()
    if encoding not in {b"7BIT", b"8BIT", b"BINARY", b"BASE64", b"QUOTED-PRINTABLE"}:
        return None
    section = ".".join(str(index) for index in (path or (1,)))
    return section, params.get(b"CHARSET", b"UTF-8"), encoding


def _text(raw, charset, encoding, password):
    part = EmailMessage(policy=policy.default)
    part["Content-Transfer-Encoding"] = encoding.decode("ascii")
    part.set_payload(raw)
    payload = part.get_payload(decode=True)
    try:
        text = payload.decode(charset.decode("ascii"), errors="replace")
    except (LookupError, UnicodeError):
        text = payload.decode("utf-8", errors="replace")
    return _display(text, password, TEXT_BYTES)


def _uidvalidity(connection, required=False):
    _, values = connection.response("UIDVALIDITY")
    if values == [None] and not required:
        return None
    validities = {_parse_number(value, 1) for value in values}
    if len(validities) != 1:
        raise ValueError("ambiguous UIDVALIDITY")
    return validities.pop()


def _by_uid(connection, uid, items, section, max_bytes, include_structure=False):
    reply = connection.uid("FETCH", str(uid), items)
    rows = _fetch_rows(reply, section, 1, max_bytes, include_structure=include_structure)
    if rows and uid not in rows:
        raise ValueError("unexpected message UID")
    return rows.get(uid)


def _jobs_smtp_recipient(message):
    traces = message.get_all("Received", [])
    originals = message.get_all("X-Pm-Original-To", [])
    if not traces or not originals:
        return {"kind": "unverified"}
    # An SMTP receiver prepends its trace. Older Received fields and any
    # duplicate alias metadata can be present in sender-controlled MIME.
    match = SMTP_TRACE.fullmatch(" ".join(str(traces[0]).split()))
    if not match:
        return {"kind": "unverified"}
    remote, address = match.groups()
    try:
        ipaddress.ip_address(remote)
    except ValueError:
        return {"kind": "unverified"}
    if str(originals[0]).strip() != address:
        return {"kind": "unverified"}
    if APPLICATION_ADDRESS.fullmatch(address):
        return {"kind": "application_address", "address": address}
    if address == "luigi@luigigirke.com":
        return {"kind": "bare_mailbox"}
    if address.startswith("luigi.") and address.endswith("@luigigirke.com"):
        return {"kind": "unsupported_application_address"}
    return {"kind": "unverified"}


def _read_inbox(connection, password, request, *, jobs_reply_headers=False):
    status, counts = connection.select("INBOX", readonly=True)
    if status != "OK":
        raise ValueError("IMAP examine failed")
    count = _parse_number(counts[-1], 0)
    uidvalidity = _uidvalidity(connection, required=True)
    parser = BytesParser(policy=policy.default)
    header_item = f"BODY.PEEK[{HEADER_SECTION}]<0.{HEADER_BYTES}>"

    if "limit" in request:
        limit = request["limit"]
        rows = {}
        if count:
            sequence = f"{max(1, count - limit + 1)}:{count}"
            reply = connection.fetch(sequence, f"(UID {header_item})")
            rows = _fetch_rows(reply, HEADER_SECTION, limit, HEADER_BYTES)
            if _uidvalidity(connection) not in (None, uidvalidity):
                return {"status": "stale_mailbox"}
        messages = [
            _headers(parser.parsebytes(rows[uid][0], headersonly=True), password, uid)
            for uid in sorted(rows, reverse=True)
        ]
        return {"status": "ok", "uidvalidity": uidvalidity, "messages": messages}

    if request["uidvalidity"] != uidvalidity:
        return {"status": "stale_mailbox"}
    uid = request["uid"]
    header_section = REPLY_HEADER_SECTION if jobs_reply_headers else HEADER_SECTION
    header_bytes = REPLY_HEADER_BYTES if jobs_reply_headers else HEADER_BYTES
    header_item = f"BODY.PEEK[{header_section}]<0.{header_bytes}>"
    message = _by_uid(connection, uid, f"(UID {header_item} BODYSTRUCTURE)", header_section, header_bytes,
                      include_structure=True)
    if _uidvalidity(connection) not in (None, uidvalidity):
        return {"status": "stale_mailbox"}
    if message is None:
        return {"status": "message_missing"}
    header, structure = message
    parsed_headers = parser.parsebytes(header, headersonly=True)
    result = _headers(parsed_headers, password, uid) | {"text": ""}
    if jobs_reply_headers:
        # These fields are message content. They can suggest a match, but do not attest to the envelope.
        complete_headers = header.endswith((b"\r\n\r\n", b"\n\n"))
        result["reply_header_hints"] = {
            name: [_display(value, password, 1024) for value in parsed_headers.get_all(name, [])[:4]]
            for name in REPLY_HEADER_NAMES
        } if complete_headers else {}
        result["recipient_evidence"] = (
            _jobs_smtp_recipient(parsed_headers) if complete_headers else {"kind": "unverified"}
        )
    plain = _plain_part(structure)
    if plain is not None:
        section, charset, encoding = plain
        body = _by_uid(connection, uid, f"(UID BODY.PEEK[{section}]<0.{MESSAGE_BYTES}>)", section, MESSAGE_BYTES)
        if _uidvalidity(connection) not in (None, uidvalidity):
            return {"status": "stale_mailbox"}
        if body is None:
            return {"status": "message_missing"}
        result["text"] = _text(body[0], charset, encoding, password)
    return {"status": "ok", "uidvalidity": uidvalidity, "message": result}


def read_mail(username, password, request, *, jobs_reply_headers=False):
    try:
        validate_request(request)
        if (not isinstance(username, str) or not re.fullmatch(r"[a-z0-9._+%-]{1,64}@[a-z0-9.-]{1,189}", username)
                or not isinstance(password, str) or not re.fullmatch(r"[ -~]{1,256}", password)):
            raise ValueError("invalid IMAP credential")
        connection = BoundedIMAP()
        try:
            connection.login(username, password)
            return _read_inbox(connection, password, request, jobs_reply_headers=jobs_reply_headers)
        finally:
            with contextlib.suppress(OSError):
                connection.shutdown()
    except (OSError, imaplib.IMAP4.error, MessageError, ValueError, LookupError, RecursionError):
        return {"status": "unavailable"}


def main():
    result = {"status": "unavailable"}
    incoming = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(incoming) <= MAX_INPUT_BYTES:
        try:
            request = json.loads(incoming)
            if isinstance(request, dict) and request.keys() == {"username", "password", "request"}:
                result = read_mail(**request)
        except (ValueError, TypeError, RecursionError):
            pass
    outgoing = json.dumps(result, ensure_ascii=False).encode("utf-8") + b"\n"
    if len(outgoing) > MAX_OUTPUT_BYTES:
        outgoing = b'{"status": "unavailable"}\n'
    sys.stdout.buffer.write(outgoing)


if __name__ == "__main__":
    main()
