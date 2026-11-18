# Analytics platform comparison (r1)

Date: 2026-11-14. Setup: girke.dev (Next.js on Vercel) plus Quantself (Next.js, Bun API, Postgres in Docker) on one small Hostinger VPS. Low traffic (hundreds to low thousands of visits/month). Needs: keep data forever, raw events for custom reports, minimal ops.

Verification legend: **[P]** = primary source fetched (official docs, repo file, release page). **[S]** = secondary/mirror/search snippet only. **UNVERIFIED** = could not confirm.

---

## 1. Corrections to the premise

1. **Umami does not store custom metadata in a JSON column.** Custom event data goes into table `event_data` as key/value rows with typed columns (`string_value`, `number_value`, `date_value`, `data_type`). No JSON column on `website_event`, `event_data`, or `session_data`. [P] https://raw.githubusercontent.com/umami-software/umami/master/prisma/schema.prisma
2. **No Umami retention or 90-day deletion setting was found.** The env-var reference lists no retention, deletion, or cleanup variable (only `SALT_ROTATION`, which rotates the session salt, not stored data). [P] https://docs.umami.is/docs/environment-variables . Event models have no retention field. [P] schema above. If the live instance deletes data at 90 days, the cause is not documented Umami behavior and must be found on the box (cron, SQL job, or another tool). UNVERIFIED on the live instance.
3. **Umami 3.4.1 is a security hotfix release.** It upgrades Next.js to 16.4.2 for a critical RCE in `next/og` and other fixes. [P] https://newreleases.io/project/github/umami-software/umami/release/v3.4.1 . Latest is **v3.5.0 (12 Nov)**, which requires `APP_SECRET` set explicitly and Node 20.19+, and drops `/api/config`. [P] https://github.com/umami-software/umami/releases/tag/v3.5.0
4. **Umami link tracking path:** official docs say `/q/<slug>`. [P] https://docs.umami.is/docs/links . A Mintlify mirror says `/l/` [S]. Trust the official docs.

---

## 2. Comparison table

| Option | License | Retention / auto-delete | Storage, min resources | Custom event properties | Raw export / SQL / API | Cookieless | Bot filtering | Redirect / link tracking | Maintenance (latest seen) |
|---|---|---|---|---|---|---|---|---|---|
| **Umami 3.5.0** (self-host) | MIT [P] https://github.com/umami-software/umami/blob/master/LICENSE | No retention setting [P] env docs; no retention fields in schema [P]. Kept until deleted (inferred from absence). | PostgreSQL 12.14+ and Node 20.19+ [P] https://docs.umami.is/docs/install . RAM not stated [P]. ClickHouse client in `package.json` and ClickHouse e2e test scripts [P] https://raw.githubusercontent.com/umami-software/umami/master/package.json , but ClickHouse is not in official install docs. How to enable: UNVERIFIED. Do not use. | Key/value rows in `event_data`, typed columns [P] schema. Docs: `umami.track()` accepts strings, numbers, booleans, arrays, objects; attribute values stored as strings. No limits documented [P] https://docs.umami.is/docs/event-data | Direct SQL on Postgres: `website_event`, `event_data`, `session_data` tables [P] schema. API described as "any operation in the app is available in the API", JSON; event endpoint paths UNVERIFIED [P] https://docs.umami.is/docs/api | Yes: "without cookies or personal data" [P] https://umami.is/ | Bots excluded from stats by default; `DISABLE_BOT_CHECK` to turn off [P] https://docs.umami.is/docs/environment-variables | Yes: Links (`/q/` redirect, records click, merges UTMs, clicks/uniques/referrers/geo). "Available since v3.0.0." Raw per-click export not documented [P] https://docs.umami.is/docs/links | v3.5.0 on 12 Nov (year not on page; 2026 inferred from © 2026 and v3.0.0 dated 07 Nov 2025) [P] https://github.com/umami-software/umami/releases . Active. |
| **PostHog self-hosted** (hobby deploy) | Core MIT; `ee/` separately licensed [P] https://github.com/PostHog/posthog/blob/master/LICENSE | Self-hosted: "keep events until you delete them" [P] https://posthog.com/docs/data/events-retention | Hobby stack: Postgres, ClickHouse, Kafka, Zookeeper, Redis, MinIO, Caddy [P] https://posthog.com/docs/self-host/deploy/hobby . Docs say "equivalent to a Hetzner VM with 4 vCPU, 16GB RAM, and more than 30GB storage" [P] same page. Image tags listed are old (ClickHouse 22.3, Kafka 2.8.1), so the page may be stale. | Event properties, `properties.` prefix in HogQL [P] https://posthog.com/docs/hogql . Per-event limits UNVERIFIED. | HogQL (SQL over `events`), Query API; free during public beta [P] https://posthog.com/docs/hogql . Batch exports mentioned [P] events-retention page. | `cookieless_mode`: `always` or `on_reject`; must also be enabled in project settings [P] https://posthog.com/docs/libraries/js/config | `opt_out_useragent_filter` (default false) drops googlebot and similar by default; `custom_blocked_useragents`. No IP filter in that page [P] same. | UNVERIFIED | Core releases active. GitHub releases page shows 14 Nov 2026 tags (mostly non-core tags) [P] https://github.com/PostHog/posthog/releases . Self-hosted: no official support [P] hobby page. |
| **Plausible Community Edition** | App: AGPL-3.0 [P] https://github.com/plausible/analytics ; CE deploy repo: MIT [P] https://github.com/plausible/community-edition ; tracker MIT [P] https://plausible.io/docs/self-hosting | No built-in retention. Maintainer answer (2021): "Clickhouse has a `TTL` directive"; pruning is manual [P, dated] https://github.com/plausible/analytics/discussions/1354 . Later community TTL steps [S] same thread. | PostgreSQL (accounts) and ClickHouse (events) [P] https://github.com/plausible/analytics ; 2 GB RAM recommended, CPU must support SSE 4.2 or NEON [P] https://github.com/plausible/community-edition | Custom props documented as **Business (Cloud) plan** feature [P] https://plausible.io/docs/custom-props/introduction . Limits (cloud doc): 30 props per event, key 300 chars, value 2000 chars [P] same. CE inclusion UNVERIFIED (CE "excludes" list does not name custom props [P] https://github.com/plausible/analytics). | CE excludes Sites API [P]. Stats API and CSV export documented under Cloud only [P] https://plausible.io/docs/self-hosting . CE direct ClickHouse access [S/UNVERIFIED]. | UNVERIFIED | UNVERIFIED | UNVERIFIED | Latest tag v3.2.1 dated "15 May" (year not on page; 2026 inferred) [P] https://github.com/plausible/analytics/releases . |
| **Matomo** | GPL v3 [P] https://github.com/matomo-org/matomo/blob/5.x-dev/LICENSE | Built-in "Regularly delete old raw data" (Administration > Privacy > Anonymize data) [P] https://matomo.org/faq/general/configure-data-retention/ . Default not stated [P]; forum says default is never delete [S] https://matomo.org/faq/troubleshooting/faq_42/ | **MySQL 8.0+ or MariaDB 10.6+** (Matomo 6). PostgreSQL not listed [P] https://matomo.org/docs/requirements/ . 100k pageviews/mo = 2 CPU, 2 GB RAM, 50 GB SSD [P] same. | Custom dimensions; FAQ title says default is 5 [P-ish] https://matomo.org/docs/custom-dimensions/ . Limits otherwise UNVERIFIED. | UNVERIFIED (Reporting API; raw visits API not checked) | UNVERIFIED | UNVERIFIED | UNVERIFIED | Matomo 6.1.0-alpha dated 13 Nov 2026 (pre-release) [P] https://github.com/matomo-org/matomo/releases |
| **OpenPanel** | AGPL-3.0 [P] https://github.com/openpanel-dev/openpanel | Not described; `openpanel reset` deletes databases [P] https://openpanel.dev/docs/self-hosting/self-hosting | Postgres, ClickHouse, Redis, Redpanda. At least 4 GB RAM [P] same page. | UNVERIFIED | CLI export: gzipped JSONL per table and day, filter by project and dates [P] https://openpanel.dev/docs/self-hosting/self-hosting . API sections exist (Track, Export, Insights) [P] same. | Cookieless by default [P] https://github.com/openpanel-dev/openpanel (comparison table) | UNVERIFIED | UNVERIFIED | No GitHub releases shown [P]. Recency UNVERIFIED. |
| **Rybbit** | AGPL-3.0 [P] https://github.com/rybbit-io/rybbit | Not stated [P] https://rybbit.com/docs/self-hosting | ClickHouse (repo has `clickhouse` folder; ARM note) [P]. Postgres UNVERIFIED. "At least 2GB of RAM" [P] https://rybbit.com/docs/self-hosting . Setup script + Docker Compose. | JSON custom events listed; no limits [P] https://github.com/rybbit-io/rybbit | Not stated | "No cookies" [P] | UNVERIFIED | Not mentioned [P] | No GitHub releases shown. UNVERIFIED. |
| **Swetrix CE** | AGPL-3.0 [P] https://github.com/swetrix/swetrix | Not covered [P] | MySQL (accounts), ClickHouse (events), Redis [P] same. RAM "2 GB" is vendor-sourced only [S] https://shop.zimaspace.com/pages/swetrix-hardware-requirements . | Custom events and properties; no limits [P] https://github.com/swetrix/swetrix | CSV export; developer statistics API [P] same | "No cookies" [P] same | No filtering described [P] same | Not mentioned [P] | No GitHub releases shown. UNVERIFIED. Docs URL `docs.swetrix.com` not fetchable. |
| **Counterscale** | MIT [P] https://github.com/benvinegar/counterscale | Analytics Engine keeps max 90 days; older data copied to R2 as Apache Arrow by default [P] https://github.com/benvinegar/counterscale | Cloudflare Workers + Analytics Engine (+ R2). No Postgres. Node 20+ [P] same. | Not documented [P] | No export/SQL documented; AE over Cloudflare API [P] same | Not explicit [P] | Not mentioned [P] | Pageview-based; manual pageviews [P] same | Releases page inconsistent; UNVERIFIED |
| **Roll your own** (events table in existing Postgres) | Your code | You define. Postgres partition `DROP` is "far faster" than bulk `DELETE` [P] https://www.postgresql.org/docs/current/ddl-partitioning.html | Existing Postgres | `jsonb` column or key/value table (Umami uses key/value) | Full SQL | You implement (no cookies is easy) | You implement (UA filter) | You implement (`/r/:slug` 302 that logs a row) | n/a |

---

## 3. Per-option notes

**Umami 3.5.0.** Fits the stated needs most closely with the least new infrastructure: MIT, Postgres only in docs, no retention setting, cookieless, bot-excluded by default, native Links (the closest match to "per-job-application link opens"), and raw SQL over `website_event` and `event_data`. Gaps: no documented property limits; time-on-page and scroll depth are not built in (send them as `umami.track` events); Links-click raw-record access not documented (verify on the instance whether a click creates a `website_event` row). Breaking change in v3.0.0: MySQL dropped [P] https://github.com/umami-software/umami/releases/tag/v3.0.0 . Release cadence is high (v3.4.1 23 Oct, v3.5.0 12 Nov) [P].

**PostHog self-hosted.** Strongest query surface (HogQL, batch exports, cookieless mode, UA filter). Weakest fit for this VPS: docs ask for ~4 vCPU and 16 GB RAM and run eight services including Kafka and ClickHouse [P]. Self-hosted has no official support [P]. Overkill for hundreds to low thousands of visits per month.

**Plausible CE.** Retention forever by default is consistent with the 2021 maintainer answer [P, dated], but there is no built-in retention control. Requires ClickHouse plus Postgres [P]. Custom props are a Cloud Business feature in docs [P]; CE inclusion unverified. Heavier ops than Umami for no gain at this scale.

**Matomo.** MySQL/MariaDB only [P] rules it out for a Postgres-based stack unless adding a second database. Retention is manual and default unclear [P/S]. Custom dimensions default 5 [P-ish]. Actively released (6.1.0-alpha) [P].

**OpenPanel.** Good export story (JSONL per table and day) [P], AGPL, cookieless [P]. Needs Postgres + ClickHouse + Redis + Redpanda and 4 GB RAM [P]. Heavier than Umami; less mature signal (no GitHub releases shown) UNVERIFIED.

**Rybbit / Swetrix.** AGPL, ClickHouse-based [P]. Neither documents retention or link tracking [P]. Two extra datastores for low traffic. Swetrix RAM figure is vendor-sourced only.

**Counterscale.** MIT [P], but Analytics Engine data is capped at 90 days [P] and there is no custom-event or raw-export model documented [P]. Fails "keep forever with raw events" unless you depend on the R2 archive format, which is undocumented for querying. Not recommended.

**Roll your own.** Full control, no new service, Postgres partition `DROP` for any future pruning [P]. Costs: you build the dashboards, bot filtering, and redirect endpoint. At thousands of visits per month a single table with `jsonb` properties and an index on `(event_name, created_at)` is more than sufficient; partitioning is optional.

---

## 4. Answers to specific questions

- **Does Umami have built-in data retention or deletion?** No setting found in the env-var reference [P] or schema [P]. Deletion appears to be manual (delete website / soft-delete flags). UNVERIFIED on the running instance.
- **Umami storage engine:** PostgreSQL per docs [P]. ClickHouse client present in code [P], not documented, not recommended.
- **Umami bot filtering:** on by default; `DISABLE_BOT_CHECK` disables it [P].
- **Umami cookieless:** yes, per product statement [P]. Session identity uses a rotating salt (`SALT_ROTATION`) [P env docs]. Exact hash inputs UNVERIFIED.
- **Umami event property limits:** none documented [P].
- **Umami raw export API paths:** UNVERIFIED (the `/docs/api/export` page returned 404 [P]).

---

## 5. Recommendation for this setup

**Stay on Umami, upgrade to 3.5.0, and run custom reporting as read-only SQL on the existing Postgres.**

Reasoning:
1. Keep-forever: Umami has no retention setting [P]. Only Plausible CE (manual TTL), Matomo (manual purge), PostHog (self-hosted keeps events) and roll-your-own also fit. Counterscale fails.
2. Raw events and custom reports: `website_event` and `event_data` are plain Postgres tables [P]. Reports can be ordinary SQL with a read-only role. This matches "raw events for custom reports" without a second datastore.
3. Minimal ops: one Node app plus the Postgres already running. Every alternative adds ClickHouse (Plausible, Rybbit, Swetrix, OpenPanel, PostHog) or MySQL (Matomo), or needs 16 GB RAM (PostHog).
4. Per-job-application links: Umami Links [P] already do redirect + click log + UTM merge. Check on the instance whether clicks produce `website_event` rows.
5. Gaps to cover in the relay/client, whichever tool: time per page and scroll depth (send as `umami.track` events on `pagehide`/scroll thresholds with flat, typed keys), and CTA clicks (`data-umami-event-*`) [P event-data docs]. Keep metadata flat; property limits are undocumented, so test with a realistic payload.

Actions:
- Upgrade 3.4.1 to 3.5.0 (security hotfix in 3.4.1; set `APP_SECRET` explicitly) [P].
- Confirm on the box that nothing deletes data (check cron/jobs and that `website_event` row count grows monotonically). Find the source of the "90-day" behavior if it exists.
- Create a read-only Postgres role for report queries.
- Test Links click persistence and `event_data` write path on a staging copy before relying on it.

Fallback: if Umami's schema churn or UI becomes a blocker, replace it with a roll-your-own Postgres events table (one table, `jsonb` properties, optional monthly partitions) fed by the existing Bun relay. This is the best option if you want the schema under your control. Do not adopt PostHog, Plausible CE, Matomo, OpenPanel, Rybbit, Swetrix, or Counterscale for this VPS and traffic level.

---

## 6. Maintenance snapshot (latest seen)

| Project | Latest seen | Source |
|---|---|---|
| Umami | v3.5.0, 12 Nov (2026 inferred) | https://github.com/umami-software/umami/releases |
| PostHog | Core tags not isolated; releases page shows 14 Nov 2026 tags | https://github.com/PostHog/posthog/releases |
| Plausible CE | v3.2.1, 15 May (2026 inferred) | https://github.com/plausible/analytics/releases |
| Matomo | 6.1.0-alpha, 13 Nov 2026 (pre-release) | https://github.com/matomo-org/matomo/releases |
| OpenPanel, Rybbit, Swetrix, Counterscale | No GitHub releases shown; UNVERIFIED | respective GitHub repos |

---

## 7. UNVERIFIED list

- Umami: RAM/CPU minimums; event API endpoint paths and limits; Links raw click records; ClickHouse enablement; hash inputs for session salt.
- PostHog: custom property limits; link/redirect tracking; current core release tag.
- Plausible CE: custom props in CE; CE Stats API; CE cookieless and bot filtering; CE RAM figures beyond the community-edition README.
- Matomo: default retention values; cookieless; bot filter; redirect tracking; raw visit API.
- OpenPanel, Rybbit, Swetrix: release dates; Postgres usage for Rybbit; Swetrix RAM (vendor only).
- Counterscale: current maintenance status.
- Plausible 2021 retention answer is dated; current CE retention UNVERIFIED.

## 8. Source index

- Umami: https://github.com/umami-software/umami ; https://github.com/umami-software/umami/blob/master/LICENSE ; https://docs.umami.is/docs/environment-variables ; https://docs.umami.is/docs/event-data ; https://docs.umami.is/docs/install ; https://docs.umami.is/docs/links ; https://docs.umami.is/docs/api ; https://umami.is/ ; https://github.com/umami-software/umami/releases ; https://github.com/umami-software/umami/releases/tag/v3.0.0 ; https://github.com/umami-software/umami/releases/tag/v3.5.0 ; https://newreleases.io/project/github/umami-software/umami/release/v3.4.1 ; https://raw.githubusercontent.com/umami-software/umami/master/prisma/schema.prisma ; https://raw.githubusercontent.com/umami-software/umami/master/package.json ; [S] https://www.dreamhost.com/guides/umami/umami-or-plausible/ ; [S, 410] https://www.mintlify.com/umami-software/umami/self-hosting/clickhouse
- PostHog: https://posthog.com/docs/self-host/deploy/hobby ; https://github.com/PostHog/posthog/blob/master/LICENSE ; https://posthog.com/docs/data/events-retention ; https://posthog.com/docs/hogql ; https://posthog.com/docs/libraries/js/config ; https://github.com/PostHog/posthog/releases
- Plausible: https://github.com/plausible/community-edition ; https://github.com/plausible/analytics ; https://github.com/plausible/analytics/releases ; https://github.com/plausible/analytics/discussions/1354 ; https://plausible.io/docs/self-hosting ; https://plausible.io/docs/custom-props/introduction
- Matomo: https://matomo.org/docs/requirements/ ; https://matomo.org/faq/general/configure-data-retention/ ; https://matomo.org/faq/troubleshooting/faq_42/ [S] ; https://matomo.org/docs/custom-dimensions/ ; https://github.com/matomo-org/matomo/blob/5.x-dev/LICENSE ; https://github.com/matomo-org/matomo/releases
- OpenPanel: https://github.com/openpanel-dev/openpanel ; https://openpanel.dev/docs/self-hosting/self-hosting
- Rybbit: https://github.com/rybbit-io/rybbit ; https://rybbit.com/docs/self-hosting
- Swetrix: https://github.com/swetrix/swetrix ; [S] https://shop.zimaspace.com/pages/swetrix-hardware-requirements
- Counterscale: https://github.com/benvinegar/counterscale
- Postgres: https://www.postgresql.org/docs/current/ddl-partitioning.html
