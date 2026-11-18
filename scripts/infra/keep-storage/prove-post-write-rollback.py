#!/usr/bin/env python3
"""Exercise one native post-write rollback using a verified release on isolated Linux."""

import argparse
import base64
from contextlib import ExitStack
from datetime import datetime, timezone
import hashlib
import http.client
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import re
import secrets
import struct
import subprocess
import tempfile
import time
from urllib.parse import quote, unquote, urlsplit
from uuid import uuid4
import wave

from backup_inventory import verify_inventory, write_inventory


spec = importlib.util.spec_from_file_location("vault_fixture", Path(__file__).with_name("prove-vault-drain.py"))
vault_fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vault_fixture)
docker = lambda *args, **kwargs: vault_fixture.command("docker", *args, **kwargs)
require = vault_fixture.require
until = vault_fixture.until
PG = "postgres:18-alpine@sha256:1018733457011bf88d81db98cf43aac6d5150afc18787dbe204771fedf80ff95"
PASSKEY_ORIGIN = "http://localhost:4310"
HOSTINGER_ORIGIN = "https://dashboard.girke.dev"
HOME_ORIGIN = "https://qs.girke.dev"
DB = "post_write_fixture"
ANALYTICS = "/api/v1/website-analytics"
RECEIPTS = "/api/v1/budgeting/receipts"
CAPTURES = "/api/v1/todo-captures"
INVENTORY = "/api/v1/inventory-items"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9XcAAAAASUVORK5CYII=")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def log(phase, **fields):
    print(json.dumps({"phase": phase, **fields}, sort_keys=True), flush=True)


def private_write(path, content):
    path.write_text(content)
    path.chmod(0o600)


def wav(frequency):
    out = io.BytesIO()
    with wave.open(out, "wb") as recording:
        recording.setparams((1, 2, 8_000, 0, "NONE", "not compressed"))
        recording.writeframes(b"".join(
            struct.pack("<h", int(5000 * math.sin(n * frequency * math.tau / 8000)))
            for n in range(16000)
        ))
    return out.getvalue()


def multipart(fields, attachment, filename, mime, data):
    boundary = secrets.token_hex(16)
    chunks = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
        for key, value in fields.items()
    ]
    chunks.extend([
        f'--{boundary}\r\nContent-Disposition: form-data; name="{attachment}"; filename="{filename}"\r\n'
        f"Content-Type: {mime}\r\n\r\n".encode(), data, f"\r\n--{boundary}--\r\n".encode(),
    ])
    return b"".join(chunks), {"Content-Type": f"multipart/form-data; boundary={boundary}"}


class Stack:
    def __init__(self, cleanup, vault, app_directory, image, ingest, proof, passkey_origin):
        self.vault = vault
        self.app_directory = app_directory
        self.image = image
        self.ingest = ingest
        self.proof = proof
        self.passkey_origin = passkey_origin
        self.db_password = secrets.token_urlsafe(24)
        self.containers = []
        cleanup.callback(self.close)
        self.pg = self.start("postgres", PG, [], [
            "-e", "POSTGRES_USER=fixture", "-e", f"POSTGRES_PASSWORD={self.db_password}",
            "-e", f"POSTGRES_DB={DB}",
        ])
        until(lambda: subprocess.run(
            ["docker", "exec", self.pg, "pg_isready", "-h", "127.0.0.1", "-U", "fixture", "-d", DB],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, timeout=5,
        ).returncode == 0, "PostgreSQL never became healthy", timeout=30)
        status, raw = vault.request("GET", "/graph/v1.0/me/drives")
        require(status == 200, f"Vault drive discovery returned {status}")
        self.space_id = unquote(vault_fixture.dav_root(json.loads(raw)).split("/")[-1])

    def start(self, alias, image, args, flags):
        name = f"{self.vault.name}-{alias}"
        identity = self.vault.create(
            "create", "--pull", "never", "--name", name, "--network", self.vault.network,
            "--network-alias", alias, *flags, image, *args,
        )
        self.containers.append(identity)
        docker("start", identity)
        return identity

    def address(self, service):
        networks = docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", service)
        return json.loads(networks)[self.vault.name]["IPAddress"]

    def sql(self, sql, db=DB):
        return docker("exec", self.pg, "psql", "-XAt", "-v", "ON_ERROR_STOP=1", "-U", "fixture", "-d", db, "-c", sql)

    def storage_flags(self, mode):
        # Keep fixture values out of Docker output and arguments carrying app commands.
        env_path = self.app_directory.parent / f"{self.vault.name}-{mode}.env"
        settings = {
            "DATABASE_URL": f"postgresql://fixture:{self.db_password}@postgres:5432/{DB}",
            "BETTER_AUTH_URL": HOME_ORIGIN if mode == "tailscale" else self.passkey_origin,
            "BETTER_AUTH_RP_ID": "qs.girke.dev" if mode == "tailscale" else urlsplit(self.passkey_origin).hostname,
            "BETTER_AUTH_SECRET_FILE": "/rollback/auth-secret",
            "QUANTSELF_OWNER_EMAIL": "post-write-owner@example.test",
            "QUANTSELF_INSTANCE_NAME": "Synthetic rollback",
            "QUANTSELF_OWNER_AUTH": mode,
            "QUANTSELF_OWNER_INGRESS_TOKEN": self.proof,
            "QUANTSELF_ORIGINALS_PROVIDER": "opencloud",
            "QUANTSELF_OPENCLOUD_URL": vault_fixture.ORIGIN,
            "QUANTSELF_OPENCLOUD_SPACE_ID": self.space_id,
            "QUANTSELF_OPENCLOUD_USERNAME": "admin",
            "QUANTSELF_OPENCLOUD_TOKEN": self.vault.password,
            "QUANTSELF_WEBSITE_ANALYTICS_INGEST_TOKEN": self.ingest,
            "QUANTSELF_TODO_CAPTURE_ROOT": "/fixture-captures",
            "QUANTSELF_PHONE_ENABLED": "0",
            "QUANTSELF_API_INTERNAL_URL": "http://api:3001",
            "NODE_EXTRA_CA_CERTS": "/rollback/vault-ca.crt",
            "DEBUG": "next:start-server",
            "HOSTNAME": "0.0.0.0",
            "PORT": "3000",
        }
        private_write(env_path, "".join(f"{key}={value}\n" for key, value in settings.items()))
        return [
            "--env-file", str(env_path), "--init",
            "--mount", f"type=bind,src={self.app_directory / 'auth-secret'},dst=/rollback/auth-secret,readonly",
            "--mount", f"type=bind,src={self.vault.directory / 'config/fixture.crt'},dst=/rollback/vault-ca.crt,readonly",
            "--mount", f"type=bind,src={self.app_directory / 'captures'},dst=/fixture-captures",
        ]

    def migrate(self):
        job = self.start("migration", self.image, ["bun", "run", "--cwd", "packages/db", "migrate:deploy-only"],
                         self.storage_flags("passkey"))
        require(docker("wait", job, timeout=120) == "0", "Migrating fresh source failed")

    def start_app(self, mode, *, web=False):
        flags = self.storage_flags(mode)
        self.api = self.start("api", self.image, ["bun", "run", "--cwd", "apps/api", "start:production"], flags)
        self.api_address = self.address(self.api)
        until(lambda: healthy(self.api_address, 3001), "Exact API never became healthy", timeout=40)
        self.web = None
        if web:
            self.web = self.start("web", self.image, ["bun", "run", "--cwd", "apps/web", "start"], flags)
            until(lambda: healthy(self.address(self.web), 3000), "Exact web never reached rewrites", timeout=45)

    def freeze_app(self):
        for container, expected, marker in (
            (self.web, 143, b"start-server process cleanup finished"),
            (self.api, 0, b"API drain complete"),
        ):
            if container:
                docker("stop", "-t", "35", container, timeout=45)
                state = docker("inspect", "--format",
                               "{{.State.ExitCode}} {{.State.OOMKilled}} {{json .State.Error}}", container)
                require(state == f'{expected} false ""', f"Unexpected application drain state: {state}")
                logs = subprocess.run(["docker", "logs", "--tail", "100", container],
                                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=True, timeout=8)
                require(marker in logs.stdout, "Exact application lacked its clean drain marker")
                docker("rm", "--volumes", container)
                self.containers.remove(container)
        self.web = self.api = None

    def close(self):
        for container in reversed(self.containers):
            docker("rm", "--force", "--volumes", container)
        self.containers.clear()


def request(addr, port, method, path, *, body=None, headers=None):
    connection = http.client.HTTPConnection(addr, port, timeout=60)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        return response.status, response.headers, response.read()
    finally:
        connection.close()


def healthy(addr, port):
    try:
        return request(addr, port, "GET", "/api/health")[0] == 200
    except OSError:
        return False


class Client:
    def __init__(self, stack, owner_headers):
        self.stack = stack
        self.owner_headers = owner_headers

    def call(self, method, path, expected, *, body=None, headers=None, ingest=False):
        request_headers = {"X-API-Key": self.stack.ingest} if ingest else self.owner_headers.copy()
        request_headers.update(headers or {})
        if isinstance(body, dict):
            body = json.dumps(body).encode()
            request_headers["Content-Type"] = "application/json"
        status, response_headers, payload = request(
            self.stack.api_address, 3001, method, path, body=body, headers=request_headers,
        )
        if status != expected:
            match = re.search(rb'"code"\s*:\s*"([A-Z0-9_]+)"', payload)
            code = match[1].decode() if match else "unclassified"
            raise vault_fixture.ProofError(f"{method} {path} returned {status}, expected {expected} ({code})")
        return response_headers, payload

    def json(self, method, path, expected=200, **kwargs):
        return json.loads(self.call(method, path, expected, **kwargs)[1])


def browser_auth(args, stack, scratch, mode):
    result_path = scratch / (mode + "-session.json")
    subprocess.run(
        [args.node, args.browser, mode, stack.address(stack.web),
         str(scratch / "virtual-passkey.json"), str(result_path), args.passkey_origin],
        check=True, timeout=90,
    )
    result = json.loads(result_path.read_text())
    result_path.unlink()
    return result


def add_capture(client, capture_id, data):
    assert client.json("POST", CAPTURES, body={
        "id": capture_id, "source": "rollback-fixture", "transcript": "Synthetic rollback audio",
        "capturedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
    })["capture"]["id"] == capture_id
    assert client.json("PUT", f"{CAPTURES}/{capture_id}/audio", body=data, headers={
        "Content-Type": "application/octet-stream", "X-Audio-Mime": "audio/wav", "X-Audio-Duration": "2",
    })["audio"]["sha256"] == digest(data)


def original_rows(stack):
    return json.loads(stack.sql(
        """SELECT coalesce(json_agg(row_to_json(f) ORDER BY key), '[]') FROM (
           SELECT key, "spaceId", "fileId", bytes, sha256, state FROM original_file
        ) f"""
    ))


def passkey_identity(stack):
    return json.loads(stack.sql(
        """SELECT json_agg(json_build_object('owner', a."userId", 'id', p.id,
                  'credential', p."credentialID", 'publicKey', p."publicKey"))
           FROM auth_owner a JOIN passkey p ON p."userId"=a."userId" WHERE a.id='singleton'"""
    ))


def verify_media(client, facts):
    for path, data in facts["media"]:
        _, payload = client.call("GET", path, 200)
        assert digest(payload) == digest(data) and len(payload) == len(data), f"Full media differs at {path}"
    path, audio = facts["media"][1]
    for first, last, selector in [(0, 63, "0-63"), (3099, 5198, "3099-5198"),
                                  (len(audio) - 67, len(audio) - 1, "-67")]:
        headers, payload = client.call("GET", path, 206, headers={"Range": f"bytes={selector}"})
        assert headers["Content-Range"] == f"bytes {first}-{last}/{len(audio)}"
        assert payload == audio[first:last + 1]
    client.call("GET", path, 416, headers={"Range": f"bytes={len(audio)}-"})


def event_rows(stack):
    return json.loads(stack.sql(
        "SELECT json_agg(website_event ORDER BY id) FROM website_event"
    ))


def verify_native_facts(stack, client, facts):
    assert client.json("GET", "/api/v1/access-context")["owner"]["id"] == facts["owner"]
    assert client.json("GET", facts["receipt"])["id"] == facts["receipt"].split("/")[-1]
    assert client.json("GET", facts["recording"])["audio"]["sha256"] == digest(facts["media"][1][1])
    verify_media(client, facts)
    deleted = client.json("GET", facts["deleted"])
    assert deleted["deleted"] and deleted["capture"] is None and deleted["audio"] is None
    assert client.json("GET", facts["deleted"] + "/audio", 409)["code"] == "CAPTURE_DELETED"
    rows = original_rows(stack)
    assert rows == facts["originals"]
    for row in rows:
        status, body = stack.vault.request("GET", "/dav/spaces/" + quote(row["fileId"], safe=""))
        if row["state"] == "deleted":
            assert status == 404
        else:
            assert status == 200 and len(body) == row["bytes"] and digest(body) == row["sha256"]
    report = client.json("GET", ANALYTICS + "/website?range=7")
    assert [inquiry["status"] for inquiry in report["inquiries"] if inquiry["id"] == facts["inquiry"]] == ["replied"]
    assert client.json("POST", ANALYTICS + "/events", 202, body=facts["event"], ingest=True) == {
        "received": 1, "inserted": 0,
    }
    assert event_rows(stack) == facts["event_rows"]
    assert stack.sql("SELECT to_regclass('legacy_analytics_reference') IS NULL") == "t"


def create_post_write_data(stack, client, owner):
    receipt_id, capture_id, deleted_id, inquiry_id = (str(uuid4()) for _ in range(4))
    receipt = f"{RECEIPTS}/{receipt_id}"
    recording = f"{CAPTURES}/{capture_id}"
    deleted = f"{CAPTURES}/{deleted_id}"
    body, headers = multipart({"id": receipt_id, "scan": "no"}, "photo", "receipt.png", "image/png", PNG)
    assert client.json("POST", RECEIPTS, body=body, headers=headers)["id"] == receipt_id
    audio = wav(440)
    add_capture(client, capture_id, audio)
    add_capture(client, deleted_id, wav(330))
    assert client.json("DELETE", deleted)["deleted"]
    inventory = wav(660)
    body, headers = multipart({"metadata": json.dumps({"captureText": "Synthetic inventory recording"})},
                              "files", "inventory.wav", "audio/wav", inventory)
    headers["Idempotency-Key"] = str(uuid4())
    item = client.json("POST", INVENTORY + "/capture", 201, body=body, headers=headers)
    media = f"{INVENTORY}/{item['item']['id']}/media/{item['media'][0]['id']}"
    inquiry = {"id": inquiry_id, "name": "Fixture", "email": "visitor@example.test",
               "topic": "Rollback rehearsal", "message": "Synthetic inquiry"}
    assert client.json("POST", ANALYTICS + "/inquiries", 202, body=inquiry, ingest=True)["id"] == inquiry_id
    assert client.json("PATCH", f"{ANALYTICS}/inquiries/{inquiry_id}", body={"status": "replied"})["status"] == "replied"
    event = {"events": [{
        "id": str(uuid4()), "occurred_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "kind": "page:view", "path": "/rollback-fixture", "visitor_id": str(uuid4()),
        "session_id": str(uuid4()), "page_view_id": str(uuid4()), "props": {},
    }]}
    assert client.json("POST", ANALYTICS + "/events", 202, body=event, ingest=True) == {"received": 1, "inserted": 1}
    events = event_rows(stack)
    assert len(events) == 1 and events[0]["id"] == event["events"][0]["id"]
    originals = original_rows(stack)
    assert len(originals) == 4 and {r["state"] for r in originals} == {"ready", "deleted"}
    assert {r["spaceId"] for r in originals} == {stack.space_id}
    facts = {"owner": owner, "receipt": receipt, "recording": recording, "deleted": deleted,
             "inquiry": inquiry_id, "event": event, "event_rows": events, "originals": originals,
             "media": [(receipt + "/original", PNG), (recording + "/audio", audio), (media, inventory)]}
    verify_native_facts(stack, client, facts)
    log("post-write-source", owner=owner, receipt_id=receipt_id, recording_id=capture_id,
        deleted_capture_id=deleted_id, inventory_id=item["item"]["id"], inventory_media_id=item["media"][0]["id"],
        inquiry_id=inquiry_id, event_id=event["events"][0]["id"], vault_originals=originals)
    return facts


def dump(stack, database, destination):
    with destination.open("xb") as stream:
        subprocess.run(["docker", "exec", stack.pg, "pg_dump", "-Fc", "--no-owner",
                        "-U", "fixture", "-d", database], stdout=stream, check=True, timeout=60)


def restore_dump(stack, source):
    with source.open("rb") as stream:
        subprocess.run(["docker", "exec", "-i", stack.pg, "pg_restore", "--exit-on-error",
                        "--no-owner", "-U", "fixture", "-d", DB], stdin=stream, check=True, timeout=60)


def create_legacy_reference(stack, scratch):
    stack.sql("CREATE DATABASE legacy_reference")
    stack.sql("CREATE TABLE legacy_analytics_reference (label text); "
              "INSERT INTO legacy_analytics_reference VALUES ('sealed fixture only')", db="legacy_reference")
    sealed = scratch / "legacy-analytics-reference.dump"
    dump(stack, "legacy_reference", sealed)
    sealed.chmod(0o400)
    stack.sql("DROP DATABASE legacy_reference")
    return sealed


def paired_snapshot(root, role, source, restore_id, restic):
    inventory = root / f"{role}-inventory.json"
    captured = write_inventory(source, inventory)
    password = root / f"{role}-repository-password"
    private_write(password, secrets.token_urlsafe(32))
    repository = root / f"{role}-repository"
    command = [restic, "--repo", str(repository), "--password-file", str(password), "--no-cache"]

    def run(*args):
        result = subprocess.run([*command, *args], capture_output=True, text=True, check=False, timeout=100)
        require(result.returncode == 0, f"{role} restic {args[0]} failed ({result.returncode})")
        return result.stdout

    run("init")
    repository_id = json.loads(run("cat", "config"))["id"]
    summary = [json.loads(line) for line in run(
        "backup", "--json", "--tag", restore_id, str(source),
    ).splitlines()]
    short_id, = [line["snapshot_id"] for line in summary if line.get("message_type") == "summary"]
    snapshots = json.loads(run("snapshots", "--json", "--tag", restore_id))
    snapshot, = [row["id"] for row in snapshots]
    assert snapshot.startswith(short_id)
    run("check", "--read-data")
    target = root / f"{role}-independent-restore"
    target.mkdir(mode=0o700)
    run("restore", snapshot, "--target", str(target), "--verify")
    restored = target / source.relative_to("/")
    verify_inventory(restored, inventory)
    log("restore-side", role=role, restore_id=restore_id, repository_id=repository_id,
        snapshot=snapshot, entries=len(captured["entries"]), inventory_sha256=digest(inventory.read_bytes()))
    return restored, repository_id, snapshot


def prove(args, root, cleanup):
    recovery_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(6)
    image_id = docker("image", "inspect", "--format", "{{.Id}}", args.image)
    revision = docker("image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}', args.image)
    require(revision == args.revision and image_id == args.image_id, "Exact loaded release was required")
    log("release", revision=revision, image_id=image_id)
    started = time.monotonic()
    source_vault = vault_fixture.Fixture(root / "source-vault")
    source_vault.directory.mkdir(mode=0o700)
    cleanup.callback(source_vault.close)
    source_vault.start()
    source_app = root / "source-app"
    source_app.mkdir(mode=0o700)
    (source_app / "captures").mkdir(mode=0o700)
    private_write(source_app / "auth-secret", secrets.token_urlsafe(48))
    ingest = secrets.token_hex(32)
    proof = secrets.token_hex(32)
    source = Stack(cleanup, source_vault, source_app, image_id, ingest, proof, args.passkey_origin)
    source.migrate()
    log("source-migrated", postgres=source.sql("SHOW server_version"), vault_space=source.space_id)
    legacy = create_legacy_reference(source, root)
    legacy_hash = digest(legacy.read_bytes())
    source.start_app("passkey", web=True)
    enrolled = browser_auth(args, source, root, "enroll")
    credentials = passkey_identity(source)
    assert len(credentials) == 1 and credentials[0]["owner"] == enrolled["ownerId"]
    source.freeze_app()
    source.start_app("tailscale")
    headers = {"X-Quantself-Owner-Proof": proof, "Origin": HOME_ORIGIN}
    writes = Client(source, headers)
    facts = create_post_write_data(source, writes, enrolled["ownerId"])
    require(passkey_identity(source) == credentials, "Native writes changed the original passkey record")

    captured_at = time.monotonic()
    source.freeze_app()
    source_vault.signal()
    source_vault.clean_exit()
    dump(source, DB, source_app / "quantself.dump")
    manifest = {"restore_id": recovery_id, "mode": "production-native-synthetic", "image_id": image_id,
                "revision": revision, "vault_space": source.space_id, "owner_id": facts["owner"],
                "passkey_origin": args.passkey_origin,
                "database_sha256": digest((source_app / "quantself.dump").read_bytes()),
                "sealed_legacy_reference_sha256": legacy_hash}
    private_write(source_app / "fixture-point.json", json.dumps(manifest))
    docker("stop", "-t", "15", source.pg, timeout=25)
    log("source-fenced", **manifest)

    app_tree, app_repo, app_snapshot = paired_snapshot(root, "app", source_app, recovery_id, args.restic)
    vault_tree, vault_repo, vault_snapshot = paired_snapshot(root, "vault", source_vault.directory, recovery_id, args.restic)
    assert app_repo != vault_repo and app_snapshot != vault_snapshot
    assert digest((app_tree / "quantself.dump").read_bytes()) == manifest["database_sha256"]
    assert json.loads((app_tree / "fixture-point.json").read_text()) == manifest
    assert digest(legacy.read_bytes()) == legacy_hash
    log("independent-pair", restore_id=recovery_id, elapsed_ms=round((time.monotonic() - captured_at) * 1000))

    restored_vault = vault_fixture.Fixture(vault_tree)
    restored_vault.password = source_vault.password
    cleanup.callback(restored_vault.close)
    restored_vault.start(restored=True)
    target = Stack(cleanup, restored_vault, app_tree, image_id, ingest, proof, args.passkey_origin)
    assert restored_vault.network != source_vault.network and target.pg != source.pg
    assert target.space_id == manifest["vault_space"]
    restore_dump(target, app_tree / "quantself.dump")
    assert passkey_identity(target) == credentials
    target.start_app("passkey", web=True)
    restored = browser_auth(args, target, root, "restore")
    assert restored["ownerId"] == facts["owner"]
    reads = Client(target, {"Cookie": restored["cookie"], "Origin": args.passkey_origin})
    verify_native_facts(target, reads, facts)
    assert passkey_identity(target) == credentials
    assert digest(legacy.read_bytes()) == legacy_hash
    log("post-write-restored", restore_id=recovery_id, owner=facts["owner"], ready_originals=3,
        passkey_origin=args.passkey_origin,
        deleted_originals=1, full_hash_checks=3, partial_ranges=3, unsatisfiable=1,
        event_rows=1, replay_inserted=0, inquiry_status="replied",
        elapsed_ms=round((time.monotonic() - started) * 1000))
    target.freeze_app()
    restored_vault.signal()
    restored_vault.clean_exit()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("image", "image-id", "revision", "browser", "node", "restic"):
        parser.add_argument("--" + flag, required=True)
    parser.add_argument("--passkey-origin", choices=(PASSKEY_ORIGIN, HOSTINGER_ORIGIN), default=PASSKEY_ORIGIN)
    args = parser.parse_args()
    require(os.getuid() == 0 and os.uname().sysname == "Linux", "Use an isolated Linux runner as root")
    with tempfile.TemporaryDirectory(prefix="qs-post-write-rollback-") as directory:
        with ExitStack() as cleanup:
            prove(args, Path(directory), cleanup)
    log("cleanup-complete")


if __name__ == "__main__":
    main()
