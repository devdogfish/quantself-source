#!/usr/bin/env python3
"""Issue a one-job repo runner configuration on the trusted operator machine."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import time

SOURCE = "devdogfish/quantself"
SOURCE_ID = 1168864504
OWNER_ID = 165058441
CONTROL_WORKFLOW = ".github/workflows/promote-keep.yml"
REPO = re.compile(r"devdogfish/[a-zA-Z0-9_.-]{1,100}")
LABELS = {"verify": "quantself-atlas-verify", "relay": "quantself-atlas-control"}
BASE_LABELS = ["self-hosted", "linux", "x64"]
CONFIG = re.compile(r"[A-Za-z0-9+/=_-]{1,65536}")
SHA = re.compile(r"[0-9a-f]{40}")
RUN_ID = re.compile(r"[1-9][0-9]{0,19}")
ATTEMPT = re.compile(r"[1-9][0-9]{0,9}")
SSH_TARGET = re.compile(r"(?:[a-z_][a-z0-9_-]*@)?[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}")
SSH_ENV = ("HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SSH_AUTH_SOCK")
GH_TOKEN_ENV = {"GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"}
RELAY_JOB_WAIT_SECONDS = 5


class RelayJobNotMaterialized(ValueError):
    pass


def api(path, payload=None, *, timeout=20):
    args = ["gh", "api", "--hostname", "github.com", path]
    if payload is not None:
        args += ["--method", "POST", "--input", "-"]
    result = subprocess.run(
        args, input=json.dumps(payload) if payload is not None else "",
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        env={key: value for key, value in os.environ.items() if key not in GH_TOKEN_ENV},
        check=False, timeout=timeout,
    )
    if result.returncode != 0:
        raise ValueError(f"GitHub API failed for {path}")
    return json.loads(result.stdout)


def validate_relay_args(args):
    if not (RUN_ID.fullmatch(args.run_id or "") and ATTEMPT.fullmatch(args.attempt or "")
            and SHA.fullmatch(args.source_sha or "") and SHA.fullmatch(args.control_sha or "")
            and SSH_TARGET.fullmatch(args.relay_ssh_target or "") and args.output is None):
        raise ValueError("Relay requires an exact run, source SHA, control SHA and pinned SSH target")


def relay_run_path(args, endpoint):
    return f"{endpoint}/actions/runs/{args.run_id}/attempts/{args.attempt}"


def relay_job(args, endpoint):
    run_path = relay_run_path(args, endpoint)
    jobs_path = f"{run_path}/jobs"
    paths = [
        f"{endpoint}/branches/main",
        f"{endpoint}/collaborators",
        f"{endpoint}/actions/permissions/fork-pr-workflows-private-repos",
        run_path,
        jobs_path,
        f"{endpoint}/actions/runners?per_page=100",
    ]
    with ThreadPoolExecutor(max_workers=len(paths)) as pool:
        branch, collaborators, forks, run, jobs, inventory = pool.map(api, paths)
    owner_only = (
        isinstance(collaborators, list) and len(collaborators) == 1
        and collaborators[0].get("id") == OWNER_ID
        and collaborators[0].get("role_name") == "admin"
    )
    if (not owner_only or branch.get("protected") is not True
            or branch.get("commit", {}).get("sha") != args.control_sha
            or any(forks.get(key) is not False for key in (
                "run_workflows_from_fork_pull_requests",
                "send_write_tokens_to_workflows",
                "send_secrets_and_variables",
            ))):
        raise ValueError("Control repository settings or pinned main commit changed")
    if (run.get("id") != int(args.run_id) or run.get("run_attempt") != int(args.attempt)
            or run.get("head_branch") != "main" or run.get("head_sha") != args.control_sha
            or run.get("event") != "workflow_dispatch" or run.get("status") not in {"queued", "in_progress"}
            or run.get("display_title") != f"Promote Quantself {args.source_sha}"
            or run.get("path") not in (CONTROL_WORKFLOW, f"{CONTROL_WORKFLOW}@main")
            or any(run.get(key, {}).get("id") != OWNER_ID for key in ("actor", "triggering_actor"))
            or any(
                run.get(key, {}).get("id") != args.repository_id
                or run.get(key, {}).get("full_name") != args.repository
                for key in ("repository", "head_repository")
            )):
        raise ValueError("Queued workflow run does not match the pinned control request")
    labels = [*BASE_LABELS, args.label, f"{args.label}-{args.run_id}-{args.attempt}"]
    require_unclaimed_label(inventory, labels[-1])
    return exact_queued_job(args, jobs, labels), labels


def require_unclaimed_label(inventory, exact_label):
    runners = inventory.get("runners") if isinstance(inventory, dict) else None
    if not isinstance(runners, list) or type(inventory.get("total_count")) is not int or (
        inventory["total_count"] != len(runners) or len(runners) > 100
    ):
        raise ValueError("Could not verify a complete relay runner inventory")
    for runner in runners:
        labels = runner.get("labels") if isinstance(runner, dict) else None
        if not isinstance(labels, list) or any(
            not isinstance(label, dict) or not isinstance(label.get("name"), str) for label in labels
        ):
            raise ValueError("Invalid relay runner label inventory")
        if any(label["name"].casefold() == exact_label.casefold() for label in labels):
            raise ValueError("Exact relay attempt label is already claimed. Inspect the existing runner")


def exact_queued_job(args, jobs, labels):
    queued = jobs.get("jobs") if isinstance(jobs, dict) else None
    if not isinstance(queued, list) or type(jobs.get("total_count")) is not int or jobs["total_count"] != len(queued):
        raise ValueError("Invalid relay job inventory")
    if not queued:
        raise RelayJobNotMaterialized("Exact queued Atlas relay job has not appeared")
    if len(queued) != 1:
        raise ValueError("Expected one queued Atlas relay job")
    job = queued[0]
    if not isinstance(job, dict):
        raise ValueError("Invalid relay job identity")
    job_id = job.get("id")
    presented_labels = job.get("labels")
    if (type(job_id) is not int or job_id <= 0 or job.get("name") != "relay"
            or job.get("run_id") != int(args.run_id) or job.get("head_sha") != args.control_sha
            or job.get("status") != "queued" or job.get("runner_id") not in (None, 0)
            or not isinstance(presented_labels, list) or len(presented_labels) != len(labels)
            or any(not isinstance(label, str) for label in presented_labels) or set(presented_labels) != set(labels)):
        raise ValueError("No matching unassigned Atlas relay job")
    return job_id


def wait_for_relay_job(args, endpoint):
    try:
        return relay_job(args, endpoint)
    except RelayJobNotMaterialized:
        if not getattr(args, "wait_for_job", False):
            raise
    labels = [*BASE_LABELS, args.label, f"{args.label}-{args.run_id}-{args.attempt}"]
    deadline = time.monotonic() + RELAY_JOB_WAIT_SECONDS
    while (remaining := deadline - time.monotonic()) > 0:
        time.sleep(min(0.25, remaining))
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        jobs = api(f"{relay_run_path(args, endpoint)}/jobs", timeout=remaining)
        try:
            exact_queued_job(args, jobs, labels)
        except RelayJobNotMaterialized:
            continue
        # Refresh the policy, exact attempt and runner inventory before issuance.
        return relay_job(args, endpoint)
    raise ValueError("Exact queued Atlas relay job did not appear. Inspect the original run")


@contextmanager
def relay_attempt_lock(args):
    directory = Path.home() / ".quantself-atlas-relay"
    directory.mkdir(mode=0o700, exist_ok=True)
    parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(parent)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError("Expected a private Atlas relay lock directory")
        name = f"{args.repository_id}-{args.run_id}-{args.attempt}.lock"
        fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise ValueError("Expected a private Atlas relay attempt lock")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise ValueError("This Mac is already handling the exact relay attempt") from error
            if os.fstat(fd).st_size:
                raise ValueError("JIT issuance was already started for this attempt. Reconcile the original run")

            def reserve_issuance():
                # A lost response can precede visibility in GitHub's runner list.
                marker = b"jit-issuance-started\n"
                if os.write(fd, marker) != len(marker):
                    raise OSError("Could not record exact relay attempt issuance")
                os.fsync(fd)
                os.fsync(parent)

            yield reserve_issuance
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def generate(endpoint, role, labels):
    name = f"quantself-{role}-{secrets.token_hex(8)}"
    result = api(f"{endpoint}/actions/runners/generate-jitconfig", {
        "name": name, "runner_group_id": 1, "labels": labels, "work_folder": "_work",
    })
    runner = result.get("runner", {})
    runner_id = runner.get("id")
    config = result.get("encoded_jit_config")
    if type(runner_id) is not int or runner_id <= 0 or runner.get("name") != name:
        raise ValueError("GitHub returned an invalid runner identity")
    print(f"JIT runner ID: {runner_id} ({name})", file=sys.stderr)
    if not isinstance(config, str) or not CONFIG.fullmatch(config):
        raise ValueError("GitHub returned an invalid JIT configuration")
    return runner_id, config


def relay_timing(args, phase, **details):
    if not getattr(args, "timing", False):
        return
    if not (args.role == "relay" and RUN_ID.fullmatch(args.run_id or "") and ATTEMPT.fullmatch(args.attempt or "")):
        return
    event = {"phase": phase, "run_id": args.run_id, "attempt": args.attempt,
             "monotonic_us": time.monotonic_ns() // 1000, **details}
    print("Atlas relay timing: " + json.dumps(event, separators=(",", ":")), file=sys.stderr, flush=True)


def start_relay(args, endpoint):
    validate_relay_args(args)
    with relay_attempt_lock(args) as reserve_issuance:
        launch_relay(args, endpoint, reserve_issuance)


def launch_relay(args, endpoint, reserve_issuance):
    job_id, labels = wait_for_relay_job(args, endpoint)
    relay_timing(args, "admitted")
    reserve_issuance()
    runner_id, config = generate(endpoint, args.role, labels)
    relay_timing(args, "runner_issued")
    try:
        result = subprocess.run(
            [
                "ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                "-o", "UpdateHostKeys=no", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes",
                "-o", "PermitLocalCommand=no", "-o", "ConnectTimeout=8",
                "--", args.relay_ssh_target, "/usr/local/sbin/quantself-atlas-control-jit",
            ],
            input=config + "\n", text=True, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE if getattr(args, "timing", False) else subprocess.DEVNULL,
            env={key: os.environ[key] for key in SSH_ENV if key in os.environ},
            timeout=25, check=False,
        )
    finally:
        del config
    if result.returncode != 0 or result.stdout != "Atlas relay runner started.\n":
        raise ValueError("Relay launcher did not confirm startup. Inspect the JIT runner before retrying")
    receipts = re.findall(
        r"^Atlas relay launcher timing: ([0-9a-f]{32}) (--worker(?:-template)?) ([0-9]{1,6})$",
        result.stderr or "", re.MULTILINE,
    )
    details = {}
    if len(receipts) == 1:
        launch_id, worker_mode, selection_ms = receipts[0]
        details = {"launch_id": launch_id, "worker_mode": worker_mode, "selection_ms": int(selection_ms)}
    relay_timing(args, "launcher_acknowledged", **details)

    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        job = api(f"{endpoint}/actions/jobs/{job_id}")
        if (not isinstance(job, dict) or job.get("id") != job_id or job.get("run_id") != int(args.run_id)
                or job.get("head_sha") != args.control_sha or job.get("name") != "relay"):
            raise ValueError("Exact relay job identity changed while waiting for assignment")
        assigned = job.get("runner_id")
        if job.get("status") in {"in_progress", "completed"}:
            if assigned != runner_id:
                raise ValueError("The exact relay job was not assigned to the issued runner")
            relay_timing(args, "assignment_observed")
            print(f"Atlas relay runner {runner_id} assigned to job {job_id}.")
            return
        time.sleep(2)
    raise ValueError("Timed out waiting for exact job assignment. Inspect the JIT runner before retrying")


def provision(args):
    source = args.repository.lower() == SOURCE
    if (not REPO.fullmatch(args.repository) or args.label != LABELS[args.role]
            or args.repository_id <= 0 or source != (args.role == "verify")
            or source != (args.repository_id == SOURCE_ID)):
        raise ValueError("Runner role, repository, ID, or label is invalid")
    relay_timing(args, "provision_started")
    endpoint = f"repos/{args.repository}"
    repo = api(endpoint)
    if (repo.get("full_name") != args.repository or repo.get("id") != args.repository_id
            or repo.get("private") is not True or repo.get("fork") is not False
            or repo.get("default_branch") != "main"):
        raise ValueError("Repository identity or settings do not match")
    if not source:
        start_relay(args, endpoint)
        return

    if args.output is None or any((args.run_id, args.attempt, args.source_sha, args.control_sha, args.relay_ssh_target)):
        raise ValueError("Verification requires a new private output file")
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        _, config = generate(endpoint, args.role, [*BASE_LABELS, args.label])
        with os.fdopen(descriptor, "w", closefd=False) as output:
            output.write(config + "\n")
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        args.output.unlink(missing_ok=True)
        raise
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("role", choices=("verify", "relay"))
    parser.add_argument("repository")
    parser.add_argument("repository_id", type=int)
    parser.add_argument("label")
    parser.add_argument("output", type=Path, nargs="?", help="New private verification JIT configuration file")
    parser.add_argument("--run-id", help="Exact queued control workflow run")
    parser.add_argument("--attempt", help="Exact queued control workflow run attempt")
    parser.add_argument("--source-sha", help="Staged Quantself source commit")
    parser.add_argument("--control-sha", help="Control main commit pinned by Keep")
    parser.add_argument("--relay-ssh-target", help="Pinned SSH alias for the independent relay guest")
    parser.add_argument("--timing", action="store_true", help="Emit credential-free relay timing markers on stderr")
    parser.add_argument("--wait-for-job", action="store_true", help="Briefly wait for the exact dispatch job to appear")
    args = parser.parse_args()
    try:
        provision(args)
    except (OSError, ValueError, subprocess.SubprocessError, KeyboardInterrupt) as exc:
        parser.exit(1, f"JIT provisioning failed: {exc}\n")


if __name__ == "__main__":
    main()
