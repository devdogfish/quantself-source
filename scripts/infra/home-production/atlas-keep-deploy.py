#!/usr/bin/env python3
"""Admit an exact signed Atlas release through Keep's production lock."""

import json
import os
from pathlib import Path
import re
import runpy
import stat
import subprocess
import sys
import tempfile


TOOLS = Path(__file__).resolve().parent
CONTROL = runpy.run_path(str(TOOLS / "atlas-control-admit.py"))
SOURCE = runpy.run_path(str(TOOLS / "atlas-admit.py"))
RELEASE = runpy.run_path(str(TOOLS / "atlas-release.py"))
JOURNAL = runpy.run_path(str(TOOLS / "atlas-deploy-journal.py"))
POLICY_DIR = Path("/etc/quantself-atlas")
STATE = Path("/var/lib/quantself-atlas-keep")
LOCK = Path("/run/lock/quantself-production.lock")
MAINTENANCE = Path("/var/lib/keep-backup/production-maintenance.json")
BACKUP_TOOLS = Path("/usr/local/lib/keep-backup/backup_guest.py")
ENV = {"PATH": "/usr/local/bin:/usr/sbin:/usr/bin:/bin", "HOME": "/root", "LC_ALL": "C"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def open_journal():
    RELEASE["private_root"](STATE, 0o700)
    return JOURNAL["DeployJournal"](LOCK, STATE / "deploy.sqlite")


def run(command, *, input=None, timeout=120):
    return subprocess.run(
        command, input=input, capture_output=True, text=True, env=ENV, timeout=timeout, check=True,
    ).stdout


def authenticate(request, token):
    result = run(
        [sys.executable, "-I", "-B", str(TOOLS / "atlas-control-admit.py"),
         request.source_sha, request.run_id, request.attempt],
        input=token + "\n", timeout=25,
    )
    require(result == "Control run admitted.\n", "Control admission did not acknowledge the request")


def verify_release(bundle, claim):
    expected_files = (
        bundle, bundle / "release.json", bundle / "release.sig", bundle / "app-image",
        *(bundle / "app-image" / name for name in RELEASE["IMAGE_FILES"]),
    )
    for path in expected_files:
        RELEASE["trusted_path"](path)
        require(path.stat().st_gid == 0, "Production release files must be owned by the root group")
    allowed = RELEASE["trusted_path"](POLICY_DIR / "allowed-signers")
    record = RELEASE["verify_bundle"](bundle, claim.source_sha, allowed)
    require(record["image_id"] == claim.image_id, "Signed Atlas image differs from approved image")
    # The signed verifier hashes and validates the same archive and additionally
    # checks its layers. Keep's independent, image-bound drain proof still applies.
    drain = RELEASE["trusted_path"](bundle / "web-drain.json")
    RELEASE["trusted_path"](BACKUP_TOOLS)
    RELEASE["trusted_path"](BACKUP_TOOLS.with_name("backup_inventory.py"))
    # Isolated Python omits the backup helper directory from its import path.
    sys.path.insert(0, str(BACKUP_TOOLS.parent))
    try:
        backup = runpy.run_path(str(BACKUP_TOOLS))
    finally:
        sys.path.pop(0)
    backup["verify_web_drain_proof"](drain, claim.image_id)


def ensure_image(archive, claim):
    inspect = [
        "/usr/bin/docker", "image", "inspect", "--format",
        '{{.Id}} {{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}',
        claim.image_id,
    ]
    try:
        observed = run(inspect, timeout=10)
    except subprocess.CalledProcessError:
        run(["/usr/bin/docker", "image", "load", "--input", str(archive)], timeout=240)
        observed = run(inspect, timeout=10)
    require(
        observed.strip() == f"{claim.image_id} linux/amd64 {claim.source_sha}",
        "Loaded image differs from the signed Atlas image",
    )


def promote(request, token):
    require(os.environ.get("QUANTSELF_DEPLOY_MODE") == "atlas", "Atlas production deploy is disabled")
    require(os.environ.get("BACKUP_READY_REVISION") == request.source_sha, "Backup readiness differs from revision")
    image = os.environ.get("BACKUP_READY_IMAGE")
    policy = CONTROL["load_policy"]()
    claim = JOURNAL["Claim"](str(policy.repository_id), request.run_id, request.attempt, request.source_sha, image)
    production = RELEASE["trusted_path"](Path(os.environ["DEPLOY_PATH"]))
    origin = os.environ["PRODUCTION_URL"].rstrip("/")
    listener = os.environ["PRODUCTION_HTTPS_IP"]
    require(origin == "https://qs.girke.dev", "Unexpected production origin")
    require(re.fullmatch(r"(?:[0-9]{1,3}\.){3}[0-9]{1,3}", listener), "Unexpected production listener")
    bundle = production / "releases" / claim.image_id.removeprefix("sha256:")
    journal = open_journal()

    def authorize(bound):
        require(not os.path.lexists(MAINTENANCE), "A coordinated backup or recovery is active")
        authenticate(request, token)
        verify_release(bundle, bound)

    with tempfile.TemporaryDirectory(prefix="source-", dir=STATE) as work:
        script = None

        def prepare(bound):
            nonlocal script
            key = POLICY_DIR / "source-ssh"
            source = SOURCE["admit"](Path(work), bound.source_sha, deploy_key=key)
            checkout = RELEASE["trusted_path"](Path(source["checkout"]))
            script = RELEASE["trusted_path"](checkout / "scripts" / "promote-home.sh")
            require(stat.S_ISREG(script.stat().st_mode), "Expected a regular promotion script")
            ensure_image(bundle / "app-image" / "image.tar.gz", bound)
            SOURCE["check_main"](bound.source_sha, deploy_key=key)

        def make_command(bound):
            return [
                "/usr/bin/env", "-i", *(f"{name}={value}" for name, value in ENV.items()),
                f"PRODUCTION_URL={origin}", f"PRODUCTION_HTTPS_IP={listener}",
                f"QUANTSELF_PRODUCTION_HTTPS_IP={listener}",
                "/bin/bash", str(script), "promote", str(production), bound.source_sha, bound.image_id,
            ]

        receipt = journal.submit(claim, make_command, authorize=authorize, prepare=prepare, output=sys.stderr)
    require(receipt.outcome == "succeeded", "The bound deploy has no success receipt")
    if script is not None and receipt.claim == claim:
        # The observer can match this fresh receipt to the child switch by
        # systemd invocation. Historical acknowledgments emit no receipt marker.
        print(
            f"Atlas promotion receipt {claim.control_repo_id} {claim.run_id} {claim.attempt} "
            f"{claim.source_sha} {claim.image_id}", file=sys.stderr, flush=True,
        )


def main(argv):
    try:
        require(os.geteuid() == 0, "Run the Keep deploy service as root")
        os.umask(0o077)
        if argv == ["--initialize-journal"]:
            open_journal().initialize()
            return 0
        if argv == ["--assert-clear"]:
            open_journal().assert_clear()
            return 0
        request = CONTROL["Request"](*argv)
        promote(request, CONTROL["read_token"]())
    except Exception as error:
        # Git and Docker errors may reference private configuration. Keep the SSH
        # response fixed and diagnostics in the privileged VM journal.
        print(f"Atlas Keep deploy rejected: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    print("QUANTSELF_DEPLOY_OK", flush=True)
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 1:
        # Match the SSH transport's bounded two-line frame without putting the
        # event token in argv or the process environment.
        from select import select
        from time import monotonic

        deadline = monotonic() + 10
        header = bytearray()
        while len(header) < 96:
            if not select([0], [], [], max(0, deadline - monotonic()))[0]:
                break
            char = os.read(0, 1)
            if not char or char == b"\n":
                break
            header.extend(char)
        match = re.fullmatch(rb"promote-atlas ([0-9a-f]{40}) ([1-9][0-9]{0,19}) ([1-9][0-9]{0,9})", header)
        if not match or char != b"\n":
            sys.exit("Atlas Keep deploy rejected: malformed request")
        sys.exit(main([value.decode("ascii") for value in match.groups()]))
    sys.exit(main(sys.argv[1:]))
