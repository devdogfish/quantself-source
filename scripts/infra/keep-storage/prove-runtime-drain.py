#!/usr/bin/env python3
"""Prove deferred runtime drain in the pinned Keep image using Docker fixtures."""

from concurrent.futures import ThreadPoolExecutor, TimeoutError as TaskTimeout
import argparse
import hashlib
import http.client
import json
import re
import secrets
import socket
import struct
import subprocess
import tempfile
from pathlib import Path
import sys
import time


CADDYFILE_SHA256 = "89fc01cd76f80dc1fcdc959bed4649c53a1a6df60c385656ec91e1b1fe9ba507"
HOME_CADDYFILE_SHA256 = "23587693238a432fa5288c6422eac7bc866c252dd5f29221c8dd3d8eb91bbe64"
CADDY = "caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b"
POSTGRES = "postgres:18-alpine@sha256:1018733457011bf88d81db98cf43aac6d5150afc18787dbe204771fedf80ff95"
IMAGE = "sha256:fef4d9af7bce109e8b5c6245422df8e01f42af9a117bef8a0f976fb2b48b5530"
UPSTREAM = """
let release;
const gate = new Promise(resolve => { release = resolve; });
let closeSse;
const sseDone = new Promise(resolve => { closeSse = resolve; });
let setupCalls = 0;
const proof = process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
let renderCalls = 0;
const render = {
  "/api/v1/inventory-capture-session": { session: null },
  "/api/v1/inventory-containers": { containers: [] },
  "/api/v1/inventory-locations": { locations: [] },
  "/api/v1/inventory-container-visuals": { editableVisuals: [], visualPresets: [] },
  "/api/v1/inventory-items": { items: [] }
};
Bun.serve({ hostname: "0.0.0.0", port: 3001, async fetch(req) {
  const { pathname } = new URL(req.url);
  if (pathname === "/release" && req.method === "POST") {
    console.log("fixture gate released");
    release();
    return new Response("released");
  }
  if (pathname === "/finish-stream" && req.method === "POST") {
    console.log("fixture API stream released");
    closeSse();
    return new Response("stream released");
  }
  if (pathname === "/api/v1/todos/live") {
    return new Response(new ReadableStream({ async start(stream) {
      const encode = new TextEncoder();
      stream.enqueue(encode.encode("data: initial\\n\\n"));
      await sseDone;
      stream.enqueue(encode.encode("data: drained\\n\\n"));
      stream.close();
    } }), { headers: { "Content-Type": "text/event-stream" } });
  }
  if (pathname === (proof ? "/api/v1/access-context" : "/api/owner-setup/state")) {
    if (proof && req.headers.get("X-Quantself-Owner-Proof") !== proof) {
      return new Response("proof missing", { status: 401 });
    }
    const call = ++setupCalls;
    console.log(`fixture Owner setup call ${call}`);
    if (call === 1) await gate;
    if (proof) return Response.json({
      owner: { id: "existing-fixture-owner" },
      client: { id: "quantself-web", kind: "web" }
    });
    return Response.json({ status: "closed" });
  }
  if (Object.hasOwn(render, pathname)) {
    console.log(`fixture inventory render call ${++renderCalls}`);
    return Response.json(render[pathname]);
  }
  if (pathname === "/api/health") return new Response("ready");
  return new Response("unexpected synthetic route", { status: 404 });
} });
"""
RELEASE = """
const response = await fetch("http://api:3001/release", { method: "POST" });
if (response.status !== 200 || await response.text() !== "released") process.exit(1);
"""
SETUP = """
const response = await fetch(`http://${process.env.DRAIN_ORIGIN || "app"}:3000/inventory`, {
  redirect: "error", signal: AbortSignal.timeout(120000),
  headers: process.env.QUANTSELF_OWNER_INGRESS_TOKEN
    ? { "X-Quantself-Owner-Proof": process.env.QUANTSELF_OWNER_INGRESS_TOKEN } : {},
});
const html = await response.text();
if (response.status !== 200 || !html.includes("No active session") || !html.trimEnd().endsWith("</html>")) {
  process.exit(1);
}
console.log("complete HTML");
"""
REFUSED = """
try {
  const socket = await Bun.connect({
    hostname: process.env.DRAIN_IP, port: 3000,
    socket: { data() {} }
  });
  socket.end();
  process.exit(1);
} catch (error) {
  if (error.code !== "ConnectionRefused" && error.code !== "ECONNREFUSED") {
    console.error(error.code);
    process.exit(1);
  }
}
"""


SSE_CLIENT = """
const response = await fetch("http://gateway:3000/api/v1/todos/live", {
  signal: AbortSignal.timeout(120000)
});
if (response.status !== 200 || !response.headers.get("content-type").includes("text/event-stream")) {
  process.exit(1);
}
const reader = response.body.getReader();
const decode = new TextDecoder();
let body = "";
while (true) {
  const chunk = await reader.read();
  if (chunk.done) break;
  body += decode.decode(chunk.value, { stream: true });
  if (body.includes("data: initial")) await Bun.write("/tmp/keep254-sse-initial", "initial");
}
body += decode.decode();
if (body !== "data: initial\\n\\ndata: drained\\n\\n") process.exit(1);
console.log("complete SSE");
"""
SSE_RELEASE = """
const response = await fetch("http://api:3001/finish-stream", { method: "POST" });
if (response.status !== 200 || await response.text() !== "stream released") process.exit(1);
"""


class ProofError(Exception):
    pass


def docker(*args, check=True, timeout=60):
    result = subprocess.run(
        ["docker", *args], capture_output=True, text=True, timeout=timeout, check=False
    )
    if check and result.returncode != 0:
        raise ProofError(f"Docker {args[0]} failed ({result.returncode})")
    return result


def require(condition, message):
    if not condition:
        raise ProofError(message)


def until(predicate, message, seconds=25):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.2)
    raise ProofError(message)


class Fixture:
    def __init__(self, image, home_auth=False):
        self.image = image
        self.proof_env = ("-e", "QUANTSELF_OWNER_INGRESS_TOKEN=" + secrets.token_hex(32)) if home_auth else ()
        self.auth_env = ("-e", "QUANTSELF_OWNER_AUTH=tailscale", *self.proof_env) if home_auth else ()
        self.origin = "https://qs.girke.dev" if home_auth else "http://localhost:3000"
        self.relying_party = "qs.girke.dev" if home_auth else "localhost"
        self.name = f"keep254-drain-{secrets.token_hex(4)}"
        self.upstream = self.name + "-api"
        self.web = self.name + "-web"
        self.client = self.name + "-client"
        self.gateway = self.name + "-gateway"
        self.containers = []
        self.network_created = False

    def start(self):
        docker("network", "create", "--internal", self.name)
        self.network_created = True
        self.start_container(self.upstream, "api", ["bun", "-e", UPSTREAM], self.proof_env)
        self.start_container(self.web, "app", ["bun", "run", "--cwd", "apps/web", "start"], [
            "--init", "--stop-timeout", "900", "--memory", "1024m",
            "-e", "DEBUG=next:start-server", "-e", "PORT=3000", "-e", "HOSTNAME=0.0.0.0",
            "-e", f"BETTER_AUTH_URL={self.origin}", "-e", f"BETTER_AUTH_RP_ID={self.relying_party}",
            *self.auth_env,
            "-e", "BETTER_AUTH_SECRET=keep254-synthetic-auth-secret-fixture-only",
            "-e", "DATABASE_URL=postgresql://fixture:fixture@127.0.0.1:1/fixture",
        ])
        self.start_container(self.client, "client", ["bun", "-e", "setInterval(() => {}, 1000)"], self.proof_env)
        until(
            lambda: self.client_call(
                'const r = await fetch("http://app:3000/api/health", '
                '{signal: AbortSignal.timeout(2000)}); '
                'if (r.status !== 200 || await r.text() !== "ready") process.exit(1);',
                check=False,
            ).returncode == 0,
            "Pinned Next image did not proxy its startup probe",
        )

    def start_container(self, name, alias, args, options=(), image=None, config=None):
        container = docker(
            "create", "--name", name, "--network", self.name, "--network-alias", alias,
            "--pull", "never", *options, image or self.image, *args
        ).stdout.strip()
        self.containers.append(container)
        if config is not None:
            docker("cp", config, f"{container}:/etc/caddy/Caddyfile")
        docker("start", container)

    def client_call(self, js, *, check=True, timeout=10, environment=()):
        return docker("exec", *environment, self.client, "bun", "-e", js, check=check, timeout=timeout)

    def logs(self, container):
        result = docker("logs", "--timestamps", container)
        return (result.stdout + result.stderr).splitlines()

    def timestamp(self, container, marker):
        matches = [line.split(maxsplit=1)[0] for line in self.logs(container) if marker in line]
        require(len(matches) == 1, f"Expected one synthetic marker: {marker}")
        return matches[0]

    def close(self):
        failures = []
        for container in reversed(self.containers):
            try:
                if docker("rm", "--force", "--volumes", container, check=False).returncode:
                    failures.append(container)
            except subprocess.TimeoutExpired:
                failures.append(container)
        if self.network_created:
            if docker("network", "rm", self.name, check=False).returncode:
                failures.append(self.name)
        require(not failures, f"Cleanup incomplete for fixture {self.name}")


def control(image, home_auth=False):
    fixture = Fixture(image, home_auth)
    try:
        fixture.start()
        fixture.client_call(RELEASE)
        fixture.client_call(SETUP, timeout=125)
        first = fixture.timestamp(fixture.upstream, "fixture Owner setup call 1")
        second = fixture.timestamp(fixture.upstream, "fixture inventory render call 1")
        require(first < second, "Ungated Next page did not make ordered middleware and render calls")
    finally:
        fixture.close()


def drain(image, gateway_config=None, *, home_auth=False):
    fixture = Fixture(image, home_auth)
    try:
        fixture.start()
        inspect = '{{(index .NetworkSettings.Networks "' + fixture.name + '").IPAddress}}'
        web_ip = docker("inspect", "--format", inspect, fixture.web).stdout.strip()
        require(bool(web_ip), "Fixture web container has no internal IP")
        if gateway_config:
            fixture.start_container(fixture.gateway, "gateway", [],
                                    ("--memory", "128m", "--stop-timeout", "1920"),
                                    image=CADDY, config=gateway_config)
            gateway_ip = docker("inspect", "--format", inspect, fixture.gateway).stdout.strip()
            require(bool(gateway_ip), "Fixture gateway container has no internal IP")
            until(
                lambda: fixture.client_call(
                    'const r = await fetch("http://gateway:3000/api/health", '
                    '{signal: AbortSignal.timeout(2000)}); '
                    'if (r.status !== 200 || await r.text() !== "ready") process.exit(1);',
                    check=False,
                ).returncode == 0,
                "Pinned Caddy image did not proxy its startup probe",
            )
        with ThreadPoolExecutor(max_workers=4 if gateway_config else 2) as tasks:
            request = tasks.submit(fixture.client_call, SETUP, timeout=125,
                                   environment=("-e", "DRAIN_ORIGIN=gateway") if gateway_config else ())
            sse = tasks.submit(fixture.client_call, SSE_CLIENT, timeout=125) if gateway_config else None
            stop = gateway_stop = None
            try:
                until(
                    lambda: any("fixture Owner setup call 1" in line
                                for line in fixture.logs(fixture.upstream)),
                    "Next did not reach the first synthetic upstream call",
                )
                if gateway_config:
                    until(
                        lambda: docker("exec", fixture.client, "test", "-f",
                                       "/tmp/keep254-sse-initial", check=False).returncode == 0,
                        "Caddy did not deliver the open SSE stream",
                    )
                    gateway_stop = tasks.submit(docker, "stop", "--time", "1920",
                                                fixture.gateway, timeout=1930)
                    until(
                        lambda: any("servers shutting down with eternal grace period" in line
                                    for line in fixture.logs(fixture.gateway)),
                        "Caddy did not enter graceful ingress shutdown",
                    )
                    until(
                        lambda: fixture.client_call(REFUSED, check=False,
                            environment=("-e", f"DRAIN_IP={gateway_ip}")).returncode == 0,
                        "Caddy did not refuse fresh ingress",
                    )
                    require(not gateway_stop.done() and not sse.done() and not request.done(),
                            "Caddy dropped an admitted request during ingress closure")
                stop = tasks.submit(docker, "stop", "--time", "900", fixture.web, timeout=910)
                until(
                    lambda: any("start-server process cleanup" in line and "finished" not in line
                                for line in fixture.logs(fixture.web)),
                    "Next did not enter graceful SIGTERM cleanup",
                )
                require(not request.done() and not stop.done(), "Deferred request or stop ended early")
                fixture.client_call(REFUSED, environment=("-e", f"DRAIN_IP={web_ip}"))
                require(not request.done() and not stop.done(), "Deferred request or stop ended before gate")
                fixture.client_call(RELEASE)
                require(request.result().stdout.strip() == "complete HTML", "Response body incomplete")
                stop.result(timeout=30)
                if gateway_config:
                    require(not sse.done() and not gateway_stop.done(),
                            "Caddy stopped while the synthetic API stream remained open")
                    fixture.client_call(SSE_RELEASE)
                    require(sse.result().stdout.strip() == "complete SSE", "SSE body incomplete")
                    gateway_stop.result(timeout=30)
                    fmt = "{{.State.ExitCode}} {{.State.OOMKilled}} {{json .State.Error}}"
                    require(docker("inspect", "--format", fmt, fixture.gateway).stdout.strip() == '0 false ""',
                            "Caddy did not exit cleanly")
            except (ProofError, TaskTimeout, subprocess.TimeoutExpired):
                # Only disposable fixtures can be forcibly stopped on failure.
                for container in (fixture.web, fixture.upstream, fixture.gateway):
                    if container != fixture.gateway or gateway_config:
                        docker("kill", container, check=False)
                raise
        first = fixture.timestamp(fixture.upstream, "fixture Owner setup call 1")
        begin_lines = [line for line in fixture.logs(fixture.web)
                       if "start-server process cleanup" in line and "finished" not in line]
        require(len(begin_lines) == 1, "Expected one graceful cleanup start marker")
        began = begin_lines[0].split(maxsplit=1)[0]
        released = fixture.timestamp(fixture.upstream, "fixture gate released")
        second = fixture.timestamp(fixture.upstream, "fixture inventory render call 1")
        finished = fixture.timestamp(fixture.web, "start-server process cleanup finished")
        require(first < began < released < second < finished, "Synthetic signal chronology differs")
        fmt = "{{.State.ExitCode}} {{.State.OOMKilled}} {{json .State.Error}}"
        exit_state = docker("inspect", "--format", fmt, fixture.web).stdout.strip()
        require(exit_state == '143 false ""', "Next did not exit 143 cleanly")
        timeline = {"first_upstream": first, "cleanup_start": began, "released": released,
                    "second_upstream": second, "cleanup_complete": finished}
        if gateway_config:
            ingress = fixture.timestamp(fixture.gateway, "servers shutting down with eternal grace period")
            sse_closed = fixture.timestamp(fixture.upstream, "fixture API stream released")
            require(first < ingress < began < finished < sse_closed,
                    "Gateway, Next and synthetic API shutdown chronology differs")
            timeline.update(ingress_closed=ingress, api_stream_released=sse_closed)
        return timeline
    finally:
        fixture.close()


API_MEMORY_MIB = 512
API_POSTGRES_MEMORY_MIB = 256
API_CLIENT_MEMORY_MIB = 384


def require_api_memory():
    try:
        field = next(line for line in Path("/proc/meminfo").read_text().splitlines()
                     if line.startswith("MemAvailable:"))
        _, available, unit = field.split()
        require(unit == "kB", "Unexpected MemAvailable unit")
        peak_mib = API_MEMORY_MIB + API_POSTGRES_MEMORY_MIB + API_CLIENT_MEMORY_MIB
        required_bytes = (peak_mib + 1024) * 1024 ** 2
        require(int(available) * 1024 >= required_bytes,
                f"API fixture requires {required_bytes:,} available bytes "
                f"for its {peak_mib} MiB peak and 1 GiB of guest headroom")
    except (OSError, StopIteration, ValueError):
        raise ProofError("Could not verify available Linux guest memory") from None


API_SSE_CLIENT = r"""
import { createConnection } from "node:net";
import { writeFile, access } from "node:fs/promises";
const key = await Bun.file("/tmp/keep254-fixture-key").text();
const open = () => new Promise((resolve, reject) => {
  const socket = createConnection({ host: "api", port: 3001 }, () => {
    socket.write("GET /api/v1/todos/live HTTP/1.1\r\nHost: api:3001\r\n" +
      "X-API-Key: " + key + "\r\nAccept: text/event-stream\r\n\r\n");
  });
  let initial = "";
  let admitted = false;
  let status = "none";
  const fail = reason => {
    if (admitted) return;
    console.log(`SSE diagnostic ${reason} status=${status}`);
    socket.destroy();
    reject(Error("SSE snapshot unavailable"));
  };
  socket.once("error", () => fail("socket-error"));
  socket.once("end", () => fail("early-eof"));
  const receive = chunk => {
    initial += chunk.toString();
    status = /^HTTP\/1\.1 (\d{3})\b/.exec(initial)?.[1] ?? "none";
    if (initial.length > 65536) return fail("frame-limit");
    if (status !== "none" && status !== "200") return fail("headers");
    if (initial.includes("event: access-denied")) return fail("access-denied");
    if (!initial.includes("event: snapshot") || !initial.includes("\n\n")) return;
    if (!initial.startsWith("HTTP/1.1 200") ||
        !initial.toLowerCase().includes("content-type: text/event-stream")) {
      return fail("headers");
    }
    admitted = true;
    socket.pause();
    socket.off("data", receive);
    resolve(socket);
  };
  socket.on("data", receive);
});
const deadline = setTimeout(() => process.exit(1), 60000);
const abandoned = await open();
abandoned.resetAndDestroy();
const active = await open();
const ended = new Promise((resolve, reject) => {
  active.once("end", resolve);
  active.once("error", reject);
});
void ended.catch(() => {});
await writeFile("/tmp/keep254-sse-ready", "ready");
while (true) {
  try { await access("/tmp/keep254-sse-read"); break; }
  catch { await Bun.sleep(50); }
}
active.resume();
await ended;
clearTimeout(deadline);
console.log("SSE ended");
"""


API_MEDIA_UPSTREAM = """
const wav = new Uint8Array(44 + 160000);
const view = new DataView(wav.buffer);
const text = (at, value) => wav.set(new TextEncoder().encode(value), at);
text(0, "RIFF"); view.setUint32(4, wav.length - 8, true); text(8, "WAVE");
text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
view.setUint16(32, 2, true); view.setUint16(34, 16, true);
text(36, "data"); view.setUint32(40, wav.length - 44, true);
let release;
const gate = new Promise(resolve => { release = resolve; });
Bun.serve({
  hostname: "0.0.0.0", port: 9443,
  tls: {cert: Bun.file("/run/fixture/cert.pem"), key: Bun.file("/run/fixture/key.pem")},
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/fixture-release" && req.method === "POST") {
      release();
      return new Response("released");
    }
    if (path !== "/dav/spaces/fixture-space!fixture-audio" &&
        path !== "/dav/spaces/fixture-space%21fixture-audio") return new Response(null, {status: 404});
    if (req.headers.get("range") !== "bytes=0-65535" ||
        req.headers.get("if-match") !== '"fixture-audio"' ||
        req.headers.get("authorization") !== "Basic Zml4dHVyZTpmaXh0dXJl") {
      return new Response(null, {status: 412});
    }
    return new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(wav.subarray(0, 4096));
        await gate;
        try { controller.enqueue(wav.subarray(4096, 65536)); controller.close(); }
        catch { /* Response already canceled by the API. */ }
      },
    }), {status: 206, headers: {"Content-Range": "bytes 0-65535/160044", "Content-Length": "65536"}});
  },
});
await Bun.write("/tmp/keep254-media-upstream-ready", "ready");
"""

def reset_media_client(fixture, api):
    # Bun's node:http facade can expose a synthetic response socket. Use the
    # host's HTTP decoder and underlying TCP socket on the fixture-only bridge.
    network = '{{(index .NetworkSettings.Networks "' + fixture.name + '").IPAddress}}'
    address = docker("inspect", "--format", network, api).stdout.strip()
    require(re.fullmatch(r"[0-9]+(?:\.[0-9]+){3}", address), "Synthetic API address unavailable")
    key = docker("exec", fixture.client, "cat", "/tmp/keep254-fixture-key").stdout.strip()
    connection = http.client.HTTPConnection(address, 3001, timeout=15)
    status, chunked, body_size, riff = "none", 0, 0, False
    range_valid = False
    try:
        connection.request(
            "GET", "/api/v1/todo-captures/49bce178-f69e-4720-9d08-dcf11ec588a9/audio",
            headers={"X-API-Key": key, "Range": "bytes=0-65535"},
        )
        with connection.getresponse() as response:
            status = response.status
            chunked = int(response.chunked)
            range_valid = response.getheader("Content-Range") == "bytes 0-65535/160044"
            if status != 206 or not range_valid:
                raise ValueError()
            body = response.read(4096)
            body_size = len(body)
            riff = body.startswith(b"RIFF")
            if body_size != 4096 or not riff or connection.sock is None or response.isclosed():
                raise ValueError()
            connection.sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            # Close both descriptor references without consuming the rest of the body.
            connection.close()
    except (OSError, ValueError, http.client.HTTPException):
        raise ProofError(
            f"Actual API WAV reset failed: status={status} range_match={int(range_valid)} "
            f"body_prefix={body_size} chunked={chunked} riff={int(riff)}"
        ) from None
    finally:
        connection.close()



def api_drain(image, with_sse=False, with_media=False, with_visitor_retention=False):
    require_api_memory()
    fixture = Fixture(image)
    docker("image", "inspect", "--format", "{{.Id}}", POSTGRES)
    database = fixture.name + "-pg"
    api = fixture.name + "-app"
    migrate = fixture.name + "-migrate"
    # These values are fixtures local to the isolated network.
    app_env = (
        "-e", "DATABASE_URL=postgresql://fixture:fixture@postgres:5432/fixture",
        "-e", "BETTER_AUTH_URL=http://localhost:3001",
        "-e", "BETTER_AUTH_SECRET=keep254-synthetic-auth-secret-fixture-only",
        "-e", "QUANTSELF_PHONE_ENABLED=0",
        "-e", "QUANTSELF_ORIGINALS_PROVIDER=opencloud",
        "-e", "QUANTSELF_OPENCLOUD_URL=https://vault-fixture.invalid",
        "-e", "QUANTSELF_OPENCLOUD_SPACE_ID=fixture-space",
        "-e", "QUANTSELF_OPENCLOUD_USERNAME=fixture",
        "-e", "QUANTSELF_OPENCLOUD_TOKEN=fixture",
    )
    sql = ("docker", "exec", "-i", database, "psql", "-XAt", "-v", "ON_ERROR_STOP=1", "-U", "fixture")
    gate = None
    visitor_gate = None
    visitor_event = "da766f12-0b82-4f87-9860-06dbd2d62e34"

    def visitor_cleanup_waiting():
        return docker(*sql[1:], "-c",
                      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' "
                      "AND query LIKE '%UPDATE website_event%' AND query LIKE '%SET visitor_id = NULL%')"
                      ).stdout.strip() == "t"

    media_directory = None
    try:
        api_mounts = client_mounts = ()
        if with_media:
            media_directory = tempfile.TemporaryDirectory(prefix="keep254-media-cert-")
            directory = Path(media_directory.name)
            certificate = directory / "cert.pem"
            key = directory / "key.pem"
            generated = subprocess.run(
                ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                 "-subj", "/CN=client", "-addext", "subjectAltName=DNS:client",
                 "-keyout", str(key), "-out", str(certificate)],
                check=False, capture_output=True, timeout=15,
            )
            require(generated.returncode == 0, "Could not create the synthetic media TLS certificate")
            app_env += ("-e", "QUANTSELF_OPENCLOUD_URL=https://client:9443",
                        "-e", "NODE_EXTRA_CA_CERTS=/run/fixture/cert.pem")
            api_mounts = ("--mount", f"type=bind,src={certificate},dst=/run/fixture/cert.pem,readonly")
            client_mounts = ("--mount", f"type=bind,src={directory},dst=/run/fixture,readonly")
        docker("network", "create", "--internal", fixture.name)
        fixture.network_created = True
        fixture.start_container(database, "postgres", [], (
            "-e", "POSTGRES_USER=fixture", "-e", "POSTGRES_PASSWORD=fixture",
            "--memory", f"{API_POSTGRES_MEMORY_MIB}m", "--memory-swap", f"{API_POSTGRES_MEMORY_MIB}m",
            "--tmpfs", "/var/lib/postgresql:rw,mode=1777,size=128m",
        ), image=POSTGRES)
        until(
            lambda: docker("exec", database, "pg_isready", "-h", "127.0.0.1", "-U",
                           "fixture", check=False).returncode == 0,
            "Synthetic PostgreSQL did not start",
        )
        fixture.start_container(migrate, "migrate",
                                ["bun", "run", "--cwd", "packages/db", "migrate:deploy-only"],
                                ("--memory", "512m", "--memory-swap", "512m", *app_env))
        require(docker("wait", migrate, timeout=120).stdout.strip() == "0",
                "Synthetic Prisma migration failed")
        client_script = API_MEDIA_UPSTREAM if with_media else "setInterval(() => {}, 1000)"
        fixture.start_container(fixture.client, "client", ["bun", "-e", client_script],
                                ("--memory", f"{API_CLIENT_MEMORY_MIB}m",
                                 "--memory-swap", f"{API_CLIENT_MEMORY_MIB}m", *client_mounts, *app_env))
        seed = fixture.client_call("""
let stage = "seed imports";
try {
const { prisma } = await import("/app/packages/db/index.ts");
const { createApiKey } = await import("/app/packages/auth/src/api-keys.ts");
stage = "seed owner";
await prisma.user.create({data: {id: "owner", name: "Fixture", email: "owner@example.test"}});
await prisma.authOwner.create({data: {id: "singleton", userId: "owner"}});
stage = "seed API key";
const key = await createApiKey({name: "Fixture", preset: "custom",
  permissionIds: ["todos:read", "todos:write"], userId: "owner",
  expiresAt: new Date(Date.now() + 600000)});
await Bun.write("/tmp/keep254-fixture-key", key.secret);
if (process.env.KEEP254_SSE_FIXTURE === "1") {
  stage = "seed task cache";
  const scope = "singleton:single-owner:undefined:undefined:v1";
  const metadata = {complete: true, readAt: new Date().toISOString(), dirty: {},
    epoch: 1, revoked: false, error: null, retryAt: 0};
  await prisma.todoCacheState.upsert({where: {scope}, create: {scope, metadata, revision: 1}, update: {metadata, revision: {increment: 1}}});
}
if (process.env.KEEP254_MEDIA_FIXTURE === "1") {
  stage = "seed WAV metadata";
  const id = "49bce178-f69e-4720-9d08-dcf11ec588a9";
  const key = "todo:" + id;
  const mime = "audio/wav";
  const sha256 = "0".repeat(64);
  await prisma.originalFile.create({data: {key, spaceId: "fixture-space",
    fileId: "fixture-space!fixture-audio", pathHint: "Recordings/fixture.wav",
    mime, bytes: 160044, sha256, etag: '"fixture-audio"', state: "ready"}});
  for (const [idempotencyKey, input] of [
    ["capture:" + id, {id, source: "synthetic", capturedAt: new Date().toISOString(), transcript: "Synthetic WAV"}],
    ["audio:" + id, {key: "original:" + key, size: 160044, duration: 10, mime, sha256}],
  ]) {
    await prisma.apiIdempotencyKey.create({data: {clientId: "todos", operation: "capture-archive",
      idempotencyKey, requestFingerprint: "synthetic", responseBody: {input, result: null}}});
  }
}
await prisma.$disconnect();
} catch (error) {
  console.log(stage);
  const knownCodes = ["P2002", "P2004", "P2021", "P2022", "ERR_MODULE_NOT_FOUND"];
  if (knownCodes.includes(error?.code)) console.log(error.code);
  process.exit(1);
}
""", check=False, environment=(
            "-e", f"KEEP254_SSE_FIXTURE={int(with_sse)}", "-e", f"KEEP254_MEDIA_FIXTURE={int(with_media)}",
        ))
        seed_diagnostics = {"seed imports", "seed owner", "seed API key", "seed task cache",
                            "seed WAV metadata",
                            "P2002", "P2004", "P2021", "P2022", "ERR_MODULE_NOT_FOUND"}
        require(seed.returncode == 0, f"Synthetic API credential setup failed ({seed.returncode}) "
                + " ".join(line for line in seed.stdout.splitlines() if line in seed_diagnostics))
        if with_visitor_retention:
            docker(*sql[1:], "-c",
                   "INSERT INTO website_event (id, occurred_at, kind, visitor_id, path, props) VALUES "
                   f"('{visitor_event}', now() - INTERVAL '14 months', 'page:view', "
                   "'be7384c4-8855-4f7c-825f-cfea0447e553', '/fixture', '{}')")
            visitor_gate = subprocess.Popen(sql, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL, text=True)
            visitor_gate.stdin.write("SET application_name = 'keep254-visitor-lock';\n"
                                     f"BEGIN; SELECT id FROM website_event WHERE id = '{visitor_event}' FOR UPDATE;\n")
            visitor_gate.stdin.flush()
            until(lambda: docker(*sql[1:], "-c",
                                 "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE "
                                 "application_name = 'keep254-visitor-lock' AND state = 'idle in transaction' "
                                 "AND query LIKE '%FOR UPDATE%')").stdout.strip() == "t",
                  "Synthetic expired visitor row was not locked")
        fixture.start_container(api, "api", ["bun", "run", "--cwd", "apps/api", "start:production"],
                                ("--init", "--stop-timeout", "900", "--memory", f"{API_MEMORY_MIB}m",
                                 "--memory-swap", f"{API_MEMORY_MIB}m", *api_mounts, *app_env))
        until(
            lambda: fixture.client_call(
                'const r = await fetch("http://api:3001/api/health", '
                '{signal: AbortSignal.timeout(2000)}); if (!r.ok) process.exit(1);',
                check=False,
            ).returncode == 0,
            "Pinned API did not start against synthetic PostgreSQL",
        )
        if with_visitor_retention:
            until(visitor_cleanup_waiting, "Native visitor cleanup did not start")
        access = fixture.client_call("""
const key = await Bun.file("/tmp/keep254-fixture-key").text();
const r = await fetch("http://api:3001/api/v1/access-context", {
  headers: {"x-api-key": key}, signal: AbortSignal.timeout(5000)
});
console.log(r.status);
""", check=False)
        access_status = access.stdout.strip()
        require(access.returncode == 0 and access_status == "200",
                f"Synthetic API access check failed (exit {access.returncode}, "
                f"HTTP {access_status if access_status.isdigit() else 'unavailable'})")
        if with_media:
            until(lambda: docker("exec", fixture.client, "test", "-f",
                                 "/tmp/keep254-media-upstream-ready", check=False).returncode == 0,
                  "Synthetic TLS media upstream did not start")
            reset_media_client(fixture, api)
        with ThreadPoolExecutor(max_workers=3 if with_sse else 2) as tasks:
            sse = tasks.submit(fixture.client_call, API_SSE_CLIENT, check=False, timeout=65) if with_sse else None
            stop = None
            try:
                if sse is not None:
                    until(lambda: sse.done() or docker("exec", fixture.client, "test", "-f",
                                                        "/tmp/keep254-sse-ready", check=False).returncode == 0,
                          "Synthetic API SSE clients did not reach the snapshot")
                    if sse.done():
                        early = sse.result()
                        diagnostic = next((line for line in early.stdout.splitlines() if re.fullmatch(
                            r"SSE diagnostic (?:socket-error|early-eof|frame-limit|headers|access-denied) "
                            r"status=(?:[0-9]{3}|none)", line)), "No sanitized SSE diagnostic")
                        raise ProofError(f"Synthetic API SSE client ended before shutdown: {diagnostic}")
                gate = subprocess.Popen(sql, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                        stderr=subprocess.DEVNULL, text=True)
                gate.stdin.write("BEGIN; LOCK TABLE api_idempotency_key IN ACCESS EXCLUSIVE MODE; SELECT 'locked';\n")
                gate.stdin.flush()
                until(
                    lambda: docker(*sql[1:], "-c", "SELECT count(*) FROM pg_locks WHERE "
                                   "relation = 'api_idempotency_key'::regclass AND granted AND mode = 'AccessExclusiveLock'")
                    .stdout.strip() == "1",
                    "Synthetic write gate did not lock",
                )
                request = tasks.submit(fixture.client_call, """
const id = "820bbbd1-4996-4fe5-bbf8-0b83b821ca7c";
const key = await Bun.file("/tmp/keep254-fixture-key").text();
const r = await fetch("http://api:3001/api/v1/todo-captures", {
  method: "POST", headers: {"x-api-key": key, "content-type": "application/json"},
  body: JSON.stringify({id, source: "isolated-drain-fixture",
    capturedAt: new Date().toISOString(), transcript: "Synthetic drain fixture"}),
  signal: AbortSignal.timeout(120000)
});
console.log(r.status);
if (r.status !== 200 || (await r.json()).capture?.id !== id) process.exit(1);
""", check=False, timeout=125)
                until(
                    lambda: request.done() or docker(*sql[1:], "-c", "SELECT count(*) FROM pg_locks WHERE "
                                   "relation = 'api_idempotency_key'::regclass AND NOT granted")
                    .stdout.strip() == "1",
                    "API did not admit the synthetic capture before SIGTERM",
                )
                if request.done():
                    early = request.result()
                    status = early.stdout.strip()
                    raise ProofError(f"Synthetic capture ended before the lock gate (exit {early.returncode}, "
                                     f"HTTP {status if status.isdigit() else 'unavailable'})")
                stop = tasks.submit(docker, "stop", "--time", "900", api, timeout=50)
                until(
                    lambda: fixture.client_call("""
try {
  const r = await fetch("http://api:3001/api/health", {signal: AbortSignal.timeout(2000)});
  if (r.status !== 503) process.exit(1);
} catch (e) {
  if (e.code !== "ECONNREFUSED" && e.code !== "ConnectionRefused") process.exit(1);
}
""", check=False).returncode == 0,
                    "API did not reject fresh requests during drain",
                )
                require(not request.done() and not stop.done(), "API exited before admitted write settled")
                if with_media:
                    fixture.client_call("""
const r = await fetch("https://client:9443/fixture-release", {method: "POST"});
if (r.status !== 200 || await r.text() !== "released") process.exit(1);
""", timeout=10)
                if sse is not None:
                    docker("exec", fixture.client, "touch", "/tmp/keep254-sse-read")
                gate.stdin.write("COMMIT;\n\\q\n")
                gate.stdin.flush()
                require(gate.wait(timeout=10) == 0, "Synthetic PostgreSQL gate did not release")
                response = request.result()
                status = response.stdout.strip()
                require(response.returncode == 0 and status == "200",
                        f"Deferred synthetic capture failed (exit {response.returncode}, "
                        f"HTTP {status if status.isdigit() else 'unavailable'})")
                if sse is not None:
                    stream = sse.result(timeout=5)
                    require(stream.returncode == 0 and stream.stdout.strip() == "SSE ended",
                            "Active synthetic API SSE client did not receive EOF")
                if visitor_gate is not None:
                    require(visitor_cleanup_waiting(), "Visitor cleanup did not remain admitted during shutdown")
                    try:
                        stop.result(timeout=1)
                    except TaskTimeout:
                        pass
                    else:
                        raise ProofError("API exited before visitor cleanup could finish")
                    visitor_gate.stdin.write("COMMIT;\n\\q\n")
                    visitor_gate.stdin.flush()
                    require(visitor_gate.wait(timeout=10) == 0, "Synthetic visitor lock did not release")
                stop.result(timeout=30)
            except BaseException:
                # Kill only this fixture API before executor shutdown, so a
                # failed assertion cannot join the full Docker stop timeout.
                if stop is not None and not stop.done():
                    try:
                        docker("kill", api, check=False, timeout=5)
                    except (OSError, subprocess.TimeoutExpired):
                        pass  # The stop observer is independently bounded.
                if gate is not None and gate.poll() is None:
                    gate.stdin.close()
                if sse is not None and not sse.done():
                    docker("exec", fixture.client, "touch", "/tmp/keep254-sse-read",
                           check=False, timeout=5)
                raise
        fixture.timestamp(api, "API drain complete")
        fmt = "{{.State.ExitCode}} {{.State.OOMKilled}} {{json .State.Error}}"
        require(docker("inspect", "--format", fmt, api).stdout.strip() == '0 false ""',
                "API did not exit 0 cleanly")
        persisted = docker(*sql[1:], "-c", "SELECT count(*) FROM api_idempotency_key WHERE "
                           "\"idempotencyKey\" = 'capture:820bbbd1-4996-4fe5-bbf8-0b83b821ca7c'")
        require(persisted.stdout.strip() == "1", "Admitted capture did not persist")
        if with_visitor_retention:
            cleared = docker(*sql[1:], "-c",
                             f"SELECT visitor_id IS NULL FROM website_event WHERE id = '{visitor_event}'")
            require(cleared.stdout.strip() == "t", "The admitted visitor cleanup did not persist")
        return {"image": image, "exit_code": 0, "marker": "API drain complete", "capture_persisted": True,
                "sse_active_and_abandoned": with_sse, "partial_wav_range_client_reset": with_media,
                "visitor_retention_drained": with_visitor_retention}
    except (ProofError, TaskTimeout, subprocess.TimeoutExpired, OSError):
        fmt = "{{.Name}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} memory={{.HostConfig.Memory}}"
        for container in fixture.containers:
            try:
                details = docker("inspect", "--format", fmt, container, check=False, timeout=5)
                if details.returncode == 0:
                    print(details.stdout.strip(), file=sys.stderr)
                memory_events = docker("exec", container, "cat", "/sys/fs/cgroup/memory.events",
                                       check=False, timeout=5)
                if memory_events.returncode == 0:
                    print(memory_events.stdout.strip(), file=sys.stderr)
            except (OSError, subprocess.TimeoutExpired):
                pass
        raise
    finally:
        if gate is not None and gate.poll() is None:
            gate.kill()
            gate.wait(timeout=10)
        if visitor_gate is not None and visitor_gate.poll() is None:
            visitor_gate.kill()
            visitor_gate.wait(timeout=10)
        try:
            fixture.close()
        finally:
            if media_directory is not None:
                media_directory.cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default=IMAGE, metavar="SHA256:IMAGE_ID",
                        help="verified local AMD64 application image ID (defaults to the baseline)")
    parser.add_argument("--api", action="store_true", help="also run the isolated PostgreSQL/API write fixture")
    parser.add_argument("--api-sse", action="store_true", help="include active and abandoned real API SSE streams")
    parser.add_argument("--api-media", action="store_true", help="include a reset real API WAV range response")
    parser.add_argument("--api-visitor-retention", action="store_true",
                        help="hold native visitor cleanup in PostgreSQL until the API is draining")
    parser.add_argument("--gateway-config", type=Path, metavar="CADDYFILE",
                        help="also prove pinned Caddy drain using the reviewed Keep Caddyfile")
    parser.add_argument("--home-auth", action="store_true",
                        help="exercise the trusted Owner proof path and select the home gateway pin")
    args = parser.parse_args()
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", args.image):
        parser.error("--image must be a full lowercase sha256 image ID")
    if args.api_sse or args.api_media or args.api_visitor_retention:
        args.api = True
    try:
        # A Linux abstract Unix socket provides a host-local lock without a
        # persistent file. Docker commands run against the local guest daemon.
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as lock:
            try:
                lock.bind("\0keep254-runtime-drain")
            except OSError:
                raise ProofError("Could not acquire the exclusive fixture lock") from None
            return run_proofs(args)
    except (ProofError, TaskTimeout, subprocess.TimeoutExpired, OSError) as error:
        print(str(error) if isinstance(error, ProofError) else "Docker fixture could not complete",
              file=sys.stderr)
        return 1


def run_proofs(args):
    if args.api:
        require_api_memory()
    image = docker("image", "inspect", "--format", "{{.Id}} {{.Os}}/{{.Architecture}}", args.image)
    require(image.stdout.strip() == f"{args.image} linux/amd64", "Selected AMD64 image is unavailable")
    control(args.image, args.home_auth)
    timeline = drain(args.image, home_auth=args.home_auth)
    result = {
        "proof": {"format": 1, "image": args.image, "contract": "next-sigterm-deferred-request-v1"},
        "next": {"exit_code": 143, "oom_killed": False, "fresh_connection_refused": True,
                 "body": "complete HTML", "timeline": timeline},
        "scope": "Pinned image with synthetic upstream and optional synthetic DB. Deployed storage is untested.",
    }
    if args.gateway_config:
        require(args.gateway_config.is_file(), "Keep Caddyfile is unavailable")
        config_digest = HOME_CADDYFILE_SHA256 if args.home_auth else CADDYFILE_SHA256
        require(hashlib.sha256(args.gateway_config.read_bytes()).hexdigest() == config_digest,
                "Keep Caddyfile differs from the pinned deployment")
        gateway_image = docker("image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", CADDY)
        require(gateway_image.stdout.strip() == "linux/amd64", "Pinned AMD64 Caddy image is unavailable")
        result["gateway"] = {
            "image": CADDY, "config_sha256": config_digest,
            "exit_code": 0, "deferred_html_and_sse_complete": True,
            "timeline": drain(args.image, args.gateway_config, home_auth=args.home_auth),
        }
    if args.api:
        result["api"] = api_drain(args.image, with_sse=args.api_sse, with_media=args.api_media,
                                  with_visitor_retention=args.api_visitor_retention)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
