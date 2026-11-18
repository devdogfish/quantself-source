#!/usr/bin/env python3
"""Guest-side capture and upload for the coordinated Keep backup."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

from backup_inventory import attributes, fingerprint, scan, write_inventory

STATE = Path("/var/lib/keep-backup")
RESTIC_DIR = Path("/etc/keep-restic")
RESTIC = "/usr/local/bin/restic"
APP = Path("/opt/keep-quantself")
VAULT = Path("/opt/keep-vault")
OPEN_CLOUD = Path("/srv/opencloud")
VAULT_IMAGE = "opencloudeu/opencloud:7.2.5@sha256:26fcc6f69d71937af015be73c585e7c36d1945d547fa2a6f706118283f1bcd6b"
VAULT_GATEWAY_PROOF = Path("/etc/keep-backup/vault-gateway.json")
VAULT_IDENTITY = Path("/etc/keep-backup/vault-identity.json")
VAULT_GATEWAY_IMAGE = "caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b"
VAULT_READY_PORTS = (9159, 9119, 9141, 9205, 9134)
VAULT_GATEWAY_SHA = "97bfabd90dff14cac701b71b6b62b66439fd627bc5595775cd5614e2e24a0918"
VAULT_HOSTNAME = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2}ts\.net")
PRODUCTION_LOCK = Path("/run/lock/quantself-production.lock")
PRODUCTION_DEPLOY_ENV = Path("/etc/quantself/deploy.env")
PRODUCTION_PROFILE = Path("/etc/keep-backup/production-profile.json")
RELEASE_STATE = Path("/var/lib/quantself-release")
RELEASE_SLOTS = ("blue", "green")
API_WORKERS = "api-workers"
RELEASE_PROJECTS = tuple(f"quantself-{slot}" for slot in RELEASE_SLOTS)
PRODUCTION_APP = {
    "gateway": "quantself-web", "app": "quantself-next", "api": "quantself-api",
    "postgres": "quantself-postgres",
    "inventory-preprocessing-worker": "quantself-inventory-preprocessing-worker",
    "inventory-codex-enrichment-worker": "quantself-inventory-codex-worker",
}
INVENTORY_WORKERS = ("inventory-preprocessing-worker", "inventory-codex-enrichment-worker")
ANALYTICS_WRITERS = ("analytics-relay", "analytics-retention", "analytics-umami")
ANALYTICS_SERVICES = (*ANALYTICS_WRITERS, "analytics-postgres")
PRODUCTION_IMAGES = {*PRODUCTION_APP, *ANALYTICS_SERVICES}
PRODUCTION_NATIVE_PROFILE = "production-native"
PRODUCTION_COMPOSE = ("compose.prod.yaml", "compose.home.yaml", "Caddyfile.home")
ANALYTICS_COMPOSE = ("compose.analytics.yaml", "compose.analytics.live.yaml", "compose.analytics.home.yaml")
ANALYTICS_BUNDLE = (".env", *ANALYTICS_COMPOSE, "scripts/website-analytics/reader.sql",
                    "scripts/website-analytics/retention.sql", "relay/relay.js")
LEGACY_MOUNTS = {
    "/app/storage/inventory-images": "legacy/images",
    "/app/storage/inventory-audio": "legacy/audio",
    "/app/storage/inventory-assets": "legacy/assets",
}
JOBS_CONFIG = Path("/etc/quantself/jobs")
JOBS_BINDS = {"api": "api/email-routes.json", "app": "web/candidate-rules.json"}
JOBS_BACKUP = "deployment/jobs"
JOBS_TEMPLATES = "api/resume-templates"
JOBS_TEMPLATE_FILES = ("admin.md", "engineering.md", "web.md")
JOBS_TEMPLATE_TARGET = "/run/quantself-job-templates"
JOBS_OUTBOX_SERVICE = "jobs-codex-worker"
JOBS_OUTBOX_KEY = "quantself_jobs_codex_outbox"
JOBS_OUTBOX_VOLUME = f"quantself_{JOBS_OUTBOX_KEY}"
JOBS_OUTBOX_TREE = "jobs-codex-outbox"
DOCKER_VOLUMES = Path("/var/lib/docker/volumes")
WEB_PROOF = Path("/etc/keep-backup/web-drain.json")
RESTORE_ID = re.compile(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}")
GIB = 1024 ** 3


class BackupError(Exception):
    pass


class Busy(BackupError):
    pass


class OperationUnconfirmed(BackupError):
    pass


class StopUnconfirmed(OperationUnconfirmed):
    pass


class CommandUnconfirmed(BackupError):
    pass


def require(condition, message):
    if not condition:
        raise BackupError(message)


def command(*args, output=subprocess.PIPE, timeout=60, env=None, cwd=None):
    try:
        result = subprocess.run(
            args, stdin=subprocess.DEVNULL, stdout=output,
            stderr=subprocess.DEVNULL, timeout=timeout, check=False, env=env, cwd=cwd,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise CommandUnconfirmed(f"{Path(args[0]).name} could not complete") from None
    require(result.returncode == 0, f"{Path(args[0]).name} failed ({result.returncode})")
    return result.stdout.decode() if output == subprocess.PIPE else None


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_json(path, value):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(value, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(temporary, path)
            sync_dir(path.parent)
        finally:
            temporary.unlink(missing_ok=True)


def read_json(path):
    return json.loads(path.read_text())


def validate_vault_origin(value):
    label = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    require(isinstance(value, str) and re.fullmatch(rf"https://{label}\.{label}\.ts\.net", value),
            "Vault identity requires the approved HTTPS Tailnet origin")
    return value


def read_vault_origin():
    def unique_object(pairs):
        value = dict(pairs)
        require(len(value) == len(pairs), "Vault identity contains duplicate fields")
        return value

    try:
        fd = os.open(VAULT_IDENTITY, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0
                    and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
                    "Vault identity must be a private root-owned file")
            data = source.read(4097)
        require(len(data) <= 4096, "Vault identity is too large")
        value = json.loads(data, object_pairs_hook=unique_object)
    except (OSError, ValueError, RecursionError):
        raise BackupError("Vault identity file is missing or invalid") from None
    require(isinstance(value, dict) and set(value) == {"KEEP_OPENCLOUD_URL"}, "Vault identity fields differ")
    return validate_vault_origin(value["KEEP_OPENCLOUD_URL"])


@contextmanager
def locked(path):
    with path.open("a") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Busy("Backup worker already running") from None
        yield


def private(path, mode):
    info = path.lstat()
    expected_type = stat.S_ISDIR if mode == 0o700 else stat.S_ISREG
    require(expected_type(info.st_mode) and info.st_uid == 0 and info.st_gid == 0
            and stat.S_IMODE(info.st_mode) == mode, "Private file or directory permissions differ")


def jobs_outbox_declared(compose_path):
    return any(line == f"  {JOBS_OUTBOX_KEY}:" for line in compose_path.read_text().splitlines())


def jobs_templates_declared(compose_path):
    return any(line.strip() == f"target: {JOBS_TEMPLATE_TARGET}" for line in compose_path.read_text().splitlines())


def validate_jobs_file(path):
    require(path.resolve(strict=True) == path, "Jobs configuration path is not canonical")
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0
                and not info.st_mode & 0o022, "Jobs configuration parent is not root-controlled")
    private(path, 0o600)
    info = path.lstat()
    require(info.st_nlink == 1 and info.st_size > 0, "Jobs configuration file has invalid links or size")
    return info


def jobs_file_record(path):
    before = validate_jobs_file(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        require(fingerprint(os.fstat(stream.fileno())) == fingerprint(before),
                "Jobs configuration changed during capture")
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    xattrs = attributes(path)
    require(fingerprint(path.lstat()) == fingerprint(before), "Jobs configuration changed during capture")
    return {"type": "file", "mode": 0o600, "uid": before.st_uid, "gid": before.st_gid,
            "size": before.st_size, "mtime_ns": before.st_mtime_ns, "sha256": digest,
            "xattrs": xattrs}


def docker(*args, **kwargs):
    return command("docker", *args, **kwargs)


def inspect(container):
    # Only request specific fields. Full inspect contains credentials.
    fmt = '{{json .Id}} {{json .Image}} {{json .State}} {{json .Mounts}}'
    decoder = json.JSONDecoder()
    text = docker("inspect", "--type", "container", "--format", fmt, container)
    values = []
    for _ in range(4):
        value, offset = decoder.raw_decode(text)
        values.append(value)
        text = text[offset:].lstrip()
    return dict(zip(("id", "image", "state", "mounts"), values))


def available_disk(paths, target, extra=0):
    # Apparent size is a conservative bound for copying sparse files too.
    total = sum(int(command("du", "--summarize", "--apparent-size", "--block-size=1", "--", p)
                    .split(maxsplit=1)[0]) for p in paths)
    disk = shutil.disk_usage(target)
    reserve = max(2 * GIB, disk.total * 15 // 100)
    require(disk.free >= total * 11 // 10 + extra + reserve,
            "Insufficient guest disk reserve for frozen backup")
    return total


def snapshot_digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_image_pin(path, image):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_size <= 72
            and path.read_bytes() in (image.encode(), (image + "\n").encode()),
            "Deployment image pin differs from app image")


def verify_docker_archive(path, image):
    digest = image.removeprefix("sha256:")
    config_names = {digest + ".json", "blobs/sha256/" + digest}
    manifest_config = None
    found_config = None
    try:
        with gzip.open(path, "rb") as raw, tarfile.open(fileobj=raw, mode="r|") as archive:
            for member in archive:
                name = PurePosixPath(member.name)
                require(not name.is_absolute() and ".." not in name.parts, "Unsafe Docker archive path")
                name = str(name)
                if name == "manifest.json":
                    require(manifest_config is None and member.isfile() and member.size <= 65536,
                            "Unexpected Docker archive manifest")
                    rows = json.load(archive.extractfile(member))
                    require(isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict),
                            "Expected exactly one image in Docker archive")
                    manifest_config = rows[0].get("Config")
                    require(isinstance(manifest_config, str) and manifest_config in config_names,
                            "Docker manifest config differs from app image")
                elif name in config_names:
                    require(found_config is None and member.isfile() and member.size <= 1024 * 1024,
                            "Unexpected Docker archive config")
                    blob = archive.extractfile(member).read()
                    require(hashlib.sha256(blob).hexdigest() == digest,
                            "Docker archive config digest differs from app image")
                    config = json.loads(blob)
                    require(isinstance(config, dict) and config.get("os") == "linux"
                            and config.get("architecture") == "amd64", "Docker archive config platform differs")
                    found_config = name
            # Read through the gzip trailer without retaining layer data.
            while raw.read(1024 * 1024):
                pass
    except (tarfile.TarError, EOFError, OSError, ValueError):
        raise BackupError("Docker image archive could not be read") from None
    require(found_config is not None and manifest_config == found_config,
            "Docker manifest does not reference the verified config")


def verify_app_image_archive(root, image, *, digests=None, revision=None):
    files = {"image.tar.gz", "image.json", "SHA256SUMS"}
    info = root.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0
            and not info.st_mode & 0o022, "App image archive directory permissions differ")
    require({path.name for path in root.iterdir()} == files, "App image archive file set differs")
    for name in files:
        info = (root / name).lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0
                and not info.st_mode & 0o022 and info.st_size > 0,
                "App image archive file permissions or size differ")
        if name != "image.tar.gz":
            require(info.st_size <= 4096, "App image archive metadata is too large")
    sums = {}
    for line in (root / "SHA256SUMS").read_text().splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (image\.tar\.gz|image\.json)", line)
        require(match and match[2] not in sums, "App image archive checksum manifest differs")
        sums[match[2]] = match[1]
    require(sums.keys() == files - {"SHA256SUMS"}, "App image archive checksums are incomplete")
    metadata = read_json(root / "image.json")
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", image)
            and metadata.get("id") == image and metadata.get("os") == "linux"
            and metadata.get("architecture") == "amd64", "App image archive identity differs")
    if revision is not None:
        require(re.fullmatch(r"[0-9a-f]{40}", revision) and metadata.get("revision") == revision,
                "App image archive revision differs")
    require(all((digests[name] if digests is not None else snapshot_digest(root / name)) == expected
                for name, expected in sums.items()), "App image archive checksum differs")
    verify_docker_archive(root / "image.tar.gz", image)


def verify_web_drain_proof(path, image):
    private(path, 0o600)
    require(read_json(path) == {
        "format": 1, "image": image, "contract": "next-sigterm-deferred-request-v1",
    }, "Running web image has no matching drain proof")


def production_release(app, image):
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", image), "Invalid production image identity")
    return app / "releases" / image.removeprefix("sha256:")


def verify_production_release(release, image, revision=None):
    for directory in (release.parent, release):
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0
                and not info.st_mode & 0o022, "Production release directory permissions differ")
    verify_web_drain_proof(release / "web-drain.json", image)
    verify_app_image_archive(release / "app-image", image, revision=revision)


def restic(role, *args, cwd=None):
    private(RESTIC_DIR, 0o700)
    private(RESTIC_DIR / "repository.env", 0o600)
    password = RESTIC_DIR / "password"
    private(password, 0o600)
    required = {"RESTIC_REPOSITORY", "RESTIC_PASSWORD_FILE", "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"}
    settings = {}
    for line in (RESTIC_DIR / "repository.env").read_text().splitlines():
        parts = shlex.split(line)
        require(len(parts) == 1, "Invalid restic settings")
        key, separator, value = parts[0].partition("=")
        require(separator and value and key in required and key not in settings,
                "Invalid restic settings")
        settings[key] = value
    require(settings.keys() == required and settings["RESTIC_PASSWORD_FILE"] == str(password),
            "Incomplete restic settings")
    prefix = "vault" if role == "files" else "quantself"
    endpoint = re.fullmatch(
        rf"s3:https://s3\.(ca-east-[0-9]{{3}})\.backblazeb2\.com/[a-z0-9-]+/{prefix}",
        settings["RESTIC_REPOSITORY"],
    )
    require(endpoint and endpoint[1] == settings["AWS_DEFAULT_REGION"],
            "Unexpected offsite repository prefix or endpoint")
    return command(RESTIC, "--no-cache", *args, timeout=None, cwd=cwd,
                   env={"PATH": "/usr/bin:/bin", "HOME": "/root", **settings})


def active_release_slot():
    require(not os.path.lexists(RELEASE_STATE / "pending"), "Release transition requires reconciliation")
    active = RELEASE_STATE / "active"
    if not os.path.lexists(active):
        return "legacy"
    private(RELEASE_STATE, 0o700)
    private(active, 0o600)
    value = active.read_text().splitlines()
    slots = ("legacy", *RELEASE_SLOTS)
    require(len(value) == 2 and value[0] in slots and value[1] in ("", *slots)
            and value[0] != value[1], "Invalid active release slot")
    return value[0]


class Guest:
    def __init__(self, role, restore_id, root=STATE, *, vault_hostname=None):
        require(vault_hostname is None or (role == "files" and VAULT_HOSTNAME.fullmatch(vault_hostname)),
                "Expected an exact Tailscale hostname for the files guest")
        self.role = role
        self.restore_id = restore_id
        self.root = root
        self.vault_hostname = vault_hostname
        self.run = root / "runs" / restore_id
        self.frozen = self.run / "frozen"
        self.state_path = self.run / "prior.json"
        self.maintenance = root / "production-maintenance.json"
        self.services = (("gateway", "app", "api", "postgres") if role == "quantself"
                         else ("opencloud", "vault-gateway"))
        self.project = "keep-quantself" if role == "quantself" else "keep-vault"
        self.app = APP
        self.analytics = None
        self.production_profile = None
        self.release_slot = "legacy"
        self.bundle = self.app
        if role == "quantself" and os.path.lexists(PRODUCTION_PROFILE):
            private(PRODUCTION_PROFILE, 0o600)
            profile = read_json(PRODUCTION_PROFILE)
            require(isinstance(profile, dict), "Invalid production backup profile")
            version = profile.get("format")
            require(type(version) is int and (
                (version == 1 and set(profile) == {"format", "app_path", "analytics_path"})
                or (version == 2 and set(profile) == {"format", "app_path"})
            ), "Invalid production backup profile")
            self.app = Path(profile["app_path"])
            self.bundle = self.app
            self.production_profile = "production" if version == 1 else PRODUCTION_NATIVE_PROFILE
            directories = [self.app]
            if version == 1:
                self.analytics = Path(profile["analytics_path"])
                directories.append(self.analytics)
            for directory in directories:
                require(directory.is_absolute() and directory.resolve(strict=True) == directory
                        and directory.is_dir(), "Production backup directory differs")
            self.project = "quantself"
            self.services = tuple(PRODUCTION_APP)
            if version == 2:
                self.release_slot = active_release_slot()
                if self.release_slot != "legacy":
                    self.bundle = RELEASE_STATE / self.release_slot
                    private(self.bundle, 0o700)
                    self.services += (API_WORKERS,)
            if self.analytics is not None:
                self.services += ANALYTICS_SERVICES

    def container_name(self, service):
        if self.production_profile is None:
            return f"{self.project}-{service}-1"
        if self.release_slot != "legacy" and service != "postgres":
            return f"quantself-{self.release_slot}-{service}-1"
        if service in PRODUCTION_APP:
            return PRODUCTION_APP[service]
        return f"portfolio-{service}-1"

    def check_host(self):
        require(socket.gethostname().split(".")[0] == self.role, "Unexpected guest hostname")

    def services_now(self):
        if self.production_profile == PRODUCTION_NATIVE_PROFILE:
            require(self.release_slot == active_release_slot(), "Active release changed during backup")
        services = {service: inspect(self.container_name(service)) for service in self.services}
        projects = (self.project,) if self.production_profile is None else (self.project, "portfolio-analytics", "keep-quantself")
        managed = self.production_profile == PRODUCTION_NATIVE_PROFILE and os.path.lexists(RELEASE_STATE / "active")
        if managed:
            projects += RELEASE_PROJECTS
        running = set()
        for project in projects:
            running.update(docker("ps", "--no-trunc", "--quiet", "--filter",
                                  f"label=com.docker.compose.project={project}").splitlines())
        expected = {info["id"] for info in services.values() if info["state"]["Running"]}
        require(running == expected, "Unexpected running Compose container or concurrent service change")
        if self.production_profile is not None:
            slot_projects = RELEASE_PROJECTS if managed else ()
            for project in (self.project, *slot_projects):
                require(not docker("ps", "--all", "--quiet",
                                   "--filter", f"label=com.docker.compose.project={project}",
                                   "--filter", f"label=com.docker.compose.service={JOBS_OUTBOX_SERVICE}").strip(),
                        "Jobs Codex one-shot has not exited and been removed")
        if self.production_profile == PRODUCTION_NATIVE_PROFILE:
            for retired in ("portfolio-analytics", "keep-quantself"):
                require(not docker("ps", "--all", "--quiet",
                                   "--filter", f"label=com.docker.compose.project={retired}").strip(),
                        "Native production requires retired project containers to be removed")
        return services

    def expected_vault_origin(self):
        return f"https://{self.vault_hostname}" if self.vault_hostname else read_vault_origin()

    def verify_vault_gateway(self, gateway):
        private(VAULT_GATEWAY_PROOF, 0o600)
        require(read_json(VAULT_GATEWAY_PROOF) == {
            "format": 1, "config_sha256": VAULT_GATEWAY_SHA, "contract": "vault-loopback-gateway-v1",
        }, "Vault gateway readiness evidence differs")
        config = VAULT / "vault.Caddyfile"
        metadata = config.lstat()
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == metadata.st_gid == 0
                and metadata.st_mode & 0o022 == 0 and snapshot_digest(config) == VAULT_GATEWAY_SHA,
                "Vault gateway configuration differs")
        mounts = [mount for mount in gateway["mounts"] if mount["Destination"] == "/etc/caddy/Caddyfile"]
        require(len(mounts) == 1 and mounts[0]["Type"] == "bind" and mounts[0]["Source"] == str(config)
                and mounts[0]["RW"] is False, "Vault gateway config mount differs")
        image = docker("image", "inspect", "--format", "{{.Id}}", VAULT_GATEWAY_IMAGE).strip()
        require(re.fullmatch(r"sha256:[a-f0-9]{64}", image) and image == gateway["image"],
                "Vault gateway image differs from the reviewed pin")
        host = self.expected_vault_origin().removeprefix("https://")
        serve = json.loads(command("tailscale", "serve", "status", "--json"))
        expected = {"TCP": {"443": {"HTTPS": True}},
                    "Web": {f"{host}:443": {"Handlers": {
                        "/": {"Proxy": "http://127.0.0.1:9201"}
                    }}}}
        require(all(serve.get(key) == value for key, value in expected.items())
                and not any(value for key, value in serve.items() if key not in expected),
                "Vault Serve routes differ from the exclusive gateway route")

    def verify_vault_ingress(self, *, closed, backend_running):
        front = command("ss", "-H", "-ltn", "sport = :9201", timeout=5).splitlines()
        back = command("ss", "-H", "-ltn", "sport = :9200", timeout=5).splitlines()
        require([row.split()[3] for row in back] == (["127.0.0.1:9200"] if backend_running else [])
                and [row.split()[3] for row in front] == ([] if closed else ["127.0.0.1:9201"]),
                "Vault listener state differs from the loopback contract")

    def jobs_sources(self, services):
        sources = {}
        for service, relative in JOBS_BINDS.items():
            filename = Path(relative).name
            source = JOBS_CONFIG / relative
            destination = f"/run/quantself-jobs/{filename}"
            candidates = [mount for mount in services[service]["mounts"]
                          if mount["Type"] != "volume"
                          or mount["Destination"].startswith("/run/quantself-jobs")
                          or mount["Destination"] == JOBS_TEMPLATE_TARGET]
            templates = [mount for mount in candidates if mount["Destination"] == JOBS_TEMPLATE_TARGET]
            if templates:
                require(service == "api" and len(templates) == 1, "Jobs template bind is API-only")
                mount = templates[0]
                template_root = JOBS_CONFIG / JOBS_TEMPLATES
                require(mount["Type"] == "bind" and mount["Source"] == str(template_root)
                        and mount["RW"] is False and template_root.resolve(strict=True) == template_root,
                        "Jobs template bind mount differs")
                private(template_root, 0o700)
                require({path.name for path in template_root.iterdir()} == set(JOBS_TEMPLATE_FILES),
                        "Jobs template file set differs")
                for filename in JOBS_TEMPLATE_FILES:
                    sources[f"{JOBS_BACKUP}/{JOBS_TEMPLATES}/{filename}"] = template_root / filename
                candidates = [candidate for candidate in candidates if candidate is not mount]
            require(len(candidates) <= 1, "Unexpected or duplicate application bind mount")
            if candidates:
                mount = candidates[0]
                require(mount["Type"] == "bind" and mount["Source"] == str(source)
                        and mount["Destination"] == destination and mount["RW"] is False,
                        "Jobs configuration bind mount differs")
                sources[f"{JOBS_BACKUP}/{relative}"] = source
        count = sum(f"{JOBS_BACKUP}/{name}" in sources for name in JOBS_BINDS.values())
        require(count in (0, len(JOBS_BINDS)), "Jobs configuration bind mounts must be paired")
        for source in sources.values():
            validate_jobs_file(source)
        return sources

    def jobs_outbox(self):
        if self.production_profile is None:
            return None
        present = docker("volume", "ls", "--quiet", "--filter",
                         f"name=^{JOBS_OUTBOX_VOLUME}$").splitlines()
        if not present:
            require(not jobs_outbox_declared(self.bundle / "compose.prod.yaml"),
                    "Required Jobs Codex outbox volume is absent")
            return None
        require(present == [JOBS_OUTBOX_VOLUME], "Unexpected Jobs Codex outbox volume name")
        fields = ('{{json .Name}} {{json .Driver}} {{json .Scope}} {{json .Mountpoint}} '
                  '{{json .Labels}} {{json .Options}} {{json .CreatedAt}}')
        decoder = json.JSONDecoder()
        text = docker("volume", "inspect", "--format", fields, JOBS_OUTBOX_VOLUME)
        values = []
        for _ in range(7):
            value, end = decoder.raw_decode(text)
            values.append(value)
            text = text[end:].lstrip()
        name, driver, scope, mount, labels, options, created = values
        expected = DOCKER_VOLUMES / JOBS_OUTBOX_VOLUME / "_data"
        require(not text.strip() and name == JOBS_OUTBOX_VOLUME and driver == "local" and scope == "local"
                and not options and mount == str(expected) and isinstance(labels, dict)
                and labels.get("com.docker.compose.project") == "quantself"
                and labels.get("com.docker.compose.volume") == JOBS_OUTBOX_KEY
                and isinstance(created, str) and bool(created), "Jobs Codex outbox volume identity differs")
        info = expected.lstat()
        require(stat.S_ISDIR(info.st_mode) and expected.resolve(strict=True) == expected
                and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022,
                "Jobs Codex outbox storage is not root-controlled")
        return {"mountpoint": str(expected), "created": created, "device": info.st_dev, "inode": info.st_ino}

    def sources(self, services):
        if self.role == "files":
            mounts = {mount["Destination"]: mount["Source"]
                      for mount in services["opencloud"]["mounts"] if mount["Type"] == "bind"}
            require(mounts.get("/etc/opencloud") == str(OPEN_CLOUD / "config")
                    and mounts.get("/var/lib/opencloud") == str(OPEN_CLOUD / "data"),
                    "OpenCloud mounts differ from backup scope")
            return {"opencloud/config": OPEN_CLOUD / "config", "opencloud/data": OPEN_CLOUD / "data"}
        mounts = {mount["Destination"]: Path(mount["Source"])
                  for mount in services["api"]["mounts"] if mount["Type"] == "volume"}
        captures = {"/app/storage/todo-captures": "captures", "/run/quantself": "auth"}
        require(captures.keys() <= mounts.keys(), "Required application volumes differ")
        sources = {target: mounts[source] for source, target in captures.items()}
        bundle = self.app if self.production_profile is None else production_release(self.app, services["app"]["image"])
        sources["deployment/app-image"] = bundle / "app-image"
        if self.production_profile is not None:
            require(mounts.keys() <= captures.keys() | LEGACY_MOUNTS.keys(),
                    "Unexpected application data volume")
            sources.update(self.jobs_sources(services))
            templates = any(name.startswith(f"{JOBS_BACKUP}/{JOBS_TEMPLATES}/") for name in sources)
            require(templates == jobs_templates_declared(self.bundle / "compose.home.yaml"),
                    "Jobs template bind differs from the deployment bundle")
            outbox = self.jobs_outbox()
            if outbox:
                sources[JOBS_OUTBOX_TREE] = Path(outbox["mountpoint"])
            for destination, target in LEGACY_MOUNTS.items():
                if destination in mounts:
                    sources[target] = mounts[destination]
            worker_volumes = {
                mount["Destination"]: Path(mount["Source"])
                for mount in services["inventory-codex-enrichment-worker"]["mounts"]
                if mount["Type"] == "volume"
            }
            require(worker_volumes.keys() == {"/codex-home"}
                    and len(services["inventory-codex-enrichment-worker"]["mounts"]) == 1,
                    "Codex worker volumes differ")
            sources["codex"] = worker_volumes["/codex-home"]
            require(len(set(sources.values())) == len(sources), "Production backup paths overlap")
        return sources

    def verify_native_schema(self, database):
        if self.production_profile == PRODUCTION_NATIVE_PROFILE:
            require(self.pg_query(database, "SELECT count(*) FROM pg_class WHERE oid IN "
                                  "(to_regclass('public.website_event'), to_regclass('public.website_inquiry'))") == "2",
                    "Native production analytics schema is incomplete")

    def database_bytes(self, services):
        query = "SELECT pg_database_size(current_database())"
        total = int(self.pg_query(services["postgres"], query)) + GIB
        if self.analytics is not None:
            total += int(docker("exec", services["analytics-postgres"]["id"], "psql", "-XAt",
                                "--no-password", "--set=ON_ERROR_STOP=1",
                                "-U", "umami", "-d", "umami", "-c", query)) + GIB
        return total

    def pg_query(self, service, query):
        return docker("exec", service["id"], "psql", "-XAt", "--no-password",
                      "--set=ON_ERROR_STOP=1", "-U", "quantself", "-d", "quantself", "-c", query).strip()

    def web_proof(self, image):
        proof = WEB_PROOF if self.production_profile is None else production_release(self.app, image) / "web-drain.json"
        verify_web_drain_proof(proof, image)

    def verify_app_images(self, services):
        image = services["app"]["image"]
        require(services["api"]["image"] == image, "Web and API image IDs differ")
        if self.production_profile is not None:
            require(all(services[name]["image"] == image for name in INVENTORY_WORKERS),
                    "Production inventory worker image differs")
        if self.release_slot != "legacy":
            require(services[API_WORKERS]["image"] == image, "Production API worker image differs")
            worker_mounts = sorted(services[API_WORKERS]["mounts"], key=lambda mount: mount["Destination"])
            api_mounts = sorted(services["api"]["mounts"], key=lambda mount: mount["Destination"])
            require(worker_mounts == api_mounts, "Production API workers use different data mounts")
        self.web_proof(image)

    def repository_id(self):
        identity = json.loads(restic(self.role, "cat", "config"))["id"]
        require(re.fullmatch(r"[0-9a-f]{64}", identity), "Invalid offsite repository ID")
        return identity

    def preflight(self):
        self.check_host()
        if self.role == "files":
            private(VAULT_GATEWAY_PROOF, 0o600)
        services = self.services_now()
        require(all(info["state"]["Status"] in ("running", "exited", "created")
                    for info in services.values()), "Guest has a container in an unstable state")
        extra = 0
        if self.role == "quantself":
            require(services["postgres"]["state"]["Running"], "PostgreSQL is unavailable")
            self.verify_native_schema(services["postgres"])
            image = services["app"]["image"]
            self.verify_app_images(services)
            if self.production_profile is None:
                verify_image_pin(self.app / "image-id", image)
                verify_app_image_archive(self.app / "app-image", image)
            else:
                require(services["inventory-preprocessing-worker"]["state"]["Status"] in ("created", "exited"),
                        "Production Inventory preprocessing worker must stay stopped")
                verify_production_release(production_release(self.app, image), image)
            if self.production_profile is not None:
                require(not os.path.lexists(self.maintenance), "Production maintenance requires reconciliation")
                private(self.app / ".env", 0o600)
                private(PRODUCTION_DEPLOY_ENV, 0o600)
                bundles = [(self.bundle, ("compose.yaml", *PRODUCTION_COMPOSE, "Caddyfile"))]
                if self.analytics is not None:
                    private(self.analytics / ".env", 0o600)
                    bundles.append((self.analytics, ANALYTICS_BUNDLE))
                    require(services["analytics-postgres"]["state"]["Running"],
                            "Analytics PostgreSQL is unavailable")
                for directory, names in bundles:
                    for name in names:
                        info = (directory / name).lstat()
                        require(stat.S_ISREG(info.st_mode) and info.st_size > 0,
                                "Production backup bundle has an invalid file")
                gateway_mounts = [mount for mount in services["gateway"]["mounts"]
                                  if mount["Destination"] == "/etc/caddy/Caddyfile"]
                require(len(gateway_mounts) == 1
                        and gateway_mounts[0]["Type"] == "bind"
                        and gateway_mounts[0]["Destination"] == "/etc/caddy/Caddyfile"
                        and Path(gateway_mounts[0]["Source"]) == self.bundle / "Caddyfile.home"
                        and gateway_mounts[0]["RW"] is False,
                        "Production gateway did not mount the backed-up Caddyfile")
            if services["app"]["state"]["Running"]:
                require("next:start-server" in docker(
                    "exec", services["app"]["id"], "printenv", "DEBUG"
                ).strip().split(","), "Web drain log namespace is not enabled")
            extra = self.database_bytes(services)
        if self.role == "files":
            gateway = services["vault-gateway"]
            self.verify_vault_gateway(gateway)
            self.verify_vault_ingress(closed=not gateway["state"]["Running"],
                                      backend_running=services["opencloud"]["state"]["Running"])
        sources = self.sources(services)
        estimate = available_disk(sources.values(), self.root, extra) * 11 // 10 + extra
        return {"estimated_copy_bytes": estimate, "repository": self.repository_id()}

    def stop(self, service, prior, since):
        if not prior["running"]:
            return
        # Docker's stop deadline can force termination. Reject that outcome.
        timeout = {"app": 900, "api": 900, "gateway": 1920, "vault-gateway": 45, "opencloud": 90,
                   **dict.fromkeys((*INVENTORY_WORKERS, API_WORKERS), 900), **dict.fromkeys(ANALYTICS_WRITERS, 60), "analytics-relay": 135}[service]
        try:
            docker("stop", "--time", str(timeout), prior["id"], timeout=timeout + 30)
            actual = inspect(prior["id"])["state"]
        except BackupError:
            # The Docker daemon may still be handling the original stop after
            # its client loses the reply. Do not race it with resume.
            raise StopUnconfirmed(f"{service} stop outcome is unconfirmed") from None
        allowed_exit = {"app": (143,), "gateway": (0,), "vault-gateway": (0,), "api": (0,), API_WORKERS: (0,), "opencloud": (0,)}
        allowed_exit.update(dict.fromkeys(INVENTORY_WORKERS, (0,)))
        allowed_exit.update(dict.fromkeys(ANALYTICS_WRITERS, (0, 143)))
        allowed_exit["analytics-relay"] = (0,)
        require(actual["Status"] == "exited" and actual["ExitCode"] in allowed_exit[service]
                and not actual["OOMKilled"] and not actual["Error"]
                and actual["StartedAt"] == prior["started"]
                and actual["FinishedAt"] > since,
                f"{service} did not exit cleanly")
        if service in ("app", "api", API_WORKERS, "gateway", "vault-gateway", "analytics-relay", *INVENTORY_WORKERS):
            logs = subprocess.run(
                ["docker", "logs", "--since", since, prior["id"]], check=False,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60,
            )
            lines = logs.stdout.splitlines()
            if service == "app":
                marker = any(b"next:start-server" in line and
                             b"start-server process cleanup finished" in line for line in lines)
            elif service in ("api", API_WORKERS):
                marker = b"API drain complete" in lines
            elif service in INVENTORY_WORKERS:
                marker = b"Inventory worker drain complete" in lines
            elif service == "analytics-relay":
                marker = b"Analytics relay drain complete" in lines
            elif service == "gateway":
                marker = any(b"servers shutting down with eternal grace period" in line for line in lines)
            else:
                marker = any(b"servers shutting down; grace period initiated" in line for line in lines)
            require(logs.returncode == 0 and marker,
                    f"{service} shutdown lacked the current graceful cleanup marker")

    def ingress_listeners(self, pid):
        # The host's Docker port proxy can keep accepting after Caddy closes
        # its sockets. Inspect the actual server's network namespace.
        return command("nsenter", "--target", str(pid), "--net", "--",
                       "ss", "-H", "-ltn", "sport = :3000", timeout=5).strip()

    def wait_ingress_closed(self, prior, stopped):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if stopped.done():
                stopped.result()
                return
            state = inspect(prior["id"])["state"]
            require(state["StartedAt"] == prior["started"], "Gateway restarted while draining")
            if state["Status"] == "running" and state["Pid"] > 0:
                try:
                    listeners = self.ingress_listeners(state["Pid"])
                except BackupError:
                    # A fast clean exit can remove its namespace mid-probe.
                    # Only the stop worker's clean-exit result can prove that path.
                    listeners = None
                current = inspect(prior["id"])["state"]
                if (listeners == "" and current["StartedAt"] == prior["started"]
                        and current["Pid"] == state["Pid"]):
                    return
            time.sleep(0.2)
        raise BackupError("Gateway did not close ingress before drain")

    def pause_app_writers(self, prior, since):
        if self.production_profile is not None:
            for worker in INVENTORY_WORKERS:
                self.stop(worker, prior[worker], since)
        self.stop("app", prior["app"], since)
        self.stop("api", prior["api"], since)
        if API_WORKERS in prior:
            self.stop(API_WORKERS, prior[API_WORKERS], since)

    def pause_app(self, prior, since):
        if not prior["gateway"]["running"]:
            self.pause_app_writers(prior, since)
            return
        gateway = inspect(prior["gateway"]["id"])["state"]
        require(gateway["Status"] == "running" and gateway["StartedAt"] == prior["gateway"]["started"]
                and gateway["Pid"] > 0 and self.ingress_listeners(gateway["Pid"]),
                "Gateway listener did not match the deployed ingress contract")
        with ThreadPoolExecutor(max_workers=1) as pool:
            stopped = pool.submit(self.stop, "gateway", prior["gateway"], since)
            downstream_error = None
            try:
                self.wait_ingress_closed(prior["gateway"], stopped)
                # Preserve Next's upstream until all admitted web work drains.
                # API shutdown closes its SSE streams, allowing Caddy to exit.
                self.pause_app_writers(prior, since)
            except Exception as error:
                downstream_error = error
            # Wait for the original stop even after a downstream failure.
            # Preserve an unresolved outcome from either operation.
            try:
                stopped.result()
            except Exception:
                if not isinstance(downstream_error, OperationUnconfirmed):
                    raise
            if downstream_error is not None:
                raise downstream_error

    def pause_vault(self, prior, since, gateway):
        image = docker("image", "inspect", "--format", "{{.Id}}", VAULT_IMAGE).strip()
        require(re.fullmatch(r"sha256:[a-f0-9]{64}", image) and image == prior["image"],
                "OpenCloud container image differs from the pinned upload-session contract")
        if not prior["running"]:
            return
        deadline = time.monotonic() + 120
        empty_samples = 0
        while (remaining := deadline - time.monotonic()) > 0:
            try:
                self.verify_vault_ingress(closed=True, backend_running=True)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                output = docker("exec", prior["id"], "opencloud", "storage-users",
                                "uploads", "sessions", "--json", timeout=min(15, remaining))
                rows = json.loads(output)
            except (BackupError, ValueError):
                raise BackupError("OpenCloud upload-session listing could not be verified") from None
            require(rows is None or (isinstance(rows, list) and all(isinstance(row, dict) for row in rows)),
                    "OpenCloud upload-session listing was invalid")
            empty_samples = 0 if rows else empty_samples + 1
            if empty_samples == 2 and time.monotonic() < deadline:
                current = inspect(prior["id"])["state"]
                require(current["Status"] == "running" and current["StartedAt"] == prior["started"],
                        "OpenCloud changed while checking upload sessions")
                self.verify_vault_gateway(inspect(gateway["id"]))
                self.verify_vault_ingress(closed=True, backend_running=True)
                if time.monotonic() >= deadline:
                    break
                self.stop("opencloud", prior, since)
                return
            time.sleep(max(0, min(2, deadline - time.monotonic())))
        raise BackupError("OpenCloud upload sessions did not clear before deadline")

    def pause(self):
        if self.production_profile is None:
            return self.pause_services()
        with locked(PRODUCTION_LOCK):
            require(not os.path.lexists(self.maintenance), "Production maintenance requires reconciliation")
            return self.pause_services()

    def pause_services(self):
        self.check_host()
        require(not self.state_path.exists(), "Prior service state already recorded")
        services = self.services_now()
        prior = {name: {"id": info["id"], "image": info["image"],
                        "started": info["state"]["StartedAt"], "running": info["state"]["Running"]}
                 for name, info in services.items()}
        if self.role == "quantself":
            self.verify_app_images(services)
        if self.production_profile is not None:
            outbox = self.jobs_outbox()
            write_json(self.maintenance, {"restore_id": self.restore_id})
            write_json(self.run / "jobs-outbox.json", outbox)
        write_json(self.state_path, prior)
        # The Docker log boundary uses nanosecond precision.
        ns = time.time_ns()
        since = datetime.fromtimestamp(ns // 10**9, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
        since += f".{ns % 10**9:09d}Z"
        if self.role == "files":
            gateway = services["vault-gateway"]
            backend_running = prior["opencloud"]["running"]
            self.verify_vault_gateway(gateway)
            self.verify_vault_ingress(closed=not prior["vault-gateway"]["running"],
                                      backend_running=backend_running)
            self.stop("vault-gateway", prior["vault-gateway"], since)
            self.verify_vault_ingress(closed=True, backend_running=backend_running)
            self.pause_vault(prior["opencloud"], since, prior["vault-gateway"])
        else:
            self.pause_app(prior, since)
            if self.analytics is not None:
                for writer in ANALYTICS_WRITERS:
                    self.stop(writer, prior[writer], since)
        return {}

    def assert_paused(self):
        require((self.run / "pause.json").exists()
                and read_json(self.run / "pause.json").get("status") == "ok",
                "Guest has no successful pause")
        require(not (self.run / "resume.json").exists(), "Guest already began resuming")
        if self.production_profile is not None:
            self.verify_maintenance()
        prior = read_json(self.state_path)
        services = self.services_now()
        require(services.keys() == prior.keys(), "Container set changed during pause")
        if self.production_profile is not None:
            baseline = self.run / "jobs-outbox.json"
            require(self.jobs_outbox() == (read_json(baseline) if baseline.exists() else None),
                    "Jobs Codex outbox volume changed during pause")
        if "vault-gateway" in services:
            self.verify_vault_gateway(services["vault-gateway"])
            self.verify_vault_ingress(closed=True, backend_running=False)
        for name, info in services.items():
            require(info["id"] == prior[name]["id"] and info["state"]["StartedAt"] == prior[name]["started"]
                    and info["state"]["Status"] in (("running",) if name in ("postgres", "analytics-postgres") else ("created", "exited")),
                    "Container state changed during pause")
        return services

    def check_paused(self):
        self.assert_paused()
        return {}

    def capture(self):
        services = self.assert_paused()
        sources = self.sources(services)
        extra = 0
        if self.role == "quantself":
            extra = self.database_bytes(services)
        available_disk(sources.values(), self.root, extra)
        staging = self.run / "staging"
        tree = staging / "tree"
        tree.mkdir(parents=True)
        source_inventories = {}
        jobs_inventory = {}
        for name, source in sources.items():
            if name.startswith(JOBS_BACKUP + "/"):
                jobs_inventory[name] = jobs_file_record(source)
            else:
                source_inventories[name] = scan(source)
            target = tree / name
            target.parent.mkdir(parents=True, exist_ok=True)
            command("cp", "-a", "--preserve=xattr", "--reflink=auto",
                    "--", source, target, timeout=None)
        if self.role == "quantself":
            private(self.app / ".env", 0o600)
            files = [self.bundle / "compose.yaml", self.bundle / "Caddyfile", self.app / ".env"]
            if self.production_profile is None:
                files.append(self.app / "image-id")
            if (self.app / "app-token-metadata.json").exists():
                files.append(self.app / "app-token-metadata.json")
        else:
            files = [VAULT / "compose.yaml"]
            if "vault-gateway" in services:
                files.append(VAULT / "vault.Caddyfile")
        deployment = tree / "deployment"
        deployment.mkdir(exist_ok=True)
        for source in files:
            require(source.is_file() and not source.is_symlink(), "Unexpected deployment file type")
            command("cp", "-a", "--", source, deployment, timeout=None)
        if self.production_profile is not None:
            image = services["app"]["image"]
            (deployment / "image-id").write_text(image + "\n")
            proof = production_release(self.app, image) / "web-drain.json"
            verify_web_drain_proof(proof, image)
            command("cp", "-a", "--", proof, deployment, timeout=None)
            bundles = [(self.bundle, deployment, PRODUCTION_COMPOSE)]
            if self.analytics is not None:
                private(self.analytics / ".env", 0o600)
                analytics_bundle = deployment / "analytics"
                analytics_bundle.mkdir()
                bundles.append((self.analytics, analytics_bundle, ANALYTICS_BUNDLE))
            for directory, destination, files in bundles:
                for name in files:
                    source = directory / name
                    require(stat.S_ISREG(source.lstat().st_mode), "Unexpected production deployment file type")
                    target = destination / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    command("cp", "-a", "--", source, target, timeout=None)
            for source, name in ((PRODUCTION_PROFILE, "production-profile.json"),
                                 (PRODUCTION_DEPLOY_ENV, "deploy.env.recovery-reference")):
                private(source, 0o600)
                command("cp", "-a", "--", source, deployment / name, timeout=None)
        manifest = {
            "format": 1, "restore_id": self.restore_id, "role": self.role,
            "images": {name: info["image"] for name, info in services.items() if name != API_WORKERS},
        }
        if self.role == "quantself":
            db = services["postgres"]
            self.verify_native_schema(db)
            postgres = tree / "postgres"
            postgres.mkdir()
            manifest["schema_migrations"] = self.pg_query(
                db, 'SELECT migration_name FROM "_prisma_migrations" '
                    'WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name'
            ).splitlines()
            require(bool(manifest["schema_migrations"]), "No completed schema migrations")
            with (postgres / "quantself.dump").open("xb") as dump:
                docker("exec", db["id"], "pg_dump", "--no-password", "--format=custom",
                       "--username=quantself", "--dbname=quantself", output=dump, timeout=None)
                dump.flush()
                os.fsync(dump.fileno())
                require(dump.tell() > 0, "PostgreSQL dump is empty")
        if self.analytics is not None:
            self.capture_analytics(services, tree)
        if self.production_profile is not None:
            manifest["profile"] = self.production_profile
            if self.production_profile == PRODUCTION_NATIVE_PROFILE and os.path.lexists(RELEASE_STATE / "active"):
                manifest["release_slot"] = self.release_slot
            manifest["legacy_sources"] = sorted(name for name in sources if name.startswith("legacy/"))
            binds = sorted(name for name in jobs_inventory if not name.startswith(f"{JOBS_BACKUP}/{JOBS_TEMPLATES}/"))
            templates = sorted(set(jobs_inventory) - set(binds))
            if binds:
                manifest["jobs_binds"] = binds
            if templates:
                manifest["jobs_templates"] = templates
            if JOBS_OUTBOX_TREE in sources:
                manifest["jobs_codex_outbox"] = JOBS_OUTBOX_VOLUME
        self.assert_paused()
        inventory = write_inventory(tree, staging / "inventory.json")
        if jobs_inventory:
            frozen_jobs = {entry["path"]: {key: value for key, value in entry.items() if key != "path"}
                           for entry in inventory["entries"] if entry["path"] in jobs_inventory}
            require(frozen_jobs == jobs_inventory
                    and all(jobs_file_record(sources[name]) == record for name, record in jobs_inventory.items()),
                    "Frozen Jobs configuration differs from source")
        for name, expected in source_inventories.items():
            if name == JOBS_OUTBOX_TREE:
                require(scan(sources[name]) == expected, "Jobs Codex outbox changed during capture")
            actual = []
            for entry in inventory["entries"]:
                path = entry["path"]
                if path == name:
                    actual.append({**entry, "path": "."})
                elif path.startswith(name + "/"):
                    row = {**entry, "path": path.removeprefix(name + "/")}
                    if "hardlink" in row:
                        row["hardlink"] = row["hardlink"].removeprefix(name + "/")
                    actual.append(row)
            require(actual == expected["entries"], "Frozen copy differs from source metadata or contents")
        if self.role == "quantself":
            verify_image_pin(deployment / "image-id", services["app"]["image"])
            verify_app_image_archive(deployment / "app-image", services["app"]["image"],
                                     digests={Path(entry["path"]).name: entry["sha256"]
                                              for entry in inventory["entries"]
                                              if entry["path"].startswith("deployment/app-image/")
                                              and entry["type"] == "file"})
        manifest["inventory_sha256"] = snapshot_digest(staging / "inventory.json")
        manifest["inventory_entries"] = len(inventory["entries"])
        write_json(staging / "manifest.json", manifest)
        # Persist copied data before publishing the durable frozen tree.
        command("sync", "-f", staging, timeout=None)
        staging.rename(self.frozen)
        sync_dir(self.run)
        return manifest

    def capture_analytics(self, services, tree):
        database = services["analytics-postgres"]["id"]
        analytics = tree / "analytics"
        analytics.mkdir(mode=0o700)
        query = """
            SELECT count(*) FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND backend_type = 'client backend'
            AND usename IS DISTINCT FROM 'quantself_analytics_reader';
        """
        require(docker("exec", database, "psql", "-XAt", "--no-password", "--set=ON_ERROR_STOP=1",
                       "-U", "umami", "-d", "umami", "-c", query).strip() == "0",
                "Unexpected analytics database session after writer drain")
        for filename, args in (
            ("umami.dump", ("pg_dump", "--format=custom", "--dbname=umami")),
            ("roles.sql", ("pg_dumpall", "--roles-only")),
        ):
            fd = os.open(analytics / filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as output:
                docker("exec", database, *args, "--no-password", "--username=umami",
                       output=output, timeout=None)
                output.flush()
                os.fsync(output.fileno())
                require(output.tell() > 0, "Analytics backup output is empty")

    def wait_vault_ready(self, *, trusted):
        origin = self.expected_vault_origin()
        host = origin.removeprefix("https://")
        endpoint = origin if trusted else "http://127.0.0.1:9200"
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            try:
                if not trusted:
                    for port in VAULT_READY_PORTS:
                        remaining = deadline - time.monotonic()
                        require(remaining > 0, "Vault readiness deadline reached")
                        status = command(
                            "curl", "-q", "--silent", "--noproxy", "*",
                            "--max-time", str(min(5, remaining)), "--output", "/dev/null",
                            "--write-out", "%{http_code}", f"http://127.0.0.1:{port}/readyz",
                            timeout=min(7, remaining),
                        )
                        require(status == "200", "Vault dependency is not ready")
                remaining = deadline - time.monotonic()
                require(remaining > 0, "Vault readiness deadline reached")
                response = command(
                    "curl", "-q", "--silent", "--fail", "--noproxy", "*",
                    "--max-time", str(min(5, remaining)), "--max-filesize", "65536",
                    "--header", f"Host: {host}", "--header", "X-Forwarded-Proto: https",
                    endpoint + "/.well-known/openid-configuration", timeout=min(7, remaining),
                )
                if json.loads(response).get("issuer", "").rstrip("/") == origin:
                    return
            except (BackupError, ValueError, AttributeError):
                pass
            time.sleep(max(0, min(2, deadline - time.monotonic())))
        raise BackupError("Vault dependency or pinned OIDC issuer did not become ready")

    def verify_maintenance(self):
        private(self.maintenance, 0o600)
        require(read_json(self.maintenance) == {"restore_id": self.restore_id},
                "Production maintenance marker belongs to a different backup")

    def resume(self):
        if self.production_profile is None:
            require(self.role != "quantself" or not os.path.lexists(self.maintenance),
                    "Production maintenance profile is unavailable")
            return self.resume_services()
        with locked(PRODUCTION_LOCK):
            if not os.path.lexists(self.maintenance):
                # A preflight/lock failure may leave nothing to resume. A lost
                # result after successful resume can retry from the same IDs.
                if not self.state_path.exists():
                    return {}
                self.verify_resumed_state(read_json(self.state_path))
                return {}
            self.verify_maintenance()
            require(self.state_path.exists(), "Production maintenance has no prior service state")
            result = self.resume_services()
            self.maintenance.unlink()
            sync_dir(self.root)
            return result

    def verify_resumed_state(self, prior):
        services = self.services_now()
        require(services.keys() == prior.keys()
                and all(info["id"] == prior[name]["id"]
                        and info["state"]["Running"] == prior[name]["running"]
                        and info["state"].get("Health", {}).get("Status", "healthy") == "healthy"
                        for name, info in services.items() if prior[name]["running"])
                and all(info["id"] == prior[name]["id"] and not info["state"]["Running"]
                        for name, info in services.items() if not prior[name]["running"]),
                "Production services did not return to their verified state")

    def resume_services(self):
        if not self.state_path.exists():
            return {}
        prior = read_json(self.state_path)
        require(prior.keys() == set(self.services), "Backup profile changed before resume")
        # Start the same containers, without Compose dependency expansion or recreation.
        order = ("postgres", "api", "app", "gateway") if self.role == "quantself" else ("opencloud", "vault-gateway")
        if self.production_profile is not None:
            self.services_now()
            worker = (API_WORKERS,) if API_WORKERS in prior else ()
            order = ("postgres", "api", *worker, *INVENTORY_WORKERS, "app", "gateway")
            if self.analytics is not None:
                order = ("analytics-postgres", "analytics-umami", "analytics-retention", "analytics-relay", *order)
        errors = []
        for name in order:
            try:
                state = inspect(self.container_name(name))
                require(state["id"] == prior[name]["id"], f"{name} was replaced during backup")
                if name == "vault-gateway" and prior[name]["running"]:
                    require(not errors and prior["opencloud"]["running"],
                            "OpenCloud did not resume before Vault gateway")
                    self.verify_vault_gateway(state)
                    self.wait_vault_ready(trusted=False)
                if prior[name]["running"] and not state["state"]["Running"]:
                    try:
                        docker("start", prior[name]["id"])
                    except CommandUnconfirmed:
                        raise OperationUnconfirmed(f"{name} start outcome is unconfirmed") from None
                require(inspect(prior[name]["id"])["state"]["Running"] == prior[name]["running"],
                        f"{name} did not return to its prior state")
            except OperationUnconfirmed:
                raise
            except (BackupError, KeyError, ValueError):
                errors.append(name)
        require(not errors, "Could not restore prior state: " + ", ".join(errors))
        if self.role == "files":
            gateway_running = prior["vault-gateway"]["running"]
            self.verify_vault_ingress(closed=not gateway_running,
                                      backend_running=prior["opencloud"]["running"])
            if gateway_running:
                self.wait_vault_ready(trusted=True)
        # A running process can still be failing its Docker health check.
        deadline = time.monotonic() + 180
        while True:
            states = [inspect(prior[name]["id"])["state"] for name in order if prior[name]["running"]]
            if all(state["Running"] and state.get("Health", {}).get("Status", "healthy") == "healthy"
                   for state in states):
                break
            require(time.monotonic() < deadline, "Resumed services did not become healthy")
            time.sleep(2)
        if self.production_profile is not None:
            self.verify_resumed_state(prior)
        return {}

    def upload(self):
        manifest = read_json(self.frozen / "manifest.json")
        require(manifest["restore_id"] == self.restore_id and manifest["role"] == self.role,
                "Frozen backup identity differs")
        expected = read_json(self.run / "preflight-1.json")["result"]["repository"]
        require(self.repository_id() == expected, "Offsite repository changed after preflight")
        out = restic(self.role, "backup", "--json", "--host", self.role, "--tag", self.restore_id,
                     "--tag", self.role, "--", ".", cwd=self.frozen)
        summaries = [row for line in out.splitlines()
                     if (row := json.loads(line)).get("message_type") == "summary"]
        require(len(summaries) == 1 and re.fullmatch(r"[0-9a-f]{8,64}", summaries[0].get("snapshot_id", "")),
                "Restic did not return a snapshot ID")
        snapshot = summaries[0]["snapshot_id"]
        matches = json.loads(restic(self.role, "snapshots", "--json", snapshot))
        require(len(matches) == 1 and re.fullmatch(r"[0-9a-f]{64}", matches[0]["id"])
                and matches[0]["id"].startswith(snapshot)
                and matches[0]["hostname"] == self.role and self.restore_id in matches[0]["tags"]
                and self.role in matches[0]["tags"] and matches[0]["paths"] == [str(self.frozen)],
                "Restic snapshot identity could not be verified")
        require(self.repository_id() == expected, "Offsite repository changed during upload")
        return {"snapshot": matches[0]["id"], "repository": expected, "manifest": manifest}

    def unit(self, operation, attempt):
        return f"keep-backup-{self.restore_id}-{operation}-{attempt}.service"

    def start(self, operation, attempt):
        self.check_host()
        self.run.mkdir(parents=True, exist_ok=True)
        unit = self.unit(operation, attempt)
        # A deterministic unit name lets Keep observe the same launch after a
        # guest-agent disconnect. The durable result outlives the transient unit.
        require(not (self.run / f"{operation}-{attempt}.json").exists(),
                "Guest operation already recorded")
        vault_args = ("--vault-hostname", self.vault_hostname) if self.vault_hostname else ()
        command("systemd-run", "--quiet", "--no-block", "--unit", unit,
                "--property=StandardOutput=null",
                "--property=StandardError=null", sys.executable, Path(__file__).resolve(),
                "worker", self.role, self.restore_id, operation, str(attempt), *vault_args)

    def status(self, operation, attempt):
        return unit_status(self.unit(operation, attempt), self.run / f"{operation}-{attempt}.json")

    def worker(self, operation, attempt):
        self.check_host()
        with locked(self.root / "worker.lock"):
            path = self.run / f"{operation}-{attempt}.json"
            require(not path.exists(), "Guest operation already recorded")
            if operation == "resume":
                write_json(self.run / "resume.json", {"status": "started"})
            try:
                result = getattr(self, operation)()
                record = {"status": "ok", "result": result}
            except OperationUnconfirmed as error:
                record = {"status": "unknown", "error": str(error)}
            except BackupError as error:
                record = {"status": "failed", "error": str(error)}
            except Exception:
                record = {"status": "failed", "error": "Guest operation failed; inspect locally"}
            if operation == "pause":
                write_json(self.run / "pause.json", record)
            write_json(path, record)


def unit_status(unit, path):
    # Observe systemd before reading the journal. A completed record may
    # become visible just before the worker releases its guest flock.
    result = subprocess.run(
        ["systemctl", "show", "--property=LoadState,ActiveState,SubState", unit],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        check=False, timeout=15, text=True,
    )
    info = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    require(result.returncode == 0 or info.get("LoadState") == "not-found",
            "Could not observe backup worker")
    if info.get("ActiveState") in ("activating", "active", "deactivating") and info.get("SubState") != "exited":
        return {"status": "running"}
    if path.exists():
        return read_json(path)
    if info.get("ActiveState") == "failed" or info.get("SubState") == "exited":
        return {"status": "unknown", "error": "Worker ended without a durable result"}
    if info.get("LoadState") == "not-found":
        return {"status": "unknown", "error": "Worker launch or previous boot outcome is unknown"}
    return {"status": "running"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("start", "status", "worker", "check-paused"))
    parser.add_argument("role", choices=("files", "quantself"))
    parser.add_argument("restore_id")
    parser.add_argument("operation", choices=("preflight", "pause", "capture", "resume", "upload"))
    parser.add_argument("attempt", type=int)
    parser.add_argument("--vault-hostname")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        require(os.geteuid() == 0, "Run as root")
        require(RESTORE_ID.fullmatch(args.restore_id) and 1 <= args.attempt <= 999,
                "Invalid restore ID or attempt")
        STATE.mkdir(exist_ok=True)
        private(STATE, 0o700)
        guest = Guest(args.role, args.restore_id, vault_hostname=args.vault_hostname)
        if args.action == "check-paused":
            result = guest.check_paused()
        else:
            result = getattr(guest, args.action)(args.operation, args.attempt)
        print(json.dumps(result or {}))
    except BackupError as error:
        print(json.dumps({"status": "error", "error": str(error)}))
        return 1
    except Exception:
        print(json.dumps({"status": "error", "error": "Guest I/O or data error"}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
