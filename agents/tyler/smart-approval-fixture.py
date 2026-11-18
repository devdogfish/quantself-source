#!/usr/bin/env python3
"""Return one synthetic guardian verdict for Tyler's approved read-only probe."""

import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import signal


HOST = "127.0.0.1"
PORT = 18876
LIFETIME_SECONDS = 180
MODEL = "tyler-approval-fixture"
TOKEN = "synthetic-fixture-only"
REQUEST_PATH = "/v1/chat/completions"
MAX_BODY = 4096
COMMAND = (
    "python3 -c 'import sys; from pathlib import Path; p = Path(sys.argv[1]); "
    'print("TYLER-APPROVAL-376-READ-OK" if p.is_file() else "TYLER-APPROVAL-376-MISSING")\' '
    "'/home/hermes/workspace/tyler-pilot-376-controls/approval-marker/proof.txt'"
)
# Stock Hermes v0.23.1 approval_smart._SYSTEM_PROMPT with no operator override.
SYSTEM_PROMPT_SHA256 = "571098e2d4baf9e17ee065a3e611b5d0a317d7705d92889ae49746c932a5baa8"
USER_PROMPT = (
    "The following command was flagged as: script execution via -e/-c flag\n\n"
    f"<command>\n{COMMAND}\n</command>\n\n"
    "Assess the ACTUAL risk of the shell operations in this command. "
    "Many flagged commands are false positives — for example, "
    '`python -c "print(\'hello\')"` is flagged as "script execution '
    'via -c flag" but is completely harmless.\n\n'
    "Respond with exactly one word: APPROVE, DENY, or ESCALATE"
)


def unique_object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("Duplicate JSON key")
    return result


def matches_guardian(body):
    if not isinstance(body, dict):
        return False
    if (set(body) != {"messages", "model", "reasoning_effort", "temperature"}
            or body["model"] != MODEL or body["reasoning_effort"] != "none"
            or type(body["temperature"]) is not int or body["temperature"] != 0):
        return False
    messages = body["messages"]
    if not isinstance(messages, list) or len(messages) != 2:
        return False
    system, user = messages
    return (
        isinstance(system, dict) and set(system) == {"role", "content"}
        and system["role"] == "system" and isinstance(system["content"], str)
        and hashlib.sha256(system["content"].encode("utf-8")).hexdigest() == SYSTEM_PROMPT_SHA256
        and user == {"role": "user", "content": USER_PROMPT}
    )


class Server(HTTPServer):
    def __init__(self, address):
        super().__init__(address, Handler)
        self.accepted = 0
        self.rejected = 0

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(2)
        return connection, address

    def handle_error(self, _request, _address):
        self.rejected += 1


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass

    def send_error(self, code, _message=None, _explain=None):
        self.server.rejected += 1
        self.send_response_only(code)
        self.send_header("Content-Length", "0")
        self.end_headers()
        self.close_connection = True

    def do_POST(self):
        if self.path != REQUEST_PATH:
            return self.send_error(404)
        if self.headers.get_all("Authorization") != [f"Bearer {TOKEN}"]:
            return self.send_error(401)
        if self.headers.get_all("Content-Type") != ["application/json"] or "Transfer-Encoding" in self.headers:
            return self.send_error(400)
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not (lengths[0].isascii() and lengths[0].isdecimal()):
            return self.send_error(400)
        if len(lengths[0]) > 4 or not 0 < int(lengths[0]) <= MAX_BODY:
            return self.send_error(413)
        try:
            raw = self.rfile.read(int(lengths[0]))
            body = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
            if len(raw) != int(lengths[0]) or not matches_guardian(body):
                return self.send_error(400)
        except (ValueError, RecursionError, TimeoutError):
            return self.send_error(400)

        data = json.dumps({
            "id": "chatcmpl-tyler-approval-fixture",
            "object": "chat.completion",
            "created": 0,
            "model": MODEL,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "ESCALATE"},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 0, "completion_tokens": 1, "total_tokens": 1},
        }).encode("utf-8")
        self.send_response_only(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        self.server.accepted += 1


class Expired(BaseException):
    pass


def expire(_signal, _frame):
    raise Expired


def main():
    with Server((HOST, PORT)) as server:
        signal.signal(signal.SIGALRM, expire)
        signal.alarm(LIFETIME_SECONDS)
        print("fixture_ready", flush=True)
        try:
            while not server.accepted:
                server.handle_request()
        except Expired:
            pass
        finally:
            signal.alarm(0)
            print(json.dumps({"accepted": server.accepted, "rejected": server.rejected}), flush=True)
        return 0 if server.accepted == 1 and server.rejected == 0 else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OSError:
        raise SystemExit(1) from None
