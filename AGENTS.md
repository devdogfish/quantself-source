# AGENTS.md

When reporting information to the user, be extremely concise and sacrifice grammar for concision.

## Performance and fetch efficiency

Performance is a priority for the Owner. Treat responsive loading and efficient data access as design requirements from the outset, not later optimizations.

- Before adding or changing a fetch flow, account for request count, sequential dependencies, payload size, and how work scales with task/record count. Apply standard database practices to external APIs too.
- Prefer bulk queries and writes, select only needed fields, and fetch only the records required for the operation. Eliminate N+1 requests and redundant full-collection rereads.
- Run independent requests concurrently with bounded concurrency; keep requests sequential only where correctness requires an earlier result.
- Preserve pagination completeness, authorization, freshness, prerequisite checks, conflict detection, and retry safety. Task reads may use the API-owned rebuildable cache specified in #117/#124; GitHub remains authoritative and writes validate current source facts. Optimize query shape and coalesce refresh work before adding cache layers.
- Render useful UI immediately with explicit loading/error states. A pending fetch must not leave an unexplained blank page.
- For fetch changes, verify request counts and relevant latency; distinguish cold setup from warm requests. Add regression coverage for avoidable fan-out. Normal task detail views target at most two GitHub requests after authentication, with explicit pagination exceptions. Report measured results rather than assuming fewer requests guarantee faster loading.

## Responsive interaction

Make reversible UI actions optimistic by default. Quantself is used repeatedly throughout the day; immediate, predictable feedback should make using it rewarding. Keep subsequent actions, Undo and Redo available while writes save. Preserve later intent when responses arrive; reconcile failures visibly and narrowly. For mutation UI, read [the responsive interaction standard](docs/responsive-interaction.md) and verify behavior with deferred responses, not just fast successful saves.

## UI styling fixes

Treat feedback about a control's appearance as a styling request. Match the adjacent component's open and closed states in the live app. Preserve placement behavior, focus, keyboard interaction, and form values unless the user requests a change.

## Protected documentation

Treat `docs/github-systems/` as read-only. Change its files only with the user's explicit approval.

## Agent skills

### Infrastructure sessions

Before infrastructure setup, recovery tests, credential handoffs or deployment/cutover work (especially #209), read [the infrastructure session workflow](docs/agents/infrastructure-sessions.md). It defines preparation, resumable execution, scoped approvals and reuse of verified evidence.

### girke.dev DNS

Before changing DNS, ingress, certificate scope or redirect hostnames for `girke.dev`, follow the [DNS runbook](docs/infra/girke-dev-dns.md). Spaceship owns registration and authoritative DNS.

### Issue tracker

Issues and PRDs live in GitHub Issues for `devdogfish/quantself`; external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default triage label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo: root `CONTEXT.md` plus root `docs/adr/`. See `docs/agents/domain.md`.

Website application tracking: see docs/website-analytics.md; the portfolio owns redirect destinations.

### Personal inventory placement

For “where should I put this?” questions, read root `INVENTORY-CONTEXT.md`.

### Database runtime

PostgreSQL for this project runs in Docker only.

- Never open, connect to, inspect, configure, or modify Postgres.app for project work.
- Before database work, discover the existing project container with `docker compose ps` and `docker ps`; use its published port and the project connection configuration.
- Do not assume `localhost:5432` is the project database, and never fall back to a host-installed PostgreSQL server.
- If the intended container or connection configuration is unclear, ask the user before starting or changing any database runtime.

Use the `bun` package manager.

Verify with `bun run typecheck` and `bun run test`. The test command keeps `--isolate` to prevent mocks leaking between files. Use `bun run test ./path/to/file.test.ts` for focused checks. Historical `sandcastle:checks` references are obsolete.
