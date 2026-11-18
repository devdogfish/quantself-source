# Deploying Quantself on Keep

[#209](https://github.com/devdogfish/quantself/issues/209) uses the Quantself VM
on Keep. Follow the named approvals in [#217](https://github.com/devdogfish/quantself/issues/217)
and the [cutover runbook](home-production-cutover.md). The synthetic
`keep-quantself` project and its backup policy are separate from the
production candidate. Preserve that proof and the active Hostinger deployment.

The private dashboard uses `qs.girke.dev` with Spaceship DNS. Follow the
[DNS runbook](infra/girke-dev-dns.md) for changes to its DNS or certificate scope.
Verify the Tailscale Owner sign-in handoff and trusted ingress before activation.

## Atlas production control relay

The [private control repository](https://github.com/devdogfish/quantself-atlas-control)
contains the Owner-dispatched promotion workflow. Keep's root-owned policy pins
its repository, workflow, Owner and exact protected `main` commit. The environment
permits deployments from `main`, and GitHub fork PR workflows are disabled.
During activation, set the reviewed Keep host and its exact Ed25519 pin in
`ATLAS_CONTROL_SSH_HOST` and `ATLAS_CONTROL_SSH_KNOWN_HOST`. Store the dedicated
`deploy-atlas` key in the `atlas-production` environment as `ATLAS_CONTROL_SSH_KEY`.

First export the exact source candidate from the isolated build guest directly
to the approved Keep staging location. Complete the signed evidence, backup and
runtime drain review there. The control workflow then sends the exact source
commit and GitHub run attempt to the Keep broker over pinned SSH.

### Prepare the independent Atlas relay guest

On the Debian amd64 relay guest, use the dedicated
`quantself-atlas-relay` service user and group with no login shell, sudo or Docker
access. Install [quantself-atlas-control-jit](../scripts/infra/home-production/quantself-atlas-control-jit)
root-owned mode 0755 at `/usr/local/sbin/quantself-atlas-control-jit`.
Install the pinned [GitHub Actions runner archive](https://github.com/actions/runner/releases/tag/v2.338.2)
root-owned mode 0644 at
`/usr/local/share/quantself-atlas/actions-runner-linux-x64-2.338.2.tar.gz`.
The launcher checks SHA-256
`baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40`
before starting the runner in a private systemd runtime directory. The unit
ends after the one job and has a 50-minute runtime cap. Use
`journalctl -u quantself-atlas-control-jit.service` on the relay guest for launch
diagnostics.

For an approved opt-in on an idle relay guest, root can run the updated launcher
with `--prepare-template` once. It verifies the pinned archive and atomically
publishes `runner-template-2.338.2` under the root-owned install directory.
Each launch validates the archive digest receipt, ownership, modes and links,
then copies the template as the service UID into a private, fresh systemd
runtime directory. The forced SSH command continues to take zero arguments.
Keep the pinned archive for fallback. Missing or invalid template evidence
selects normal verified extraction. To disable the option, move the template
out of the expected path as root while the relay is idle. The option adds
about 682 MiB of disk usage and no service between jobs.

On the operator Mac, use an explicit SSH alias for the independent relay
guest, with the verified host key in `known_hosts` and a dedicated operator
identity. The alias must run the fixed launcher as root. An administrator
account can use a restricted authorized key forced to
`sudo -n /usr/local/sbin/quantself-atlas-control-jit`, with a sudo rule permitting
that exact command with zero arguments. The relay service user has no access
to the operator's SSH or GitHub credentials.

### Run one queued relay

Use `QUANTSELF_DEPLOY_CONTROL_REPO=devdogfish/quantself-atlas-control bun run prod`
on clean Quantself `main`. It prints and watches the exact dispatch run ID.
While the relay job is queued, start its runner from another Mac terminal.
Set `control_sha` to the control commit in the Keep policy, `source_sha` to
the exact approved Quantself commit, and `run_id` and `attempt` to that queued run.

```sh
python3 -B scripts/infra/home-production/atlas-provision-jit.py \
  relay devdogfish/quantself-atlas-control 1459341623 quantself-atlas-control \
  --run-id "$run_id" --attempt "$attempt" --source-sha "$source_sha" \
  --control-sha "$control_sha" --relay-ssh-target atlas-relay-operator
```

The helper validates the Owner, protected control revision and exact queued job.
It issues the JIT configuration on the Mac using the Owner's GitHub CLI session,
sends the one-job credential over SSH stdin and waits for GitHub to confirm
assignment to the issued runner ID. Inspect the run and runner before retrying
a handoff with an uncertain outcome.

### Automatic handoff candidate

The opt-in path has been exercised with offline doubles. In an approved test
window, `QUANTSELF_ATLAS_RELAY_AUTO=1` makes `bun run prod` hand the single
dispatch response to the same Mac provisioner. Set `QUANTSELF_ATLAS_RELAY_CONTROL_SHA`
to Keep's pinned control commit and `QUANTSELF_ATLAS_RELAY_SSH_TARGET` to the
reviewed isolated guest alias. The opt-in is restricted to the existing private
control repository and starts only attempt 1. The manual path remains the default.

The provisioner waits up to five seconds for an authenticated attempt's job to
appear, then refreshes admission before issuing its exact runner label. A job
that already exists must match admission immediately. Both paths check for an
existing exact label with one inventory read in parallel with the other
admission checks. While the job is absent, only its listing is polled.
Both paths use a private per-attempt lock and issuance record on the operator
Mac. A failed or ambiguous launch leaves the original run and
issuance record for reconciliation. Use the pinned operator Mac for this path.
An isolated guest that cannot be reached or whose acknowledgment is lost can
leave an issued runner record. Inspect the original run and runner before a
new attempt. [Timing capture](home-production-timing.md#where-the-relay-waited)

## Stage the VM

- Keep a root-owned production checkout and mode 0600 `.env` in the approved
  deployment directory. The protected GitHub job supplies its short-lived
  Contents read and Actions read token over pinned SSH stdin for a deploy.
- Render `compose.yaml`, `compose.prod.yaml`, `compose.home.yaml` in that order
  under project name `quantself`. Restore app PostgreSQL, the auth secret,
  capture metadata, legacy conversion mounts and Codex state per the runbook.
  Use `https://qs.girke.dev` as the home origin. Only the API sees the
  scoped OpenCloud token. The application gateway is on loopback port 3000;
  Caddy on the VM terminates trusted private HTTPS on the tailnet IP.
- In the native analytics release, restore the primary Docker PostgreSQL
  database and apply the event, inquiry and tracked-link migrations. Import
  history from the frozen Umami dump in a disconnected fixture. Keep the
  verified two-database recovery point for rollback. The native home stack
  uses only Quantself's PostgreSQL. Stage its app environment without
  `QUANTSELF_UMAMI_WEBSITE_ID` or `QUANTSELF_UMAMI_READ_DATABASE_URL`, and
  validate the three Compose files with `config --quiet`. Home Compose clears
  both legacy values and removes the `portfolio-analytics_default` network dependency.
  Configure the four [API-only credentials](../deploy/gateway/README.md)
  before switching the portfolio. Assess storage for the verified image,
  imports and paired backup.
- Stage `scripts/infra/home-production/quantself-deploy` and
  `quantself-deploy-ssh` as root-owned mode 0755 in `/usr/local/libexec`.
  Stage the accompanying `.socket` and `@.service` as root-owned systemd units.
  Install and verify `gh`, `jq`, Python 3, the Keep backup helpers and `socat`. The dedicated
  `deploy` account requires no sudo, Docker group, forwarding or interactive
  shell access. Configure its one reviewed key and the sshd rules below only
  with the named approval. Test a fresh Owner login before closing the old one.

```text
Match User deploy
    AuthenticationMethods publickey
    ForceCommand /usr/local/libexec/quantself-deploy-ssh
    DisableForwarding yes
    PermitTTY no
    PermitUserRC no
```

Use a valid shell to let sshd run the forced command. Set `restrict` on the
dedicated authorized key. Validate effective sshd configuration for both users,
including denied root/password access, before reloading. Confirm the account
rejects unrelated commands, interactive access and forwarding. The root socket
accepts preflight or a GitHub run pointer with a bounded token message.
Preflight carries no token.

Store root-owned mode 0600 `/etc/quantself/deploy.env` with these settings:

| Setting | Value |
| --- | --- |
| `DEPLOY_PATH` | Absolute path of the root-owned production checkout |
| `PRODUCTION_URL` | `https://qs.girke.dev` |
| `PRODUCTION_HTTPS_IP` | VM's tailnet IPv4 for pinned TLS smoke via SSH |
| `BACKUP_READY_REVISION` | Reviewed exact main SHA, after backup compatibility and rollback review |
| `BACKUP_READY_IMAGE` | Full local image ID from that revision's verified release artifact |

Keep both settings unset until review. Run `build-private-image.yml` on the
exact main SHA and stage its verified artifact in the root-owned
`releases/<image ID without sha256:>/app-image/` under the deployment path.
Place its matching `web-drain.json` beside `app-image/`, root-owned mode 0600.
Use the exact image and home gateway in the drain rehearsal. Retain the previous
approved release for rollback. Backups look up the archive and proof by the
running image ID and preserve both with the recovery point.

```sh
python3 scripts/infra/keep-storage/prove-runtime-drain.py \
  --image "$verified_image_id" --home-auth --gateway-config Caddyfile.home \
  --api-sse --api-media --api-visitor-retention
```

Save the successful result's `proof` object as `web-drain.json`. Run the
fixture in an admitted, isolated Docker environment with the pinned
PostgreSQL and Caddy images loaded.

Check the [paired backup contract](home-production-cutover.md#admission)
before approving the next deployment. The deployment lock is
`/run/lock/quantself-production.lock`; the backup marker blocks deployment until production resumes.
Schedule a release window with no unresolved freeze or recovery.

Home keeps Inventory OCR/transcription preprocessing stopped. Deploy stages
its container without starting it so backups can verify the image and stopped
state. Keep existing jobs, original files and completed results. The Codex
enrichment worker can process eligible jobs. The old Girke provider is
optional and stays unset on Keep until a replacement is approved.

## Restore private Jobs configuration

After the paired restore audit passes, stage the Jobs files from the app tree
before starting home Compose. The recovery operator runs these commands on
the isolated target as root. `app_tree` is the verified app archive's `tree`
directory. The target paths are reserved for this clean restore.

```sh
test ! -e /etc/quantself/jobs/api/email-routes.json
test ! -e /etc/quantself/jobs/web/candidate-rules.json
install -d -o root -g root -m 0700 /etc/quantself/jobs/{api,web}
install -o root -g root -m 0600 \
  "$app_tree/deployment/jobs/api/email-routes.json" /etc/quantself/jobs/api/
install -o root -g root -m 0600 \
  "$app_tree/deployment/jobs/web/candidate-rules.json" /etc/quantself/jobs/web/
```

Verify the API and web mounts against the reviewed private inventory using
the [Jobs status checks](../scripts/jobs/README.md#stage-and-roll-back) in
one-off containers from the recovered image. Use the same status check on the
Mac for the runner's separate files. Recreate the corresponding service if
replacing an existing bind source so Docker opens the new file.

The redesigned Jobs API also requires `engineering.md`, `web.md`, and
`admin.md`. For a clean deployment, use the Owner-reviewed portable Markdown
derived from the existing Mac templates with contact placeholders. For recovery,
use `$app_tree/deployment/jobs/api/resume-templates` as `approved_templates`.
Stage only those three files on encrypted Keep storage. The directory belongs
to the API and is mounted read-only.

```sh
test ! -e /etc/quantself/jobs/api/resume-templates
install -d -o root -g root -m 0700 /etc/quantself/jobs/api/resume-templates
for track in admin engineering web; do
  install -o root -g root -m 0600 \
    "$approved_templates/$track.md" /etc/quantself/jobs/api/resume-templates/
done
```

The exact candidate API checks those permissions and parses the three files
before migrating. The read-only production preflight repeats the check on the
running API.

## Stage the private Mac Jobs runner

Set `QUANTSELF_JOBS_RUNNER_TAILNET_IPS` in the root-only
`/etc/quantself/ingress.env` to the approved Mac's exact Tailscale addresses.
Keep's private dashboard edge matches the connection source and the registered
Jobs worker methods and paths. It forwards the runner's bearer credential to
the API at `127.0.0.1:3001`. Test a claim, report and PDF transfer through the
private lane. Verify 404 for other internal paths, the runner routes from other
devices and the same paths on public Gate.

For an approved release, the Owner generates two distinct single-token
credentials of at least 32 characters. Store the pair in a root-owned mode 0600
JSON file with keys `JOBS_RUNNER_SECRET` and `JOBS_WORKER_SECRET`. Provision
the staged app environment from that file in one atomic update.

```sh
sudo python3 scripts/provision-runtime-env.py \
  /opt/quantself-production/.env --jobs-runtime-file "$approved_jobs_runtime_json"
```

The API receives both values. The Jobs Codex worker receives its worker
credential. The Mac receives its runner credential in its private runtime
config, with `JOBS_RUNNER_BASE_URL=https://qs.girke.dev` and the dedicated
loopback `JOBS_RUNNER_CDP_URL`. Configure the Mac using its reviewed runner
supervisor and verify both credential roles. See the [runner commands](../scripts/jobs/README.md).

For the final release, reconcile old and new Jobs queues. Fence new claims
and enqueueing first. Leave report routes available until admitted work settles,
then close the Mac lane before the first writer freeze. Preserve the Mac's
journals and outbox. Verify the scheduled backup covers the new worker's named
outbox and Jobs PDF originals before running a Jobs Codex batch on Keep.

Provision the release's named outbox before its first paired backup. For
recovery, restore the audited `tree/jobs-codex-outbox` into this fresh volume
with its numeric ownership and file modes preserved before enabling a batch.

```sh
docker volume create --driver local \
  --label com.docker.compose.project=quantself \
  --label com.docker.compose.volume=quantself_jobs_codex_outbox \
  quantself_quantself_jobs_codex_outbox
```

On the isolated restore target, verify the volume is empty before copying the
audited tree. Keep the batch stopped until the restored point is verified.

```sh
outbox="$(docker volume inspect --format '{{.Mountpoint}}' quantself_quantself_jobs_codex_outbox)"
test "$outbox" = /var/lib/docker/volumes/quantself_quantself_jobs_codex_outbox/_data
test -z "$(find "$outbox" -mindepth 1 -maxdepth 1 -print -quit)"
cp -a -- "$app_tree/jobs-codex-outbox/." "$outbox/"
```

The Keep launcher holds the production lock for the batch, checks the live
image matches the checkout, and leaves the named outbox for the next run.

```sh
sudo bash scripts/run-home-jobs-codex-worker.sh /opt/quantself-production
```

## Enable the protected GitHub environment

Use environment `production-home`, limited to deployments from `main`.
The Owner approves the exact revision and image in the VM's root-owned
deploy settings. Enable GitHub's additional required-reviewer rule if the
repository plan offers it. Set `HOME_DEPLOY_ENABLED=true` when the approved
VM is ready. The Owner enters these secrets directly in GitHub:

- `SSH_HOST`: VM's full tailnet DNS name. `SSH_KNOWN_HOSTS`: verified OpenSSH
  host key for that name. `SSH_PRIVATE_KEY`: dedicated CI key for `deploy`.
- `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET`: scoped Tailscale OAuth
  credentials for ephemeral `tag:ci` nodes. The tag has only TCP 22 to
  `tag:quantself`, with no dashboard or Vault grant.

With the production runtime staged and healthy, the Owner can run the
token-free VM-local preflight while the GitHub environment is disabled.

```sh
sudo -u deploy env SSH_ORIGINAL_COMMAND=preflight /usr/local/libexec/quantself-deploy-ssh </dev/null
```

The protected workflow can run this same preflight from `main` while
`HOME_DEPLOY_ENABLED` is unset. Run a home workflow dispatch with
`preflight_only=true` first, then the normal deploy from the
[README](../README.md#deploy). The VM verifies the
repository, workflow path, run ID, main SHA and run attempt. The token is used
only for the run lookup and exact repository fetch. The dispatcher runs the
deployment script from that verified Git revision. The VM verifies the staged
image archive and drain proof, then loads that exact image. Smoke tests
run on the VM against trusted TLS, so CI needs no TCP 443 grant. Check expiry
and disappearance of the ephemeral CI node, one successful deploy,
inaccessible public SSH, and Owner log following.

The existing production provision and phone verification workflows still
target Hostinger. Do not dispatch them against Keep. Apply the approved home
phone/provider settings with Owner access and verify the callbacks via
the [gateway checklist](../deploy/gateway/README.md).
