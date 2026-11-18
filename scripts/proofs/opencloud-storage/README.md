# OpenCloud storage proof

Synthetic integration experiment for ADR 0048. Uses real OpenCloud, Docker PostgreSQL and headless Chromium, **not the Quantself application's routes or schema**. Never imports production records or credentials.

From the repository root:

```sh
scripts/proofs/opencloud-storage/run.sh
```

Requires Docker, Bun, Node, Python 3, curl and FFmpeg. Installs pinned Playwright into a private temporary directory and ensures its Chromium is present. Uses localhost ports 19200 (OpenCloud) and 19201 (a minimal authenticated streaming proxy); leave both free. No PostgreSQL host port is published.

The runner generates an isolated Compose project and synthetic administrator password. OpenCloud is pinned by version and digest. Self-signed TLS and PostgreSQL trust authentication are confined to this disposable local test. These are not deployment settings.

The experiment creates application, Owner-viewer and outsider identities; an originals space; one synthetic receipt PNG; one eight-second Opus/WebM tone; and a private sentinel document. PostgreSQL contains a tiny proof-only table. Tests cover app tokens, permissions, guarded upload retries, hashes, file IDs, browsing, ranges, Chromium rendering/playback/seek, database-only listing and backup/restore into new volumes and a separate database. Expiry/revocation/rotation are exercised after restore.

Backup uses GNU tar with xattrs/ACLs/numeric ownership while OpenCloud is stopped; this is a consistency proof, not a PBS backup test. Restored playback uses a fresh browser context so it cannot reuse the original audio from browser cache. The proxy forwards streams and Range headers; it is only a proof harness, not production-ready application code.

The runner removes only its own disposable containers, network and volumes on exit. The printed private temporary directory retains `results.json`, generated fixtures, screenshot, configuration and backup evidence. **That directory includes synthetic passwords/tokens in its `.env` and OpenCloud backup; do not commit or publish the directory.** Only reviewed credential-free results belong in `docs/validation/`.

Version-specific findings:

- Root-space invitation/permissions endpoints in 7.2.0 use `/graph/v1beta1`; user/drive creation uses `/graph/v1.0`.
- Discover the root-space roles (`Can edit` / `Can view`); their IDs differ from individual-file sharing roles. Recipients require `@libre.graph.recipient.type`.
- Do not rely on conditional PUT for no-overwrite. Use unique staging paths and MOVE with `Overwrite: F`, then verify the final SHA-256 before completing the database operation.
- App tokens authenticate using a Basic header even with account-password Basic authentication disabled. Scope is the service identity's access, not a per-folder restriction on the token itself.

Use the accompanying validation report for measured results and remaining production gates. Passing this experiment is not permission to cut over Hostinger or remove originals.
