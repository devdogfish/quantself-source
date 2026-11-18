# Tailscale Owner sign-in (#209)

## Contract

Keep runs the app and API with `QUANTSELF_PUBLIC_ORIGIN=https://qs.girke.dev` (also used by browser origin checks and notifications), and the same `QUANTSELF_OWNER_INGRESS_TOKEN` as its trusted Caddy listener. The Owner provisions a random 32-byte token encoded as 64 lowercase hex characters; keep it out of Git, diagnostics, logs and client responses. App and API listeners stay private. The proof is a runtime setting. A missing or malformed token denies Owner access. Existing Keep configuration can supply the origin through `BETTER_AUTH_URL` during the transition.

Only the exact private HTTPS site can inject `X-Quantself-Owner-Proof`, and only for the two explicitly approved Tailscale peers. Confirm both nodes belong to the Owner in Tailscale and constrain the listener to tailnet traffic. Establish eligibility from the direct authenticated peer; never use a client or forwarded IP, claimed login, email, or user ID. Strip the incoming proof and Tailscale identity headers before matching, and from all other paths and upstream hops, including the public relay. Ingress must overwrite or strip client forwarded host and scheme, preserve the real browser Origin, and prevent shared caching. Keep health and machine routes separate from Owner proof; reverse proxies and the Next server forward the proof only to the private app/API. Revoke access at the tailnet/ingress, terminating existing connections (including live task streams); rotate the proof in both services and Caddy if exposed.

The proof maps to the existing singleton `AuthOwner.userId`. No user creation, session issuance, login round trip or database migration. A missing Owner row denies access; restore the authoritative database before activating Keep. Unsafe browser requests must carry Origin `https://qs.girke.dev`. Legacy browser cookies, login, bootstrap and passkey management are unavailable on Keep. An explicit `X-API-Key` takes precedence in the API even if Owner proof is present: invalid keys deny, valid keys keep only their original scopes. Webhook handlers still require their own credentials/signatures and must never receive proof from public ingress. Machine requests may use proof-free health. Next’s shared image optimizer can only read bundled public assets; private media use authenticated API routes.

## Live evidence and rollback

- From clean browser state on the approved Mac **and** iPhone, open `https://qs.girke.dev` and confirm trusted TLS, automatic access, and the same Owner ID from `/api/v1/access-context` as at the legacy deployment. Verify an Owner page, Settings credentials, a reversible same-origin write and Undo, and the live task stream. Verify a foreign or missing Origin cannot write. Reinstall the iPhone Home Screen app at the new origin and re-enable/test Web Push; service workers, subscriptions and browser storage are origin-bound.
- From outside Tailscale and from an unapproved device (including another device of the same Owner), test dashboard denial with forged proof, Tailscale identity and forwarded addresses. Test spoofing through the webhook and Agent routes, direct-origin denial, proof-free CI health, and that Keep does not accept the old session cookie.
- Use real Agent credentials to observe an allowed action and a denied broader permission. Confirm audit attribution for a supported Agent write. Observe live signed Twilio, ElevenLabs, GitHub and analytics deliveries for the configured ingress allowlist; prove rejected bad signature/credential and unrelated paths. Record status/timing and the exact app and ingress revisions in the #209 cutover ledger; never log secrets.
- Preserve the Hostinger release, `BETTER_AUTH_URL` and RP ID for `dashboard.girke.dev`, auth secret, users, sessions, passkeys and DB recoverability. Prove Owner passkey sign-in at that original origin as part of rehearsal. A Keep certificate for `qs.girke.dev` cannot recover a passkey scoped to the old hostname. Roll back via the original deployment/hostname with `QUANTSELF_OWNER_AUTH=passkey` (default) and its saved configuration; freeze/reconcile writes per the paired-storage rollback before switching the active writer. Do not enable public or alternate ingress to Keep as a fallback.

#347 retires browser passkey code from future Keep releases. Current releases
use the existing Owner row, retain scoped Agent credential management and
preserve all provider checks. The schema, migrations, auth-secret volume and
legacy recovery inputs are retained.

The [#209 cutover evidence](https://github.com/devdogfish/quantself/issues/209#issuecomment-6898372932)
records the isolated production database and Vault restore. The
[#347 hosted rehearsal](https://github.com/devdogfish/quantself/actions/runs/43745954883/job/132909173433)
used the verified, pre-cleanup native rollback image
`1350301b12fa3600720bb8f81181715e2ea7659a` and a synthetic paired point.
On an isolated target it verified the same Owner's passkey at
`https://dashboard.girke.dev` with trusted HTTPS, exact original hashes and
recording ranges, preserved deletion, and duplicate analytics replay.
Use the retained Hostinger release and configuration for the pre-write rollback,
or the native-compatible release and matching paired recovery point for post-write rollback.
