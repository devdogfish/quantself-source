#!/usr/bin/env python3
"""Owner-run secret handoff. Agents may review this source but must not execute it."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
SPACE = "d3a176a6-2f2a-49fe-9ead-159902b4c48f$36b7656a-8f4c-4d30-8fdd-2934394b7102"
SSH = [sys.executable, str(ROOT / "owner-pinned-ssh.py"),
       "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
       "-o", "IdentitiesOnly=yes",
       "-i", str(Path.home() / ".ssh/proton.pub"), "-o",
       f"IdentityAgent={Path.home() / '.ssh/proton-pass-agent.sock'}"]


def remote(host, command, payload=None, timeout=120):
    result = subprocess.run(SSH + [f"devdogfish@{host}.tail555ca5.ts.net", command],
                            input=payload, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        # Subprocess errors can include credentials; never echo their output.
        raise RuntimeError(f"{host}: step failed (exit {result.returncode}); credentials retained, no values displayed")
    return result.stdout


def save_new(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as target:
        target.write(value)
        target.flush()
        os.fsync(target.fileno())


def read_private(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise RuntimeError("Existing recovery file must be a private regular file")
    return path.read_text()


def valid_app_token(value):
    # OpenCloud 7.2.5 defaults to six diceware words joined with ASCII spaces.
    # Its optional random generator emits one alphanumeric token. Both are safe
    # inside the literal single-quoted Compose value below. Reject control chars,
    # quotes and shell/dotenv syntax rather than interpolating arbitrary output.
    return isinstance(value, str) and 8 <= len(value) <= 512 and bool(
        re.fullmatch(r"[A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*", value))


def parse_app_token(output):
    tokens = re.findall(r"^ token: (.*)$", output, re.MULTILINE)
    if len(tokens) != 1 or not valid_app_token(tokens[0]):
        raise RuntimeError("App token output format unexpected; private response retained for retry; no values displayed")
    return tokens[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--recovery-directory", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.+%-]+@[A-Za-z0-9.-]+", args.email):
        raise RuntimeError("Enter a valid Owner email without shell metacharacters")
    directory = Path(args.recovery_directory)
    if not directory.is_absolute() or directory.is_symlink():
        raise RuntimeError("Recovery directory must be absolute and not a symlink")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    path = directory / "keep-app-secrets.json"
    image = remote("quantself", "sudo -n cat /opt/keep-quantself/image-id").strip()
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise RuntimeError("Verified image is not installed; do not create credentials yet")
    remote("quantself", "sudo -n docker image inspect " + shlex.quote(image) + " --format '{{.Id}}'")
    if path.exists() or path.is_symlink():
        bundle = json.loads(read_private(path))
        if bundle["ownerEmail"] != args.email:
            raise RuntimeError("Existing credentials belong to a different Owner email")
        if dt.datetime.fromisoformat(bundle["tokenExpiresAt"]) <= dt.datetime.now(dt.timezone.utc):
            raise RuntimeError("Saved app token expired; use the deliberate rotation procedure")
    else:
        pending = directory / "keep-app-token-pending.json"
        if pending.exists() or pending.is_symlink():
            response = json.loads(read_private(pending))
            now = dt.datetime.fromisoformat(response["createdAt"])
        else:
            now = dt.datetime.now(dt.timezone.utc)
            output = remote("files", "sudo -n docker exec keep-vault-opencloud-1 opencloud auth-app create --user-name quantself --expiration 2160h")
            # Save before parsing so a formatting mismatch never creates a new
            # credential on every retry. This file is Owner-only recovery data.
            response = {"createdAt": now.isoformat(), "output": output}
            save_new(pending, json.dumps(response) + "\n")
        if now + dt.timedelta(days=90) <= dt.datetime.now(dt.timezone.utc):
            raise RuntimeError("Pending app token expired; use the deliberate rotation procedure")
        bundle = {"ownerEmail": args.email, "databasePassword": secrets.token_hex(32),
                  "appToken": parse_app_token(response["output"]), "tokenCreatedAt": now.isoformat(),
                  "tokenExpiresAt": (now + dt.timedelta(days=90)).isoformat()}
        save_new(path, json.dumps(bundle) + "\n")
    password = bundle["databasePassword"]
    if not re.fullmatch(r"[0-9a-f]{64}", password) or not valid_app_token(bundle["appToken"]):
        raise RuntimeError("Saved credential format unexpected; existing files preserved")
    values = {"QUANTSELF_IMAGE": image, "QUANTSELF_OWNER_EMAIL": args.email,
              "POSTGRES_PASSWORD": password,
              "DATABASE_URL": f"postgresql://quantself:{password}@postgres:5432/quantself",
              "QUANTSELF_OPENCLOUD_SPACE_ID": SPACE, "QUANTSELF_OPENCLOUD_USERNAME": "quantself",
              "QUANTSELF_OPENCLOUD_TOKEN": bundle["appToken"], "QUANTSELF_ORIGINALS_WRITE_PAUSED": "0"}
    # Single quotes keep the literal dollar sign in OpenCloud's compound space ID.
    env = "".join(f"{key}='{value}'\n" for key, value in values.items())
    install = """import sys, os
from pathlib import Path
p=Path('/opt/keep-quantself/.env'); value=sys.stdin.read()
if p.is_symlink(): raise SystemExit(2)
if p.exists():
 if p.read_text()!=value: raise SystemExit(3)
else:
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f: f.write(value); f.flush(); os.fsync(f.fileno())
p.chmod(0o600)
"""
    remote("quantself", "sudo -n python3 -c " + shlex.quote(install), env)
    metadata = {key: bundle[key] for key in ("tokenCreatedAt", "tokenExpiresAt")}
    metadata.update({"username": "quantself", "spaceId": SPACE, "rotationDueDaysBeforeExpiry": 14})
    install_metadata = """import sys, os
from pathlib import Path
p=Path('/opt/keep-quantself/app-token-metadata.json')
if p.is_symlink(): raise SystemExit(2)
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'w') as f: f.write(sys.stdin.read())
"""
    remote("quantself", "sudo -n python3 -c " + shlex.quote(install_metadata), json.dumps(metadata) + "\n")
    compose = "sudo -n docker compose --project-directory /opt/keep-quantself --env-file /opt/keep-quantself/.env -f /opt/keep-quantself/compose.yaml"
    remote("quantself", compose + " config --quiet")
    remote("quantself", compose + " up -d --wait --wait-timeout 240", timeout=300)
    print("Private credentials installed; app services passed startup health checks.")
    print(f"Recovery copy: {path}. Retain independently; never paste its contents.")
    print("App token expires: " + bundle["tokenExpiresAt"])


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        # JSON/subprocess parse errors may embed sensitive input; report only safe failures.
        print(str(error) if isinstance(error, RuntimeError) else "Setup stopped; existing files preserved. No secret values displayed.", file=sys.stderr)
        sys.exit(1)
