#!/usr/bin/python3 -I
"""Client for the Agent's Vaultwarden service."""

import json
import re
import socket
import sys
from time import monotonic

SOCKET_PATH = "/run/quantself-vaultwarden.sock"
RESPONSE_LIMIT = 32768
FORM_NAME = re.compile(r"[a-z][a-z0-9_-]{0,47}")
ACCOUNT_INPUT_LIMIT = 12288
ACCOUNT_STATUSES = {
    "signed_in", "signed_out", "created", "email_verification_required", "sign_in_required",
    "unsupported", "unconfirmed", "locked", "unavailable", "origin_refused", "existing_account",
    "verification_rejected",
}


def request(arguments, socket_path=SOCKET_PATH, timeout=11.5):
    deadline = monotonic() + timeout
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(deadline - monotonic())
        connection.connect(socket_path)
        connection.sendall(json.dumps(arguments, ensure_ascii=False).encode() + b"\n")
        reply = bytearray()
        while not reply.endswith(b"\n"):
            connection.settimeout(max(0, deadline - monotonic()))
            chunk = connection.recv(4096)
            if not chunk or len(reply) + len(chunk) > RESPONSE_LIMIT:
                raise ValueError
            reply.extend(chunk)
    return json.loads(reply)


def respond(arguments):
    if arguments in (["--website-account"], ["--read-account"]):
        data = sys.stdin.buffer.read(ACCOUNT_INPUT_LIMIT + 1)
        if len(data) > ACCOUNT_INPUT_LIMIT:
            raise ValueError
        payload = json.loads(data)
        if not isinstance(payload, dict):
            raise ValueError
        if arguments == ["--read-account"]:
            return site_read_response(request({"read_account": payload}, timeout=42), allow_forms=False)
        result = request({"website_account": payload}, timeout=92)
        if not isinstance(result, dict) or result.keys() not in ({"status"}, {"error"}):
            raise ValueError
        status = result.get("status", result.get("error"))
        if not isinstance(status, str) or status not in ACCOUNT_STATUSES:
            raise ValueError
        return status
    if arguments == ["--mail"]:
        data = sys.stdin.buffer.read(257)
        if len(data) > 256:
            raise ValueError
        result = request({"mail": json.loads(data)}, timeout=42)
        if not isinstance(result, dict):
            raise ValueError
        if result.get("status") == "ok" and result.keys() in (
                {"status", "uidvalidity", "messages"}, {"status", "uidvalidity", "message"}):
            return json.dumps(result)
        status = result.get("status", result.get("error"))
        if status not in ("locked", "unavailable", "stale_mailbox", "message_missing"):
            raise ValueError
        return json.dumps({"status": status})
    if arguments in (["--submit-site"], ["--approve-site"]):
        data = sys.stdin.buffer.read(16001)
        if len(data) > 16000:
            raise ValueError
        submission = json.loads(data)
        if arguments == ["--approve-site"]:
            if request({"approve_submit_site": submission}) != {"status": "approved"}:
                raise ValueError
            return "approved"
        result = request({"submit_site": submission}, timeout=42)
        if (not isinstance(result, dict) or result.keys() != {"status"}
                or result["status"] not in ("submitted", "form_refused", "approval_required", "sign_in_required",
                                            "origin_refused", "outcome_unknown", "unavailable")):
            raise ValueError
        return result["status"]
    if len(arguments) in (2, 3) and arguments[0] == "--read-site":
        result = request({"read_site": {"item_id": arguments[1],
                                        "url": arguments[2] if len(arguments) == 3 else None}}, timeout=42)
        return site_read_response(result)
    if arguments == ["--sync"]:
        if request({"refresh": True}) != {"status": "refreshed"}:
            raise ValueError
        return "refreshed"
    if len(arguments) == 2 and arguments[0] == "--login":
        result = request({"login": arguments[1]}, timeout=42)
        if not isinstance(result, dict):
            raise ValueError
        status = result.get("status", result.get("error"))
        if status not in ("signed_in", "sign_in_blocked", "origin_refused", "transfer_rejected", "locked", "unavailable"):
            raise ValueError
        return status
    if arguments in (["--lock"], ["--unlock"]):
        locked = arguments == ["--lock"]
        expected = "locked" if locked else "unlocked"
        if request({"owner_lock": locked}) != {"status": expected}:
            raise ValueError
        return expected
    result = request({"keys": arguments}, timeout=14)
    if not isinstance(result, dict) or result.keys() != {"keys"}:
        raise ValueError
    values = result["keys"]
    if (not isinstance(values, dict) or values.keys() != set(arguments)
            or not all(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9._~+/=-]{8,4096}", value)
                       for value in values.values())):
        raise ValueError
    return "\n".join(f"{name}={values[name]}" for name in arguments)


def site_read_response(result, *, allow_forms=True):
    if not isinstance(result, dict):
        raise ValueError
    fields = ({"status", "text"}, {"status", "text", "forms"}) if allow_forms else ({"status", "text"},)
    if (result.get("status") == "ok" and result.keys() in fields
            and isinstance(result["text"], str) and len(result["text"]) <= 4000
            and valid_forms(result.get("forms", {}))):
        return json.dumps(result)
    status = result.get("status", result.get("error"))
    if status not in ("sign_in_required", "origin_refused", "locked", "unavailable"):
        raise ValueError
    return json.dumps({"status": status})


def valid_forms(forms):
    return isinstance(forms, dict) and len(forms) <= 16 and all(
        isinstance(name, str) and FORM_NAME.fullmatch(name) and isinstance(fields, list) and 1 <= len(fields) <= 12
        and all(isinstance(field, str) and FORM_NAME.fullmatch(field) for field in fields)
        for name, fields in forms.items()
    )


if __name__ == "__main__":
    try:
        print(respond(sys.argv[1:]))
    except (OSError, ValueError):
        sys.exit("Vaultwarden request unavailable")
