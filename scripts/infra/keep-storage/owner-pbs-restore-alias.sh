#!/usr/bin/env bash
# Owner-only. Install the approved temporary PBS alias from the independent Mac key.
set +x
set -euo pipefail

if [[ $# -ne 1 || ! $1 =~ ^([0-9a-f]{2}:){31}[0-9a-f]{2}$ ]]; then
  echo "Usage: $0 <client encryption fingerprint from the approved complete pair>" >&2
  exit 2
fi
if [[ ! ${KEEP_PBS_SSH_HOST:-} =~ ^([A-Za-z0-9-]+\.)+ts\.net$ ]]; then
  echo 'Required SSH destination missing or invalid (1)' >&2
  exit 1
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
recovery_key="$HOME/.local/share/quantself-recovery/keep-pbs.key"
[[ -f "$recovery_key" && ! -L "$recovery_key" && -O "$recovery_key" ]] || {
  echo "The Owner's independent recovery file is unavailable" >&2
  exit 1
}
read -r key_mode key_size < <(stat -f '%Lp %z' "$recovery_key")
[[ "$key_mode" == 600 && "$key_size" =~ ^[1-9][0-9]{0,4}$ && "$key_size" -le 16384 ]] || {
  echo "The Owner's recovery file must be mode 0600 and between 1 and 16384 bytes" >&2
  exit 1
}

remote=$(cat <<'PY'
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys

ALIAS = "backup-restore-254"
PRIVATE = Path("/etc/pve/priv/storage")
METADATA = ("server", "port", "datastore", "namespace", "fingerprint", "username")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def get(path):
    return json.loads(subprocess.check_output(
        ["pvesh", "get", path, "--output-format", "json"], stderr=subprocess.DEVNULL))


def change(*args):
    # The PVE create response can include the supplied client key.
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def install(expected):
    require(os.geteuid() == 0 and Path("/etc/pve/local").resolve().name == "keep",
            "Expected root on PVE node keep")
    require(re.fullmatch(r"(?:[0-9a-f]{2}:){31}[0-9a-f]{2}", expected),
            "Expected a complete-pair encryption fingerprint")
    source = get("/storage/backup")
    require(source.get("type") == "pbs" and source.get("datastore") == "main"
            and source.get("server") and source.get("username") and source.get("fingerprint")
            and str(source.get("encryption-key", "")).lower() == expected,
            "Source PBS metadata differs from the approved pair")
    require(all(row.get("storage") != ALIAS for row in get("/storage")),
            "Temporary alias already exists; review its state before retrying")
    alias_key = PRIVATE / (ALIAS + ".enc")
    alias_password = PRIVATE / (ALIAS + ".pw")
    require(not os.path.lexists(alias_key) and not os.path.lexists(alias_password),
            "Temporary alias already has private files; review before retrying")
    password = PRIVATE / "backup.pw"
    info = password.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_size > 0,
            "Existing PBS credential file is unavailable")

    args = ["pvesm", "add", "pbs", ALIAS, "--disable", "1", "--nodes", "keep",
            "--content", "backup", "--encryption-key", "/dev/stdin"]
    for key in METADATA:
        if source.get(key) is not None:
            args.extend(("--" + key, str(source[key])))
    change(*args)

    alias = get("/storage/" + ALIAS)
    require(alias.get("type") == "pbs" and str(alias.get("disable")) == "1" and alias.get("nodes") == "keep"
            and all(alias.get(key) == source.get(key) for key in METADATA)
            and str(alias.get("encryption-key", "")).lower() == expected,
            "Imported alias metadata or encryption fingerprint differs")
    os.umask(0o077)
    with password.open("rb") as source_file, alias_password.open("xb") as alias_file:
        shutil.copyfileobj(source_file, alias_file)
    change("pvesm", "set", ALIAS, "--disable", "0")
    subprocess.run(["pvesm", "list", ALIAS, "--content", "backup", "--vmid", "2540"],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("Temporary PBS alias enabled and readable")


try:
    install(sys.argv[1])
except ValueError as error:
    # Only our fixed validation messages may be shown.
    print(error if type(error) is ValueError else "Invalid PBS metadata", file=sys.stderr)
    sys.exit(1)
except (OSError, subprocess.CalledProcessError):
    sys.exit("PBS setup failed; inspect the temporary alias before retrying")
PY
)
# Shell-quote the fixed Python code for the remote shell. The key travels only via stdin.
remote_quoted=$(printf "%s" "$remote" | sed "s/'/'\\\\''/g")
python3 "${script_dir}/owner-pinned-ssh.py" \
  -T -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -i "$HOME/.ssh/proton.pub" -o "IdentityAgent=$HOME/.ssh/proton-pass-agent.sock" \
  "devdogfish@${KEEP_PBS_SSH_HOST}" \
  "sudo -n python3 -c '$remote_quoted' '$1'" < "$recovery_key"
