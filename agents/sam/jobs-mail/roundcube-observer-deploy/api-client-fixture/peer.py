"""Exercise the observer's real peer check and TLS handler for the mounted client."""

import json
import os
import socket
import struct
import sys
import tempfile
from pathlib import Path
from time import sleep

sys.path[:0] = ["/fixture/agents/sam/jobs-mail", "/fixture/agents/vaultwarden"]
from jobs_mail_service import peer_allowed
from test_roundcube_observer import SECRET, certificates, observe_fixture, tls_peer


SOCKET = Path("/run/quantself-roundcube-observer/observe.sock")


with tempfile.TemporaryDirectory() as directory, socket.socket(socket.AF_UNIX) as listener:
    root = Path(directory)
    credential = root / "imap"
    credential.write_bytes(SECRET + b"\n")
    tls, trust, pin = certificates(root)
    with tls_peer(tls, "ok") as peer:
        listener.settimeout(20)
        listener.bind(str(SOCKET))
        SOCKET.chmod(0o660)
        os.chown(SOCKET, 0, 41002)
        listener.listen(4)
        print("ready", flush=True)
        challenges = set()
        for case in ("root", "valid", "wrong-uid", "missing-credential", "oversized", "timeout"):
            connection, _ = listener.accept()
            with connection, connection.makefile("rb") as request:
                connection.settimeout(3)
                _, uid, gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                assert (uid, gid) == ((0, 0) if case == "root" else (41001, 41002))
                if not peer_allowed(request, 41004 if case == "wrong-uid" else 41001):
                    assert case in ("root", "wrong-uid")
                    request.readline(1025)
                    connection.sendall(b"null\n")
                elif case in ("valid", "missing-credential"):
                    profile = credential if case == "valid" else root / "missing"
                    command_count = len(peer.commands)
                    response = observe_fixture(request, profile, peer, trust, pin)
                    assert (response is None) == (case == "missing-credential")
                    if response:
                        challenges.add(response["challenge"])
                    else:
                        assert len(peer.commands) == command_count
                    connection.sendall(json.dumps(response).encode("ascii") + b"\n")
                else:
                    query = json.loads(request.readline(1025))
                    assert query["challenge"] not in challenges
                    challenges.add(query["challenge"])
                    if case == "oversized":
                        connection.sendall(b" " * 4096 + b"null\n")
                    else:
                        sleep(4.8)
                print(f"{case} uid={uid} gid={gid}", flush=True)
        assert sum(command.startswith(b"UID SEARCH") for command in peer.commands) == 1
        assert sum(command.startswith(b"UID FETCH") for command in peer.commands) == 1
        print("PASS one fresh TLS IMAP observation and scoped negative controls")
