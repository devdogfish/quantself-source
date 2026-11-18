#!/usr/bin/env python3
"""Exercise SIGTERM during an admitted WebDAV PUT on an isolated Vault fixture."""

import argparse
import base64
from contextlib import contextmanager
import errno
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit


IMAGE = "opencloudeu/opencloud:7.2.5@sha256:26fcc6f69d71937af015be73c585e7c36d1945d547fa2a6f706118283f1bcd6b"
CADDY = "caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b"
CADDYFILE_SHA256 = "97bfabd90dff14cac701b71b6b62b66439fd627bc5595775cd5614e2e24a0918"
HOST = "vault-fixture.test"
PORT = 9200
ORIGIN = f"https://{HOST}:{PORT}"
PREFIX = b"vault-drain-fixture-prefix\n" * 4096
BODY = PREFIX + b"vault-drain-fixture-remainder\n" * 4096
TARGET = "vault-drain-synthetic.bin"
CONTROL = "vault-drain-control.bin"
CONTROL_BODY = b"vault-drain-control\n"
STOP_GRACE = 90


class ProofError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise ProofError(message)


def command(*args, timeout=15):
    argv = args
    env = {"PATH": "/usr/bin:/bin", "LANG": "C"}
    if args[0] == "docker":
        argv = ("/usr/bin/docker", "--host", "unix:///var/run/docker.sock", *args[1:])
        env["DOCKER_CONFIG"] = "/dev/null"
    result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False, env=env)
    require(result.returncode == 0, f"{args[0]} {args[1]} failed ({result.returncode})")
    return result.stdout.strip()


def until(check, message, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.2)
    raise ProofError(message)


def dav_root(payload):
    personal = [entry for entry in payload["value"] if entry["driveType"] == "personal"]
    require(len(personal) == 1, "Fixture did not return exactly one personal space")
    location = urlsplit(personal[0]["root"]["webDavUrl"])
    require(location.scheme == "https" and location.netloc == f"{HOST}:{PORT}"
            and re.fullmatch(r"/(?:remote\.php/)?dav/spaces/[A-Za-z0-9$%!_-]+/?", location.path)
            and not location.query and not location.fragment, "Unexpected fixture WebDAV URL")
    return location.path.rstrip("/")


def classify(upload_status, lookup_status, lookup_body):
    if upload_status in (200, 201, 204):
        require(lookup_status == 200 and lookup_body == BODY, "Acknowledged PUT failed verification")
        return "completed"
    require(upload_status is None or upload_status >= 500, "Unexpected deferred PUT status")
    require(lookup_status == 404, "Aborted PUT left a visible object")
    return "aborted_without_visible_object"


def scratch_parent(path):
    require(path.is_absolute() and path.resolve() == path, "Scratch parent must be absolute and canonical")
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0
            and stat.S_IMODE(info.st_mode) == 0o700, "Scratch parent must be root:root mode 0700")
    for ancestor in path.parents:
        info = ancestor.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                and (not info.st_mode & 0o022 or info.st_mode & stat.S_ISVTX),
                "Scratch parent must have trusted ancestors")


def staged_prefix(directory):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(directory, flags)
    try:
        for part in ("data", "storage", "users", "uploads"):
            try:
                child = os.open(part, flags, dir_fd=fd)
            except FileNotFoundError:
                return False
            os.close(fd)
            fd = child
        for name in os.listdir(fd):
            try:
                candidate = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            except OSError as error:
                if error.errno in (errno.ENOENT, errno.ELOOP):
                    continue
                raise
            try:
                info = os.fstat(candidate)
                if (stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size >= len(PREFIX)
                        and os.read(candidate, len(PREFIX)) == PREFIX):
                    return True
            finally:
                os.close(candidate)
        return False
    finally:
        os.close(fd)


class HTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, address, context):
        super().__init__(HOST, PORT, timeout=5, context=context)
        self.address = address
        self.context = context

    def connect(self):
        stream = socket.create_connection((self.address, PORT), timeout=self.timeout)
        try:
            self.sock = self.context.wrap_socket(stream, server_hostname=HOST)
        except BaseException:
            stream.close()
            raise


class Fixture:
    def __init__(self, directory, gateway_config=None):
        self.directory = directory
        self.name = f"keep254-vault-drain-{secrets.token_hex(6)}"
        self.network = None
        self.initializer = None
        self.container = None
        self.address = None
        self.stop = None
        self.password = secrets.token_urlsafe(24)
        self.gateway_config = gateway_config
        self.gateway = None
        self.edge = None

    def create(self, *args):
        try:
            identity = command("docker", *args)
            require(re.fullmatch(r"[0-9a-f]{64}", identity), "Docker did not return a fixture resource ID")
        except (ProofError, OSError, subprocess.TimeoutExpired):
            raise ProofError(f"Fixture creation unconfirmed for {self.name}. Inspect matching fixture resources.") from None
        return identity

    def start(self, *, restored=False):
        config = self.directory / "config"
        data = self.directory / "data"
        cert = config / "fixture.crt"
        key = config / "fixture.key"
        if not restored:
            for directory in (config, data):
                directory.mkdir()
                os.chown(directory, 1000, 1000)
                directory.chmod(0o700)
            command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                    "-subj", f"/CN={HOST}", "-addext", f"subjectAltName=DNS:{HOST}",
                    "-keyout", str(key), "-out", str(cert))
            os.chown(key, 1000, 1000)
            key.chmod(0o600)
            cert.chmod(0o644)
        self.context = ssl.create_default_context(cafile=str(cert))
        settings = {
            "IDM_ADMIN_PASSWORD": self.password,
            "IDM_CREATE_DEMO_USERS": "false",
            "OC_URL": ORIGIN,
            "OC_INSECURE": "true",
            "PROXY_TLS": "false" if self.gateway_config else "true",
            "PROXY_TRANSPORT_TLS_CERT": "/etc/opencloud/fixture.crt",
            "PROXY_TRANSPORT_TLS_KEY": "/etc/opencloud/fixture.key",
            "PROXY_HTTP_ADDR": f"{'127.0.0.1' if self.gateway_config else '0.0.0.0'}:{PORT}",
            "PROXY_ENABLE_BASIC_AUTH": "true",
            "STORAGE_USERS_DRIVER": "posix",
            "OC_LOG_LEVEL": "warn",
        }
        env = self.directory / "fixture.env"
        if not restored:
            env.write_text("".join(f"{key}={value}\n" for key, value in settings.items()))
            env.chmod(0o600)
        label = f"io.quantself.vault-drain-fixture={self.name}"
        self.network = self.create("network", "create", "--internal", "--label", label, self.name)
        options = (
            "--pull", "never", "--network", self.network, "--network-alias", HOST, "--label", label,
            "--user", "1000:1000", "--memory", "768m", "--memory-swap", "768m",
            "--env-file", str(env),
            "--mount", f"type=bind,src={config},dst=/etc/opencloud",
            "--mount", f"type=bind,src={data},dst=/var/lib/opencloud",
        )
        if not restored:
            self.initializer = self.create("create", "--name", self.name + "-init", *options,
                                           IMAGE, "init", "--insecure", "yes", "--quiet")
            command("docker", "start", "--attach", self.initializer, timeout=60)
            init_exit = command("docker", "inspect", "--format", "{{.State.ExitCode}}", self.initializer)
            require(init_exit == "0", "OpenCloud fixture initialization failed")
        self.container = self.create("create", "--name", self.name, *options,
                                 "--stop-timeout", str(STOP_GRACE), IMAGE)
        self.boot()

    def boot(self):
        command("docker", "start", self.container)
        addresses = command("docker", "inspect", "--format", "{{json .NetworkSettings.Networks}}",
                            self.container)
        self.address = json.loads(addresses)[self.name]["IPAddress"]
        require(bool(self.address), "Fixture container has no internal IP")
        if self.gateway_config:
            self.start_gateway()

        def ready():
            try:
                status, _ = self.request("GET", "/graph/v1.0/me/drives")
                return status == 200
            except OSError:
                return False

        until(ready, "Fixture failed authenticated Graph readiness", timeout=60)

    def start_gateway(self):
        label = f"io.quantself.vault-drain-fixture={self.name}"
        options = ("--pull", "never", "--network", f"container:{self.container}", "--label", label,
                   "--memory", "128m", "--memory-swap", "128m")
        gateway_config = self.directory / "gateway.Caddyfile"
        gateway_config.write_bytes(self.gateway_config.read_bytes())
        edge_config = self.directory / "edge.Caddyfile"
        edge_config.write_text(
            "{\n admin off\n auto_https off\n}\n"
            f"https://{HOST}:{PORT} {{\n bind {self.address}\n"
            " tls /fixture/fixture.crt /fixture/fixture.key\n"
            " reverse_proxy 127.0.0.1:9201\n}\n"
        )
        self.gateway = self.create(
            "create", "--name", self.name + "-gateway", *options,
            "--mount", f"type=bind,src={gateway_config},dst=/etc/caddy/Caddyfile,readonly", CADDY,
        )
        self.edge = self.create(
            "create", "--name", self.name + "-edge", *options,
            "--mount", f"type=bind,src={edge_config},dst=/etc/caddy/Caddyfile,readonly",
            "--mount", f"type=bind,src={self.directory / 'config'},dst=/fixture,readonly", CADDY,
        )
        command("docker", "start", self.gateway)
        command("docker", "start", self.edge)

    def connection(self):
        return HTTPSConnection(self.address, self.context)

    @property
    def authorization(self):
        return "Basic " + base64.b64encode(f"admin:{self.password}".encode()).decode()

    def request(self, method, path, body=None, *, headers=None):
        conn = self.connection()
        try:
            conn.request(method, path, body=body, headers={
                "Authorization": self.authorization, "Content-Type": "application/octet-stream", **(headers or {}),
            })
            response = conn.getresponse()
            return response.status, response.read(len(BODY) + 1)
        finally:
            conn.close()

    def staged_prefix(self):
        return staged_prefix(self.directory)

    def signal(self):
        # No Docker stop timer runs in the background. Wait explicitly for clean exit.
        command("docker", "kill", "--signal", "TERM", self.container)

    def ingress_refused(self):
        try:
            with socket.create_connection((self.address, PORT), timeout=0.5):
                return False
        except ConnectionRefusedError:
            return True

    def clean_exit(self):
        until(lambda: command("docker", "inspect", "--format", "{{.State.Status}}",
                              self.container) == "exited",
              "OpenCloud did not exit before its stop deadline", timeout=STOP_GRACE)
        state = command("docker", "inspect", "--format",
                        "{{.State.ExitCode}} {{.State.OOMKilled}} {{json .State.Error}}", self.container)
        require(state == '0 false ""', "OpenCloud exit was not clean")

    def close(self):
        errors = []
        for container in (self.edge, self.gateway, self.container, self.initializer):
            if container:
                try:
                    command("docker", "rm", "--force", "--volumes", container)
                except (ProofError, subprocess.TimeoutExpired):
                    errors.append(container)
        if self.network:
            try:
                command("docker", "network", "rm", self.network)
            except (ProofError, subprocess.TimeoutExpired):
                errors.append(self.network)
        require(not errors, f"Cleanup incomplete for fixture {self.name}")


def upload_session_count(payload):
    rows = json.loads(payload)
    if rows is None:
        return 0
    require(isinstance(rows, list) and all(isinstance(row, dict) and isinstance(row.get("id"), str)
                                          and row["id"] for row in rows),
            "Unexpected OpenCloud upload session output")
    return len(rows)


def session_count(fixture):
    return upload_session_count(command("docker", "exec", fixture.container,
                                        "/usr/bin/opencloud", "storage-users", "uploads",
                                        "sessions", "--json", timeout=5))


@contextmanager
def staged_put(fixture, target):
    conn = fixture.connection()
    try:
        conn.putrequest("PUT", target)
        conn.putheader("Authorization", fixture.authorization)
        conn.putheader("Content-Type", "application/octet-stream")
        conn.putheader("Content-Length", str(len(BODY)))
        conn.putheader("Expect", "100-continue")
        conn.endheaders()
        # Read the interim response without buffering the later final response.
        with conn.sock.makefile("rb", buffering=0) as interim:
            require(interim.readline(1024).split()[1:2] == [b"100"],
                    "WebDAV did not return 100 Continue")
            for _ in range(32):
                if interim.readline(4096) == b"\r\n":
                    break
            else:
                raise ProofError("Malformed interim HTTP response")
        conn.send(PREFIX)
        until(fixture.staged_prefix, "Could not verify the PUT prefix on the OpenCloud staging filesystem")
        yield conn
    finally:
        conn.close()


def prove(fixture, quiescent=False):
    status, drives = fixture.request("GET", "/graph/v1.0/me/drives")
    require(status == 200, "Fixture Graph drive lookup failed")
    root = dav_root(json.loads(drives))
    target = f"{root}/{TARGET}"
    control = f"{root}/{CONTROL}"
    control_put, _ = fixture.request("PUT", control, CONTROL_BODY)
    control_status, control_body = fixture.request("GET", control)
    require(control_put == 201 and control_status == 200 and control_body == CONTROL_BODY,
            f"Baseline DAV verification failed: PUT {control_put}, "
            f"GET {describe_lookup(control_status, control_body)}")
    require(fixture.request("GET", target)[0] == 404, "Fixture target already exists")
    if quiescent:
        until(lambda: session_count(fixture) == 0, "Baseline upload session did not clear")
    with staged_put(fixture, target) as conn:
        if quiescent:
            require(session_count(fixture) == 1, "CLI did not identify the admitted gated PUT")
        if not quiescent:
            fixture.signal()
            until(fixture.ingress_refused, "OpenCloud did not refuse fresh connections after SIGTERM")
        try:
            conn.send(BODY[len(PREFIX):])
            upload_status = conn.getresponse().status
        except (BrokenPipeError, ConnectionResetError, http.client.RemoteDisconnected, ssl.SSLEOFError):
            upload_status = None
    pre_stop_reads = None
    session_counts = []
    if quiescent:
        require(upload_status == 201, "Pre-stop fixture PUT was not acknowledged")
        status, body, pre_stop_reads = read_ready(fixture, target)
        require(status == 200 and body == BODY,
                f"PUT never finalized before shutdown: GET {describe_lookup(status, body)}; "
                f"HTTP history {pre_stop_reads['statuses']}")

        def no_sessions():
            count = session_count(fixture)
            session_counts.append(count)
            return len(session_counts) >= 2 and session_counts[-2:] == [0, 0]

        until(no_sessions, "OpenCloud upload sessions did not reach quiescence")
        fixture.signal()
        until(fixture.ingress_refused, "OpenCloud did not refuse fresh connections after SIGTERM")
    fixture.clean_exit()
    fixture.boot()
    control_status, control_body, control_reads = read_ready(fixture, control)
    require(control_status == 200 and control_body == CONTROL_BODY,
            f"Post-restart DAV control differs: GET {describe_lookup(control_status, control_body)}; "
            f"HTTP history {control_reads['statuses']}")
    lookup_status, lookup_body, target_reads = read_ready(fixture, target)
    try:
        outcome = classify(upload_status, lookup_status, lookup_body)
    except ProofError as error:
        raise ProofError(f"{error}: PUT {upload_status}, GET "
                         f"{describe_lookup(lookup_status, lookup_body)}; HTTP history {target_reads['statuses']}; "
                         f"expected {len(BODY)} bytes sha256={hashlib.sha256(BODY).hexdigest()}") from None
    if outcome == "aborted_without_visible_object":
        require(fixture.request("PUT", target, BODY)[0] == 201, "Post-restart retry did not create object")
        require(fixture.request("GET", target) == (200, BODY), "Post-restart retry bytes differ")
    return {"image": IMAGE, "provider": "posix", "fixture": "synthetic isolated WebDAV",
            "mode": "quiescent" if quiescent else "in_flight",
            "staged_prefix_bytes_observed": len(PREFIX), "status": outcome,
            "gated_put_session_observed": quiescent,
            "pre_stop_target_reads": pre_stop_reads, "pre_stop_upload_session_counts": session_counts,
            "upload_http_status": upload_status, "fresh_connection_refused": True,
            "lookup_http_status": lookup_status,
            "lookup_bytes": len(lookup_body) if lookup_status == 200 else None,
            "lookup_sha256": hashlib.sha256(lookup_body).hexdigest() if lookup_status == 200 else None,
            "post_restart_control_reads": control_reads,
            "post_restart_target_reads": target_reads,
            "exit_code": 0, "verified_bytes": len(BODY), "sha256": hashlib.sha256(BODY).hexdigest()}


def describe_lookup(status, body):
    if status != 200:
        return str(status)
    return f"{status}, {len(body)} bytes sha256={hashlib.sha256(body).hexdigest()}"


def read_ready(fixture, path):
    started = time.monotonic()
    deadline = started + 15
    statuses = []
    while True:
        status, body = fixture.request("GET", path)
        statuses.append(status)
        now = time.monotonic()
        if status not in (425, 502, 503) or now >= deadline:
            return status, body, {"statuses": statuses, "attempts": len(statuses),
                                  "elapsed_ms": round((now - started) * 1000)}
        time.sleep(0.2)


def prove_gateway(fixture):
    # This edge models Serve's TLS termination; the harness uses only a fixture
    # account and never claims to exercise Tailnet authentication.
    status, payload = fixture.request("GET", "/.well-known/openid-configuration")
    discovery = json.loads(payload)
    jwks = urlsplit(discovery["jwks_uri"])
    require(status == 200 and discovery["issuer"] == ORIGIN
            and jwks.scheme == "https" and jwks.netloc == f"{HOST}:{PORT}",
            "Fixture OIDC discovery changed the HTTPS origin")
    status, payload = fixture.request("GET", jwks.path)
    require(status == 200 and bool(json.loads(payload)["keys"]), "Fixture OIDC JWKS unavailable")
    status, payload = fixture.request("GET", "/graph/v1.0/me/drives")
    require(status == 200, "Fixture Graph drive lookup failed")
    root = dav_root(json.loads(payload))
    normal = f"{root}/gateway-complete.bin"
    slow = f"{root}/gateway-slow.bin"
    until(lambda: session_count(fixture) == 0, "Fixture started with unfinished uploads")

    def close_ingress():
        start = time.monotonic()
        command("docker", "kill", "--signal", "TERM", fixture.gateway)
        until(lambda: fixture.request("GET", "/status.php")[0] == 502,
              "Fixture TLS edge still reaches gateway after SIGTERM")
        return start

    def gateway_exit(start):
        fmt = "{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}"
        until(lambda: command("docker", "inspect", "--format", fmt, fixture.gateway) == "exited 0 false",
              "Fixture gateway did not exit cleanly", timeout=36)
        elapsed = round((time.monotonic() - start) * 1000)
        require(elapsed <= 36_000, "Fixture gateway exceeded its bounded grace")
        return elapsed

    sse = fixture.connection()
    sse.timeout = 35
    try:
        sse.request("GET", "/ocs/v2.php/apps/notifications/api/v1/notifications/sse",
                    headers={"Authorization": fixture.authorization, "Accept": "text/event-stream"})
        stream = sse.getresponse()
        require(stream.status == 200 and stream.getheader("Content-Type", "").startswith("text/event-stream"),
                f"Fixture SSE did not open (HTTP {stream.status})")
        with staged_put(fixture, normal) as conn:
            require(session_count(fixture) == 1, "Normal PUT was not admitted to OpenCloud")
            start = close_ingress()
            conn.send(BODY[len(PREFIX):])
            require(conn.getresponse().status == 201, "Admitted PUT did not complete during gateway grace")
        normal_ms = gateway_exit(start)
        require(normal_ms >= 28_000, "SSE did not hold the gateway to its bounded grace")
        until(lambda: session_count(fixture) == 0, "Completed PUT session did not clear")
    finally:
        sse.close()

    command("docker", "start", fixture.gateway)
    until(lambda: fixture.request("GET", "/status.php")[0] == 200, "Fixture gateway did not restart")
    # OpenCloud's download path can call back through its canonical HTTPS URL.
    # Read the acknowledged object after that route is reachable again.
    lookup_status, body, reads = read_ready(fixture, normal)
    require(lookup_status == 200 and body == BODY,
            f"Completed PUT readback failed: PUT 201, GET {describe_lookup(lookup_status, body)}; "
            f"HTTP history {reads['statuses']}; "
            f"expected {len(BODY)} bytes sha256={hashlib.sha256(BODY).hexdigest()}")
    with staged_put(fixture, slow) as conn:
        require(session_count(fixture) == 1, "Slow PUT was not admitted to OpenCloud")
        start = close_ingress()
        slow_ms = gateway_exit(start)
        require(slow_ms >= 28_000, "Slow PUT did not hold the gateway to its bounded grace")
        try:
            conn.send(BODY[len(PREFIX):])
            status = conn.getresponse().status
            require(status >= 500, f"Canceled slow PUT returned HTTP {status}")
        except (BrokenPipeError, ConnectionResetError, http.client.RemoteDisconnected, ssl.SSLEOFError):
            status = None
    pending = session_count(fixture)
    if pending:
        result = "blocked_by_pending_upload_sessions"
    else:
        command("docker", "start", fixture.gateway)
        until(lambda: fixture.request("GET", "/status.php")[0] == 200, "Fixture gateway did not restart")
        lookup_status, body, _ = read_ready(fixture, slow)
        require(lookup_status == 404 or (lookup_status == 200 and body == BODY),
                "Canceled PUT left an inconsistent visible object")
        result = "no_pending_upload_sessions"
    require(command("docker", "inspect", "--format", "{{.State.Running}}", fixture.container) == "true",
            "OpenCloud exited during ingress tests")
    return {"mode": "gateway", "opencloud_image": IMAGE, "gateway_image": CADDY,
            "gateway_config_sha256": hashlib.sha256(fixture.gateway_config.read_bytes()).hexdigest(),
            "fixture_oidc_discovery_and_jwks": True, "fresh_ingress_denied": True,
            "normal_put_bytes": len(BODY), "normal_put_sha256": hashlib.sha256(BODY).hexdigest(),
            "normal_put_reads": reads, "sse_gateway_exit_ms": normal_ms,
            "slow_put_gateway_exit_ms": slow_ms, "slow_put_status": status,
            "pending_upload_sessions": pending, "stop_decision": result,
            "opencloud_running_after_gateway_tests": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scratch", type=Path, required=True,
                        help="existing private Linux scratch parent on encrypted local storage")
    parser.add_argument("--quiescent", action="store_true",
                        help="wait for finalized WebDAV bytes and empty upload sessions before SIGTERM")
    parser.add_argument("--gateway-config", type=Path, metavar="CADDYFILE",
                        help="exercise Vault ingress with this reviewed loopback Caddy configuration")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        require(sys.platform == "linux" and os.geteuid() == 0, "Run as root on the Linux fixture host")
        scratch_parent(args.scratch)
        require(shutil.disk_usage(args.scratch).free >= 512 * 1024 ** 2,
                "Fixture scratch needs 512 MiB of free space")
        architecture = command("docker", "image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", IMAGE)
        require(architecture == "linux/amd64", "Pinned AMD64 OpenCloud image is unavailable")
        if args.gateway_config:
            require(not args.quiescent and args.gateway_config.is_file(), "Expected one reviewed gateway fixture mode")
            require(hashlib.sha256(args.gateway_config.read_bytes()).hexdigest() == CADDYFILE_SHA256,
                    "Vault Caddyfile differs from the reviewed loopback configuration")
            require(command("docker", "image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", CADDY)
                    == "linux/amd64", "Pinned AMD64 Caddy image is unavailable")
        with tempfile.TemporaryDirectory(prefix="keep254-vault-drain-", dir=args.scratch) as directory:
            fixture = Fixture(Path(directory).resolve(), args.gateway_config)
            try:
                fixture.start()
                result = prove_gateway(fixture) if args.gateway_config else prove(fixture, quiescent=args.quiescent)
            finally:
                fixture.close()
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ProofError, OSError, ValueError, subprocess.TimeoutExpired, http.client.HTTPException) as error:
        print(str(error) if isinstance(error, ProofError) else "Isolated Vault fixture could not complete",
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
