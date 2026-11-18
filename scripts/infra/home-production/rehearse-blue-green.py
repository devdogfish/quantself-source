#!/usr/bin/env python3
"""Exercise Caddy's app/API switch and rollback on loopback with synthetic upstreams."""

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from http.client import HTTPConnection, HTTPException
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import threading
import time


LOOPBACK = "127.0.0.1"
TIMEOUT = 10
HOME_CONFIG = Path(__file__).resolve().parents[3] / "Caddyfile.home"
ROUTES = {"/": "app", "/api/health": "api", "/llms.txt": "api", "/api/internal/test": None}
HEALTH = {"app": "/favicon.ico", "api": "/api/health"}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def request(port, path):
    connection = HTTPConnection(LOOPBACK, port, timeout=TIMEOUT)
    try:
        connection.request("GET", path, headers={"Connection": "close"})
        response = connection.getresponse()
        return response.status, response.read().decode().strip()
    finally:
        connection.close()


def start_upstream(stack, color, service):
    started, release = threading.Event(), threading.Event()
    identity = f"{color}/{service}"

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.endswith("?hold"):
                started.set()
                if not release.wait(TIMEOUT):
                    self.send_error(504)
                    return
            forwarded = self.headers.get("X-Forwarded-Proto")
            status = 200 if self.path == HEALTH[service] or forwarded == "https" else 400
            body = identity.encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer((LOOPBACK, 0), Handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
    thread.start()

    def stop():
        release.set()
        server.shutdown()
        thread.join()
        server.server_close()

    stack.callback(stop)
    return server.server_port, started, release


def wait_until(check, description, interval=0.01):
    deadline = time.monotonic() + TIMEOUT
    while time.monotonic() < deadline:
        try:
            if check():
                return
        except OSError:
            pass
        time.sleep(interval)
    raise RuntimeError(f"Timed out waiting for {description}")


def config(template, ports, listener, admin):
    replacements = {
        "admin off": f"admin {LOOPBACK}:{admin}\n\tpersist_config off",
        "\n:3000 {": f"\nhttp://:{listener} {{\n\tbind {LOOPBACK}",
        "reverse_proxy app:3000": f"reverse_proxy {LOOPBACK}:{ports['app'][0]}",
        "reverse_proxy api:3001": f"reverse_proxy {LOOPBACK}:{ports['api'][0]}",
    }
    for old, new in replacements.items():
        require(template.count(old) == 1, f"Unexpected Caddyfile.home: {old}")
        template = template.replace(old, new, 1)
    return template


def check_listeners(candidate, listener, admin):
    require(
        candidate.get("admin") == {"listen": f"{LOOPBACK}:{admin}", "config": {"persist": False}},
        "Caddy admin must use the fixture's loopback address",
    )
    apps = candidate["apps"]
    require(set(apps) == {"http"}, "Caddy fixture requires only the HTTP app")
    servers = list(apps["http"]["servers"].values())
    require(
        len(servers) == 1
        and servers[0].get("listen") == [f"{LOOPBACK}:{listener}"]
        and servers[0].get("automatic_https", {}).get("disable") is True,
        "Caddy ingress must use only the fixture's HTTP loopback address",
    )


def run(caddy, directory, log):
    env = os.environ | {"XDG_CONFIG_HOME": str(directory), "XDG_DATA_HOME": str(directory)}
    version = subprocess.check_output([caddy, "version"], text=True, timeout=TIMEOUT).strip()
    template = HOME_CONFIG.read_text()
    with socket.socket() as ingress, socket.socket() as control:
        ingress.bind((LOOPBACK, 0))
        control.bind((LOOPBACK, 0))
        listener = ingress.getsockname()[1]
        admin = control.getsockname()[1]

    def start_pair(stack, color):
        pair = {service: start_upstream(stack, color, service) for service in HEALTH}
        for service, (port, _, _) in pair.items():
            wait_until(
                lambda: request(port, HEALTH[service]) == (200, f"{color}/{service}"),
                f"{color}/{service} health",
                interval=1,
            )
        return pair

    def write_config(name, candidate):
        check_listeners(candidate, listener, admin)
        file = directory / f"{name}.json"
        file.write_text(json.dumps(candidate))
        return file

    def render_config(name, pair):
        adapted = subprocess.check_output(
            [caddy, "adapt", "--config", "-", "--adapter", "caddyfile"],
            input=config(template, pair, listener, admin),
            env=env, timeout=TIMEOUT, text=True,
        )
        return write_config(name, json.loads(adapted))

    def is_routed(path, color):
        service = ROUTES[path]
        expected = (200, f"{color}/{service}") if service else (404, "")
        return request(listener, path) == expected

    def reload(file):
        result = subprocess.run(
            [caddy, "reload", "--address", f"{LOOPBACK}:{admin}",
             "--config", str(file)],
            env=env, timeout=TIMEOUT, text=True, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        log.write(result.stdout)
        log.flush()
        return result

    attempts = Counter()
    failures = Counter()
    traffic_stop = threading.Event()

    def monitor():
        while not traffic_stop.is_set():
            for path, service in ROUTES.items():
                attempts[path] += 1
                try:
                    status, body = request(listener, path)
                    expected = {(200, f"{color}/{service}") for color in ("blue", "green")}
                    if (status, body) not in (expected if service else {(404, "")}):
                        failures[f"{path} → {status} {body}"] += 1
                except (OSError, ValueError, HTTPException) as error:
                    failures[f"{path} → {error!r}"] += 1
            traffic_stop.wait(0.005)

    switches = []
    with ExitStack() as blue, ExitStack() as green:
        outgoing = start_pair(blue, "blue")
        initial = render_config("blue", outgoing)
        caddy_process = subprocess.Popen(
            [caddy, "run", "--config", str(initial)],
            env=env, stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            wait_until(lambda: is_routed("/", "blue"), "Caddy readiness")
            require(all(is_routed(path, "blue") for path in ROUTES), "Initial route mismatch")
            traffic = threading.Thread(target=monitor)
            traffic.start()
            try:
                time.sleep(0.2)
                # JSON reaches the admin API unchanged, then fails module provisioning.
                invalid_handler = "quantself_invalid_fixture"
                candidate = json.loads(initial.read_text())
                server, = candidate["apps"]["http"]["servers"].values()
                server["routes"].insert(0, {"handle": [{"handler": invalid_handler}]})
                result = reload(write_config("rejected", candidate))
                require(result.returncode != 0 and f"http.handlers.{invalid_handler}" in result.stdout,
                        "Caddy did not reject the invalid handler as expected")
                require(all(is_routed(path, "blue") for path in ROUTES),
                        "Rejected reload disrupted blue routes")

                for color, next_stack, retire_stack in (
                    ("green", green, blue), ("blue", blue, green),
                ):
                    incoming = start_pair(next_stack, color)
                    updated = render_config(f"next-{color}", incoming)
                    previous = "blue" if color == "green" else "green"
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        pending = {
                            service: pool.submit(request, listener, path + "?hold")
                            for service, path in (("app", "/"), ("api", "/api/health"))
                        }
                        try:
                            for service, (_, started, _) in outgoing.items():
                                require(started.wait(TIMEOUT), f"Hold never reached {previous}/{service}")
                            start = time.monotonic()
                            require(reload(updated).returncode == 0,
                                    f"Reload to {color} failed")
                            require(all(is_routed(path, color) for path in ROUTES), f"{color} route mismatch")
                            require(not any(future.done() for future in pending.values()),
                                    "An in-flight request ended before the new routes were verified")
                            switch_ms = round((time.monotonic() - start) * 1000, 1)
                        finally:
                            for _, _, release in outgoing.values():
                                release.set()
                        for service, future in pending.items():
                            require(future.result() == (200, f"{previous}/{service}"),
                                    f"In-flight {previous}/{service} response failed")

                    retire_stack.close()
                    require(all(is_routed(path, color) for path in ROUTES),
                            f"{color} routing failed after stopping {previous}")
                    switches.append({"from": previous, "to": color, "switch_ms": switch_ms,
                                     "old_responses_drained": len(pending)})
                    outgoing = incoming
                    time.sleep(0.2)
            finally:
                traffic_stop.set()
                traffic.join()
        finally:
            caddy_process.terminate()
            try:
                caddy_process.wait(timeout=TIMEOUT)
            except subprocess.TimeoutExpired:
                caddy_process.kill()
                caddy_process.wait()
    print(json.dumps({"caddy": version, "invalid_reload_rejected": True,
                      "requests": dict(attempts), "failures": dict(failures),
                      "switches": switches}, indent=2))
    require(all(attempts[path] > 1 for path in ROUTES) and not failures,
            "Continuous traffic check failed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--caddy", default="caddy", help="path to Caddy (use the home Compose version)")
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    with tempfile.TemporaryDirectory(prefix="quantself-blue-green-") as scratch:
        directory = Path(scratch)
        log_file = directory / "caddy.log"
        with log_file.open("w") as log:
            try:
                run(args.caddy, directory, log)
            except KeyboardInterrupt:
                parser.exit(130, "Rehearsal interrupted.\n")
            except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                parser.exit(1, f"{error}\n{log_file.read_text()}\n")


if __name__ == "__main__":
    main()
