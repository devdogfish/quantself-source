#!/usr/bin/env python3
"""Run the feed acceptance fixture with pinned images and isolated runtime networking."""

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

BUN_IMAGE = "oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4"
POSTGRES_IMAGE = "postgres@sha256:b0ba6f2b6290ae40c9aacf6cc72849a2954778fef88774e122131d4b3c3b5e5b"
N8N_IMAGE = "docker.n8n.io/n8nio/n8n@sha256:3db21366be1d3c77c1708963129c051948573019659e8873e0294be035ffc1b2"

FEED = Path("automation/n8n/jobs-feed")
SMOKE = FEED / "smoke"
FIXTURE_API = SMOKE / "jobs-api-fixture.ts"
FIXTURE_N8N = SMOKE / "n8n-jobs-api.mjs"
FIXTURE_PILOT_POSTING = SMOKE / "pilot-posting.mjs"
FIXTURE_TYPES = SMOKE / "tsconfig.json"
PILOT_TEST = Path("apps/api/src/jobs-pilot-allowance-docker.test.ts")
NATIVE_TLS_TEST = Path("apps/api/src/jobs-pilot-screening-docker.test.ts")
NATIVE_N8N_TEST = Path("apps/api/src/jobs-pilot-native-n8n.test.ts")
RENDER_ASSETS = {
    "render_resumes.py": "/renderer/render_resumes.py",
    "md_to_pdf.py": "/Users/devdogfish/bin/md_to_pdf.py",
    "geist-latin.woff2": "/Users/devdogfish/bin/geist-latin.woff2",
}


def invoke(*args, **options):
    return subprocess.run(["docker", *args], check=True, text=True, **options)


def prepare(root, revision, scratch):
    source = scratch / "source"
    source.mkdir()
    (scratch / "cache").mkdir()
    with subprocess.Popen(["git", "archive", revision], cwd=root, stdout=subprocess.PIPE) as archive:
        with tarfile.open(fileobj=archive.stdout, mode="r|") as files:
            files.extractall(source, filter="data")
        if archive.wait():
            raise RuntimeError("Could not archive the pinned source")
    for path in (FIXTURE_API, FIXTURE_N8N, FIXTURE_TYPES, FIXTURE_PILOT_POSTING):
        target = source / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / path, target)

    started = time.monotonic()
    invoke("run", "--rm", "--pull=never", "--cpus", "1", "--memory", "1536m",
           "-e", "DATABASE_URL=postgresql://unused:unused@127.0.0.1:59999/unused",
           "--mount", f"type=bind,source={source},target=/repo",
           "--mount", f"type=bind,source={scratch / 'cache'},target=/root/.cache",
           "--workdir", "/repo", BUN_IMAGE, "sh", "-ec",
           "bun install --frozen-lockfile && "
           "bun --no-env-file run --cwd packages/db generate && "
           "bun automation/n8n/jobs-feed/build-workflow.mjs --check && "
           "if test -f automation/n8n/jobs-feed/build-pilot-workflow.mjs; then "
           "bun automation/n8n/jobs-feed/build-pilot-workflow.mjs --check; fi")
    return round((time.monotonic() - started) * 1000)


def check_fixture_types(scratch):
    started = time.monotonic()
    subprocess.run(["nice", "-n", "12", "node", "--max-old-space-size=4096",
                    "node_modules/typescript/bin/tsc", "--project", str(FIXTURE_TYPES)],
                   cwd=scratch / "source", check=True)
    return round((time.monotonic() - started) * 1000)


def prepare_tls(scratch):
    assets = scratch / "tls"
    assets.mkdir()

    def openssl(*args):
        subprocess.run(["openssl", *args], cwd=assets, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    def root(name):
        openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Quantself Fixture " + name,
                "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
                "-keyout", name + ".key", "-out", name + ".pem")

    def issue(name, issuer, serial, extensions):
        (assets / "extensions.cnf").write_text(extensions)
        openssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=" + name,
                "-keyout", name + ".key", "-out", name + ".csr")
        openssl("x509", "-req", "-in", name + ".csr", "-CA", issuer + ".pem", "-CAkey", issuer + ".key",
                "-set_serial", str(serial), "-days", "1", "-extfile", "extensions.cnf", "-out", name + ".pem")

    root("root")
    root("untrusted-root")
    issue("intermediate", "root", 1, "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n")
    for name, issuer, host, serial in (
        ("good", "intermediate", "api.anthropic.com", 2),
        ("wrong-host", "intermediate", "wrong.example.test", 3),
        ("untrusted", "untrusted-root", "api.anthropic.com", 4),
    ):
        issue(name, issuer, serial, f"basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:{host}\n")
        chain = (assets / f"{name}.pem").read_bytes()
        if issuer == "intermediate":
            chain += (assets / "intermediate.pem").read_bytes()
        (assets / f"{name}-chain.pem").write_bytes(chain)
    for path in assets.iterdir():
        if path.name not in {"root.pem", "good.key", "good-chain.pem", "wrong-host.key", "wrong-host-chain.pem", "untrusted.key", "untrusted-chain.pem"}:
            path.unlink()
    return assets


def rehearse_native_tls(scratch, revision, dependency_setup_ms, native_n8n=False, handoff_db=None):
    assets = prepare_tls(scratch)
    database = "jobs_pilot_screen_fixture"
    db = scratch.name + "-db"
    client = scratch.name + "-tls"
    n8n = scratch.name + "-n8n"
    started = time.monotonic()
    try:
        invoke("run", "--detach", "--rm", "--pull=never", "--name", db, "--network", "none",
               "--add-host", "api.anthropic.com:127.0.0.1", "--tmpfs", "/var/lib/postgresql:rw,size=256m",
               "-e", "POSTGRES_USER=fixture", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
               "-e", "POSTGRES_DB=" + database, POSTGRES_IMAGE, stdout=subprocess.DEVNULL)
        for _ in range(60):
            if subprocess.run(["docker", "exec", db, "pg_isready", "-h", "127.0.0.1", "-U", "fixture", "-d", database],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                break
            time.sleep(.5)
        else:
            raise RuntimeError("TLS fixture database failed readiness")
        pg_version = invoke("exec", db, "postgres", "--version", capture_output=True).stdout.strip()
        test = NATIVE_N8N_TEST if native_n8n else NATIVE_TLS_TEST
        mode = ("--detach",) if native_n8n else ("--rm",)
        fixture = invoke("run", *mode, "--pull=never", "--name", client, "--network", "container:" + db,
                         "-e", f"DATABASE_URL=postgresql://fixture@127.0.0.1:5432/{database}",
                         "-e", "QUANTSELF_JOBS_NATIVE_N8N_FIXTURE=1" if native_n8n else "QUANTSELF_JOBS_PILOT_SCREEN_FIXTURE=1",
                         "-e", "QUANTSELF_JOBS_PILOT_NATIVE_TLS_DIR=/pilot-tls",
                         "--mount", f"type=bind,source={scratch / 'source'},target=/repo,readonly",
                         "--mount", f"type=bind,source={scratch / 'cache'},target=/root/.cache",
                         "--mount", f"type=bind,source={assets},target=/pilot-tls,readonly", "--workdir", "/repo",
                         BUN_IMAGE, "sh", "-ec", "bun --no-env-file run --cwd packages/db migrate:deploy-only && "
                         f"NODE_EXTRA_CA_CERTS=/pilot-tls/root.pem bun --no-env-file test --isolate {test}",
                         capture_output=True, timeout=120)
        n8n_evidence = None
        if native_n8n:
            for _ in range(90):
                if subprocess.run(["docker", "exec", client, "bun", "-e",
                                   'if (!(await fetch("http://127.0.0.1:3001/health")).ok) process.exit(1)'],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                    break
                if invoke("inspect", "--format", "{{.State.Running}}", client, capture_output=True).stdout.strip() != "true":
                    raise RuntimeError("Native gateway exited before readiness")
                time.sleep(.5)
            else:
                raise RuntimeError("Native gateway failed readiness")
            entrypoint = "n8n-pilot-gateway.mjs" if (scratch / "source" / SMOKE / "n8n-pilot-gateway.mjs").exists() else "n8n-jobs-api.mjs"
            n8n_run = invoke("run", "--rm", "--pull=never", "--name", n8n, "--network", "container:" + db,
                             "-e", "QUANTSELF_JOBS_PILOT_N8N_FIXTURE=1", "-e", "TZ=America/Halifax", "-e", "GENERIC_TIMEZONE=America/Halifax",
                             "--mount", f"type=bind,source={scratch / 'source' / FEED},target=/fixture,readonly",
                             "--entrypoint", "node", N8N_IMAGE, "/fixture/smoke/" + entrypoint,
                             capture_output=True, timeout=100)
            n8n_evidence = json.loads(n8n_run.stdout.splitlines()[-1])
            n8n_evidence.update(image=N8N_IMAGE, version="2.43.7")
            exit_code = invoke("wait", client, capture_output=True, timeout=20).stdout.strip()
            fixture = invoke("logs", client, capture_output=True)
            if exit_code != "0":
                raise RuntimeError("Native n8n gateway failed")
        print(fixture.stderr.strip(), flush=True)
        prefix = "Jobs pilot native n8n " if native_n8n else "Jobs pilot native TLS "
        proof = next(line for line in fixture.stdout.splitlines() if line.startswith(prefix))
        evidence = json.loads(proof.removeprefix(prefix))
        evidence.update(sourceRevision=revision, postgresqlVersion=pg_version, bunImage=BUN_IMAGE,
                        postgresImage=POSTGRES_IMAGE, dependencySetupMs=dependency_setup_ms,
                        elapsedMs=round((time.monotonic() - started) * 1000))
        if n8n_evidence:
            evidence["n8n"] = n8n_evidence
        if handoff_db:
            # The database and all data in it belong to the disconnected synthetic run.
            with os.fdopen(os.open(handoff_db, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as dump:
                subprocess.run(["docker", "exec", db, "pg_dump", "-U", "fixture", "-Fc",
                                "--no-owner", "--no-privileges", database], stdout=dump, check=True)
            evidence["handoffDumpSha256"] = sha256(handoff_db.read_bytes()).hexdigest()
        return evidence
    except subprocess.CalledProcessError as error:
        print((error.stderr or "")[-5000:], file=sys.stderr)
        if native_n8n:
            subprocess.run(["docker", "logs", "--tail", "20", client], check=False)
        raise
    except RuntimeError:
        if native_n8n:
            subprocess.run(["docker", "logs", "--tail", "20", client], check=False)
        raise
    finally:
        for resource in (n8n, client, db):
            subprocess.run(["docker", "rm", "--force", resource], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def rehearse(s, source_revision, dependency_setup_ms, render=None, pilot=False):
    source = s / "source"
    name = s.name
    network = name + "-net"
    db = name + "-db"
    api = name + "-api"
    n8n = name + "-n8n"
    database = "jobs_pilot_allowance_fixture" if pilot else "jobs_feed_n8n_fixture"
    started = time.monotonic()
    invoke("network", "create", "--internal", network, stdout=subprocess.DEVNULL)
    try:
        invoke("run", "--detach", "--rm", "--pull=never", "--name", db, "--network", network, "--network-alias", "db",
            "--cpus", "0.75", "--memory", "512m", "--tmpfs", "/var/lib/postgresql:rw,size=256m",
            "-e", "POSTGRES_USER=fixture", "-e", "POSTGRES_PASSWORD=fixture", "-e", "POSTGRES_DB=" + database, POSTGRES_IMAGE,
            stdout=subprocess.DEVNULL)
        for attempt in range(40):
            if subprocess.run(["docker", "exec", db, "pg_isready", "-h", "127.0.0.1", "-U", "fixture", "-d", database],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                break
            time.sleep(.5)
        else:
            raise RuntimeError("Disposable PostgreSQL failed readiness")
        pg_version = invoke("exec", db, "postgres", "--version", capture_output=True).stdout.strip()
        print("Disposable database ready:", pg_version, flush=True)

        render_args = []
        fixture_args = ["-e", "QUANTSELF_JOBS_FEED_N8N_FIXTURE=1"]
        fixture_command = f"bun --no-env-file {FIXTURE_API}"
        ready_path = "/__fixture/ready"
        if pilot:
            fixture_args = ["-e", "QUANTSELF_JOBS_PILOT_ALLOWANCE_FIXTURE=1", "-e", "QUANTSELF_JOBS_PILOT_N8N_FIXTURE=1"]
            fixture_command = f"bun --no-env-file test --isolate {PILOT_TEST}"
            ready_path = "/ready"
        if render:
            for name, target in RENDER_ASSETS.items():
                render_args.extend(("--mount", f"type=bind,source={render['bundle'] / name},target={target},readonly"))
            render_args.extend(("-e", "QUANTSELF_JOBS_FEED_PDF_FIXTURE=1", "-e", "QUANTSELF_JOBS_SUBMIT_DISABLED=1",
                                "-e", "QUANTSELF_JOBS_PYTHON=/opt/jobs-python/bin/python"))
        invoke("run", "--detach", "--pull=never", "--name", api, "--network", network, "--network-alias", "api",
            "--cpus", "1", "--memory", "1536m" if render else "1024m",
            "-e", f"DATABASE_URL=postgresql://fixture:fixture@db:5432/{database}",
            *fixture_args, "-e", "NODE_ENV=test",
            "-e", "QUANTSELF_PUBLIC_ORIGIN=http://127.0.0.1:3001",
            "-e", "BETTER_AUTH_SECRET=feed-rehearsal-synthetic-better-auth-secret", "-e", "TZ=America/Halifax",
            "--mount", f"type=bind,source={source},target=/repo", "--mount", f"type=bind,source={s / 'cache'},target=/root/.cache",
            *render_args, "--workdir", "/repo", render["image"] if render else BUN_IMAGE, "sh", "-ec",
            "bun --no-env-file run --cwd packages/db generate && bun --no-env-file run --cwd packages/db migrate:deploy-only && "
            + fixture_command, stdout=subprocess.DEVNULL)
        for attempt in range(90):
            probe = subprocess.run(["docker", "exec", api, "bun", "-e",
                f'const r=await fetch("http://127.0.0.1:3001{ready_path}"); if (!r.ok) process.exit(1);'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if probe.returncode == 0:
                break
            running = invoke("inspect", "--format", "{{.State.Running}}", api, capture_output=True).stdout.strip()
            if running != "true":
                raise RuntimeError("Synthetic API exited during startup")
            time.sleep(.5)
        else:
            raise RuntimeError("Synthetic API did not become ready")
        api_ready_ms = round((time.monotonic() - started) * 1000)
        print(f"Jobs API ready in {api_ready_ms} ms including database setup and migrations.", flush=True)
        n8n_network = "container:" + api if pilot else network
        n8n_args = ["-e", "QUANTSELF_JOBS_PILOT_N8N_FIXTURE=1"] if pilot else []
        result = invoke("run", "--rm", "--pull=never", "--name", n8n, "--network", n8n_network, "--cpus", "1.25", "--memory", "1536m",
            "-e", "TZ=America/Halifax", "-e", "GENERIC_TIMEZONE=America/Halifax",
            *n8n_args,
            "--mount", f"type=bind,source={source / FEED},target=/fixture,readonly",
            "--entrypoint", "node", N8N_IMAGE, "/fixture/smoke/n8n-jobs-api.mjs", capture_output=True)
        evidence = json.loads(result.stdout.splitlines()[-1])
        evidence.update(sourceRevision=source_revision, postgresqlVersion=pg_version, bunVersion="1.3.14", n8nVersion="2.43.7",
            bunImage=BUN_IMAGE, dependencySetupMs=dependency_setup_ms, postgresImage=POSTGRES_IMAGE, n8nImage=N8N_IMAGE, apiReadyMs=api_ready_ms,
            elapsedMs=round((time.monotonic() - started) * 1000))
        if pilot:
            exit_code = invoke("wait", api, capture_output=True, timeout=30).stdout.strip()
            logs = invoke("logs", api, capture_output=True).stdout
            if exit_code != "0":
                raise RuntimeError("Pilot allowance fixture failed")
            proof = next(line for line in logs.splitlines() if line.startswith("Shared Jobs pilot allowance "))
            evidence["allowance"] = json.loads(proof.removeprefix("Shared Jobs pilot allowance "))
        if render:
            proof = evidence["work"]["pdf"]
            assert proof["applicationId"] in {row["applicationId"] for row in evidence["providerBindings"]}, "PDF draft must come from n8n"
            proof["renderImage"] = render["image"]
            proof["rendererAssets"] = render["sha256"]
            proof["chromiumVersion"] = invoke("exec", api, "chromium", "--version", capture_output=True).stdout.strip()
            proof["pythonVersion"] = invoke("exec", api, "/opt/jobs-python/bin/python", "--version", capture_output=True).stdout.strip()
            for extension in ("pdf", "png"):
                invoke("cp", f"{api}:/tmp/qs-approved-resume.{extension}", str(s / f"approved-resume.{extension}"))
            assert sha256((s / "approved-resume.pdf").read_bytes()).hexdigest() == proof["sha256"]
        return evidence
    except subprocess.CalledProcessError as error:
        if error.stderr:
            print(error.stderr[-5000:], file=sys.stderr)
        else:
            print(str(error), file=sys.stderr)
        subprocess.run(["docker", "logs", "--tail", "18", api], check=False)
        raise
    except RuntimeError:
        subprocess.run(["docker", "logs", "--tail", "18", api], check=False)
        raise
    finally:
        subprocess.run(["docker", "rm", "--force", api], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for resource in (n8n, db):
            subprocess.run(["docker", "stop", "--time", "2", resource], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        invoke("network", "rm", network, stdout=subprocess.DEVNULL)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="Git revision to archive and rehearse")
    parser.add_argument("evidence", type=Path, help="Destination for sanitized fixture evidence")
    parser.add_argument("--typecheck", action="store_true", help="Check the standalone fixture with local Node before rehearsal")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--pilot", action="store_true", help="Run the one-permit held-import acceptance fixture")
    mode.add_argument("--native-tls", action="store_true", help="Run the paid transport against a disposable loopback TLS server")
    mode.add_argument("--native-n8n", action="store_true", help="Run pinned n8n through native TLS and durable held Jobs work")
    parser.add_argument("--handoff-db", type=Path, help="Export the synthetic native n8n database for the Chrome fixture")
    parser.add_argument("--renderer-bundle", type=Path, help="Directory containing only the fixture's three real renderer assets")
    parser.add_argument("--render-image", help="Local Docker image containing Bun, Python, Chromium and Poppler")
    args = parser.parse_args()
    if args.handoff_db and not args.native_n8n:
        parser.error("--handoff-db requires --native-n8n")
    if bool(args.renderer_bundle) != bool(args.render_image):
        parser.error("--renderer-bundle and --render-image must be supplied together")
    if (args.pilot or args.native_tls or args.native_n8n) and args.render_image:
        parser.error("Pilot modes cannot be combined with the PDF renderer fixture")
    render = None
    if args.renderer_bundle:
        bundle = args.renderer_bundle.resolve()
        paths = [bundle / name for name in RENDER_ASSETS]
        if not all(path.is_file() for path in paths):
            parser.error("The renderer bundle needs render_resumes.py, md_to_pdf.py and geist-latin.woff2")
        image = invoke("image", "inspect", "--format", "{{.Id}}", args.render_image, capture_output=True).stdout.strip()
        render = {"bundle": bundle, "image": image, "sha256": {path.name: sha256(path.read_bytes()).hexdigest() for path in paths}}
    root = Path(__file__).resolve().parents[4]
    revision = subprocess.check_output(["git", "rev-parse", args.source + "^{commit}"], cwd=root, text=True).strip()
    with tempfile.TemporaryDirectory(prefix="qs-feed-198-") as directory:
        scratch = Path(directory).resolve()
        print(f"Rehearsal {scratch.name}, source {revision}", flush=True)
        dependency_setup_ms = prepare(root, revision, scratch)
        typecheck = {}
        if args.typecheck:
            typecheck["fixtureTypecheckNodeVersion"] = subprocess.check_output(["node", "--version"], text=True).strip()
            typecheck["fixtureTypecheckMs"] = check_fixture_types(scratch)
            print(f"Fixture typecheck passed in {typecheck['fixtureTypecheckMs']} ms.", flush=True)
        evidence = (rehearse_native_tls(scratch, revision, dependency_setup_ms, args.native_n8n, args.handoff_db) if args.native_tls or args.native_n8n
                    else rehearse(scratch, revision, dependency_setup_ms, render, args.pilot))
        evidence.update(typecheck)
        if render:
            for extension in ("pdf", "png"):
                shutil.copyfile(scratch / f"approved-resume.{extension}", args.evidence.with_suffix("." + extension))
    args.evidence.write_text(json.dumps(evidence, indent=2) + "\n")
    print(f"Evidence written to {args.evidence}")


if __name__ == "__main__":
    main()
