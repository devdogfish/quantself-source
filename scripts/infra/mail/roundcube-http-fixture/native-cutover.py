"""Freeze and rehearse rollback inside the disposable native Roundcube fixture."""

import os
from pathlib import Path
import subprocess
import sys
from time import monotonic, sleep


def rehearse(compose):
    prior = os.environ["QS_ROUNDCUBE_FIXTURE_NATIVE_PRIOR"]
    candidate_release = os.environ["QS_ROUNDCUBE_FIXTURE_NATIVE_CANDIDATE"]
    state = Path(os.environ["QS_ROUNDCUBE_FIXTURE_STATE"]) / "cutover"
    state.mkdir(mode=0o700)
    run = ("run", "--rm", "--no-deps", "--pull", "never")
    mount = ("--volume", f"{state}:/cutover-check")

    def execute(*args, deadline, upstream=None, capture=False):
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise TimeoutError("Roundcube cutover deadline expired")
        env = dict(os.environ)
        if upstream:
            env["QS_ROUNDCUBE_ACTIVE_UPSTREAM"] = upstream
        return subprocess.run(
            [*compose, *args], env=env, timeout=remaining, check=True, text=True, capture_output=capture,
        ).stdout

    def probe(kind, deadline, *, candidate=False, version=prior):
        execute(
            *run, *mount, "--env", f"QS_ROUNDCUBE_CUTOVER_PROBE={kind}",
            "--env", f"QS_ROUNDCUBE_FIXTURE_CANDIDATE={int(candidate)}",
            "--env", f"QS_ROUNDCUBE_FIXTURE_RELEASE={version}", "http-proof", deadline=deadline,
        )

    def runtime(action, deadline):
        execute(*run, *mount, "roundcube-snapshot", action, deadline=deadline)

    def route(upstream, deadline):
        execute("up", "-d", "--no-deps", "--pull", "never", "--force-recreate", "edge",
                deadline=deadline, upstream=upstream)

    def stop_workers(*services, deadline):
        execute("stop", "--timeout", "5", *services, deadline=deadline)
        for service in services:
            stopped = execute("ps", "--all", "--format", "{{.State}} {{.ExitCode}}", service,
                              deadline=deadline, capture=True)
            if stopped.strip() != "exited 0":
                raise RuntimeError(f"Expected graceful worker shutdown: {service}")

    # SQLite last_login has one-second precision. Capture a login after qualification.
    sleep(1.05)
    preflight = monotonic() + 25
    probe("record", preflight)
    runtime("witness", preflight)
    print("PASS early SQLite clone missed the late login, settings and session", flush=True)
    probe("stale", preflight, candidate=True, version=candidate_release)

    started = monotonic()
    deadline = started + 25
    exposure_started = False
    try:
        route("freeze", deadline)
        probe("frozen", deadline)
        stop_workers("roundcube", "roundcube-candidate", deadline=deadline)
        runtime("final-snapshot", deadline)
        execute("up", "-d", "--no-deps", "--pull", "never", "roundcube-candidate", deadline=deadline)
        probe("preserved", deadline, candidate=True, version=candidate_release)
        runtime("candidate", deadline)
        runtime("candidate-only-schema", deadline)
        # A failed route command may still have admitted writes.
        exposure_started = True
        route("roundcube-candidate", deadline)
        probe("preserved", deadline, version=candidate_release)
        print(f"PASS frozen cutover preserved late SQLite writes in {monotonic() - started:.3f}s", flush=True)
        probe("post-promotion-write", deadline, version=candidate_release)
    finally:
        # Give recovery its own budget, even when qualification exhausted the freeze budget.
        recovery_started = monotonic()
        recovery = recovery_started + 20
        if exposure_started:
            print("Holding rollback after possible candidate exposure without proven compatibility", flush=True)
            route("freeze", recovery)
            probe("frozen", recovery)
            stop_workers("roundcube-candidate", deadline=recovery)
        else:
            execute("up", "-d", "--no-deps", "--pull", "never", "roundcube", deadline=recovery)
            route("roundcube", recovery)
            probe("preserved", recovery)
            runtime("prior", recovery)
            print("PASS pre-promotion recovery restored the prior route, writes and browser session", flush=True)
    runtime("retained", recovery)
    print(f"PASS incompatible rollback held with the accepted candidate write retained "
          f"in {monotonic() - recovery_started:.3f}s", flush=True)


if __name__ == "__main__":
    try:
        rehearse(sys.argv[1:])
    except (TimeoutError, RuntimeError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        sys.exit(str(error))
