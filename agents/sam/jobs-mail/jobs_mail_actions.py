"""Journal scoped Jobs mailbox writes with resumable, conditional Undo."""

import contextlib
import fcntl
import imaplib
import json
import re
import sqlite3
import uuid

from mail import BoundedIMAP, MAX_UID, _fetch_responses, _parse_number, _uidvalidity


FOLDERS = {"INBOX", "Archive"}
MARK_FLAGS = {"seen": b"\\Seen", "flagged": b"\\Flagged"}
UNCERTAIN = {"status": "outcome_uncertain"}


def validate_action(request):
    if not isinstance(request, dict) or type(request.get("command_id")) is not str:
        raise ValueError("invalid mailbox action")
    if str(uuid.UUID(request["command_id"])) != request["command_id"]:
        raise ValueError("invalid command ID")
    action = request.get("action")
    if action == "undo":
        if (set(request) != {"action", "command_id", "undo_id"} or type(request["undo_id"]) is not str
                or str(uuid.UUID(request["undo_id"])) != request["undo_id"]):
            raise ValueError("invalid Undo request")
        return
    common = {"action", "command_id", "folder", "uidvalidity", "uid"}
    if request.get("folder") not in FOLDERS or not all(
        type(request.get(key)) is int and 1 <= request[key] <= MAX_UID for key in ("uid", "uidvalidity")
    ):
        raise ValueError("invalid mailbox reference")
    if action == "move" and request.keys() == common | {"destination"}:
        if request["destination"] in FOLDERS and request["destination"] != request["folder"]:
            return
    if action == "mark" and request.keys() == common | {"flag", "enabled"}:
        if request["flag"] in MARK_FLAGS and type(request["enabled"]) is bool:
            return
    raise ValueError("invalid mailbox action")


def _reference(request):
    return {key: request[key] for key in ("folder", "uid", "uidvalidity")}


def _flags(connection, uid):
    status, data = connection.uid("FETCH", str(uid), "(UID FLAGS MODSEQ)")
    if status != "OK":
        raise ValueError("IMAP flag check failed")
    rows = [fields for fields in _fetch_responses(data or ())
            if fields.get(b"UID") == str(uid).encode() and b"MODSEQ" in fields]
    if not rows:
        return None
    if len(rows) != 1:
        raise ValueError("ambiguous flags")
    values, modification = rows[0].get(b"FLAGS"), rows[0].get(b"MODSEQ")
    if (not isinstance(values, list) or not all(isinstance(value, bytes) for value in values)
            or not isinstance(modification, list) or len(modification) != 1
            or not isinstance(modification[0], bytes) or not re.fullmatch(rb"[1-9][0-9]{0,19}", modification[0])):
        raise ValueError("invalid flags")
    return frozenset(value.upper() for value in values), modification[0].decode("ascii")


def _mark(connection, request, flags, modification):
    uid = request["uid"]
    flag = MARK_FLAGS[request["flag"]]
    before = flag.upper() in flags
    if (("expected" in request and before != request["expected"])
            or ("expected_modseq" in request and modification != request["expected_modseq"])):
        return {"status": "conflict"}, None
    if before == request["enabled"]:
        return {"status": "unchanged", "message": _reference(request)}, None
    # Purelymail advertises CONDSTORE but rejects a matching UNCHANGEDSINCE.
    # UID STORE touches one flag only, preserving any unrelated edits.
    operator = "+FLAGS.SILENT" if request["enabled"] else "-FLAGS.SILENT"
    status, _ = connection.uid("STORE", str(uid), operator, f"({flag.decode()})")
    if status != "OK":
        return UNCERTAIN, None
    after = _flags(connection, uid)
    if (after is None or (flag.upper() in after[0]) != request["enabled"]
            or _uidvalidity(connection) not in (None, request["uidvalidity"])):
        return UNCERTAIN, None
    result = {"status": "ok", "message": _reference(request)}
    if flags - {flag.upper()} != after[0] - {flag.upper()}:
        return {**result, "undo_unavailable": "message_flags_changed"}, None
    undo = {**request, "expected": request["enabled"], "enabled": before, "expected_modseq": after[1]}
    return result, undo


def _move(connection, request):
    connection.response("COPYUID")
    status, _ = connection.uid("MOVE", str(request["uid"]), request["destination"])
    _, values = connection.response("COPYUID")
    if status != "OK" or len(values) != 1 or not isinstance(values[0], bytes):
        return UNCERTAIN, None
    try:
        epoch, source, destination = (_parse_number(value, 1) for value in values[0].split())
    except ValueError:
        return UNCERTAIN, None
    if source != request["uid"]:
        return UNCERTAIN, None
    target = {"folder": request["destination"], "uid": destination, "uidvalidity": epoch}
    undo = {**request, **target, "destination": request["folder"]}
    return {"status": "ok", "message": target}, undo


def _apply(username, password, request):
    connection = BoundedIMAP()
    try:
        connection.login(username, password)
        needed = {"CONDSTORE"} | ({"MOVE", "UIDPLUS"} if request["action"] == "move" else set())
        if not needed.issubset(connection.capabilities):
            return {"status": "unsupported"}, None
        status, _ = connection.select(f'{request["folder"]} (CONDSTORE)', readonly=False)
        if status != "OK":
            return {"status": "folder_unavailable"}, None
        if _uidvalidity(connection, required=True) != request["uidvalidity"]:
            return {"status": "stale_mailbox"}, None
        snapshot = _flags(connection, request["uid"])
        if snapshot is None:
            return {"status": "message_missing"}, None
        if _uidvalidity(connection) not in (None, request["uidvalidity"]):
            return {"status": "stale_mailbox"}, None
        if request["action"] == "mark":
            return _mark(connection, request, *snapshot)
        return _move(connection, request)
    finally:
        with contextlib.suppress(OSError):
            connection.shutdown()


def _execute(db, username, password, request, apply):
    command = request["command_id"]
    wire = json.dumps(request, sort_keys=True)
    previous = db.execute("SELECT request, result FROM action WHERE id = ?", (command,)).fetchone()
    if previous:
        if previous[0] != wire:
            return {"status": "conflict"}
        return json.loads(previous[1]) if previous[1] else UNCERTAIN
    action = request
    if request["action"] == "undo":
        original = db.execute("SELECT undo, undone_by FROM action WHERE id = ?", (request["undo_id"],)).fetchone()
        if not original or not original[0] or original[1]:
            return {"status": "undo_unavailable"}
        action = {**json.loads(original[0]), "command_id": command}
    with db:
        db.execute("INSERT INTO action (id, request) VALUES (?, ?)", (command, wire))
        if request["action"] == "undo":
            db.execute("UPDATE action SET undone_by = ? WHERE id = ?", (command, request["undo_id"]))
    # Persist the reservation before IMAP. Losing the acknowledgement never
    # causes a second MOVE or STORE when the same command is replayed.
    try:
        result, undo = apply(username, password, action)
    except (OSError, ValueError, imaplib.IMAP4.error, RecursionError):
        result, undo = UNCERTAIN, None
    if undo:
        result = {**result, "undo_id": command}
    with db:
        db.execute("UPDATE action SET result = ?, undo = ? WHERE id = ?", (
            json.dumps(result), json.dumps(undo) if undo else None, command,
        ))
        if request["action"] == "undo" and result["status"] not in ("ok", "outcome_uncertain"):
            db.execute("UPDATE action SET undone_by = NULL WHERE id = ?", (request["undo_id"],))
    return result


def apply_action(state, username, password, request, apply=_apply):
    validate_action(request)
    with (state / "actions.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"status": "busy"}
        with contextlib.closing(sqlite3.connect(state / "actions.db")) as db:
            db.execute("""CREATE TABLE IF NOT EXISTS action (
                id TEXT PRIMARY KEY, request TEXT NOT NULL, result TEXT, undo TEXT, undone_by TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )""")
            return _execute(db, username, password, request, apply)
