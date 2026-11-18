# Roundcube qualification scheduler

Stage these units for a dedicated Linux qualification VM with a local Docker engine and no route to production. The runner needs outbound access to the official Roundcube and GitHub release endpoints. Docker socket access is host-level authority. Keep the runner separate from the Atlas browser, Keep observer, and their credentials.

Use a root-owned, committed checkout at `/opt/quantself-roundcube-qualification/checkout`. Prepare the existing joined fixture images for its `bun.lock` on the runner's local Docker engine. Supply the trusted `/etc/quantself-roundcube-qualification/qualification.json` from #514 with a provisioned installed-version manifest, prior archive and signature, trusted upstream public key, and the explicit pair review when applicable. Refresh the manifest from the approved installed release record. The scheduler reads a local copy.

The timer is staged disabled. Its proposed cadence is daily at 05:00 Halifax. Runner, cadence and activation require their separately reviewed window. The oneshot prevents overlap and is bounded to five minutes. Reserve space in `/run` for both expanded release trees and the fixture source archive. The scratch directory is visible to the local daemon so fixture bind mounts resolve. The supervisor forwards termination and keeps scratch available for up to 25 seconds while the fixture tears down its Compose project. An in-flight `compose down` is shielded from the forwarded signal and remains subject to the service hard stop. If teardown fails or exhausts that budget, use the Compose project name in the journal to reconcile that project's resources before manual retry.

The service preserves the checker's JSON result and exit status. `no_candidate` means discovery found no newer eligible security patch. `review_required` exits zero and includes the plan awaiting explicit review. `fixture_qualified` includes the qualification receipt. A `failed` result exits nonzero. Unit failures also produce an error-priority event, including failures before the checker can emit JSON.

```sh
journalctl -u quantself-roundcube-qualification.service --grep='"status": "review_required"'
journalctl -u quantself-roundcube-qualification.service --grep='"status": "failed"'
journalctl -t quantself-roundcube-qualification-failure -p err
systemctl show -p Result -p ExecMainStatus quantself-roundcube-qualification.service
```

Use the service journal for the full plan or diagnostic. The existing Keep backup and restore alerts have their own scopes. The scheduler exposes local journal events for a separately approved monitoring route.

The service invokes only `--qualification-config`. A qualification receipt is evidence for separate revalidation. Release promotion and rollback stay under their existing approval gates.
