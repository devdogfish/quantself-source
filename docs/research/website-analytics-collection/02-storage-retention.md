# R2: Storage, retention, privacy, backups for website analytics events

Date of research: 2026-11-14. Scope: PostgreSQL 18 in Docker on one VPS, Bun + Prisma, about 10k to 50k events/month.

Conventions: every claim has a URL. `[calc]` = my arithmetic from sourced numbers. `UNVERIFIED` = no primary source read, or source failed to load.

---

## 1. Storage shape

### 1.1 Typed columns vs JSONB

- Postgres docs: jsonb is "a decomposed binary format" that is "significantly faster to process, since no reparsing is needed"; "most applications should prefer to store JSON data as jsonb". https://www.postgresql.org/docs/18/datatype-json.html
- Fixed fields (`occurred_at`, `kind`, `site_id`, `browser_id`, `path`, `scroll_pct`, `active_ms`) should be typed columns. Only variable per-kind extras go in `props jsonb`.
- GIN on jsonb: default `jsonb_ops` vs `jsonb_path_ops` (smaller, value-only, no key-exists operators). https://www.postgresql.org/docs/18/datatype-json.html
- At this volume an expression index on `props->>'x'` is enough. GIN is not needed.

### 1.2 Types

- `timestamptz`: 8 bytes, 1 µs resolution, stored internally as UTC. https://www.postgresql.org/docs/18/datatype-datetime.html
- `smallint` 2 B, `integer` 4 B, `bigint` 8 B, `double precision` 8 B, `numeric` variable. https://www.postgresql.org/docs/18/datatype-numeric.html
- `uuidv7()` exists in PG18. Release note: "This UUID value is temporally sortable." https://www.postgresql.org/docs/18/release-18.html and https://www.postgresql.org/docs/18/functions-uuid.html
- The docs say only "time-ordered". The claim that it improves B-tree insert locality is `UNVERIFIED` as a docs claim (general B-tree behavior, not sourced here).

### 1.3 Row and index size

Sourced layout numbers (https://www.postgresql.org/docs/18/storage-page-layout.html):
- Page header 24 B.
- Item pointer 4 B per row.
- Heap tuple header 23 B "on most machines", plus null bitmap if any column is NULL, plus MAXALIGN padding.

TOAST (https://www.postgresql.org/docs/18/storage-toast.html): only rows wider than about 2 kB are toasted. Typical event rows never are. Each TOAST pointer is 18 B.

Estimated per-row size for the schema in section 2 (`[calc]`, from the numbers above, not measured):
- Heap row: about 200 B of data + about 32 B header + 4 B pointer = about 230 to 240 B.
- Indexes (PK on uuidv7 + btree on `(kind, occurred_at)`): about 50 to 60 B/row. BRIN on time is negligible.
- Total: about 0.25 to 0.35 GB per million events. `UNVERIFIED` until measured.

Scale at 50k events/month `[calc]`:
- About 15 MB/month.
- About 6M events in 10 years, about 2 GB total.

Storage is not a constraint. Measure with `pg_total_relation_size` after loading 1M synthetic rows, to replace these estimates.

### 1.4 Indexes

- BRIN: "designed for handling very large tables in which certain columns have some natural correlation with their physical location within the table." Summaries update as new pages fill. Lossy, so rows are rechecked. Autosummarize is off by default. https://www.postgresql.org/docs/18/brin.html
- Index size comparison: a blog post reports a BRIN index of about 32 KB against about 214 MB for B-tree on a 574 MB heap. This is one unreproduced post, so `UNVERIFIED` as a benchmark. https://dev.to/software_mvp-factory/postgresql-brin-indexes-for-time-series-mobile-telemetry-when-a-128-page-index-beats-a-50gb-b-tree-3b18 (search snippet; page not fetched)
- Recommendation: a BRIN on `occurred_at` (cheap, append-only) plus a btree on `(kind, occurred_at)` or `(site_id, occurred_at)` for dashboard queries. At 50k rows/month, even a plain btree on `occurred_at` is fine.
- `pages_per_range` default: the BRIN page I read does not state it. Commonly cited as 128 `UNVERIFIED`.

### 1.5 Partitioning

Declarative partitioning (https://www.postgresql.org/docs/18/ddl-partitioning.html):
- Range/list/hash supported. Pruning on partition key is on by default.
- "up to a few thousand partitions fairly well"; planner cost and session memory grow with partitions.
- `DETACH PARTITION ... CONCURRENTLY` needs only `SHARE UPDATE EXCLUSIVE` on the parent.
- Unique and PK constraints must include all partition key columns. So if you partition by `occurred_at` later, the PK becomes `(event_id, occurred_at)`.

Verdict at this volume: **not needed for performance.** Monthly partitions would give about 12 partitions per year. Benefit is operational only: retention by `DROP`/`DETACH` instead of `DELETE` + vacuum. At 50k rows/month a daily `DELETE` is trivial.

If you want it anyway, pg_partman is the usual tool:
- Retention default: `retention` column defaults NULL (keep everything).
- `retention_keep_table` defaults TRUE, meaning children are detached, not dropped. Set FALSE to drop.
- `premake` default 4. Background worker `pg_partman_bgw.interval` default 3600 s. Source: https://github.com/pgpartman/pg_partman/blob/master/doc/pg_partman.md

TimescaleDB: retention works on chunks, and continuous aggregates can outlive raw rows. Source (search snippets, not fetched): https://docs.tigerdata.com/use-timescale/latest/data-retention . Overkill for this volume: extra extension in a Docker image for no measurable gain `UNVERIFIED` as a benchmark claim.

### 1.6 When ClickHouse makes sense

- ClickHouse MergeTree is for "massive data volumes"; the sparse primary index is held entirely in memory, granule default 8192 rows. https://clickhouse.com/docs/guides/best-practices/sparse-primary-indexes
- The docs give no row-count switchover point. Heuristic `UNVERIFIED` (my judgment, no source): stay on Postgres until one of these holds: a few hundred million rows, sustained ingest in the thousands of rows/second, or dashboards that need full scans over billions of rows. None of these is near this project.

### 1.7 Archive format

- DuckDB Parquet defaults `[from search snippets of DuckDB docs, not fetched]`: `ROW_GROUP_SIZE` default 122,880 rows; compression default snappy.
  - https://duckdb.org/docs/lts/data/parquet/tips.html
  - https://duckdb.org/docs/2.0/sql/statements/copy
- Use case: after the raw retention window, export raw months to Parquet on cold storage and keep them queryable with DuckDB. This is an option only if you want raw data beyond the window (see section 3).

---

## 2. Recommended schema (PostgreSQL 18)

```sql
-- Event log: append-only, pseudonymous, no raw IP, no names.
CREATE TABLE site (
  site_id  smallint PRIMARY KEY,
  host     text NOT NULL UNIQUE          -- portfolio, dashboard
);

CREATE TABLE visit_event (
  event_id      uuid PRIMARY KEY DEFAULT uuidv7(),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  site_id       smallint NOT NULL REFERENCES site(site_id),
  kind          text NOT NULL CHECK (kind IN (
                  'pageview','heartbeat','scroll_depth',
                  'cta_click','redirect_open','contact_submit')),
  browser_id    uuid,                    -- random first-party ID; NULL after tier-1 purge
  ip_day_id     bytea,                   -- HMAC(daily_key, ip); daily_key deleted after 24 h; NULL after tier-1 purge
  path          text,
  referrer_host text,
  scroll_pct    smallint CHECK (scroll_pct BETWEEN 0 AND 100),
  active_ms     integer CHECK (active_ms >= 0),   -- heartbeat delta
  target        text,                    -- CTA id or redirect slug
  props         jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX visit_event_time_brin ON visit_event USING brin (occurred_at)
  WITH (pages_per_range = 32, autosummarize = on);
CREATE INDEX visit_event_kind_time ON visit_event (kind, occurred_at);

-- Contact inquiries: PII, separate table, NOT linked to analytics IDs.
CREATE TABLE contact_inquiry (
  inquiry_id    uuid PRIMARY KEY DEFAULT uuidv7(),
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  name          text,
  email         text NOT NULL,
  message       text NOT NULL,
  closed_at     timestamptz,
  purge_after   timestamptz               -- set on close, e.g. closed_at + 24 months (policy choice)
);

-- Daily rollups: aggregate counts only, no IDs. Kept forever.
CREATE TABLE daily_rollup (
  day            date     NOT NULL,
  site_id        smallint NOT NULL REFERENCES site(site_id),
  kind           text     NOT NULL,
  path           text     NOT NULL DEFAULT '',
  events         bigint   NOT NULL,
  unique_browsers integer NOT NULL,       -- COUNT(DISTINCT browser_id) that day, computed before raw purge
  unique_ip_days  integer NOT NULL,       -- COUNT(DISTINCT ip_day_id) that day
  PRIMARY KEY (day, site_id, kind, path)
);
```

Rollup job (run nightly, before raw purge):

```sql
INSERT INTO daily_rollup (day, site_id, kind, path, events, unique_browsers, unique_ip_days)
SELECT (occurred_at AT TIME ZONE 'UTC')::date, site_id, kind, COALESCE(path, ''),
       count(*), count(DISTINCT browser_id), count(DISTINCT ip_day_id)
FROM visit_event
WHERE occurred_at >= $1 AND occurred_at < $2          -- one closed UTC day
GROUP BY 1, 2, 3, 4
ON CONFLICT (day, site_id, kind, path) DO UPDATE
  SET events = EXCLUDED.events,
      unique_browsers = EXCLUDED.unique_browsers,
      unique_ip_days = EXCLUDED.unique_ip_days;
```

Tier-1 purge (identifier strip) and tier-2 purge (delete). Both run as batches:

```sql
-- Tier 1: after 13 months, strip linkable identifiers, keep the event row.
UPDATE visit_event SET browser_id = NULL, ip_day_id = NULL
WHERE occurred_at < now() - interval '13 months'
  AND (browser_id IS NOT NULL OR ip_day_id IS NOT NULL);

-- Tier 2: after 25 months, delete raw rows. Rollups survive.
DELETE FROM visit_event WHERE occurred_at < now() - interval '25 months';
```

If you later partition, the PK must become `(event_id, occurred_at)` (docs constraint in section 1.5).

---

## 3. Retention and privacy

### 3.1 Canada (PIPEDA)

- Applies to organizations collecting personal information "in the course of commercial activities" (s. 4(1)(a)). Whether a non-commercial personal portfolio is in scope is `UNVERIFIED` for your case. The dashboard and any Dawnshift-related use may be commercial. https://laws-lois.justice.gc.ca/eng/acts/P-8.6/page-1.html
- Personal information = "information about an identifiable individual." https://laws-lois.justice.gc.ca/eng/acts/P-8.6/page-1.html
- Principle 4.5: personal information "shall be retained only as long as necessary for the fulfilment of those purposes." Clause 4.5.3: information "no longer required to fulfil the identified purposes should be destroyed, erased, or made anonymous." https://laws-lois.justice.gc.ca/eng/acts/P-8.6/page-7.html
- OPC: an IP address "can be considered personal information if it can be associated with an identifiable individual." https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/pipeda-compliance-help/pipeda-interpretation-bulletins/interpretations_02/
- OPC on de-identified data: it "does not qualify as anonymous information" if "there is a serious possibility of linking the de-identified data back to an identifiable individual." Same URL.
- OPC's 2013 IP report is archived; it shows IP-derived data can reveal interests and location. https://www.priv.gc.ca/en/opc-actions-and-decisions/research/explore-privacy-research/2013/ip_201305/
- Quebec Law 25 (anonymised data rules, retention) `UNVERIFIED`, not read. Relevant only if you have Quebec-based users or a Quebec business.

Reading: "forever raw events with persistent IDs" is hard to justify under 4.5, because the purpose ("understand portfolio traffic") does not need raw per-visitor rows for decades. "Forever aggregates without identifiers" is easy to justify under 4.5.3 ("made anonymous", as long as the aggregation is real).

### 3.2 EU (GDPR), if EU visitors are in scope

- Art. 3(2)(b) can reach a non-EU controller that monitors behaviour "as far as their behaviour takes place within the Union." https://gdpr-info.eu/art-3-gdpr/
- Art. 5(1)(e) storage limitation: data "kept in a form which permits identification of data subjects for no longer than is necessary for the purposes for which the personal data are processed." Longer periods are allowed for archiving, research or statistics "subject to implementation of the appropriate technical and organisational measures." https://gdpr-info.eu/art-5-gdpr/
- Recital 26: pseudonymised data "which could be attributed to a natural person by the use of additional information should be considered to be information on an identifiable natural person." Identifiability is judged by "all the means reasonably likely to be used." https://gdpr-info.eu/recitals/no-26/
- CJEU C-413/23 P (EDPS v SRB), 4 Sept 2025, ECLI:EU:C:2025:645: the Court takes a relative view of pseudonymised data. A recipient without means of re-identification may not be handling personal data. The controller holding the key still does. Read via secondary sources, not the judgment: https://www.skadden.com/insights/publications/2025/11/in-a-landmark-decision-eu-court-clarifies and https://cm.twobirds.com/en/insights/2025/eu-the-srb-decision-a-new-era-for-personal-data-and-data-processing-agreements . Full judgment text `UNVERIFIED`.
- EDPB Guidelines 01/2025 on Pseudonymisation: adopted 16 Jan 2025, public consultation. Final status `UNVERIFIED`. https://www.edpb.europa.eu/news/edpb-adopts-pseudonymisation-guidelines-and-paves-the-way-to-improve-cooperation-with_ga
- ICO (UK, as persuasive guidance): pseudonymised data "is personal data in the hands of someone who holds the additional information." Hashing of guessable inputs weakens protection. Draft-era pages; check final. https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-sharing/anonymisation/pseudonymisation/
- Key point for IPs: the IPv4 space is about 4.3 billion values `[calc/known]`. A salted or unsalted hash of an IP is guessable if the key/salt leaks. Keeping one HMAC key for years is the risky case. Rotating or deleting the key removes the linkage.
- Article 29 WP216 (Opinion 05/2014 on anonymisation) would be the primary source for hashing; the PDF failed to load. `UNVERIFIED`. Link: https://ec.europa.eu/justice/article-29/documentation/opinion-recommendation/files/2014/wp216_en.pdf
- ePrivacy Art. 5(3) on storing a random browser ID (localStorage/cookie) for analytics on EU devices: consent normally required; exemptions are narrow. `UNVERIFIED`, not fetched in this run.

### 3.3 What comparable products do

- Plausible (primary source, https://plausible.io/data-policy, page dated Nov 2026):
  - "Raw IP addresses and User-Agent data are never stored."
  - The salt is "rotated and deleted every 24 hours."
  - No cookies and no persistent visitor identifiers.
  - Retention period not stated on the page. `UNVERIFIED`.
- Fathom: its privacy page covers Fathom's own website visitors, not the analytics product's method. It says Fathom processes IP and User-Agent briefly and keeps partial logs after a DDoS. No salt rotation or retention period found. https://usefathom.com/privacy . Analytics-product behaviour `UNVERIFIED`.
- CNIL audience-measurement exemption (France): secondary sources say raw data retention is capped at 25 months and tracker lifetime at 13 months. Primary cnil.fr page failed to load (404). Figures are `UNVERIFIED` at primary-source level. https://www.wsgrdataadvisor.com/2020/10/cnil-issues-updated-cookie-guidance/ and https://truendo.com/en/blog/what-is-audience-measurement-cookies-consent-exemption

### 3.4 Recommended policy (for a personal portfolio, with a documented purpose)

| Data | Identifiers | Keep | Basis |
|---|---|---|---|
| `visit_event` tier 0 | browser_id, ip_day_id, all fields | 0 to 13 months | Principle 4.5; matches CNIL 13-month tracker cap (secondary) |
| `visit_event` tier 1 | identifiers NULLed, event fields kept | 13 to 25 months | Event without linkable ID; low singling-out risk `[judgment]` |
| `visit_event` tier 2 | deleted | after 25 months | Principle 4.5; CNIL 25-month cap (secondary) |
| `daily_rollup` | counts only, no IDs | forever | Made anonymous under 4.5.3 if small-cell suppression applied `[judgment]` |
| `contact_inquiry` | name, email, message | until closed + N months, or on request | Principle 4.5.3; N is a policy choice |
| Browser ID | random first-party | expire at 13 months, rotate | CNIL tracker cap (secondary); ePrivacy `UNVERIFIED` |
| IP-derived ID | HMAC with daily key | key deleted after 24 h | Plausible pattern (primary) |
| Raw IP | never stored | n/a | Plausible pattern (primary) |

Rules that follow:
1. Never store raw IPs. Derive the day ID at request time, then drop the IP.
2. Rotate the HMAC key daily and delete old keys. A forever-stable key turns the IP ID into a permanent identifier.
3. Keep contact inquiries out of the analytics tables. Do not join them to `browser_id`.
4. Small-cell suppression in public rollups (for example, hide any count below 5) `[judgment, no source]`.
5. Write the purpose down in one paragraph. Retention is defensible when tied to that purpose.

"Raw events forever" as asked: not recommended. Principle 4.5 makes indefinite identifiable raw rows hard to defend, even for a personal project. The defensible alternative is the tiered table above, with rollups kept forever. If you still want raw data beyond 25 months, keep only the tier-1 form (no identifiers) and export it to Parquet (section 1.7).

---

## 4. Backups

- pg_dump: consistent snapshot without blocking readers or writers. The docs warn it is "generally not the right choice for taking regular backups of production databases" except in simple cases. https://www.postgresql.org/docs/18/app-pgdump.html
- Custom format `-Fc` is compressed by default (gzip, moderate). Directory format `-Fd` is the only one that supports `-j` parallel dumps. Same URL.
- Size estimate `[calc]`: plain text is about 100 to 150 B per row for this schema; custom format compression about 3 to 5x `UNVERIFIED`. Expect about 40 to 80 MB per million events compressed. At 6M events, about 250 to 500 MB. `UNVERIFIED` until run.
- PITR: `pg_dump` "cannot be used as part of a continuous-archiving solution." For point-in-time recovery use `pg_basebackup` plus WAL archiving. WAL segments are 16 MB by default and "a busy system will generate many megabytes of WAL." https://www.postgresql.org/docs/18/continuous-archiving.html . At this volume WAL is modest `UNVERIFIED` magnitude.
- Off-site: the docs do not prescribe a destination. Practical setup `[judgment]`:
  - Nightly `pg_dump -Fc` of the `visit_event`, `daily_rollup`, `contact_inquiry` tables and the rest of the DB.
  - Encrypt before upload (age or gpg), then send to S3-compatible object storage in another region or provider.
  - Rolling window of about 35 days of dailies plus a few monthlies.
- Backups hold deleted data too. Set the backup window to match the retention policy, for example 35 days, so purged analytics rows leave backups in bounded time `[judgment]`. Note this in the policy.
- Restore test: run a restore into a scratch container once per quarter. `UNVERIFIED` practice recommendation, no source.

---

## 5. Open items

- Measure real per-row size with 1M synthetic rows (`pg_total_relation_size`, `pg_relation_size` on the BRIN and btree).
- Read the CJEU judgment text (curia.europa.eu) and the final EDPB pseudonymisation guidelines.
- Read WP216 (the PDF failed to load) and the CNIL primary page (404 on fetch).
- Confirm Plausible's retention period on their docs or source.
- Confirm whether the site is in PIPEDA scope (commercial activity) for the Dawnshift-related dashboard.

## Sources

- https://www.postgresql.org/docs/18/ddl-partitioning.html
- https://www.postgresql.org/docs/18/brin.html
- https://www.postgresql.org/docs/18/storage-page-layout.html
- https://www.postgresql.org/docs/18/storage-toast.html
- https://www.postgresql.org/docs/18/datatype-json.html
- https://www.postgresql.org/docs/18/datatype-datetime.html
- https://www.postgresql.org/docs/18/datatype-numeric.html
- https://www.postgresql.org/docs/18/functions-uuid.html
- https://www.postgresql.org/docs/18/release-18.html
- https://www.postgresql.org/docs/18/app-pgdump.html
- https://www.postgresql.org/docs/18/continuous-archiving.html
- https://github.com/pgpartman/pg_partman/blob/master/doc/pg_partman.md
- https://docs.tigerdata.com/use-timescale/latest/data-retention (search snippet)
- https://clickhouse.com/docs/guides/best-practices/sparse-primary-indexes
- https://duckdb.org/docs/lts/data/parquet/tips.html (search snippet)
- https://duckdb.org/docs/2.0/sql/statements/copy (search snippet)
- https://laws-lois.justice.gc.ca/eng/acts/P-8.6/page-1.html
- https://laws-lois.justice.gc.ca/eng/acts/P-8.6/page-7.html
- https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/pipeda-compliance-help/pipeda-interpretation-bulletins/interpretations_02/
- https://www.priv.gc.ca/en/opc-actions-and-decisions/research/explore-privacy-research/2013/ip_201305/
- https://gdpr-info.eu/art-3-gdpr/
- https://gdpr-info.eu/art-5-gdpr/
- https://gdpr-info.eu/recitals/no-26/
- https://www.skadden.com/insights/publications/2025/11/in-a-landmark-decision-eu-court-clarifies (secondary, CJEU C-413/23 P)
- https://cm.twobirds.com/en/insights/2025/eu-the-srb-decision-a-new-era-for-personal-data-and-data-processing-agreements (secondary)
- https://www.edpb.europa.eu/news/edpb-adopts-pseudonymisation-guidelines-and-paves-the-way-to-improve-cooperation-with_ga (search snippet)
- https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-sharing/anonymisation/pseudonymisation/ (search snippet)
- https://ec.europa.eu/justice/article-29/documentation/opinion-recommendation/files/2014/wp216_en.pdf (failed to load)
- https://plausible.io/data-policy
- https://usefathom.com/privacy
- https://www.wsgrdataadvisor.com/2020/10/cnil-issues-updated-cookie-guidance/ (secondary, CNIL)
- https://truendo.com/en/blog/what-is-audience-measurement-cookies-consent-exemption (secondary, CNIL)
- https://dev.to/software_mvp-factory/postgresql-brin-indexes-for-time-series-mobile-telemetry-when-a-128-page-index-beats-a-50gb-b-tree-3b18 (search snippet, blog)
