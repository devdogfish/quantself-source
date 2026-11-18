#!/usr/bin/env python3
"""Run the exact Keep receipt forced command in disposable loopback-only Linux."""

import base64
from contextlib import ExitStack, redirect_stdout
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
from unittest.mock import patch

import atlas_keep_receipt_handoff as handoff
import backup_pair_proof as proof
import test_atlas_keep_receipt_handoff as fixtures


SCRIPTS = Path(__file__).resolve().parent
INSTALL = Path("/usr/local/lib/keep-backup")
FORCED = Path("/usr/local/libexec/keep-backup-receipt-ssh")
SUDO_RULE = Path("/etc/sudoers.d/quantself-atlas-receipt-fixture")
ACCOUNT = "atlas-receipt"
HOST = "127.0.0.1"
SSH = "/usr/bin/ssh"
SSHD = "/usr/sbin/sshd"
RUN = subprocess.run


def run(*args, check=True, input=None):
    return RUN(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check, input=input, timeout=10)


def write(path, content, mode):
    path.write_text(content)
    path.chmod(mode)


def require_disposable_container():
    error = "Run as PID 1 in a disposable --network none --hostname keep container"
    if (not __debug__ or sys.platform != "linux" or os.geteuid() != 0 or os.getpid() != 1
            or not Path("/.dockerenv").is_file() or socket.gethostname() != "keep"):
        raise AssertionError(error)
    links = Path("/sys/class/net").glob("*/flags")
    active = {link.parent.name for link in links if int(link.read_text(), 16) & 1}
    if active != {"lo"}:
        raise AssertionError(error)
    for path in (INSTALL, FORCED, SUDO_RULE, handoff.STATE, Path("/home") / ACCOUNT):
        if os.path.lexists(path):
            raise AssertionError(f"Fixture path already exists: {path}")
    try:
        pwd.getpwnam(ACCOUNT)
    except KeyError:
        return
    raise AssertionError("The disposable account already exists")


def setup_fixture(cleanup, fixture, scratch):
    cleanup.enter_context(patch.object(handoff, "read_receipt_frame", REAL_READER))
    shutil.copytree(fixture.keep, "/var/lib/keep-backup")
    cleanup.callback(shutil.rmtree, "/var/lib/keep-backup")
    INSTALL.mkdir(parents=True)
    cleanup.callback(shutil.rmtree, INSTALL)
    for source in SCRIPTS.glob("*.py"):
        shutil.copyfile(source, INSTALL / source.name)
        (INSTALL / source.name).chmod(0o644)
    if not FORCED.parent.exists():
        FORCED.parent.mkdir(parents=True)
        cleanup.callback(FORCED.parent.rmdir)
    shutil.copyfile(SCRIPTS / FORCED.name, FORCED)
    FORCED.chmod(0o755)
    cleanup.callback(FORCED.unlink)

    bin_dir = scratch / "bin"
    bin_dir.mkdir()
    completed = datetime.fromisoformat(fixture.pair["completed_at"])
    journal = json.dumps({"MESSAGE": fixture.logged, "_SYSTEMD_UNIT": proof.BACKUP,
                          "_SYSTEMD_INVOCATION_ID": fixture.invocation,
                          "__REALTIME_TIMESTAMP": str(int(completed.timestamp() * 1_000_000))})
    service = (f"Id={proof.BACKUP}\nInvocationID={fixture.invocation}\nActiveState=inactive\n"
               "Result=success\nExecMainCode=1\nExecMainStatus=0")
    for unit_command, expected, body in (("systemctl", proof.BACKUP, service),
                                          ("journalctl", f"_SYSTEMD_INVOCATION_ID={fixture.invocation}", journal)):
        write(bin_dir / unit_command,
              f"#!/usr/bin/python3\nimport sys\nassert sys.argv[-1] == {expected!r}\nprint({body!r})\n",
              0o755)
    write(SUDO_RULE,
          f'Defaults:{ACCOUNT} secure_path="{bin_dir}:/usr/bin:/bin"\n'
          f"{ACCOUNT} ALL=(root) NOPASSWD: /usr/bin/python3 -B {INSTALL}/atlas_keep_receipt_handoff.py export\n",
          0o440)
    cleanup.callback(SUDO_RULE.unlink)
    run("/usr/sbin/visudo", "-cf", str(SUDO_RULE))


def setup_ssh(cleanup, scratch):
    run("/usr/sbin/useradd", "-m", "-s", "/bin/sh", "-p", "*", ACCOUNT)
    cleanup.callback(run, "/usr/sbin/userdel", "-r", ACCOUNT)
    account = pwd.getpwnam(ACCOUNT)
    host_key, client_key, wrong_key = (scratch / name for name in ("host", "client", "wrong"))
    for key in (host_key, client_key, wrong_key):
        run("/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key))
    user_ssh = Path(account.pw_dir) / ".ssh"
    user_ssh.mkdir(mode=0o700)
    os.chown(user_ssh, account.pw_uid, account.pw_gid)
    expires = (datetime.now(timezone.utc) + timedelta(minutes=5)).strftime("%Y%m%d%H%M%SZ")
    authorized = user_ssh / "authorized_keys"
    write(authorized,
          f'restrict,expiry-time="{expires}",command="{FORCED}" {client_key.with_suffix(".pub").read_text()}', 0o600)
    os.chown(authorized, account.pw_uid, account.pw_gid)
    known_hosts, wrong_hosts = (scratch / name for name in ("known_hosts", "wrong_hosts"))
    write(known_hosts, f"{HOST} {host_key.with_suffix('.pub').read_text()}", 0o600)
    write(wrong_hosts, f"{HOST} {wrong_key.with_suffix('.pub').read_text()}", 0o600)

    runtime = Path("/run/sshd")
    if not runtime.exists():
        runtime.mkdir()
        cleanup.callback(runtime.rmdir)
    config = scratch / "sshd_config"
    write(config, f"""Port 22
ListenAddress {HOST}
HostKey {host_key}
PidFile {scratch / "sshd.pid"}
AllowUsers {ACCOUNT}
AuthorizedKeysFile .ssh/authorized_keys
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
PermitRootLogin no
""", 0o600)
    run(SSHD, "-t", "-f", str(config))
    daemon = subprocess.Popen([SSHD, "-D", "-e", "-f", str(config)],
                              stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    cleanup.callback(stop_daemon, daemon)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and daemon.poll() is None:
        try:
            with socket.create_connection((HOST, 22), timeout=0.2):
                return daemon, client_key, wrong_key, known_hosts, wrong_hosts
        except OSError:
            time.sleep(0.05)
    raise AssertionError("Loopback SSH fixture did not start")


def stop_daemon(daemon):
    if daemon.poll() is None:
        daemon.terminate()
        try:
            daemon.wait(timeout=5)
        except subprocess.TimeoutExpired:
            daemon.kill()
            daemon.wait(timeout=5)


def ssh_request(identity, known_hosts, *request, forwarding=(), input=None):
    return run(SSH, "-F", "/dev/null", "-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
               "-o", "IdentityAgent=none", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no",
               "-o", "GlobalKnownHostsFile=/dev/null", "-o", f"UserKnownHostsFile={known_hosts}",
               "-i", str(identity), *forwarding, "--", f"{ACCOUNT}@{HOST}", *request, input=input, check=False)


def prove(fixture, client, wrong_key, known_hosts, wrong_hosts):
    allowed = ssh_request(client, known_hosts, handoff.EXPORT_COMMAND)
    assert allowed.returncode == 0, allowed.stderr.decode()
    envelope = json.loads(allowed.stdout)
    assert base64.b64decode(envelope["complete_base64"], validate=True) == fixture.raw
    assert envelope["complete_sha256"] == hashlib.sha256(fixture.raw).hexdigest()
    assert envelope["invocation_id"] == fixture.invocation

    shell = ssh_request(client, known_hosts, input=b"echo unexpected-shell\n")
    other = ssh_request(client, known_hosts, "id")
    for result in (shell, other):
        assert result.returncode != 0 and not result.stdout and b"Only the Keep backup receipt" in result.stderr
    denied_sudo = run("/usr/sbin/runuser", "-u", ACCOUNT, "--", "/usr/bin/sudo", "-n", "/usr/bin/id", check=False)
    assert denied_sudo.returncode != 0 and not denied_sudo.stdout
    forward = ssh_request(client, known_hosts, forwarding=("-W", f"{HOST}:22"))
    assert forward.returncode != 0 and not forward.stdout and b"administratively prohibited" in forward.stderr
    reverse = ssh_request(client, known_hosts, forwarding=("-N", "-R", f"{HOST}:6222:{HOST}:22",
                                                          "-o", "ExitOnForwardFailure=yes"))
    assert reverse.returncode != 0 and not reverse.stdout and b"remote port forwarding failed" in reverse.stderr
    client_denied = ssh_request(wrong_key, known_hosts, handoff.EXPORT_COMMAND)
    assert client_denied.returncode != 0 and not client_denied.stdout and b"Permission denied" in client_denied.stderr
    host_denied = ssh_request(client, wrong_hosts, handoff.EXPORT_COMMAND)
    assert host_denied.returncode != 0 and not host_denied.stdout and b"Host key verification failed" in host_denied.stderr

    atlas = fixture.atlas
    output = io.StringIO()
    argv = [handoff.__file__, "preview", "--keep-host", HOST, "--keep-known-hosts", str(known_hosts),
            "--keep-identity-file", str(client), "--policy", str(atlas.policy_path),
            "--policy-sha256", atlas.policy_sha, "--keyfile", str(fixture.keyfile),
            "--password-file", str(fixture.password)]
    with patch.object(sys, "argv", argv), redirect_stdout(output):
        handoff.main()
    assert json.loads(output.getvalue()) == {"status": "preview", "restore_id": atlas.restore_id, "vmid": 901}
    assert fixture.steps == ["atlas_postgres_restore_point.py", "atlas_postgres_restore_drill.py"]
    assert len(fixture.reader_calls) == 3 and not atlas.events
    assert all(not scratch.exists() for scratch in fixture.scratch), "Atlas preview scratch remained"


REAL_READER = handoff.read_receipt_frame


def main():
    require_disposable_container()
    with TemporaryDirectory(prefix="atlas-ssh-proof-") as directory, ExitStack() as cleanup:
        scratch = Path(directory)
        fixture = fixtures.KeepReceiptHandoffTest("test_exact_receipt_through_producer_and_atlas_preview")
        cleanup.callback(fixture.doCleanups)
        fixture.setUp()
        setup_fixture(cleanup, fixture, scratch)
        daemon, *keys = setup_ssh(cleanup, scratch)
        prove(fixture, *keys)
    assert daemon.poll() is not None and not scratch.exists(), "SSH process or keys remained"
    for path in (INSTALL, FORCED, SUDO_RULE, Path("/var/lib/keep-backup"), Path("/home") / ACCOUNT):
        assert not path.exists(), f"Fixture path remained: {path}"
    print("Verified loopback SSH export and Atlas preview, shell and forwarding denials, both key pins, and cleanup.")


if __name__ == "__main__":
    main()
