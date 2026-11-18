"""Serve one local Jobs inbox read to Sam’s Linux account."""

import json
import os
import pwd
import socket
import struct
import sys
from pathlib import Path

# The installer places both modules in the same root-owned directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from mail import MAX_OUTPUT_BYTES, read_mail, validate_request
from jobs_mail_actions import apply_action, validate_action
from jobs_mail_reply import send_reply, validate_reply


MAILBOX = "luigi@luigigirke.com"
MAX_REQUEST_BYTES = 100_000


def unique_fields(pairs):
    fields = dict(pairs)
    if len(fields) != len(pairs):
        raise ValueError("duplicate request field")
    return fields


def handle(incoming, credential, reader=read_mail, *, state=None, action_runner=apply_action):
    try:
        line = incoming.readline(MAX_REQUEST_BYTES + 1)
        if len(line) > MAX_REQUEST_BYTES or not line.endswith(b"\n"):
            return {"status": "unavailable"}
        request = json.loads(line, object_pairs_hook=unique_fields)
        is_action = isinstance(request, dict) and "action" in request
        is_reply = is_action and request["action"] == "reply"
        if is_reply:
            if state is None:
                return {"status": "sender_unconfigured"}
            validate_reply(request)
        elif is_action:
            if state is None:
                return {"status": "unavailable"}
            validate_action(request)
        else:
            validate_request(request)
        with credential.open("rb") as source:
            password = source.read(257).decode("ascii").rstrip("\r\n")
        if not password or len(password) > 256:
            return {"status": "unavailable"}
        if is_reply:
            return send_reply(state, password, request, os.environ.get("QUANTSELF_API_URL", ""),
                              credential.with_name("qs196-jobs-ses"))
        if is_action:
            return action_runner(state, MAILBOX, password, request)
        return reader(MAILBOX, password, request, jobs_reply_headers=True)
    except (OSError, ValueError, TypeError, RecursionError):
        return {"status": "unavailable"}


def peer_allowed(stream, uid):
    try:
        with socket.fromfd(stream.fileno(), socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            _, peer_uid, _ = struct.unpack("3i", connection.getsockopt(
                socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"),
            ))
        return peer_uid == uid
    except OSError:
        return False


def main():
    credential = Path(os.environ["CREDENTIALS_DIRECTORY"]) / "imap"
    result = {"status": "unavailable"}
    if peer_allowed(sys.stdin.buffer, pwd.getpwnam("hermes").pw_uid):
        state_directory = os.environ.get("STATE_DIRECTORY")
        result = handle(sys.stdin.buffer, credential, state=Path(state_directory) if state_directory else None)
    response = json.dumps(result, ensure_ascii=False).encode("utf-8") + b"\n"
    if len(response) > MAX_OUTPUT_BYTES:
        response = b'{"status":"unavailable"}\n'
    sys.stdout.buffer.write(response)


if __name__ == "__main__":
    main()
