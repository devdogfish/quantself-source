#!/usr/bin/env python3
"""Disposable, single-message IMAP peer for the Roundcube HTTP fixture."""

import argparse
import base64
import os
import re
import shlex
import socketserver
from pathlib import Path
from time import monotonic, sleep

import spool_fixture

ACCOUNTS = {"jobs@example.test", "other@example.test"}
PASSWORD = "fixture-only"
UID = 42
UIDVALIDITY = 120
CAPABILITIES = "IMAP4rev1 NAMESPACE"
FLAGS = r"(\Seen)"
INTERNAL_DATE = '"17-Nov-2026 12:00:00 +0000"'
BOUNDARY = "qs-roundcube-fixture-boundary"
HEADERS = (
    b"Date: Tue, 17 Nov 2026 12:00:00 +0000",
    b"From: Fixture Sender <sender@example.test>",
    b"To: jobs@example.test",
    b"Subject: Roundcube fixture original",
    b"Message-ID: <roundcube-proof@example.test>",
    b"MIME-Version: 1.0",
    f'Content-Type: multipart/mixed; boundary="{BOUNDARY}"'.encode("ascii"),
)
TEXT = b"ROUND-CUBE-FIXTURE-ORIGINAL-BODY <b> &\r\n"
ATTACHMENTS = {
    "2": ("fixture.bin", base64.b64encode(b"\x00QS-ROUND-CUBE-ATTACHMENT\xff\r\n")),
    "3": ("other.bin", base64.b64encode(b"\xffQS-ROUND-CUBE-OTHER-PART\x00\r\n")),
}
SPOOL = os.environ.get("QS_ROUNDCUBE_FIXTURE_SPOOL") == "1"
if SPOOL:
    ATTACHMENTS = {spool_fixture.SECTION: ("fixture.bin", spool_fixture.ENCODED), "3": ATTACHMENTS["3"]}
CRLF = b"\r\n"
HEADER = CRLF.join(HEADERS) + CRLF * 2
TEXT_HEADER = (
    b"Content-Type: text/plain; charset=US-ASCII" + CRLF
    + b"Content-Transfer-Encoding: 7bit" + CRLF * 2
)
DISPLAY = os.environ.get("QS_ROUNDCUBE_FIXTURE_DISPLAY") == "1"
DISPLAY_SOURCE = DISPLAY and os.environ.get("QS_ROUNDCUBE_FIXTURE_SOURCE") == "1"
HTML_MIME = b"Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n"
if DISPLAY:
    TEXT = base64.encodebytes(spool_fixture.DISPLAY_TEXT).replace(b"\n", CRLF)
    TEXT_HEADER = b"Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
DELIMITER = f"--{BOUNDARY}".encode("ascii")
TEXT_STRUCTURE = (f'"TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "BASE64" {len(TEXT)} {TEXT.count(CRLF)}'
                  if DISPLAY
                  else f'"TEXT" "PLAIN" ("CHARSET" "US-ASCII") NIL NIL "7BIT" {len(TEXT)} 1')
if DISPLAY_SOURCE:
    TEXT_STRUCTURE = f'"TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" {len(spool_fixture.DISPLAY_HTML)} 1'
basic_structure = [f"({TEXT_STRUCTURE})"]
extended_structure = [f"({TEXT_STRUCTURE} NIL NIL NIL NIL)"]
body_parts = [DELIMITER, HTML_MIME + spool_fixture.DISPLAY_HTML if DISPLAY_SOURCE else TEXT_HEADER + TEXT]
SECTIONS = {"HEADER": HEADER, "1": TEXT, "1.MIME": TEXT_HEADER}
for part, (filename, payload) in ATTACHMENTS.items():
    mime = CRLF.join((
        f'Content-Type: application/octet-stream; name="{filename}"'.encode("ascii"),
        b"Content-Transfer-Encoding: base64",
        f'Content-Disposition: attachment; filename="{filename}"'.encode("ascii"),
        b"", b"",
    ))
    structure = f'"APPLICATION" "OCTET-STREAM" ("NAME" "{filename}") NIL NIL "BASE64" {len(payload)}'
    basic = f"({structure})"
    extended = f'({structure} NIL ("ATTACHMENT" ("FILENAME" "{filename}")) NIL NIL)'
    content = mime + payload
    if part == spool_fixture.SECTION:
        nested = "qs-roundcube-nested"
        basic = f'({basic} "MIXED")'
        extended = f'({extended} "MIXED" ("BOUNDARY" "{nested}") NIL NIL NIL)'
        content = (f'Content-Type: multipart/mixed; boundary="{nested}"\r\n\r\n--{nested}\r\n'.encode("ascii")
                   + content + f'\r\n--{nested}--'.encode("ascii"))
    basic_structure.append(basic)
    extended_structure.append(extended)
    body_parts.extend((DELIMITER, content))
    SECTIONS[part] = payload
    SECTIONS[f"{part}.MIME"] = mime

BODY = CRLF.join((*body_parts, DELIMITER + b"--", b""))
SOURCE = HEADER + BODY
SECTIONS.update({"": SOURCE, "TEXT": BODY})
IDENTITY_FIELD = "BODY[HEADER.FIELDS (MESSAGE-ID)]"
IDENTITY = b"Message-ID: <roundcube-proof@example.test>" + CRLF * 2
OTHER_IDENTITY = IDENTITY.replace(b"roundcube-proof", b"roundcube-other")
RFC822_ITEMS = {"RFC822": SOURCE, "RFC822.HEADER": HEADER, "RFC822.TEXT": BODY}
FETCH_ITEMS = {
    "UID": str(UID),
    "FLAGS": FLAGS,
    "INTERNALDATE": INTERNAL_DATE,
    "RFC822.SIZE": str(len(SOURCE)),
    "BODYSTRUCTURE": f'({"".join(extended_structure)} "MIXED" ("BOUNDARY" "{BOUNDARY}") NIL NIL NIL)',
    "BODY": f'({"".join(basic_structure)} "MIXED")',
}
BODY_ITEM = re.compile(r"BODY(?:\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?")


def literal(label, data):
    return f"{label} {{{len(data)}}}\r\n".encode("ascii") + data


def fetch_item(query):
    if query in FETCH_ITEMS:
        return f"{query} {FETCH_ITEMS[query]}".encode("ascii")

    if query in RFC822_ITEMS:
        return literal(query, RFC822_ITEMS[query])

    body = BODY_ITEM.fullmatch(query)
    if not body:
        return None

    section, start, length = body.groups()
    if section.startswith("HEADER.FIELDS (") and section.endswith(")"):
        names = section[len("HEADER.FIELDS (") : -1].encode("ascii").split()
        lines = [line for line in HEADERS if line.split(b":", 1)[0].upper() in names]
        data = b"".join(line + CRLF for line in lines) + CRLF
    else:
        data = SECTIONS.get(section)
        if data is None:
            return None

    label = f"BODY[{section}]"
    if start is not None:
        offset = int(start)
        data = data[offset : offset + int(length)]
        label += f"<{offset}>"
    return literal(label, data)


def sequence_contains(spec, number):
    for element in spec.split(","):
        first, _, last = element.partition(":")
        first, last = [number if value == "*" else int(value) for value in (first, last or first)]
        if min(first, last) <= number <= max(first, last):
            return True
    return False


class FixturePeer(socketserver.StreamRequestHandler):
    def send(self, data):
        self.wfile.write((data.encode("ascii") if isinstance(data, str) else data) + CRLF)

    def hold_fixture_login(self):
        if self.server.server_address[1] != 1993:
            return
        gate = Path("/fixture-state/session-login")
        entered = gate / "entered"
        try:
            (gate / "armed").rename(entered)
        except FileNotFoundError:
            return
        deadline = monotonic() + 4
        while entered.exists():
            if monotonic() >= deadline:
                raise TimeoutError("Session concurrency fixture failed to release LOGIN")
            sleep(0.01)

    def display_fetch(self):
        case = spool_fixture.DISPLAY_CASES[self.server.display_attempt]
        self.server.display_attempt += 1
        log = "/fixture-state/display-fetch.log"
        with open(log, "a", encoding="ascii") as journal:
            journal.write(case + "\n")
        if case == "oversize-wire":
            self.send("* 1 FETCH (BODY[1] {262145}")
            self.request.settimeout(2)
            if self.rfile.read(1) == b"":
                with open(log, "a", encoding="ascii") as journal:
                    journal.write("closed-before-literal\n")
            return None
        mime = HTML_MIME if case.startswith("html") else TEXT_HEADER
        if case == "html-malformed-mime":
            mime = b"Invalid MIME field\r\n" + mime
        elif case == "html-malformed-encoding":
            mime = mime.replace(b"7bit", b"base64")
        elif case == "duplicate-type":
            mime = b"Content-Type: text/html; charset=UTF-8\r\n" + mime
        elif case == "attachment-disposition":
            mime = b"Content-Disposition: attachment\r\n" + mime
        elif case == "wrong-charset":
            mime = mime.replace(b"UTF-8", b"US-ASCII")
        body = spool_fixture.DISPLAY_HTML if case.startswith("html") else TEXT
        if case == "invalid-utf8":
            body = base64.b64encode(b"before\xffafter")
        elif case == "oversize-decoded":
            body = base64.b64encode(b"x" * 65537)
        section = "2" if case == "wrong-section" else "1"
        identity = OTHER_IDENTITY if case == "identity" else IDENTITY
        uid = b"43" if case == "html-wrong-uid" else b"42"
        self.send(b"* 1 FETCH (" + literal(f"BODY[{section}]", body) + b" UID " + uid + b" "
                  + literal(IDENTITY_FIELD, identity) + b" " + literal("BODY[1.MIME]", mime) + b")")
        if case in ("epoch", "html-epoch"):
            self.send("* OK [UIDVALIDITY 121] Selected mailbox reset")
        return "NO rejected after literal" if case == "tagged-no" else "OK FETCH completed"

    def source_fetch(self, tag):
        case = spool_fixture.SOURCE_CASES[self.server.source_attempt]
        self.server.source_attempt += 1
        journal_path = "/fixture-state/source-fetch.log"
        with open(journal_path, "a", encoding="ascii") as journal:
            journal.write(case + "\n")
        if case == "oversize":
            self.send("* 1 FETCH (BODY[] {8388609}")
            self.request.settimeout(2)
            if self.rfile.read(1) == b"":
                with open(journal_path, "a", encoding="ascii") as journal:
                    journal.write("closed-before-literal\n")
            return None
        if case == "truncated":
            self.wfile.write(f"* 1 FETCH (BODY[] {{{len(SOURCE)}}}\r\n".encode("ascii") + SOURCE[:98304])
            return None

        field = IDENTITY[:-2]
        raw = {
            "raw-id": SOURCE.replace(field, OTHER_IDENTITY[:-2], 1),
            "raw-duplicate": field + SOURCE,
            "raw-missing": SOURCE.replace(field, b"", 1),
            "oversize-header": (b"X-Pad: " + b"x" * 100 + CRLF) * 602 + SOURCE,
        }.get(case, SOURCE)
        section = "BODY[TEXT]" if case == "wrong-section" else "BODY[]"
        uid = b"43" if case == "wrong-uid" else b"42"
        projection = OTHER_IDENTITY if case == "projection-id" else IDENTITY
        self.send(b"* 1 FETCH (" + literal(section, raw) + b" UID " + uid + b" "
                  + literal(IDENTITY_FIELD, projection) + b")")
        if case == "epoch":
            self.send("* OK [UIDVALIDITY 121] Selected mailbox reset")
        if case in ("fragmented-completion", "slow-completion", "partial-completion"):
            completion = f"{tag} OK FETCH completed\r\n".encode("ascii")
            if case == "partial-completion":
                self.wfile.write(completion[:-1])
                return None
            pause = 0.32 if case == "slow-completion" else 0.01
            try:
                for byte in completion:
                    self.wfile.write(bytes([byte]))
                    sleep(pause)
            except OSError:
                # The timed-out client closes the stream during the slow reply.
                if case != "slow-completion":
                    raise
            return None
        return "NO rejected after literal" if case == "tagged-no" else "OK FETCH completed"

    def spool_fetch(self):
        case = spool_fixture.CASES[self.server.spool_attempt]
        self.server.spool_attempt += 1
        with open("/fixture-state/spool-fetch.log", "a", encoding="ascii") as journal:
            journal.write(case + "\n")
        section = "3" if case == "wrong-section" else spool_fixture.SECTION
        encoded = b"ABCD" if case == "7bit" else spool_fixture.ENCODED
        prefix = f"* 1 FETCH (BODY[{section}] ".encode("ascii")
        if case in ("oversize", "oversize-mime"):
            declaration = (prefix + b"{8388609}" if case == "oversize"
                           else f"* 1 FETCH (BODY[{section}.MIME] {{4097}}".encode("ascii"))
            self.send(declaration)
            self.request.settimeout(2)
            if self.rfile.read(1) == b"":
                with open("/fixture-state/spool-fetch.log", "a", encoding="ascii") as journal:
                    journal.write(f"closed-before-{case}\n")
            return None
        if case == "truncated":
            self.wfile.write(prefix + f"{{{len(encoded)}}}\r\n".encode("ascii") + encoded[:131072])
            return None
        identity = literal(IDENTITY_FIELD, OTHER_IDENTITY if case == "identity" else IDENTITY)
        uid = b"43" if case == "wrong-uid" else b"42"
        if case == "wrong-section":
            self.send(prefix + b"{1}")
            return None
        mime = {
            "7bit": b"cOnTeNt-TrAnSfEr-EnCoDiNg:\r\n\t7bIt\r\n\r\n",
            "duplicate-cte": b"Content-Transfer-Encoding: 7bit\r\ncontent-transfer-encoding: base64\r\n\r\n",
            "folded-spoof": b"X-Test: note\r\n Content-Transfer-Encoding: base64\r\n\r\n",
            "unsupported-cte": b"Content-Transfer-Encoding: x-fixture\r\n\r\n",
        }.get(case, SECTIONS[f"{spool_fixture.SECTION}.MIME"])
        if case in spool_fixture.TRANSFER_CASES:
            mime, encoded, _ = spool_fixture.TRANSFER_CASES[case]
            if isinstance(mime, str):
                media = "application/octet-stream" if mime == "binary" or case == "qp-binary" else "text/plain; charset=ISO-8859-1"
                mime = f"Content-Type: {media}\r\nContent-Transfer-Encoding: {mime}\r\n\r\n".encode("ascii")
        if case == "binary-literal8":
            prefix += b"~"
        mime_section = "3" if case == "wrong-mime-section" else spool_fixture.SECTION
        mime_literal = b"" if case == "missing-mime" else b" " + literal(f"BODY[{mime_section}.MIME]", mime)
        self.send(prefix + f"{{{len(encoded)}}}\r\n".encode("ascii") + encoded + b" UID " + uid
                  + b" " + identity + mime_literal + b")")
        if case == "epoch":
            self.send("* OK [UIDVALIDITY 121] Selected mailbox reset")
        return "NO rejected after literal" if case == "tagged-no" else "OK FETCH completed"

    def fetch(self, arguments, by_uid, tag):
        sequence, fields = arguments.upper().split(maxsplit=1)
        items = re.findall(r"BODY(?:\.PEEK)?\[[^\]]*\](?:<\d+\.\d+>)?|[A-Z0-9.]+", fields)
        if any(item in ("BODY[1]", "BODY.PEEK[1]") for item in items):
            method = "VIEW_BODY_VERIFIED_FETCH" if any("HEADER.FIELDS" in item for item in items) else "VIEW_BODY_NATIVE_FETCH"
            with open(getattr(self.server, "command_log", "/fixture-state/imap.log"), "a", encoding="ascii") as journal:
                journal.write(method + "\n")
        if by_uid and "UID" not in items:
            items.insert(0, "UID")
        if self.selected_epoch != self.server.epoch:
            return "NO Reselect mailbox after UIDVALIDITY change"
        if (getattr(self.server, "display_probe", False) and by_uid and sequence == str(UID)
                and items == ["UID", "BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]", "BODY.PEEK[1]", "BODY.PEEK[1.MIME]"]):
            return self.display_fetch()
        if (getattr(self.server, "source_probe", False) and by_uid and sequence == str(UID)
                and items == ["UID", "BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]", "BODY.PEEK[]"]):
            return self.source_fetch(tag)
        if (getattr(self.server, "spool_probe", False) and by_uid and sequence == str(UID)
                and items == ["UID", "BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]",
                              f"BODY.PEEK[{spool_fixture.SECTION}]", f"BODY.PEEK[{spool_fixture.SECTION}.MIME]"]):
            return self.spool_fetch()
        fault = self.server.fetch_fault
        section = "1" if fault.startswith("show-") else "2" if fault.startswith("attachment") else ""
        inject = (fault != "0" and self.selected_epoch == UIDVALIDITY and by_uid
                  and any(item in (f"BODY[{section}]", f"BODY.PEEK[{section}]") for item in items))
        reply_uid = UID
        if fault == "show-header-uid" and by_uid and "BODYSTRUCTURE" in items:
            print(f"IMAP injected FETCH fault {fault}", flush=True)
            reply_uid += 1
        completion = "OK FETCH completed"
        if inject:
            print(f"IMAP injected FETCH fault {fault}", flush=True)
            identity = literal(IDENTITY_FIELD, IDENTITY)
            prefix = f"* 1 FETCH (UID {UID} ".encode("ascii") + identity + b" "
            if fault in ("show-epoch", "show-identity"):
                projection = OTHER_IDENTITY if fault == "show-identity" else IDENTITY
                fields = [b"UID 42"]
                if any("HEADER.FIELDS" in item for item in items):
                    fields.append(literal(IDENTITY_FIELD, projection))
                changed = b"ROUND-CUBE-FIXTURE-UNVERIFIED-VIEW".ljust(len(TEXT) - len(CRLF), b" ") + CRLF
                assert len(changed) == len(TEXT)
                fields.append(literal("BODY[1]", changed))
                self.send(b"* 1 FETCH (" + b" ".join(fields) + b")")
                if fault == "show-epoch":
                    self.server.epoch += 1
                    self.selected_epoch = None
                    self.send(f"* OK [UIDVALIDITY {self.server.epoch}] Fixture mailbox reset")
                return completion
            if fault == "source-oversize":
                # Send the declaration only. A bounded reader must close without waiting for bytes.
                self.send(prefix + b"BODY[] {1025}")
                self.request.settimeout(2)
                if self.rfile.read(1) == b"":
                    print("IMAP client closed before oversized literal was sent", flush=True)
                return None
            if fault == "source-truncated":
                self.wfile.write(prefix + f"BODY[] {{{len(SOURCE)}}}\r\n".encode("ascii") + SOURCE[:23])
                return None
            if fault == "source-at-limit":
                payload = SOURCE.ljust(1024, b" ")
                self.send(b"* 1 FETCH (" + literal("BODY[]", payload) + b" " + identity + b" UID 42)")
                return completion
            if fault == "attachment-reordered":
                folded = IDENTITY.replace(b": ", b":\r\n\t", 1)
                mime = b" " + literal("BODY[2.MIME]", SECTIONS["2.MIME"]) if "BODY.PEEK[2.MIME]" in items else b""
                self.send(b"* 1 FETCH (" + literal("BODY[2]", ATTACHMENTS["2"][1])
                          + b" UID 42 " + literal(IDENTITY_FIELD.lower(), folded) + mime + b")")
                return completion
            if fault == "source-body-identity":
                other_source = SOURCE.replace(b"roundcube-proof", b"roundcube-other", 1)
                self.send(prefix + literal("BODY[]", other_source) + b")")
                return completion
            if fault == "source-mixed-newline":
                ambiguous = SOURCE.replace(
                    b"Date:", b"X-Ambiguous: 1\nMessage-ID: <roundcube-other@example.test>\r\nDate:", 1
                )
                self.send(prefix + literal("BODY[]", ambiguous) + b")")
                return completion
            if fault == "attachment-identity":
                mime = b" " + literal("BODY[2.MIME]", SECTIONS["2.MIME"]) if "BODY.PEEK[2.MIME]" in items else b""
                self.send(b"* 1 FETCH (UID 42 " + literal(IDENTITY_FIELD, OTHER_IDENTITY)
                          + b" " + literal("BODY[2]", ATTACHMENTS["3"][1]) + mime + b")")
                return completion
            if fault == "source-duplicate-identity":
                duplicate = IDENTITY[:-2] + OTHER_IDENTITY
                self.send(b"* 1 FETCH (UID 42 " + literal(IDENTITY_FIELD, duplicate)
                          + b" " + literal("BODY[]", SOURCE) + b")")
                return completion
            if fault == "source-split-fetch":
                self.send(b"* 1 FETCH (UID 42 " + identity + b")")
                self.send(b"* 1 FETCH (UID 42 " + literal("BODY[]", SOURCE) + b")")
                return completion
            if fault == "source-wrong-uid":
                reply_uid += 1
            elif fault == "attachment-wrong-section":
                items = ["BODY.PEEK[3]" if item in ("BODY[2]", "BODY.PEEK[2]") else item for item in items]
            elif fault == "source-tagged-no":
                completion = "NO Fixture command rejected after literal"
            elif fault == "source-tagged-epoch":
                completion = "OK [UIDVALIDITY 121] Fixture mailbox reset"
            elif fault not in ("source-wrong-tag", "source-epoch-after"):
                self.server.epoch += 1
                self.send(f"* OK [UIDVALIDITY {self.server.epoch}] Fixture mailbox reset")
                self.selected_epoch = None
                if fault in ("1", "attachment"):
                    return "NO UIDVALIDITY changed"
                if fault.endswith("-literal-no"):
                    completion = "NO UIDVALIDITY changed"

        parts = [f"UID {reply_uid}".encode("ascii") if item == "UID" else fetch_item(item) for item in items]
        if not parts or any(part is None for part in parts):
            return "BAD Unsupported fixture FETCH item"
        if sequence_contains(sequence, UID if by_uid else 1):
            self.send(b"* 1 FETCH (" + b" ".join(parts) + b")")
        if fault == "lookup-duplicate" and by_uid and sequence_contains(sequence, UID + 1):
            second = [f"UID {UID + 1}".encode("ascii") if item == "UID" else fetch_item(item) for item in items]
            self.send(b"* 2 FETCH (" + b" ".join(second) + b")")
        if inject and fault == "source-wrong-tag":
            self.send("Z9999 OK FETCH completed")
            return None
        if inject and fault == "source-epoch-after":
            self.server.epoch += 1
            self.send(f"* OK [UIDVALIDITY {self.server.epoch}] Fixture mailbox reset")
            self.selected_epoch = None
        return completion

    def handle(self):
        self.request.settimeout(15)
        self.send(f"* OK [CAPABILITY {CAPABILITIES}] Synthetic IMAP fixture")
        authenticated = False
        selected = False
        self.selected_epoch = None
        while line := self.rfile.readline(8192):
            tag, _, command = line.decode("ascii", errors="replace").strip().partition(" ")
            verb, _, arguments = command.partition(" ")
            verb = verb.upper()
            by_uid = verb == "UID"
            if by_uid:
                verb, _, arguments = arguments.partition(" ")
                verb = verb.upper()
            print(f"IMAP {'UID ' if by_uid else ''}{verb}", flush=True)
            with open(getattr(self.server, "command_log", "/fixture-state/imap.log"), "a", encoding="ascii") as journal:
                journal.write(f"{'UID ' if by_uid else ''}{verb}\n")

            status = f"OK {verb} completed"
            try:
                if verb == "CAPABILITY":
                    self.send(f"* CAPABILITY {CAPABILITIES}")
                elif verb == "LOGOUT":
                    self.send("* BYE Fixture logout")
                    self.send(f"{tag} {status}")
                    return
                elif verb == "LOGIN":
                    credentials = shlex.split(arguments)
                    authenticated = (len(credentials) == 2 and credentials[0] in ACCOUNTS
                                     and credentials[1] == PASSWORD)
                    if authenticated:
                        self.hold_fixture_login()
                    status = "OK LOGIN completed" if authenticated else "NO Invalid fixture login"
                elif not authenticated:
                    status = "NO Fixture login required"
                elif verb in ("SELECT", "EXAMINE"):
                    selected = shlex.split(arguments) == ["INBOX"]
                    if selected:
                        self.selected_epoch = self.server.epoch
                        count = 2 if self.server.fetch_fault == "lookup-duplicate" else 1
                        self.send(f"* FLAGS {FLAGS}")
                        self.send(f"* {count} EXISTS")
                        self.send("* 0 RECENT")
                        self.send(f"* OK [UIDVALIDITY {self.selected_epoch}] Fixture epoch")
                        self.send(f"* OK [UIDNEXT {UID + count}] Fixture next UID")
                        self.send("* OK [PERMANENTFLAGS ()] Fixture flags")
                        status = f"OK [READ-ONLY] {verb} completed"
                    else:
                        status = "NO Fixture mailbox does not exist"
                elif verb == "NAMESPACE":
                    self.send('* NAMESPACE (("" "/")) NIL NIL')
                elif verb in ("LIST", "LSUB"):
                    reference, pattern = shlex.split(arguments)
                    if not reference and pattern in ("", "*", "%", "INBOX"):
                        mailbox = '"INBOX"' if pattern else '""'
                        self.send(f'* {verb} () "/" {mailbox}')
                elif verb == "STATUS":
                    mailbox, *items = shlex.split(arguments.upper())
                    values = {"MESSAGES": 1, "RECENT": 0, "UNSEEN": 0, "UIDNEXT": UID + 1,
                              "UIDVALIDITY": self.server.epoch}
                    if mailbox == "INBOX":
                        fields = " ".join(
                            f"{item} {values[item]}" for item in " ".join(items).strip("()").split()
                        )
                        self.send(f'* STATUS "INBOX" ({fields})')
                    else:
                        status = "NO Fixture mailbox does not exist"
                elif verb == "FETCH" and selected:
                    status = self.fetch(arguments, by_uid, tag)
                elif verb == "SEARCH" and selected and by_uid and arguments.upper().startswith("HEADER MESSAGE-ID "):
                    criterion = shlex.split(arguments)[2].encode("ascii").lower()
                    present = criterion in IDENTITY.lower()
                    found = f" {UID}" if present else ""
                    if present and self.server.fetch_fault == "lookup-duplicate":
                        found += f" {UID + 1}"
                    self.send("* SEARCH" + found)
                    if self.server.fetch_fault == "lookup-epoch":
                        self.server.epoch += 1
                        self.send(f"* OK [UIDVALIDITY {self.server.epoch}] Fixture mailbox reset")
                elif verb == "SEARCH" and selected and arguments.upper() in ("ALL", "UNDELETED", "ALL UNDELETED"):
                    self.send(f"* SEARCH {UID if by_uid else 1}")
                elif verb == "CLOSE":
                    selected = False
                elif verb != "NOOP":
                    status = f"BAD Unsupported fixture command: {verb}"
            except (KeyError, ValueError):
                status = f"BAD Unsupported fixture arguments for {verb}"

            if status is None:
                return
            if status.startswith("BAD"):
                print(status, flush=True)
            self.send(f"{tag} {status}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=1143)
    args = parser.parse_args()
    with socketserver.ThreadingTCPServer((args.host, args.port), FixturePeer) as server:
        server.epoch = UIDVALIDITY
        server.fetch_fault = os.environ.get("QS_ROUNDCUBE_FIXTURE_MID_FETCH", "0")
        server.serve_forever()
