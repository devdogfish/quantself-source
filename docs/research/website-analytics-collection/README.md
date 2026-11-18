# Website analytics data collection

Research 2026-11-14 for the redesigned Website and Job search dashboards ([#289](https://github.com/devdogfish/quantself/issues/289)). Five parallel reports, each citing primary sources and marking unchecked claims UNVERIFIED:

1. [Platforms](01-platforms.md): Umami, PostHog, Plausible CE, Matomo, OpenPanel, Rybbit, Swetrix, Counterscale, own table
2. [Storage and retention](02-storage-retention.md): Postgres shape, size, retention law (PIPEDA, GDPR), backups
3. [Link URLs](03-link-urls.md): query param vs path vs subdomain vs short domain, redirect status codes
4. [Scanners](04-scanners.md): email/ATS scanner signals, libraries, tagging rules
5. [Attribution and collection](05-attribution-collection.md): referrers, carrying attribution, engagement time, event names

## Findings that change the picture

- **The 90-day deletion is ours, not Umami's.** `scripts/website-analytics/retention.sql` runs hourly. Umami has no retention setting ([01](01-platforms.md)).
- **Every heavier platform needs ClickHouse, MySQL or 16 GB RAM** (PostHog, Plausible CE, OpenPanel, Rybbit, Swetrix, Matomo). Counterscale caps at 90 days. Only Umami and an own table fit the VPS ([01](01-platforms.md)).
- **Referrers carry origin only** (`strict-origin-when-cross-origin`). LinkedIn, YouTube, PDFs and mail apps can't tell us which post or application. That has to be in the URL ([05](05-attribution-collection.md), [03](03-link-urls.md)).
- **301/308 redirects are cached by browsers**, so repeat opens never reach the server. Tracking redirects must be 302/307 with `Cache-Control: no-store` ([03](03-link-urls.md)).
- **No scanner vendor publishes its user agents or IPs.** The only dependable signals are timing after send, same-IP bursts, HEAD requests, data-centre IPs and the absence of a JS beacon. Dub records bot clicks rather than dropping them; Umami silently drops `isbot` matches ([04](04-scanners.md)).
- **Pseudonymous IDs are still personal data** under GDPR and OPC guidance. Raw events kept forever with long-lived visitor IDs are hard to defend; events without IDs are not ([02](02-storage-retention.md)).

## Recommendation

### Storage: own event table, drop Umami

The platform report recommends staying on Umami. We already bypass everything Umami offers: its UI (own dashboard), its data model (our metadata is a JSON blob in `event_data`), its links (own registry) and its bot filter (we tag, it drops). What's left is cost: a second Postgres, a reader role, an SSH tunnel for local dashboards, and schema changes on every Umami upgrade. One typed `website_event` table in the Quantself database, written by the existing relay, is less to run and lets the API answer each report in one query.

- Single unpartitioned table, typed columns plus `props jsonb`; BRIN on time, btree on `(kind, occurred_at)`. ~0.3 GB per million events; years of traffic stays in single-digit GB ([02](02-storage-retention.md)).
- **Keep events forever.** Rotate the IP hash key daily (Plausible's pattern) so no IP-derived ID lives longer than a day, and clear the browser ID on events older than 13 months. Counts, pages, channels and applications stay forever; only "same visitor across years" is lost. Inquiries live in their own table and stay until deleted.
- Nightly encrypted `pg_dump` off-site.
- Migration: copy the retained Umami events once, then remove Umami, the retention job, the reader role and the tunnel.

### Links: one path-based system on the main domain

Keep `girke.dev/r/<code>` and use it for **every** tracked link, not just applications. A code is a registry row: application or post, plus destination.

| Use | Link | Lands on |
|---|---|---|
| Résumé, main link | `girke.dev/r/k3Vw9QpX2nR7tLzA` | home |
| Résumé, project | `girke.dev/r/k3Vw9QpX2nR7tLzA/rbc` | `/projects/rbc` |
| LinkedIn / YouTube post | `girke.dev/r/rbc-launch` | the page that post is about |

- **No subdomain or short domain.** Neither helps a single personal domain; both add DNS/Vercel setup, cookie-scope work, and look less trustworthy on a PDF ([03](03-link-urls.md)).
- **No UTM as the main mechanism.** Long, case-sensitive, ugly on a résumé, and survival through LinkedIn/YouTube wrappers is unverified. Still read `utm_*` when someone else's link carries them.
- Flatten the sub-paths: `/r/<code>/<destination-key>` instead of `/profile/github`, `/project/rbc/demo`. Keys come from the portfolio's existing link catalog.
- 307 + `no-store`. Existing codes and old `/r`, `/go` cohort links keep resolving, since they're printed in résumés already sent.

### Attribution through the visit

The redirect appends `?via=<code>` to the destination. The tracker reads it, keeps it in `sessionStorage` for that tab, and removes it from the address bar with `history.replaceState` (Dub's `dub_id` pattern without a cookie). Every later event in that tab carries the code. Precedence: `via` → `utm_*` → referrer host → direct → other ([05](05-attribution-collection.md)).

### Collection

Own ~2 KB tracker posting to a same-origin portfolio route, relayed server-side (ad-blocker safe, IP hashed before storage, deduped by event ID). Events: `page:view`, `page:engagement` (visible-and-focused time and max scroll, flushed on `visibilitychange` via `sendBeacon`), `cta:click`, `outbound:click`, `link:open` (server-side at the redirect), `contact_form:submit` ([05](05-attribution-collection.md)).

### Scanners: tag, score, confirm with JS

Store every open with `method`, `ua`, `asn`, `ms_since_sent`, `burst_count` and whether a JS beacon from the same `via` followed. Hard bot: HEAD, known scanner/preview UA (`isbot`). Soft points: under ~10 s after sending, several links in the same second, data-centre ASN, no beacon. Human = beacon plus engagement. Thresholds are heuristics until checked with real sends to Gmail, Outlook and one ATS ([04](04-scanners.md)).

### Owner traffic

Two filters, both applied at the portfolio before anything is stored:

- **Device flag:** visiting a private owner link once per browser (`girke.dev/?owner=<secret>`) sets a `localStorage` flag; the tracker then sends nothing from that browser. Works on any network, including mobile data.
- **IP list:** `ANALYTICS_EXCLUDED_IPS` (home and office) for browsers without the flag and for server-side redirect opens. Compared against the raw IP before hashing, so it doesn't fight the daily key rotation.

## Follow-up answers (2026-11-14)

**Do email scanners run JavaScript?** Sometimes. Microsoft says Safe Links detonation is recorded as a user click, a few seconds after delivery ([Microsoft attack simulation FAQ](https://learn.microsoft.com/en-us/defender-office-365/attack-simulation-training-faq)). Deliverability sources report some scanners render the page and run JS, firing analytics like a real visitor, while others say most don't ([Suped](https://www.suped.com/learn/email-deliverability/why-are-email-security-filters-auto-clicking-links-in-opt-in-emails-with-javascript-and-how-can-), [Suped](https://www.suped.com/learn/email-deliverability/do-email-security-software-solutions-click-hyperlinks-in-emails)). So "a script ran" is not enough. A human needs **engagement**: at least ~5 s visible-and-focused time, a scroll, or a click. Scanners also show timing clusters right after delivery and hit every link at once.

**Do links survive LinkedIn and YouTube?** LinkedIn wraps external links in `lnkd.in` but passes the destination and its query string through; its iOS in-app browser can drop the referrer, so those visits look direct ([quickutm](https://quickutm.com/utm-generator/linkedin), [LinkedIn shortener guide](https://connectsafely.ai/articles/linkedin-url-shortener-guide-2026)). YouTube wraps description links in `youtube.com/redirect?q=…` with the full destination encoded. No official docs from either. Conclusion: referrers are unreliable, the path survives; a per-post `/r/<code>` link is the robust choice.

**Vercel Hobby budget** ([Hobby plan](https://vercel.com/docs/plans/hobby), [Functions pricing](https://vercel.com/docs/functions/usage-and-pricing)): 1M function invocations, 4 active-CPU hours, 1M CDN requests and 100 GB transfer per month. A visit costs about 2-3 invocations (redirect plus 1-2 batched event posts). Exceeding a limit pauses the project (503) until you act.
