#!/usr/bin/env python3
"""Owner-only B2 credential handoff. Do not run in an agent or captured terminal."""
import argparse
import base64
import fcntl
import getpass
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import stat
import subprocess
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import warnings

ROOT = Path(__file__).resolve().parent
API_VERSION = "/b2api/v4/"
AUTHORIZE = "https://api.backblazeb2.com" + API_VERSION + "b2_authorize_account"
CA_ENDPOINT = r"https://s3\.(ca-east-[0-9]{3})\.backblazeb2\.com"
BUCKET_NAME = r"[a-z0-9][a-z0-9-]{4,61}[a-z0-9]"
ROLES = {"quantself": "quantself", "vault": "files"}
# B2's S3 integration requires listAllBucketNames for bucket-restricted SDK
# keys; it discloses bucket names, not files. No deleteFiles or admin access.
UPLOAD_CAPABILITIES = ["listBuckets", "listAllBucketNames", "listFiles", "readFiles", "writeFiles"]
LIFECYCLE = {"fileNamePrefix": "", "daysFromHidingToDeleting": 30, "daysFromUploadingToHiding": None}
GUEST_DIRECTORY = "/etc/keep-restic"


class SetupError(Exception):
    """Safe to display: only fixed text and non-secret operation names."""


class B2Rejection(SetupError):
    """B2 explicitly rejected the operation before creation."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def api_json(url, authorization, operation, body=None):
    request = Request(url, data=None if body is None else json.dumps(body).encode(),
                      headers={"Authorization": authorization, "Content-Type": "application/json"})
    try:
        with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=30) as result:
            return json.load(result)
    except HTTPError as error:
        error_type = B2Rejection if error.code in (400, 401, 403) else SetupError
        raise error_type(f"B2 {operation} returned HTTP {error.code}; rerun to reconcile.") from None
    except (URLError, OSError, ValueError):
        raise SetupError(f"B2 {operation} failed; rerun to reconcile.") from None


class B2:
    def __init__(self, response):
        storage = response["apiInfo"]["storageApi"]
        allowed = storage["allowed"]
        required = {"listBuckets", "writeBuckets", "listKeys", "writeKeys"}
        if allowed.get("buckets") or allowed.get("namePrefix") or not required <= set(allowed["capabilities"]):
            raise SetupError("Use an unrestricted Owner master key for setup.")
        self.endpoint = storage["s3ApiUrl"]
        region = re.fullmatch(CA_ENDPOINT, self.endpoint)
        if not region:
            raise SetupError("B2 S3 endpoint is not Canada East; no resources changed.")
        self.region = region[1]
        self.api_url = storage["apiUrl"]
        if not re.fullmatch(r"https://api[0-9]+\.backblazeb2\.com", self.api_url):
            raise SetupError("Unexpected B2 Native API endpoint; no resources changed.")
        self.account = response["accountId"]
        self.token = response["authorizationToken"]
        if not isinstance(self.account, str) or not self.account or not isinstance(self.token, str) or not self.token:
            raise SetupError("Unexpected B2 authorization response; no resources changed.")

    def call(self, operation, **fields):
        return api_json(self.api_url + API_VERSION + operation, self.token,
                        operation, {"accountId": self.account, **fields})


def private_json(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(fd) as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise SetupError("Recovery state must be regular, Owner-owned files with mode 0600.")
        value = json.load(source)
        if not isinstance(value, dict):
            raise SetupError("Unexpected recovery state; existing files preserved.")
        return value


def save_private(path, value):
    # Publish a complete fsynced file without overwriting existing recovery state.
    # The caller holds the recovery-directory lock.
    if path.exists() or path.is_symlink():
        raise SetupError("Recovery state already exists; no overwrite.")
    fd, temporary = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    with os.fdopen(fd, "w") as target:
        json.dump(value, target)
        target.write("\n")
        target.flush()
        os.fsync(target.fileno())
    os.link(temporary, path)
    os.unlink(temporary)
    sync_directory(path.parent)


def sync_directory(path):
    directory_fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def bucket_for(b2, name, directory):
    path = directory / "setup.json"
    saved = private_json(path)
    identity = {"accountId": b2.account, "s3ApiUrl": b2.endpoint, "bucketName": name}
    if saved is not None and any(saved.get(key) != value for key, value in identity.items()):
        raise SetupError("Recovery state belongs to a different account, endpoint or bucket.")
    existing = b2.call("b2_list_buckets", bucketName=name)["buckets"]
    if len(existing) > 1 or (existing and saved is None):
        raise SetupError("Bucket already exists without matching setup intent; no adoption.")
    if saved is None:
        saved = {**identity, "marker": secrets.token_hex(16),
                 "passwords": {role: secrets.token_hex(32) for role in ROLES}}
        save_private(path, saved)
    if (not re.fullmatch(r"[a-f0-9]{32}", saved["marker"]) or
            any(not re.fullmatch(r"[a-f0-9]{64}", saved["passwords"][role]) for role in ROLES) or
            saved["passwords"]["quantself"] == saved["passwords"]["vault"]):
        raise SetupError("Unexpected recovery state; existing files preserved.")
    marker = {"keep-setup": saved["marker"]}
    bucket_path = directory / "bucket.json"
    recorded = private_json(bucket_path)
    key_paths = (directory / f"{role}-key.json" for role in ROLES)
    if not existing and (recorded is not None or any(path.exists() or path.is_symlink() for path in key_paths)):
        raise SetupError("Previously configured bucket is missing; no recreation.")
    bucket = existing[0] if existing else b2.call(
        "b2_create_bucket", bucketName=name, bucketType="allPrivate",
        bucketInfo=marker, lifecycleRules=[LIFECYCLE])
    rules = bucket["lifecycleRules"]
    if (bucket["accountId"] != b2.account or bucket["bucketName"] != name or
            bucket["bucketType"] != "allPrivate" or bucket["bucketInfo"] != marker or
            len(rules) != 1 or any(rules[0].get(key) != value for key, value in LIFECYCLE.items()) or
            any(value is not None for key, value in rules[0].items() if key not in LIFECYCLE)):
        raise SetupError("Bucket ownership marker, privacy or lifecycle policy does not match; no changes.")
    bound = {"bucketId": bucket["bucketId"]}
    if recorded is None:
        save_private(bucket_path, bound)
    elif recorded != bound:
        raise SetupError("Bucket ID changed; no adoption.")
    return bucket["bucketId"], saved["passwords"]


def relevant_keys(b2, names):
    keys = {name: [] for name in names}
    cursor = None
    seen = set()
    while True:
        page = b2.call("b2_list_keys", maxKeyCount=1000,
                       **({"startApplicationKeyId": cursor} if cursor else {}))
        for key in page["keys"]:
            if key["keyName"] in keys:
                keys[key["keyName"]].append(key)
        cursor = page.get("nextApplicationKeyId")
        if not cursor:
            return keys
        if cursor in seen:
            raise SetupError("B2 key listing repeated a page; no credentials installed.")
        seen.add(cursor)


def validate_key(key, b2, expected):
    if (key.get("accountId") != b2.account or key.get("keyName") != expected["keyName"] or
            key.get("bucketIds") != expected["bucketIds"] or key.get("namePrefix") != expected["namePrefix"] or
            sorted(key.get("capabilities", [])) != sorted(UPLOAD_CAPABILITIES) or
            key.get("expirationTimestamp") is not None):
        raise SetupError("B2 key scope does not match expected uploader access; no credentials installed.")


def reconcile_key(b2, role, fields, saved, existing, intent):
    if saved is None:
        if existing or intent is not None:
            raise SetupError(f"{role}: key creation has no local response. Owner must reconcile it; no duplicate created.")
        return
    if len(existing) != 1 or existing[0].get("applicationKeyId") != saved.get("applicationKeyId"):
        raise SetupError(f"{role}: saved key is absent or conflicts in B2; no replacement created.")
    validate_key(existing[0], b2, fields)
    validate_secret(b2, role, fields, saved)


def validate_secret(b2, role, fields, saved):
    validate_key(saved, b2, fields)
    for field in ("applicationKeyId", "applicationKey"):
        if not isinstance(saved.get(field), str) or not re.fullmatch(r"[A-Za-z0-9_+/=-]{1,512}", saved[field]):
            raise SetupError(f"{role}: unexpected key format; private response retained.")


def guest_payload(b2, name, role, key, password):
    values = {"RESTIC_REPOSITORY": f"s3:{b2.endpoint}/{name}/{role}",
              "RESTIC_PASSWORD_FILE": GUEST_DIRECTORY + "/password",
              "AWS_DEFAULT_REGION": b2.region,
              "AWS_ACCESS_KEY_ID": key["applicationKeyId"],
              "AWS_SECRET_ACCESS_KEY": key["applicationKey"]}
    return {"repository.env": "".join(f"{k}={shlex.quote(v)}\n" for k, v in values.items()),
            "password": password + "\n"}


# Only the JSON sent on stdin contains credentials. Check both targets before
# publishing either. A partial SSH run is safely retried with the same values.
GUEST_INSTALL = """import fcntl, json, os, stat, sys, tempfile
from pathlib import Path

directory = Path(sys.argv[1])
payload = json.load(sys.stdin)
if set(payload) != {"repository.env", "password"}:
    raise SystemExit(2)
directory.mkdir(mode=0o700, exist_ok=True)
directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
info = os.fstat(directory_fd)
if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid or info.st_gid:
    raise SystemExit(3)
fcntl.flock(directory_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
pending = {}
for name, value in payload.items():
    path = directory / name
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        pending[path] = value
        continue
    with os.fdopen(fd) as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid or info.st_gid or source.read() != value:
            raise SystemExit(4)
for path, value in pending.items():
    fd, temporary = tempfile.mkstemp(prefix=".pending-", dir=directory)
    with os.fdopen(fd, "w") as output:
        output.write(value)
        output.flush()
        os.fsync(output.fileno())
    os.link(temporary, path)
    os.unlink(temporary)
os.fsync(directory_fd)
os.close(directory_fd)
"""


def install_guest(host, payload):
    ssh = [sys.executable, str(ROOT / "owner-pinned-ssh.py"),
           "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
           "-o", "IdentitiesOnly=yes", "-i", str(Path.home() / ".ssh/proton.pub"),
           "-o", f"IdentityAgent={Path.home() / '.ssh/proton-pass-agent.sock'}"]
    command = "sudo -n python3 -c " + shlex.quote(GUEST_INSTALL) + " " + shlex.quote(GUEST_DIRECTORY)
    try:
        result = subprocess.run(ssh + [f"devdogfish@{host}.tail555ca5.ts.net", command],
                                input=json.dumps(payload), text=True, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        raise SetupError(f"{host}: SSH install failed; recovery copy retained. Rerun to reconcile.") from None
    if result.returncode:
        raise SetupError(f"{host}: SSH install failed (exit {result.returncode}); recovery copy retained.")


def setup(b2, name, directory, install=install_guest):
    bucket_id, passwords = bucket_for(b2, name, directory)
    names = {role: f"{name}-{role}-upload" for role in ROLES}
    listed = relevant_keys(b2, names.values())
    paths = {role: directory / f"{role}-key.json" for role in ROLES}
    intents = {role: directory / f"{role}-key-attempt.json" for role in ROLES}
    fields = {role: {"keyName": names[role], "bucketIds": [bucket_id],
                     "namePrefix": f"{role}/", "capabilities": UPLOAD_CAPABILITIES}
              for role in ROLES}
    keys = {role: private_json(path) for role, path in paths.items()}
    for role in ROLES:
        reconcile_key(b2, role, fields[role], keys[role], listed[names[role]], private_json(intents[role]))
    for role in ROLES:
        if keys[role] is None:
            # Key names are not unique in B2. Persist intent before the request
            # so a crash/lost reply cannot result in a duplicate on stale reads.
            save_private(intents[role], fields[role])
            try:
                keys[role] = b2.call("b2_create_key", **fields[role])
            except B2Rejection:
                intents[role].unlink()
                sync_directory(directory)
                raise
            # B2 returns the secret exactly once. Persist the reply before
            # validation or any further network operations.
            save_private(paths[role], keys[role])
            validate_secret(b2, role, fields[role], keys[role])
    for role, host in ROLES.items():
        install(host, guest_payload(b2, name, role, keys[role], passwords[role]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", required=True, help="New globally unique, non-personal B2 bucket name")
    parser.add_argument("--recovery-directory", required=True, type=Path,
                        help="Absolute private directory outside the checkout; reuse on retry")
    args = parser.parse_args()
    if not re.fullmatch(BUCKET_NAME, args.bucket) or args.bucket.startswith("b2-"):
        raise SetupError("Use a new 6–63 character bucket name: lowercase ASCII letters, digits, hyphens; begin and end with a letter or digit; no b2- prefix.")
    if not sys.stdin.isatty():
        raise SetupError("Run in a private interactive Owner terminal.")
    directory = args.recovery_directory
    if (not directory.is_absolute() or directory.resolve() != directory or
            directory.is_relative_to(ROOT.parents[2])):
        raise SetupError("Recovery directory must be absolute, outside the checkout, without symlinks.")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise SetupError("Recovery directory must be Owner-owned with mode 0700.")
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SetupError("Another Owner setup run holds the recovery directory lock.") from None
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            key_id = getpass.getpass("B2 Canada East master key ID (hidden): ")
            key = getpass.getpass("B2 Canada East master application key (hidden): ")
        if not key_id or not key:
            raise SetupError("Both B2 master key fields are required.")
        basic = base64.b64encode(f"{key_id}:{key}".encode()).decode()
        del key_id, key
        response = api_json(AUTHORIZE, "Basic " + basic, "b2_authorize_account")
        del basic
        setup(B2(response), args.bucket, directory)
    finally:
        os.close(fd)
    print("Scoped B2 credentials installed on both guests; repositories are not initialized.")
    print(f"Independent Mac recovery copy: {directory}. Retain privately outside the guests.")


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print(str(error) if isinstance(error, SetupError) else
              "Setup stopped; existing files preserved. No secret values displayed.", file=sys.stderr)
        sys.exit(1)
