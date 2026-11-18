"""One observation over a private, socket-activated connection. Dormant until installed."""

import json
import os
import signal
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jobs_mail_service import MAILBOX, peer_allowed, unique_fields
from mail import HOST, PORT, _tls_context
from roundcube_imap import PIN, observe, validate_query


REQUEST_LIMIT = 1024
PROCESS_SECONDS = 4


def handle(incoming, credential, *, pin, host=HOST, port=PORT, tls_context=_tls_context):
    try:
        if not PIN.fullmatch(pin):
            return None
        line = incoming.readline(REQUEST_LIMIT + 1)
        if len(line) > REQUEST_LIMIT or not line.endswith(b"\n"):
            return None
        query = json.loads(line, object_pairs_hook=unique_fields)
        validate_query(query)
        with credential.open("rb") as source:
            raw = source.read(259)
        password = raw.removesuffix(b"\n").removesuffix(b"\r").decode("ascii")
        return observe(query, account=MAILBOX, password=password, host=host, port=port, tls=tls_context(), pin=pin)
    except (OSError, ValueError, TypeError, RecursionError):
        return None


def main():
    signal.alarm(PROCESS_SECONDS)
    result = None
    try:
        uid = int(os.environ.get("QUANTSELF_JOBS_ROUNDCUBE_PEER_UID", ""))
        pin = os.environ.get("QUANTSELF_JOBS_ROUNDCUBE_IMAP_CERT_SHA256", "")
        if sys.platform == "linux" and uid > 0 and peer_allowed(sys.stdin.buffer, uid):
            credential = Path(os.environ["CREDENTIALS_DIRECTORY"]) / "imap"
            result = handle(sys.stdin.buffer, credential, pin=pin)
    except (KeyError, ValueError):
        pass
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=True, separators=(",", ":")).encode("ascii") + b"\n")
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
