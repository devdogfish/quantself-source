"""Run promote-home.sh against temporary paths and synthetic commands only."""

import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import sys


COMMAND = """
import fcntl, json, os, sys
from pathlib import Path

root = Path(os.environ["FIXTURE_ROOT"])
command = Path(sys.argv[0]).name
args = sys.argv[1:]
state, ingress = root / "release-state", root / "ingress"
with (root / "deploy.lock").open("r+") as lock:
    metadata = os.fstat(lock.fileno())
    inherited = []
    for entry in os.listdir("/dev/fd"):
        if entry.isdecimal() and int(entry) > 2 and int(entry) != lock.fileno():
            fd = int(entry)
            try:
                candidate = os.fstat(fd)
            except OSError:
                continue
            if (candidate.st_dev, candidate.st_ino) == (metadata.st_dev, metadata.st_ino):
                inherited.append(fd)
    assert inherited, "Shell operation lost its inherited deploy lock descriptor"
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        pass
    else:
        raise AssertionError("Shell operation ran outside the deploy lock")

def event(*fields):
    with (root / "shell-events").open("a") as stream:
        stream.write(json.dumps(fields) + "\\n")

def checked_path(text):
    path = Path(text).resolve()
    assert path.is_relative_to(root)
    return path

if command == "docker":
    metadata = json.loads((root / "shell-containers").read_text())
    if args[:3] == ["container", "inspect", "--format"]:
        assert args[3] == "{{.Name}} {{.Id}} {{.Image}}"
        event("inspect_names", *args[4:])
        for name in args[4:]:
            container_id, image = metadata[name]
            print(f"/{name} {container_id} {image}")
    elif args[:2] == ["inspect", "--format"]:
        field, ref = args[2:]
        started = {item[1] for line in (root / "shell-events").read_text().splitlines()
                   if (item := json.loads(line))[0] == "start"}
        if field == "{{.State.Running}}":
            print("true" if ref.startswith("quantself-green-") or ref in started else "false")
        elif field in ("{{.State.ExitCode}}", "{{.RestartCount}}"):
            print(0)
        elif field == "{{.State.Running}} {{.RestartCount}}":
            assert ref in started
            print("true 0")
        else:
            raise AssertionError(args)
    elif len(args) == 2 and args[0] in ("start", "stop"):
        if args[0] == "start":
            assert (state / "pending").read_text() == "blue\\ngreen\\n"
        event(*args)
    else:
        raise AssertionError(args)
elif command == "curl":
    url, = [arg for arg in args if arg.startswith(("http://", "https://"))]
    if url.endswith("/api/health"):
        print('{"service":"quantself-api","status":"ok"}')
    elif url.endswith("/heartbeat"):
        print(404 if url.startswith("https:") else 401)
    else:
        assert url.endswith("/favicon.ico")
elif command == "mv":
    assert args[0] == "-fT"
    source, target = map(checked_path, args[1:])
    os.replace(source, target)
    event("write", target.name)
elif command == "rm":
    checked_path(args[0]).unlink()
elif command == "systemctl":
    assert args == ["reload", "quantself-ingress.service"]
    assert "127.0.0.1:13000" in ingress.read_text()
    event("reload")
elif command in ("chmod", "chown"):
    assert checked_path(args[0].removeprefix("--reference=")) == ingress
    checked_path(args[1])
elif command == "sync":
    assert args[0] == "-f"
    checked_path(args[1])
elif command == "sleep":
    assert args == ["5"]
elif command == "install":
    assert args[:3] == ["-d", "-m", "0700"]
    assert checked_path(args[3]) == state and state.is_dir()
else:
    raise AssertionError(command)
"""


class RollbackShellFixture:
    def __init__(self, case, containers):
        root = self.root = case.root.resolve()
        self.script = root / "promote-home.sh"
        self.ingress = root / "ingress"
        self.events_path = root / "shell-events"
        (root / "shell-containers").write_text(json.dumps(containers))

        template = (
            "\tadmin unix//run/quantself-ingress/admin.sock\n"
            + "reverse_proxy 127.0.0.1:3000\n" * 3
            + "reverse_proxy 127.0.0.1:3001\n"
        )
        self.original_ingress = template.replace(":3000", ":13002").replace(":3001", ":13003")
        self.ingress.write_text(self.original_ingress)
        (root / "ingress.release-template").write_text(template)

        admin = case.enterContext(socket.socket(socket.AF_UNIX))
        admin_path = root / "admin.sock"
        admin.bind(str(admin_path))
        source = Path(__file__).resolve().parents[2] / "promote-home.sh"
        script = source.read_text()
        for original, replacement in {
            '[[ "$EUID" == 0 &&': f'[[ "$EUID" == {os.geteuid()} &&',
            "state=/var/lib/quantself-release": f"state={shlex.quote(str(case.state.resolve()))}",
            "ingress=/etc/quantself-ingress/Keep.Caddyfile": f"ingress={shlex.quote(str(self.ingress))}",
            "-S /run/quantself-ingress/admin.sock": f"-S {shlex.quote(str(admin_path))}",
        }.items():
            case.assertEqual(script.count(original), 1)
            script = script.replace(original, replacement)
        self.script.write_text(script)

        self.bin = root / "bin"
        self.bin.mkdir()
        shim = root / "command"
        shim.write_text(f"#!{sys.executable}\n" + COMMAND)
        shim.chmod(0o700)
        for name in ("docker", "curl", "mv", "rm", "systemctl", "chmod", "chown", "sync", "sleep", "install"):
            (self.bin / name).symlink_to(shim)
        for name in ("cat", "grep", "dirname", "cmp", "sort", "jq", "mktemp", "sed"):
            (self.bin / name).symlink_to(shutil.which(name))
        self.bash_env = root / "bash-env"
        self.bash_env.write_text("""
if ! type readarray >/dev/null 2>&1; then
  readarray() {
    [[ "$*" == "-t slots" ]] || return 1
    local line
    slots=()
    while IFS= read -r line || [[ -n "$line" ]]; do slots+=("$line"); done
  }
fi
""")

    def shell_command(self, *args):
        return [
            "/usr/bin/env", "-i", f"PATH={self.bin}", f"BASH_ENV={self.bash_env}", f"FIXTURE_ROOT={self.root}",
            "QUANTSELF_PRODUCTION_HTTPS_IP=127.0.0.1", "/bin/bash", str(self.script), *args,
        ]

    def command(self, request, plan):
        gateway_image = next(container.image_id for container in plan.containers if container.service == "gateway")
        return self.shell_command(
            "rollback-verified", str(self.root), request.prior_slot, request.target_sha, request.image_id,
            gateway_image, *plan.start_ids,
        )

    def events(self):
        return [json.loads(line) for line in self.events_path.read_text().splitlines()]
