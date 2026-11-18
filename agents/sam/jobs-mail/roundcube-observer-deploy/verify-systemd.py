#!/usr/bin/env python3
"""Verify the exact staged observer units under disposable Linux systemd."""

import contextlib
import hashlib
import json
import os
import shutil
import socket
import socketserver
import ssl
import stat
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


HERE = Path(__file__).resolve().parent
UNIT = "quantself-roundcube-observer"
SOCKET_UNIT = UNIT + ".socket"
SERVICE_GLOB = UNIT + "@*.service"
SOCKET = Path(f"/run/{UNIT}/observe.sock")
CONFIG = Path(f"/etc/{UNIT}/observer.env")
HOST = "imap.purelymail.com"
API_UID, API_GID = 41001, 41002
OTHER_UID, OTHER_GID = 41004, 41005
CLIENT = """
import json, socket, sys
with socket.socket(socket.AF_UNIX) as conn:
    conn.settimeout(6)
    try:
        conn.connect(sys.argv[1])
    except PermissionError:
        print(json.dumps({"denied": True}))
    else:
        print("connected", flush=True)
        conn.sendall(sys.stdin.buffer.readline())
        with conn.makefile("rb") as wire:
            print(json.dumps(json.loads(wire.readline(4097))))
"""


def command(*args, input=None):
    result = subprocess.run(args, input=input, capture_output=True, check=True, timeout=12)
    return result.stdout.decode().strip()


def systemctl(*args):
    return command("systemctl", *args)


def scoped_client(uid=API_UID, gid=API_GID):
    return subprocess.Popen([sys.executable, "-IB", "-c", CLIENT, str(SOCKET)],
                            user=uid, group=gid, extra_groups=[], text=True,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def finish(client, request):
    output, error = client.communicate(request, timeout=7)
    assert client.returncode == 0 and not error, error
    return json.loads(output.splitlines()[-1])


def active_instances():
    return [
        line.split()[0]
        for line in systemctl("list-units", "--no-legend", "--plain", "--full",
                               "--state=active,activating,deactivating", SERVICE_GLOB).splitlines()
    ]


def wait_for_credential():
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        for unit in active_instances():
            pid = int(systemctl("show", "-p", "MainPID", "--value", unit))
            if pid == 0:
                continue
            # The exact unit puts the credential mount in the dynamic worker's mount namespace.
            path = Path(f"/proc/{pid}/root/run/credentials") / unit / "imap"
            if path.is_file():
                euid = int(next(line for line in Path(f"/proc/{pid}/status").read_text().splitlines()
                               if line.startswith("Uid:")).split()[2])
                return path, euid
        time.sleep(0.025)
    raise AssertionError("Activated instance did not expose the scoped credential")


def certificate(root, label):
    key, cert = root / f"{label}.key", root / f"{label}.pem"
    command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", f"/CN=Observer fixture {label}", "-addext", f"subjectAltName=DNS:{HOST}",
            "-keyout", str(key), "-out", str(cert))
    shutil.copyfile(cert, f"/usr/local/share/ca-certificates/qs359-observer-{label}.crt")
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(cert, key)
    return tls, hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert.read_text())).hexdigest()


class LoopbackServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


@contextlib.contextmanager
def loopback_peer(tls, handler):
    with LoopbackServer(("127.0.0.1", 993), handler) as peer:
        peer.tls, peer.mode, peer.commands = tls, "ok", []
        thread = threading.Thread(target=peer.serve_forever, kwargs={"poll_interval": 0.01})
        thread.start()
        try:
            yield peer
        finally:
            peer.shutdown()
            thread.join()


def install(stage):
    for source in stage.rglob("*"):
        if source.is_file():
            target = Path("/") / source.relative_to(stage)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.parent.chmod(source.parent.stat().st_mode & 0o777)
            shutil.copy2(source, target)


def replace_pin(stage):
    pending = CONFIG.with_suffix(".next")
    shutil.copy2(stage / CONFIG.relative_to("/"), pending)
    os.replace(pending, CONFIG)


def verify():
    assert os.environ.get("QS359_SYSTEMD_FIXTURE") == "1" and Path("/.dockerenv").exists()
    assert os.getuid() == 0 and Path("/proc/1/comm").read_text().strip() == "systemd"
    up = {name for _, name in socket.if_nameindex() if int(Path(f"/sys/class/net/{name}/flags").read_text(), 16) & 1}
    assert up == {"lo"}, "Fixture must have no active external interface"
    assert {item[4][0] for item in socket.getaddrinfo(HOST, 993)} == {"127.0.0.1"}, "Use the fixture host mapping"
    assert not CONFIG.parent.exists() and not SOCKET.exists(), "Use a fresh disposable fixture"

    sys.path.insert(0, str(HERE.parent))
    from test_roundcube_observer import MAILBOX, QUERY, SECRET, TLSPeer

    request = json.dumps(QUERY) + "\n"
    with tempfile.TemporaryDirectory(prefix="qs359-systemd-") as temporary:
        root = Path(temporary)
        tls_first, pin_first = certificate(root, "first")
        tls_second, pin_second = certificate(root, "second")
        command("update-ca-certificates")
        command("groupadd", "--gid", str(API_GID), "qs359-fixture-api")
        for name, pin in (("first", pin_first), ("second", pin_second)):
            command(str(HERE / "stage.sh"), str(root / name), str(API_UID), str(API_GID), pin)
        install(root / "first")
        credential = CONFIG.parent / "imap.cred"
        command("systemd-creds", "encrypt", "--name=imap", "--with-key=host", "-", str(credential), input=SECRET + b"\n")
        credential.chmod(0o600)
        unit_dir = Path("/etc/systemd/system")
        command("systemd-analyze", "--man=no", "verify", str(unit_dir / SOCKET_UNIT), str(unit_dir / (UNIT + "@.service")))
        systemctl("daemon-reload")
        assert systemctl("show", "-p", "ActiveState", "--value", SOCKET_UNIT) == "inactive"
        try:
            systemctl("start", SOCKET_UNIT)
            assert systemctl("is-active", SOCKET_UNIT) == "active"
            sock = SOCKET.stat()
            assert (sock.st_uid, sock.st_gid, stat.S_IMODE(sock.st_mode)) == (0, API_GID, 0o660)
            directory = SOCKET.parent.stat()
            assert (directory.st_uid, directory.st_gid, stat.S_IMODE(directory.st_mode)) == (0, 0, 0o755)
            with loopback_peer(tls_first, TLSPeer) as peer:
                for uid, gid, expected in (
                    (OTHER_UID, OTHER_GID, {"denied": True}), (OTHER_UID, API_GID, None), (0, 0, None),
                ):
                    with scoped_client(uid, gid) as client:
                        assert finish(client, request) == expected
                assert peer.commands == [], "An unauthorized client reached IMAP"
                with scoped_client() as allowed:
                    assert allowed.stdout.readline().strip() == "connected"
                    runtime_file, worker_uid = wait_for_credential()
                    file = runtime_file.stat()
                    assert worker_uid not in (0, API_UID) and file.st_uid == worker_uid and file.st_mode & 0o077 == 0
                    check = subprocess.run(["test", "!", "-r", str(runtime_file)], user=API_UID, group=API_GID, extra_groups=[])
                    assert check.returncode == 0, "API UID could read the injected credential"
                    accepted = finish(allowed, request)
                assert accepted["account"] == MAILBOX
                assert accepted["matches"] == [{"uid": 42, "messageId": QUERY["messageId"]}]
            with loopback_peer(tls_second, TLSPeer) as peer:
                with scoped_client() as client:
                    assert finish(client, request) is None
                assert peer.commands == [], "The replaced TLS certificate received credentials"
                replace_pin(root / "second")
                systemctl("daemon-reload")
                assert systemctl("is-active", SOCKET_UNIT) == "active" and SOCKET.stat().st_ino == sock.st_ino
                with scoped_client() as client:
                    assert finish(client, request)["matches"] == accepted["matches"]
            systemctl("stop", SOCKET_UNIT)
            assert not SOCKET.exists() and not active_instances()
            replace_pin(root / "first")
            systemctl("daemon-reload")
            with loopback_peer(tls_first, TLSPeer):
                systemctl("start", SOCKET_UNIT)
                with scoped_client() as client:
                    assert finish(client, request)["matches"] == accepted["matches"]
        finally:
            systemctl("stop", SOCKET_UNIT)
        assert not SOCKET.exists() and not active_instances()
        print("PASS exact systemd activation, encrypted credential, UID denial, reload and rollback")


if __name__ == "__main__":
    verify()
