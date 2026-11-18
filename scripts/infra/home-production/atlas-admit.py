#!/usr/bin/env python3
"""Admit canonical main into a fresh checkout on the Atlas build controller."""

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile


CANONICAL_REPOSITORY = "https://github.com/devdogfish/quantself.git"
SSH_REPOSITORY = "ssh://git@github.com/devdogfish/quantself.git"
# https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
GITHUB_HOST_KEY = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
MAIN_REF = "refs/heads/main"
FETCHED_REF = "refs/remotes/canonical/main"
FULL_SHA = re.compile(r"[0-9a-f]{40}")
GIT_PROTOCOL = "https"


def git(checkout, *args, credential_helper=None, ssh_command=None):
    # Build tools must not supply Git config, object stores, hooks or URL rewrites.
    environment = {
        "PATH": "/usr/bin:/bin",
        "LC_ALL": "C",
        "GIT_CEILING_DIRECTORIES": str(checkout.parent),
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_ATTR_NOSYSTEM": "1",
        "GIT_ALLOW_PROTOCOL": GIT_PROTOCOL,
        "GIT_TERMINAL_PROMPT": "0",
    }
    if ssh_command is not None:
        environment.update(GIT_ALLOW_PROTOCOL="ssh", GIT_SSH_VARIANT="ssh",
                           GIT_SSH_COMMAND=shlex.join(ssh_command))
    credential_config = []
    if credential_helper is not None:
        credential_config = [
            "-c", "credential.helper=",
            "-c", f"credential.helper={credential_helper}",
            "-c", "credential.useHttpPath=true",
        ]
    return subprocess.run(
        [
            "/usr/bin/git", "-C", str(checkout),
            "-c", f"core.hooksPath={os.devnull}",
            "-c", f"core.attributesFile={os.devnull}",
            "-c", "http.followRedirects=false",
            "-c", "http.sslVerify=true",
            *credential_config, *args,
        ],
        env=environment, check=True, capture_output=True, text=True, timeout=120,
    ).stdout.strip()


def require_full_sha(expected_sha):
    if not FULL_SHA.fullmatch(expected_sha):
        raise ValueError("Expected SHA must be a full lowercase Git commit SHA")


def require_commit(commit, expected_sha):
    if not FULL_SHA.fullmatch(commit):
        raise ValueError("Canonical main did not resolve to a full commit SHA")
    if expected_sha is not None and commit != expected_sha:
        raise ValueError(f"Expected {expected_sha}, but canonical main is {commit}")


def validate_credential_helper(path):
    if path is None:
        return
    # Git evaluates helper commands through a shell, so accept only a literal path.
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(path)) or path.resolve(strict=True) != path:
        raise ValueError("Credential helper must be an absolute resolved path without shell syntax")
    helper_stat = path.stat()
    if (not stat.S_ISREG(helper_stat.st_mode) or stat.S_IMODE(helper_stat.st_mode) not in (0o500, 0o700)
            or not os.access(path, os.R_OK | os.X_OK)):
        raise ValueError("Credential helper must be a private executable regular file (0500 or 0700)")
    for component in (path, *path.parents):
        status = component.stat()
        if status.st_uid not in (0, os.geteuid()) or status.st_mode & 0o022:
            raise ValueError("Credential helper and ancestors must be controller- or root-owned and private to write")


def validate_deploy_key(path):
    # OpenSSH expands tokens and tilde in IdentityFile even after shell quoting.
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(path)) or path.resolve(strict=True) != path:
        raise ValueError("Deploy key must be an absolute resolved path without SSH tokens or shell syntax")
    info = path.stat()
    if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_uid != os.geteuid()):
        raise ValueError("Deploy key must be a controller-owned regular file with mode 0600")
    for parent in path.parents:
        info = parent.stat()
        if info.st_uid not in (0, os.geteuid()) or info.st_mode & 0o022:
            raise ValueError("Deploy key ancestors must be controller- or root-owned and private to write")


def remote_git(checkout, args, ref, credential_helper, deploy_key):
    if deploy_key is None:
        return git(checkout, *args, CANONICAL_REPOSITORY, ref, credential_helper=credential_helper)

    with tempfile.TemporaryDirectory(prefix="atlas-host-key-", dir="/tmp") as pin_dir:
        pin = Path(pin_dir) / "known_hosts"
        pin.write_text(GITHUB_HOST_KEY + "\n", encoding="ascii")
        ssh_command = [
            "/usr/bin/ssh", "-F", os.devnull, "-o", "BatchMode=yes",
            "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
            "-o", "PreferredAuthentications=publickey", "-o", "ConnectTimeout=10",
            "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2",
            "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={pin}",
            "-o", f"GlobalKnownHostsFile={os.devnull}", "-o", "HostKeyAlgorithms=ssh-ed25519",
            "-o", "UpdateHostKeys=no", "-i", str(deploy_key),
        ]
        return git(checkout, *args, SSH_REPOSITORY, ref, ssh_command=ssh_command)


def validate_auth(credential_helper, deploy_key):
    if deploy_key is None:
        validate_credential_helper(credential_helper)
    elif credential_helper is not None:
        raise ValueError("Choose one Git authentication method")
    else:
        validate_deploy_key(deploy_key)


def check_main(expected_sha, credential_helper=None, deploy_key=None):
    require_full_sha(expected_sha)
    validate_auth(credential_helper, deploy_key)
    with tempfile.TemporaryDirectory(prefix="atlas-main-") as temporary_directory:
        result = remote_git(
            Path(temporary_directory), ("ls-remote", "--exit-code", "--refs"),
            MAIN_REF, credential_helper, deploy_key,
        )
    commit, _, ref = result.partition("\t")
    if ref != MAIN_REF:
        raise ValueError("Git did not report exactly refs/heads/main")
    require_commit(commit, expected_sha)
    return {"commit": commit}


def admit(checkout_root, expected_sha=None, credential_helper=None, deploy_key=None):
    if expected_sha is not None:
        require_full_sha(expected_sha)
    validate_auth(credential_helper, deploy_key)

    # The service owner configures this path under controller-owned ancestors.
    if not checkout_root.is_absolute() or checkout_root.resolve(strict=True) != checkout_root:
        raise ValueError("Checkout root must be an absolute, resolved directory")
    root_stat = checkout_root.stat()
    if (
        not stat.S_ISDIR(root_stat.st_mode)
        or stat.S_IMODE(root_stat.st_mode) != 0o700
        or root_stat.st_uid != os.geteuid()
    ):
        raise ValueError("Checkout root must have mode 0700 and belong to the controller UID")

    checkout = Path(tempfile.mkdtemp(prefix="main-", dir=checkout_root))
    try:
        git(checkout, "init", "--quiet", "--template=", "--object-format=sha1")
        remote_git(
            checkout, ("fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--depth=1"),
            f"{MAIN_REF}:{FETCHED_REF}", credential_helper, deploy_key,
        )
        commit = git(checkout, "rev-parse", "--verify", f"{FETCHED_REF}^{{commit}}")
        require_commit(commit, expected_sha)

        git(checkout, "checkout", "--quiet", "--detach", "--no-recurse-submodules", commit)
        if (
            git(checkout, "rev-parse", "--verify", "HEAD") != commit
            or git(checkout, "status", "--porcelain", "--untracked-files=all")
        ):
            raise ValueError("Checkout is dirty or does not match canonical main")
        return {"commit": commit, "checkout": str(checkout)}
    except BaseException:
        shutil.rmtree(checkout)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--checkout-root", type=Path, help="private directory for admitted checkouts")
    parser.add_argument("--expected-sha", help="full commit SHA required to match canonical main")
    parser.add_argument("--check-only", action="store_true", help="look up main without fetching a checkout")
    auth = parser.add_mutually_exclusive_group()
    auth.add_argument("--credential-helper", type=Path, help="absolute path to a controller-managed Git helper")
    auth.add_argument("--deploy-key", type=Path, help="absolute path to a controller-owned read-only GitHub SSH key")
    args = parser.parse_args()
    try:
        if args.check_only:
            if args.expected_sha is None:
                parser.error("--check-only requires --expected-sha")
            result = check_main(args.expected_sha, args.credential_helper, args.deploy_key)
        else:
            if args.checkout_root is None:
                parser.error("--checkout-root is required to admit a checkout")
            result = admit(args.checkout_root, args.expected_sha, args.credential_helper, args.deploy_key)
    except subprocess.CalledProcessError as error:
        # A credential helper may have written sensitive data to Git's stderr.
        parser.exit(1, f"Atlas admission rejected: Git exited with status {error.returncode}\n")
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        parser.exit(1, f"Atlas admission rejected: {error}\n")
    print(json.dumps(result))


def interrupt_admission(signum, _frame):
    raise SystemExit(128 + signum)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupt_admission)
    main()
