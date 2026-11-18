# QuantSelf

Personal operating system for health, productivity, and environment signals.

## Stack

- Next.js 16 App Router
- Postgres + Prisma 7
- Bun workspaces
- Chakra UI v3, TypeScript, Lucide icons

See [frontend setup and component workflow](apps/web/README.md).

## Local Dev

Install dependencies once, then start the complete development stack:

```bash
bun install
bun run dev
```

The command starts/reuses the project's Docker PostgreSQL container, waits for
health, generates Prisma and applies checked-in migrations. Next.js and the API
then run directly on your machine with source watching—no app image build or file syncing.
The command also starts a Cloudflare tunnel and updates/verifies Jarvis task callbacks.
Docker Desktop must be running, and `cloudflared` must be installed. Logs stay in one terminal. Ctrl-C stops Next.js
the API and the tunnel; PostgreSQL and its data remain available.

Keep the whole `bun run dev` supervisor running in a persistent terminal/process.
A leftover web/API process can serve localhost while Jarvis's public callback is
dead. If that happens, stop that development instance and restart the full command;
wait for `Jarvis callbacks and task-only credential verified` before reconnecting
Jarvis. Startup allows up to three minutes for tunnel DNS propagation and verifies
authenticated reachability before replacing provider callbacks.

On macOS, enable automatic recovery with `bun run dev:service start` (stop any
foreground development instance first). This installs a per-user LaunchAgent,
starts at login, and supervises the full web/API/tunnel stack. One process owns
the development stack, including during retry delays; a second launch fails clearly.
Managed failures retry up to five attempts, with exponential backoff from 30 seconds
to five minutes (HTTP 429 always waits five minutes). Exhaustion opens the circuit;
`bun run dev:service start` explicitly retries after the cause is fixed. Normal failure
exits never trigger an unlimited launchd restart loop. Managed children share the
supervisor's process group so even a killed supervisor cannot leave stale servers
behind. Recovery briefly interrupts the app; an existing voice conversation may
need reconnecting after its quick-tunnel URL changes.

Use `bun run dev:service status` for state and log location, `stop` to stop until
next login, or `remove` to stop and disable login startup. Logs are private at
`~/Library/Logs/Quantself/dev.log`; credentials load from the existing `.env`,
never from the LaunchAgent file. Docker Desktop must still be running.
See Apple's [launchd guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).

- Next.js: tries port 3000, then the next available port; the selected URL is printed.
- API: a separate OS-assigned loopback port (also proxied through Next.js).
- PostgreSQL: native dev discovers the selected Docker container's published loopback port. The default project is `quantself-dev`.

Fresh setups let Docker choose a free database port. Override it with
`QUANTSELF_POSTGRES_PORT=5436 bun run dev` on first setup. Existing containers
and their bindings are preserved. Native uploads/recordings default to `storage/`;
set `QUANTSELF_DEV_STORAGE_ROOT` in `.env` to use an existing local directory.
Integration credentials are loaded from the root `.env`. Development uses local
auth defaults; `QUANTSELF_DEV_AUTH_SECRET` overrides the local secret if needed.
Jarvis needs `QUANTSELF_ELEVENLABS_API_KEY` and `QUANTSELF_ELEVENLABS_AGENT_ID`
in `.env`. Set `QUANTSELF_DEV_ELEVENLABS_AGENT_ID` to select a dedicated agent
only for native development, leaving the production agent setting intact.
Use a dedicated development agent with cloned webhook tools; separate
agents sharing tool IDs still share callback URLs and credentials. Development
refuses to retarget callbacks from a stable production origin. Its tools must
already target a development tunnel. Callback URLs follow each new tunnel. A private local credential file
is reused and renewed automatically, retaining task-only permissions and a 24-hour
lifetime. `QUANTSELF_DEV_JARVIS=0` explicitly disables the tunnel and Jarvis setup.
Native development uses a loopback Owner ingress for the displayed localhost URL. It creates a local fixture Owner only in an empty database.

For reliable local Jarvis, use a dedicated named Cloudflare tunnel instead of
creating disposable quick tunnels on every restart. Set `QUANTSELF_DEV_TUNNEL_ORIGIN`
to its dedicated HTTPS hostname and `QUANTSELF_DEV_TUNNEL_CONFIG` to an absolute
cloudflared YAML path. Its ingress must route that hostname to `http://127.0.0.1:3000`
with a final `http_status:404` rule. Keep tunnel credentials/config private. Named
ingress should expose only health and the authenticated task/GitHub callback routes;
leave the local dashboard and auth routes inaccessible through this hostname. Named
mode requires the dedicated development agent setting and refuses to move the web
server off port 3000. Provision the new tunnel/DNS separately; never reuse production
tunnels or overwrite their routes. Jarvis only migrates existing development callbacks
and verifies authenticated reachability before updating them. Opt-in GitHub webhook
sync likewise refuses to replace production callbacks. Without named configuration,
the quick-tunnel fallback remains available for short-lived development.

### Development caches and previews

Use Ctrl-C to stop a preview, including its Next.js child processes and stub
API. Each preview has its own development output under `apps/web/.next/`.
Turbopack keeps compilation in memory by default. Set
`QUANTSELF_DEV_TURBOPACK_DISK_CACHE=1` to opt in to persistent cache for native
development. Previews run with persistent caching disabled.

Stop this checkout's Next.js processes before running `bun run dev:clean`.
It clears known Next.js development caches only in this checkout and refuses
to clear them if a development lock or symlink is present. The optional
`bun run dev:clean --docker-images` also removes dangling images carrying the
`quantself-dev` Compose project label on a local Docker socket. Shared BuildKit
cache requires separately verified ownership, such as a Quantself-only builder
or known cache record IDs.

### Database consolidation

Shared routing is opt-in per checkout. Set `QUANTSELF_SHARED_DEV_DATABASE` in
that checkout's private `.env` after its database is ready. Native dev looks
up the running `quantself-shared-dev` Compose project's PostgreSQL container
and checks the exact database before Prisma runs. Use one `qs_dev_` name per
checkout. Provision new checkouts with their own empty database.

Proposed mapping for an Owner-approved copy:

| Existing Compose project / database | Database in `quantself-shared-dev` | Legacy route on rollback |
| --- | --- | --- |
| `quantself-dev` / `quantself` | `qs_dev_checkout` | `QUANTSELF_DEV_POSTGRES_PROJECT=quantself-dev` (default) |
| `quantself-main-dev` / `quantself` | `qs_dev_main` | `QUANTSELF_DEV_POSTGRES_PROJECT=quantself-main-dev` |

1. Confirm the target and both mappings before copying. Discover each source
   with `docker compose ps` and `docker ps`. Confirm the database name,
   PostgreSQL version, locale, extensions and any nondefault role grants.
   Keep source and target Compose projects and volumes distinct. For the
   proposed new target, start only PostgreSQL after approval with
   `docker compose -p quantself-shared-dev -f compose.yaml -f compose.dev.yaml up -d --wait --no-recreate postgres`.
2. Pause writers for each source during its snapshot and verification. Take a
   separate private `pg_dump --format=custom` archive for each source. In the
   shared target, create each mapped database empty and restore its archive with
   `pg_restore --single-transaction --no-owner --no-privileges --dbname=<mapped-database>`.
   Check each restored database against its source, including migration history,
   representative records, and access under the target role. Keep the original
   databases and archives available.
3. Set the shared database name and the legacy rollback project from the table
   in each checkout. Keep its storage root and auth settings. Restart the
   affected development supervisor and verify that each checkout reaches its
   own records, auth and media.
4. To roll back, stop the affected development supervisor and clear
   `QUANTSELF_SHARED_DEV_DATABASE`. Keep the mapped legacy project selection.
   If the shared copy has accepted writes, pause and capture them before
   returning traffic to the original. Restart and verify against the original
   database. Keep the shared copy available for reconciliation.

The shared checkout databases use the same trusted local development role.
Sandcastle keeps its isolated Compose project and credentials. The analytics
dashboard continues to validate its legacy Docker binding. Production data
pulls continue to use the legacy project selected by
`QUANTSELF_DEV_PROJECT_NAME`. From a shared checkout, explicitly clear
`QUANTSELF_SHARED_DEV_DATABASE` and select that legacy project before pulling.

Rehearse the two restores locally with the cached `postgres:18-alpine` image:

```bash
QUANTSELF_DEV_POSTGRES_FIXTURE=1 bun run test scripts/dev-postgres.fixture.test.ts
```

The test creates one temporary Compose project with a loopback port and
in-memory data directory, verifies both routes from Bun, then removes the
fixture.

## Commands

- `bun run dev` - native Next.js/API plus Docker PostgreSQL
- `bun run prod` - complete monitored production deployment
- `bun run dev:api` - API only (requires configured database/environment; root dev selects an available port)
- `bun test` - tests
- `bun run typecheck` - Prisma generate + TS checks
- `bun run build` - production build
- `bun run build:api` - production API bundle
- `bun run db:migrate` - apply checked-in migrations
- `bun run db:migrate:dev` - create/apply a new development migration
- `bun run db:migrate:deploy` - production migrations
- `bun run data:pull-production --yes` - replace local non-auth DB data and inventory media from production; incompatible tables are skipped

## Deploy

Deploy from a clean, committed `main`. `bun run prod` dispatches GitHub
Actions, verifies the running site, then follows app, API and gateway logs.
Ctrl-C detaches the logs. Pushing `main` alone does not deploy.

Deploy current releases to Keep from an approved tailnet device using the Owner SSH
alias and production checkout. Hostinger recovery uses the [retained release and
rollback configuration](docs/tailscale-owner-auth.md#live-evidence-and-rollback).

```bash
QUANTSELF_SSH_TARGET=quantself-owner \
QUANTSELF_DEPLOY_PATH=/opt/quantself-production \
QUANTSELF_PRODUCTION_URL=https://qs.girke.dev bun run prod
```

The alias in this example must resolve to the VM using the pinned host key.
CI joins the tailnet ephemerally as `tag:ci` and logs in as the restricted
`deploy` service account. The Owner's own SSH login follows logs with sudo.
See the [deployment setup](docs/home-production-deploy.md),
[gateway configuration](deploy/gateway/README.md) and
[cutover and rollback runbook](docs/home-production-cutover.md).

Production identity:

```dotenv
QUANTSELF_PUBLIC_ORIGIN=https://qs.girke.dev
QUANTSELF_INSTANCE_NAME="Quantself Prod 1.0"
QUANTSELF_OWNER_EMAIL=production@quantself.valid
```

Owner access uses the singleton identity in the restored production database.

Compose runs a one-shot migrator, the Next.js web app, the Hono API, an internal
Caddy path-routing gateway, Postgres, and both private Inventory workers. When
`BETTER_AUTH_SECRET` is blank, Compose generates it once and persists it in
`quantself_auth_secret`; an explicit environment value overrides the file.
Back up and restore that volume with the database. Inventory image uploads
persist in `quantself_inventory_uploads`, audio uploads persist in
`quantself_inventory_audio_uploads`, file attachments persist in
`quantself_inventory_asset_uploads`, and Codex login state persists in
`quantself_codex_home`.

The retained Hostinger rollback release lives in `/root/quantself`. Its external
Caddy in `/root/api` targets `quantself-web:3000` over `girke-edge`. The
Quantself gateway sends `/api/*` and `/llms.txt` to Hono and other traffic to Next.js.
The previous Oracle Quantself containers and database are stopped and retained
only for rollback. Wiki, n8n, and Excalidraw remain hosted on Oracle.

Private workers call the API only over the internal Compose network. The Girke
preprocessing worker uses `INVENTORY_PREPROCESSING_WORKER_SECRET` plus
server-only `GIRKE_API_TOKEN`. The Codex enrichment worker uses
`INVENTORY_ENRICHMENT_WORKER_SECRET`, does not expose a public port, and does
not need `GIRKE_API_TOKEN`.

First deploy needs one ChatGPT login inside the worker volume:

```bash
cd /root/quantself
docker compose \
  -f compose.yaml \
  -f compose.prod.yaml \
  run --rm \
  --entrypoint /app/apps/web/node_modules/.bin/codex \
  inventory-codex-enrichment-worker login
COMPOSE_FILE=compose.yaml:compose.prod.yaml ./scripts/check-inventory-workers.sh
```

## Inventory

`/inventory` is implemented in the Next app with server actions, Prisma models,
local image storage, deterministic metadata, and keyword/alias search.

See [docs/inventory.md](docs/inventory.md).

## Phone Jarvis

Phone Jarvis uses a Twilio voice number with ElevenLabs' native `register-call`
integration. The native integration connects the audio stream; a Twilio account
and number are still required. The browser Jarvis agent stays separate.

Setup:

1. Sign in to Twilio, finish account/billing setup, and obtain a voice-capable
   number. Trial accounts may require verifying the Owner's destination number.
2. Provision the GitHub/ElevenLabs source credentials and telephone settings.
   The server bootstrap creates and verifies a dedicated task-only API key;
   no manual key handling or Owner key reuse is needed.
3. Fill the phone entries in [.env.example](.env.example). Numbers use E.164
   (`+` followed by country code and number). `QUANTSELF_PHONE_PUBLIC_URL` is the
   public HTTPS origin, without a path. Keep `QUANTSELF_PHONE_ENABLED` unset.
4. Choose a private 6–12 digit PIN. Hash it locally with `hashPhonePin` from
   `apps/api/src/phone-jarvis-security.ts`; store only its salted result in
   `QUANTSELF_PHONE_PIN_HASH`. Do not put the PIN in command history or chat.
5. Deploy the checked-in image/migration with `QUANTSELF_PHONE_ENABLED` unset.
   The production image includes all setup scripts. Once the API is healthy, run
   the **Bootstrap disabled production Phone Jarvis** GitHub Actions workflow
   from `main`. It uses the existing server SSH connection, verifies that current
   remote `main`, checked-out server source and the running API image have the
   same revision, and refuses to run if either the next Compose configuration or
   the existing API process has phone enabled. It never deploys/restarts services.

   Bootstrap creates a custom `todos:read`/`todos:write` credential for the
   established Owner, verifies its exact scope against the running API, and
   configures the separate private ElevenLabs phone agent internally. Raw keys
   remain in mode-0600 server files and child environment; no key is printed or
   extracted to the runner. Persistent receipts live under the private
   capture-volume directory `.phone-bootstrap/`; the workflow discovers the
   actual configured capture root. Interrupted creation fails closed until
   reconciled. Successful retries reuse the credential and agent. The agent
   preserves voice/model/retention settings, uses `ulaw_8000` audio, and receives
   the Halifax clock/recent summaries per call.

   The workflow copies the private generated runtime fragment into a mode-0700
   server directory and merges its key/agent ID into the server dotenv file
   without displaying contents. This leaves the phone disabled; enable only
   after Twilio settings are ready. No local SSH access or manual key handling
   is needed. `QUANTSELF_TODO_PROJECT_NUMBER` and `QUANTSELF_JARVIS_TOOL_ORIGIN`
   are supported production runtime settings; use the stable production origin,
   never a development tunnel.
6. In Twilio's number settings, set the incoming voice webhook to
   `https://YOUR_ORIGIN/api/v1/phone-jarvis/inbound`, method **POST**.
7. Provision production runtime values before enabling. The separate
   **Provision production runtime configuration** workflow consumes the production
   environment secret `QUANTSELF_RUNTIME_CONFIGURATION`, a JSON object containing
   only the supported runtime keys. It atomically updates the VPS `.env` over SSH
   without restarting services or printing credentials. Its allowlist lives in
   `scripts/provision-runtime-env.py`; unsupported keys and values containing
   apostrophes or dollar signs fail before any write. Existing multiline PEM
   assignments are replaced as complete values.
8. Apply the checked-in database migration through the normal production deploy,
   then set `QUANTSELF_PHONE_ENABLED=1` and deploy. Explicit enablement with missing
   configuration fails startup. Clearing the flag disables new phone runtime work.

Validation:

```bash
bun run typecheck
bun run test
```

The full test command runs 64 short-lived isolated shards with up to three workers and prints a combined result. Use smaller selections during development and native shards for CI.

```bash
bun run test ./apps/web/app/todo/todo-location-input.test.tsx
bun run test --shard=1/16
```

Verify an actual inbound call requires the PIN, rejects an incorrect PIN and
unknown caller, then connects to Jarvis after authentication. Confirm a requested
read/create/edit uses production tasks and the conversation/audio archive appears
in Quantself. Do not place a verification call without the Owner's instruction.
For an authorized outbound check, dispatch **Request one Owner verification call**
from `main` after deployment and enablement. It verifies the running revision,
calls only the configured Owner, and claims a durable slot before dialing.
Rerunning the same Actions run cannot place another call; ambiguous delivery
requires reconciliation instead of automatic retry.
The nightly scheduler runs at 21:00 America/Halifax, independently of task state;
one retry at 21:10 occurs only after busy/no-answer. An uncertain call-creation
response suppresses automatic redial. Recording/transcript retention remains
indefinite until Owner deletion.

Provider reference: [ElevenLabs Twilio register-call setup](https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/register-call).

### Jarvis habits (#147 / PRD #142)

Habit server tools work in web and phone Jarvis through the existing versioned
API. Existing task keys remain task-only. Before live enablement, the Owner must
explicitly grant `habits:read` and `habits:write` to each intended agent key;
logging never needs `habits:delete`. No setup script widens grants.

After deploying the API, run the guarded sync separately for each agent:

```sh
QUANTSELF_JARVIS_HABIT_ORIGIN=https://your-api.example \
  bun apps/api/scripts/sync-jarvis-habits.ts --environment=production --channel=web
```

Use `--channel=phone` for `QUANTSELF_ELEVENLABS_PHONE_AGENT_ID`; web uses
`QUANTSELF_ELEVENLABS_AGENT_ID`. Both need `QUANTSELF_ELEVENLABS_API_KEY`.
The explicit origin must match the attached `read_tasks` webhook. For a dedicated
development agent use `--environment=development`, `QUANTSELF_DEV_ELEVENLABS_AGENT_ID`
(or `QUANTSELF_DEV_ELEVENLABS_PHONE_AGENT_ID`) and its HTTPS tunnel origin.
Named tunnels also require `QUANTSELF_DEV_TUNNEL_ORIGIN`.
Development bootstrap still creates task-only credentials; do not attach habit
tools to that automatically rotated key. Use a separately Owner-granted key and
agent for habit development. Run phone habit sync after ordinary phone setup.

Default is read-only preview. After reviewing the target and granting access,
add `--apply --owner-granted-habits`. Sync backs up provider configuration with
private file permissions, checks concurrent edits, recovers exact orphan tools,
and verifies tools, prompt, privacy and unrelated settings after writing.
It never changes the nightly 21:00 schedule or enables additional calls.

Tools read one habit day, apply revision/before-state occurrence commands, append
idempotent urge commands, and retrieve documents plus 14 local days of facts.
Advice discloses unavailable inputs; ambiguous habit/date/outcome input requires
clarification. Rules remain read-only. Existing context exports still default to
28 days; `GET /api/v1/habits/context?days=14` selects voice grounding.

Release verification requires deployed tools and real web **and** phone voice:
read today's habits; clarify an ambiguous name; log a neutral test occurrence and
urge; replay the identical commands without duplicates; verify correction against
current revision, denied task-only keys, and advice grounded in retrieved rules.
In the existing evening call verify open habits are reviewed without another call.
Setup/readback and unit tests alone do not verify live voice logging.

## License

QuantSelf source is available under the [MIT License](LICENSE). The bundled
label fonts use the [SIL Open Font License](apps/web/lib/fonts/LICENSE.md).
