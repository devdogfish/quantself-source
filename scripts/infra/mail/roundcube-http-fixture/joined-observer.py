"""Serve the stock fixture mailbox on plain IMAP and pinned TLS with the real IPC observer."""

import hashlib
import json
import os
import socketserver
import ssl
import sys
from pathlib import Path
from threading import Thread

sys.path[:0] = ["/fixture", "/fixture-repo/agents/sam/jobs-mail", "/fixture-repo/agents/vaultwarden"]
import jobs_roundcube_observer as observer
from imap_peer import FixturePeer, UIDVALIDITY

# Only the disposable mailbox account and transport config differ from the native handler.
observer.MAILBOX = "jobs@example.test"
state = Path("/fixture-state")
credential = Path("/tmp/synthetic-imap")
credential.write_text("fixture-only\n")
cert = state / "imap.crt"
tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
tls.load_cert_chain(cert, state / "imap.key")
trust = ssl.create_default_context(cafile=cert)
pin = hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert.read_text())).hexdigest()
socket = Path("/run/quantself-roundcube-observer/observe.sock")


class TLSServer(socketserver.ThreadingTCPServer):
    def get_request(self):
        connection, address = super().get_request()
        if self.server_address[1] == 1993:
            with (state / "roundcube-tls-connections.log").open("a", encoding="ascii") as journal:
                journal.write("accepted\n")
        try:
            return tls.wrap_socket(connection, server_side=True), address
        except ssl.SSLError:
            connection.close()
            raise


class Observe(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(4)
        assert observer.peer_allowed(self.rfile, 41001), "Expected the dedicated API client UID"
        result = observer.handle(self.rfile, credential, pin=pin, host="localhost",
                                 port=secured.server_address[1], tls_context=lambda: trust)
        assert result is not None, "The pinned TLS observation failed"
        with (state / "observations.jsonl").open("a", encoding="ascii") as journal:
            journal.write(json.dumps(result) + "\n")
        self.wfile.write(json.dumps(result).encode("ascii") + b"\n")


with (socketserver.ThreadingTCPServer(("0.0.0.0", 1143), FixturePeer) as plain,
      TLSServer(("0.0.0.0", 1993), FixturePeer) as roundcube_tls,
      TLSServer(("127.0.0.1", 0), FixturePeer) as secured,
      socketserver.UnixStreamServer(str(socket), Observe) as ipc):
    https = os.environ.get("QS_ROUNDCUBE_FIXTURE_HTTPS") == "1"
    roundcube_tls.spool_probe = os.environ.get("QS_ROUNDCUBE_FIXTURE_SPOOL") == "1"
    roundcube_tls.spool_attempt = 0
    roundcube_tls.source_probe = os.environ.get("QS_ROUNDCUBE_FIXTURE_SOURCE") == "1"
    roundcube_tls.source_attempt = 0
    roundcube_tls.display_probe = os.environ.get("QS_ROUNDCUBE_FIXTURE_DISPLAY") == "1"
    roundcube_tls.display_attempt = 0
    for server, name in ((plain, "plain-imap.log" if https else "imap.log"),
                         (roundcube_tls, "imap.log" if https else "unused-tls-imap.log"),
                         (secured, "observer-imap.log")):
        server.epoch, server.fetch_fault = UIDVALIDITY, "0"
        server.command_log = str(state / name)
        (state / name).touch()
        Thread(target=server.serve_forever, daemon=True).start()
    os.chown(socket, 0, 41002)
    socket.chmod(0o660)
    print("joined observer ready", flush=True)
    ipc.serve_forever()
