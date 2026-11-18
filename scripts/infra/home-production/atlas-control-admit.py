#!/usr/bin/env python3
"""Review-stage verifier for a private control repository's deployment request."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import select
import ssl
import stat
import sys
import tempfile
from threading import Timer
import time


POLICY_PATH = Path("/etc/quantself-atlas/control-policy.json")
API_HOST = "api.github.com"
SHA = r"[0-9a-f]{40}"
RUN_ID = r"[1-9][0-9]{0,19}"
ATTEMPT = r"[1-9][0-9]{0,9}"
MAX_TOKEN = 4096
MAX_RESPONSE = 256 * 1024
TOKEN_TIMEOUT = 10
API_TIMEOUT = 8
ADMISSION_TIMEOUT = 20
FAILURE = "Control admission rejected."
MAX_RUN_AGE = timedelta(minutes=15)
CLOCK_SKEW = timedelta(seconds=5)


@dataclass(frozen=True)
class ControlPolicy:
    repository: str
    repository_id: int
    workflow_path: str
    workflow_id: int
    owner_id: int
    control_sha: str

    def __post_init__(self):
        for value, pattern in (
            (self.repository, r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*"),
            (self.workflow_path, r"\.github/workflows/[A-Za-z0-9][A-Za-z0-9_.-]*\.ya?ml"),
            (self.control_sha, SHA),
        ):
            if not isinstance(value, str) or not re.fullmatch(pattern, value):
                raise ValueError("Invalid control policy")
        if self.repository.casefold() == "devdogfish/quantself" or any(
            type(value) is not int or not 0 < value < 10**20
            for value in (self.repository_id, self.workflow_id, self.owner_id)
        ):
            raise ValueError("Invalid control policy")


@dataclass(frozen=True)
class RollbackControlPolicy(ControlPolicy):
    workflow_sha256: str

    def __post_init__(self):
        super().__post_init__()
        if not isinstance(self.workflow_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", self.workflow_sha256):
            raise ValueError("Invalid rollback workflow digest")


@dataclass(frozen=True)
class Request:
    source_sha: str
    run_id: str
    attempt: str

    def __post_init__(self):
        for value, pattern in ((self.source_sha, SHA), (self.run_id, RUN_ID), (self.attempt, ATTEMPT)):
            if not isinstance(value, str) or not re.fullmatch(pattern, value):
                raise ValueError("Invalid control request")


def require_control_directory(directory):
    if directory.resolve(strict=True) != directory:
        raise ValueError("Expected resolved control policy directory")
    for parent in (directory, *directory.parents):
        info = parent.stat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("Expected root-controlled policy directory")


def read_control_record(path, *, mode=None):
    if path.resolve(strict=True) != path:
        raise ValueError("Expected resolved control policy path")
    require_control_directory(path.parent)
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as file:
        info = os.fstat(file.fileno())
        if (
            not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022
            or (mode is not None and stat.S_IMODE(info.st_mode) != mode)
        ):
            raise ValueError("Expected root-controlled control policy")
        data = file.read(4097)
    if len(data) > 4096:
        raise ValueError("Control policy too large")
    return data


def load_policy():
    return ControlPolicy(**json.loads(read_control_record(POLICY_PATH)))


def rollback_approval_path(directory, policy, request):
    return directory / f"{policy.repository_id}-{request.run_id}-{request.attempt}.json"


def require_unexpired_approval(expires_at, now):
    if type(expires_at) is not int or expires_at <= 0:
        raise ValueError("Invalid rollback approval expiration")
    if (time.time() if now is None else now) >= expires_at:
        raise ValueError("Rollback approval expired")


def rollback_approval_record(policy, request, release, *, expires_at):
    if not isinstance(policy, RollbackControlPolicy):
        raise ValueError("Rollback requires a pinned workflow digest")
    if request.source_sha != release.canonical_sha:
        raise ValueError("Rollback approval source differs from request")
    return {
        "format": 1, "action": "rollback", "control_policy": asdict(policy), "expires_at": expires_at,
        "control_ref": "refs/heads/main",
        "run_id": request.run_id, "attempt": request.attempt,
        "canonical_sha": release.canonical_sha, "target_sha": release.target_sha,
        "image_id": release.image_id, "prior_slot": release.prior_slot,
    }


def require_rollback_approval(directory, policy, request, release, *, now=None):
    """Read an exact approval while the caller holds the deploy lock."""
    path = rollback_approval_path(directory, policy, request)

    def unique_fields(pairs):
        record = {}
        for key, value in pairs:
            if key in record:
                raise ValueError("Duplicate rollback approval field")
            record[key] = value
        return record

    try:
        observed = json.loads(read_control_record(path, mode=0o600), object_pairs_hook=unique_fields)
    except FileNotFoundError as error:
        raise ValueError("Rollback request was not approved for this control attempt") from error
    expires_at = observed.get("expires_at") if isinstance(observed, dict) else None
    require_unexpired_approval(expires_at, now)
    expected = rollback_approval_record(policy, request, release, expires_at=expires_at)
    # Compare JSON types as well as values (for example, true is not 1).
    if json.dumps(observed, sort_keys=True) != json.dumps(expected, sort_keys=True):
        raise ValueError("Rollback request was not approved for this control attempt")


def sync_approval_directory(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def require_private_approval_directory(directory):
    require_control_directory(directory)
    if stat.S_IMODE(directory.stat().st_mode) != 0o700:
        raise ValueError("Expected a private rollback approval directory")


def publish_rollback_approval(directory, policy, request, release, *, expires_at, lock, now=None):
    """Atomically publish a new approval under the deploy journal lock."""
    path = rollback_approval_path(directory, policy, request)
    with lock():
        require_unexpired_approval(expires_at, now)
        require_private_approval_directory(directory)
        if os.path.lexists(path):
            raise FileExistsError("Rollback approval already exists")
        record = rollback_approval_record(policy, request, release, expires_at=expires_at)
        payload = json.dumps(record, sort_keys=True).encode("ascii") + b"\n"
        if len(payload) > 4096:
            raise ValueError("Control policy too large")
        fd, temporary = tempfile.mkstemp(prefix=".rollback-approval-", dir=directory)
        try:
            with os.fdopen(fd, "wb") as file:
                os.fchmod(file.fileno(), 0o600)
                if os.fstat(file.fileno()).st_uid != 0:
                    raise ValueError("Expected root-owned rollback approval")
                file.write(payload)
                file.flush()
                os.fsync(file.fileno())
            os.link(temporary, path, follow_symlinks=False)
        finally:
            os.unlink(temporary)
        sync_approval_directory(directory)
    return path


def revoke_rollback_approval(directory, policy, request, *, lock):
    """Remove an exact attempt's trusted approval under the deploy lock."""
    path = rollback_approval_path(directory, policy, request)
    with lock():
        require_private_approval_directory(directory)
        if not os.path.lexists(path):
            return False
        read_control_record(path, mode=0o600)
        path.unlink()
        sync_approval_directory(directory)
        return True


def read_token(fd=0):
    deadline = time.monotonic() + TOKEN_TIMEOUT
    data = bytearray()
    while len(data) <= MAX_TOKEN:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            break
        block = os.read(fd, MAX_TOKEN + 1 - len(data))
        if not block:
            if re.fullmatch(rb"ghs_[A-Za-z0-9_.-]+\n", data):
                return data[:-1].decode("ascii")
            break
        data.extend(block)
    raise ValueError("Invalid control credential")


def get_json(path, token):
    # A fixed TLS origin, direct GET, no redirects, and no CLI environment or token argv.
    # Construct the context explicitly so SSLKEYLOGFILE cannot enable TLS key logging.
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_default_certs()
    connection = http.client.HTTPSConnection(API_HOST, timeout=API_TIMEOUT, context=context)
    try:
        connection.request("GET", path, headers={
            "Accept": "application/vnd.github+json",
            "Authorization": "Bearer " + token,
            "User-Agent": "quantself-atlas-control",
            "X-GitHub-Api-Version": "2022-11-28",
        })
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError("Control GitHub lookup failed")
        data = response.read(MAX_RESPONSE + 1)
        if len(data) > MAX_RESPONSE:
            raise ValueError("Control GitHub response too large")
        return json.loads(data)
    finally:
        connection.close()


def run_identity_matches(policy, request, run, control_main, now):
    """Check run provenance. Callers must also match the exact operation title."""
    if not isinstance(run, dict):
        return False
    started = run.get("run_started_at")
    if not isinstance(started, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", started):
        return False
    try:
        started = datetime.strptime(started, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    if not now - MAX_RUN_AGE <= started <= now + CLOCK_SKEW:
        return False
    if any(not isinstance(run.get(field), dict) for field in (
        "repository", "head_repository", "actor", "triggering_actor",
    )):
        return False
    identities = (
        (run.get("id"), int(request.run_id)), (run.get("run_attempt"), int(request.attempt)),
        (run.get("workflow_id"), policy.workflow_id),
        (run["repository"].get("id"), policy.repository_id),
        (run["head_repository"].get("id"), policy.repository_id),
        (run["actor"].get("id"), policy.owner_id), (run["triggering_actor"].get("id"), policy.owner_id),
    )
    return (
        all(type(actual) is int and actual == expected for actual, expected in identities)
        and run.get("status") == "in_progress" and run.get("event") == "workflow_dispatch"
        and run.get("head_branch") == "main" and run.get("head_sha") == control_main == policy.control_sha
        and run.get("path") in (policy.workflow_path, f"{policy.workflow_path}@main")
        and run["repository"].get("private") is True
        and all(run[field].get("full_name") == policy.repository for field in ("repository", "head_repository"))
    )


def operation_matches(policy, request, run, control_main, now, expected_title):
    return (
        run_identity_matches(policy, request, run, control_main, now)
        and run.get("display_title") == expected_title
    )


def promotion_title(request):
    return f"Promote Quantself {request.source_sha}"


def run_matches(policy, request, run, control_main, now):
    return operation_matches(policy, request, run, control_main, now, promotion_title(request))


def verify_operation(policy, request, token, *, expected_title, fetch_json=None, now=None):
    """Verify the API run against the operation title chosen by the caller."""
    fetch_json = get_json if fetch_json is None else fetch_json
    base = f"/repos/{policy.repository}"
    with ThreadPoolExecutor(max_workers=2) as pool:
        current = pool.submit(fetch_json, f"{base}/actions/runs/{request.run_id}", token)
        main = pool.submit(fetch_json, f"{base}/git/ref/heads/main", token)
        run, ref = current.result(), main.result()
    ref_object = ref.get("object") if isinstance(ref, dict) and ref.get("ref") == "refs/heads/main" else None
    control_main = ref_object.get("sha") if isinstance(ref_object, dict) and ref_object.get("type") == "commit" else None
    now = datetime.now(timezone.utc) if now is None else now
    if not operation_matches(policy, request, run, control_main, now, expected_title):
        raise ValueError("Control run identity rejected")


def verify_request(policy, request, token):
    verify_operation(policy, request, token, expected_title=promotion_title(request))


def rollback_title(release):
    return f"Rollback Quantself {release.canonical_sha} {release.target_sha} {release.image_id} {release.prior_slot}"


def verify_rollback_operation(policy, request, release, token, *, read_workflow, fetch_json=None, now=None):
    """Bind the authenticated run to bytes read from the pinned commit and path."""
    if not isinstance(policy, RollbackControlPolicy) or request.source_sha != release.canonical_sha:
        raise ValueError("Rollback workflow or source is not pinned")
    verify_operation(policy, request, token, expected_title=rollback_title(release), fetch_json=fetch_json, now=now)
    workflow = read_workflow(policy.control_sha, policy.workflow_path)
    if (
        not isinstance(workflow, bytes) or len(workflow) > 64 * 1024
        or hashlib.sha256(workflow).hexdigest() != policy.workflow_sha256
    ):
        raise ValueError("Pinned rollback workflow bytes differ")


def main(argv=None):
    try:
        request = Request(*(sys.argv[1:] if argv is None else argv))
        verify_request(load_policy(), request, read_token())
    except Exception:
        # Request parsing and API failures must not echo input, diagnostics, or response bodies.
        print(FAILURE, file=sys.stderr)
        return 1
    print("Control run admitted.")
    return 0


def expire_admission():
    # Exit the whole helper even if executor threads are blocked in DNS or HTTP reads.
    try:
        if select.select([], [2], [], 0)[1]:
            os.write(2, (FAILURE + "\n").encode("ascii"))
    finally:
        os._exit(1)


def run_cli():
    watchdog = Timer(ADMISSION_TIMEOUT, expire_admission)
    watchdog.daemon = True
    watchdog.start()
    try:
        return main()
    finally:
        watchdog.cancel()


if __name__ == "__main__":
    sys.exit(run_cli())
