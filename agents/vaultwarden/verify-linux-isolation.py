"""Prove the browser and service boundary on a disposable Linux runner."""

import asyncio
import json
import os
from pathlib import Path
import pwd
import select
import signal
import socket
import subprocess
import sys
import tempfile

SOURCE = Path(__file__).resolve()
sys.path.insert(0, str(SOURCE.parent))

import browser
import keys
from service import Vault, serve
from test_service import FAKE_BW, FOLDER, LOGIN_ITEM, NAME, VALUE, note

SUBMISSION = {"item_id": LOGIN_ITEM, "form": "save", "fields": {"subject": "reviewed draft"}}


def browser_process(state):
    for proc in Path("/proc").iterdir():
        if not proc.name.isdecimal():
            continue
        try:
            args = (proc / "cmdline").read_bytes().split(b"\0")
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        if b"--remote-debugging-pipe" not in args or any(arg.startswith(b"--type=") for arg in args):
            continue
        profile_arg = next((arg for arg in args if arg.startswith(b"--user-data-dir=")), None)
        if profile_arg is None:
            continue
        profile = Path(os.fsdecode(profile_arg.partition(b"=")[2]))
        if profile.is_relative_to(state):
            if any(arg.startswith(b"--remote-debugging-port") for arg in args):
                raise AssertionError("The protected Chromium process exposed a DevTools port")
            return proc, profile
    raise AssertionError("Could not find the protected Chromium process")


def verify_devtools_handles(proc):
    # Node can implement Chromium's inherited stdio pipes as Unix socketpairs.
    # Require an unnamed, non-listening stream socket or a kernel pipe for each end.
    unix_streams = set()
    for line in (proc / "net/unix").read_text().splitlines()[1:]:
        fields = line.split(maxsplit=7)
        if len(fields) == 7 and fields[3:5] == ["00000000", "0001"]:
            unix_streams.add(f"socket:[{fields[6]}]")
    for number in (3, 4):
        target = os.readlink(proc / f"fd/{number}")
        if not target.startswith("pipe:[") and target not in unix_streams:
            raise AssertionError("Chromium DevTools descriptor is not private IPC")


async def fixture(dependencies, chromium, state, fd, agent_uid):
    sys.path.insert(0, dependencies)
    browser.CHROMIUM = chromium
    protected = browser.ProtectedBrowser()
    sites = {LOGIN_ITEM: {"forms": {"save": {"fields": {"subject": "#subject"}, "approval": "owner"}}}}
    vault = Vault(str(state / "bw-fixture"), state, state / "credentials/unlock", FOLDER,
                  sites=sites, protected_browser=protected)
    with socket.socket(fileno=fd) as listener:
        server = asyncio.create_task(serve(vault, listener, agent_uid))
        try:
            await protected._start()
            cdp = await protected.browser.new_browser_cdp_session()
            await cdp.send("Browser.getVersion")
            process, profile = browser_process(state)
            print(json.dumps({"pid": int(process.name), "profile": str(profile)}), flush=True)
            await asyncio.to_thread(sys.stdin.read)
        finally:
            server.cancel()
            await asyncio.gather(server, return_exceptions=True)
            await vault.close()


def agent_probe(socket_path, credentials, profile, pid):
    proc = Path(f"/proc/{pid}")
    for read in (credentials.read_bytes, lambda: list(profile.iterdir()),
                 lambda: (proc / "fd/3").readlink(), lambda: (proc / "fd/4").readlink()):
        try:
            read()
        except PermissionError:
            continue
        raise AssertionError("The Agent UID could access a private credential, profile or DevTools handle")
    assert keys.request({"keys": [NAME]}, socket_path) == {"keys": {NAME: VALUE}}
    for request in ({"totp_challenge": True}, {"owner_lock": False}, {"keys": ["WEBSITE_PASSWORD"]}):
        assert keys.request(request, socket_path) == {"error": "unavailable"}
    changed = SUBMISSION | {"fields": {"subject": "different draft"}}
    assert keys.request({"submit_site": changed}, socket_path) == {"status": "approval_required"}
    submit = {"submit_site": SUBMISSION}
    assert keys.request(submit, socket_path) == {"status": "sign_in_required"}
    assert keys.request({"approve_submit_site": SUBMISSION}, socket_path) == {"error": "unavailable"}
    assert keys.request(submit, socket_path) == {"status": "approval_required"}
    print("Agent UID received only its startup key and was denied the private credential, browser, pipe and controls")
    print("Root approval authorized the exact form once. Agent approval, changed text and replay were denied.")


def test_directory(state, owner):
    for folder in (state, state / "bw", state / "credentials"):
        folder.mkdir(mode=0o700)
        os.chown(folder, owner.pw_uid, owner.pw_gid)
    (state / "bw/items.json").write_text(json.dumps([note()]))
    credential = state / "credentials/unlock"
    credential.write_text("synthetic-password")
    credential.chmod(0o400)
    os.chown(credential, owner.pw_uid, owner.pw_gid)
    executable = state / "bw-fixture"
    executable.write_text(f"#!{sys.executable}\n" + FAKE_BW)
    executable.chmod(0o755)
    return credential


def verify(dependencies, chromium):
    if sys.platform != "linux" or os.geteuid() != 0:
        raise SystemExit("Run on a disposable Linux host as root")
    service_user, agent_user = pwd.getpwnam("nobody"), pwd.getpwnam("www-data")
    assert service_user.pw_uid != agent_user.pw_uid and service_user.pw_gid != agent_user.pw_gid
    command = [sys.executable, "-I", str(SOURCE)]
    with tempfile.TemporaryDirectory(prefix="qs-vault-", dir="/tmp") as directory:
        root = Path(directory)
        root.chmod(0o755)
        state = root / "state"
        credential = test_directory(state, service_user)
        socket_path = root / "vault.sock"
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(socket_path))
            socket_path.chmod(0o600)
            os.chown(socket_path, agent_user.pw_uid, agent_user.pw_gid)
            listener.listen()
            fd = listener.fileno()
            with subprocess.Popen(
                command + ["--fixture", dependencies, chromium, str(state), str(fd), str(agent_user.pw_uid)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, pass_fds=(fd,),
                user=service_user.pw_uid, group=service_user.pw_gid, extra_groups=[], start_new_session=True,
                env={"HOME": str(state), "TMPDIR": str(state), "PATH": "/usr/local/bin:/usr/bin:/bin"},
                cwd=state,
            ) as child:
                try:
                    if not select.select([child.stdout], [], [], 20)[0]:
                        raise AssertionError("Protected browser startup timed out")
                    ready_line = child.stdout.readline()
                    if not ready_line:
                        raise AssertionError("Protected browser exited before startup")
                    receipt = json.loads(ready_line)
                    proc = Path(f"/proc/{receipt['pid']}")
                    profile = Path(receipt["profile"])
                    uid_line = next(line for line in (proc / "status").read_text().splitlines() if line.startswith("Uid:"))
                    assert int(uid_line.split()[2]) == service_user.pw_uid
                    assert profile.is_dir() and profile.is_relative_to(state)
                    verify_devtools_handles(proc)
                    assert keys.request({"totp_challenge": True}, str(socket_path)) == {"error": "unavailable"}
                    assert keys.request({"approve_submit_site": SUBMISSION}, str(socket_path)) == {"status": "approved"}
                    subprocess.run(
                        command + ["--probe", str(socket_path), str(credential), str(profile), str(receipt["pid"])],
                        user=agent_user.pw_uid, group=agent_user.pw_gid, extra_groups=[], cwd=root, check=True, timeout=15,
                    )
                finally:
                    child.stdin.close()
                    try:
                        child.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait()
                if child.returncode != 0:
                    raise AssertionError("Protected browser fixture did not shut down cleanly")


if __name__ == "__main__":
    match sys.argv[1:]:
        case ["--fixture", dependencies, chromium, state, fd, agent_uid]:
            asyncio.run(fixture(dependencies, chromium, Path(state), int(fd), int(agent_uid)))
        case ["--probe", socket_path, credential, profile, pid]:
            agent_probe(socket_path, Path(credential), Path(profile), int(pid))
        case [dependencies, chromium]:
            verify(dependencies, chromium)
        case _:
            raise SystemExit("Usage: verify-linux-isolation.py WHEEL_DIRECTORY CHROMIUM")
