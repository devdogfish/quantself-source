#!/usr/bin/env python3
"""Exercise staged observer code with real Linux users, sockets and synthetic TLS."""

import configparser
import contextlib
import json
import os
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
from functools import partial
from pathlib import Path


HERE = Path(__file__).resolve().parent
API_UID = 41001
API_GID = 41002
WORKER_UID = 41003
OUTSIDER_UID = 41004
OUTSIDER_GID = 41005
UNIT = "quantself-roundcube-observer"
QUERY = {
    "challenge": "52472ac1-4283-4b88-b000-7caa214d7cab",
    "folder": "INBOX",
    "uidValidity": 120,
    "messageId": "<roundcube-proof@example.test>",
}


def worker(libexec, port, cert):
    sys.path.insert(0, libexec)
    import jobs_roundcube_observer as observer

    # Replace only the remote host and trust roots. main() still uses the real peer UID,
    # reads the staged config and opens the exact credential as the worker UID.
    observer.handle = partial(
        observer.handle, host="localhost", port=int(port),
        tls_context=lambda: ssl.create_default_context(cafile=cert),
    )
    observer.main()


def client(path, credential):
    if os.getuid() != 0:
        for filename in (Path(credential) / "imap", Path(path)):
            assert not os.access(filename.parent, os.W_OK), "Client can modify a protected directory"
        try:
            with open(Path(credential) / "imap", "rb"):
                raise AssertionError("Client can read the worker credential")
        except PermissionError:
            pass
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(6)
        try:
            connection.connect(path)
        except PermissionError:
            print('{"socket":"denied"}')
            return
        connection.sendall(json.dumps(QUERY).encode("ascii") + b"\n")
        with connection.makefile("rb") as wire:
            print(json.dumps(json.loads(wire.readline(4097))))


def child_args(role, *args):
    return [sys.executable, "-IB", str(Path(__file__).resolve()), role, *map(str, args)]


def mode(path):
    return stat.S_IMODE(path.stat().st_mode)


def read_unit(path):
    config = configparser.ConfigParser(interpolation=None)
    with path.open() as source:
        config.read_file(source)
    return config


def stage(root, pin):
    subprocess.run([str(HERE / "stage.sh"), str(root), str(API_UID), str(API_GID), pin],
                   check=True, stdout=subprocess.DEVNULL)
    return root


def check_stage(root):
    unit_dir = root / "etc/systemd/system"
    sock = dict(read_unit(unit_dir / (UNIT + ".socket"))["Socket"])
    service = dict(read_unit(unit_dir / (UNIT + "@.service"))["Service"])
    group = read_unit(unit_dir / (UNIT + ".socket.d/10-api-group.conf"))["Socket"]["SocketGroup"]
    assert sock["listenstream"] == f"/run/{UNIT}/observe.sock" and sock["directorymode"] == "0755"
    assert sock["socketuser"] == "root" and sock["socketmode"] == "0660" and int(group) == API_GID
    assert sock["accept"] == "yes" and sock["removeonstop"] == "yes"
    assert sock["maxconnections"] == sock["maxconnectionspersource"] == "2"
    assert service["dynamicuser"] == "yes" and service["runtimemaxsec"] == "5s"
    assert service["standardinput"] == service["standardoutput"] == "socket"
    assert service["loadcredentialencrypted"] == f"imap:/etc/{UNIT}/imap.cred"
    assert service["environmentfile"] == f"/etc/{UNIT}/observer.env"
    assert not (root / f"etc/{UNIT}/imap.cred").exists()
    assert not list(root.rglob("*.wants"))
    config = root / f"etc/{UNIT}/observer.env"
    assert mode(config.parent) == 0o700 and mode(config) == 0o600
    return dict(line.split("=", 1) for line in config.read_text().splitlines())


def exchange(listener, path, credential, libexec, config, cert, port, uid=API_UID, gid=API_GID):
    with subprocess.Popen(child_args("client", path, credential), user=uid, group=gid,
                          extra_groups=[], stdout=subprocess.PIPE, stderr=subprocess.PIPE) as caller:
        if gid == OUTSIDER_GID:
            stdout, stderr = caller.communicate(timeout=7)
        else:
            incoming, _ = listener.accept()
            with incoming:
                env = config | {"CREDENTIALS_DIRECTORY": str(credential)}
                with subprocess.Popen(child_args("worker", libexec, port, cert),
                                      user=WORKER_UID, group=WORKER_UID, extra_groups=[], env=env,
                                      stdin=incoming, stdout=incoming, stderr=subprocess.PIPE) as process:
                    _, worker_error = process.communicate(timeout=6)
                    assert process.returncode == 0 and worker_error == b"", "Observer failed or wrote to stderr"
            stdout, stderr = caller.communicate(timeout=7)
        assert caller.returncode == 0 and stderr == b"", "Unix socket client failed"
        return json.loads(stdout)


@contextlib.contextmanager
def listener_at(path):
    with socket.socket(socket.AF_UNIX) as listener:
        listener.settimeout(6)
        listener.bind(str(path))
        os.chown(path, 0, API_GID)
        path.chmod(0o660)
        listener.listen(8)
        try:
            yield listener
        finally:
            path.unlink()


def verify():
    assert sys.platform == "linux" and os.getuid() == 0, "Run only in the disposable Linux fixture"
    from shutil import copyfile

    sys.path.insert(0, str(HERE.parent))
    from test_roundcube_observer import MAILBOX, SECRET, certificates, tls_peer

    with tempfile.TemporaryDirectory(prefix="qs-observer-") as directory:
        root = Path(directory)
        root.chmod(0o755)
        old, new = root / "old", root / "new"
        old.mkdir()
        new.mkdir()
        tls_old, _, pin_old = certificates(old)
        tls_new, _, pin_new = certificates(new)
        stage_old = stage(root / "stage-old", pin_old)
        stage_new = stage(root / "stage-new", pin_new)
        assert pin_old != pin_new
        for invalid_uid in ("0", "01", "65535", "4294967295", "41001\nEXTRA=1"):
            result = subprocess.run([str(HERE / "stage.sh"), str(root / "invalid"), invalid_uid,
                                     str(API_GID), pin_old], capture_output=True)
            assert result.returncode != 0 and not (root / "invalid").exists()
        for invalid_gid, invalid_pin in (("0", pin_old), (str(API_GID), "not-a-pin")):
            result = subprocess.run([str(HERE / "stage.sh"), str(root / "invalid"), str(API_UID),
                                     invalid_gid, invalid_pin], capture_output=True)
            assert result.returncode != 0 and not (root / "invalid").exists()
        repeated = subprocess.run([str(HERE / "stage.sh"), str(stage_old), str(API_UID),
                                   str(API_GID), pin_new], capture_output=True)
        config_old, config_new = check_stage(stage_old), check_stage(stage_new)
        assert repeated.returncode != 0 and config_old["QUANTSELF_JOBS_ROUNDCUBE_IMAP_CERT_SHA256"] == pin_old

        socket_dir = root / "run"
        socket_dir.mkdir(mode=0o755)
        path = socket_dir / "observe.sock"
        # Materialize the root-owned libexec payload outside the private staging directory.
        libexec = root / "libexec"
        libexec.mkdir(mode=0o755)
        for source in (stage_old / f"usr/local/libexec/{UNIT}").iterdir():
            copyfile(source, libexec / source.name)
        credential = root / "credentials"
        credential.mkdir(mode=0o700)
        os.chown(credential, WORKER_UID, WORKER_UID)
        password_file = credential / "imap"
        password_file.write_bytes(SECRET + b"\n")
        password_file.chmod(0o400)
        os.chown(password_file, WORKER_UID, WORKER_UID)

        with listener_at(path) as listener:
            assert path.stat().st_uid == 0 and path.stat().st_gid == API_GID and mode(path) == 0o660
            assert socket_dir.stat().st_uid == 0 and socket_dir.stat().st_gid == 0 and mode(socket_dir) == 0o755
            call = partial(exchange, listener, path, credential, libexec)
            with tls_peer(tls_old, "ok") as peer:
                args = (old / "certificate.pem", peer.server_address[1])
                assert call(config_old, *args, OUTSIDER_UID, OUTSIDER_GID) == {"socket": "denied"}
                assert call(config_old, *args, OUTSIDER_UID, API_GID) is None
                assert call(config_old, *args, 0, 0) is None
                password_file.rename(credential / "other")
                assert call(config_old, *args) is None
                (credential / "other").rename(password_file)
                assert peer.commands == [], "Denied peers or missing credential reached IMAP"
                expected = call(config_old, *args)
                assert expected["account"] == MAILBOX and expected["matches"] == [{"uid": 42, "messageId": QUERY["messageId"]}]
            with tls_peer(tls_new, "ok") as peer:
                cert = new / "certificate.pem"
                args = (cert, peer.server_address[1])
                assert call(config_old, *args) is None
                assert peer.commands == [], "An unpinned certificate received IMAP commands"
                assert call(config_new, *args)["matches"] == expected["matches"]
            with tls_peer(tls_old, "ok") as peer:
                args = (old / "certificate.pem", peer.server_address[1])
                assert call(config_new, *args) is None
                assert call(config_old, *args)["matches"] == expected["matches"]
        assert not path.exists(), "The observer socket remained after rollback"
        print("PASS Linux peer UID, socket DAC, isolated credential, pin rotation and rollback")


if __name__ == "__main__":
    if len(sys.argv) == 1:
        verify()
    elif sys.argv[1] == "worker":
        worker(*sys.argv[2:])
    elif sys.argv[1] == "client":
        client(*sys.argv[2:])
