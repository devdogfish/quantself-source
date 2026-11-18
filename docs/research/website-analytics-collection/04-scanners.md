# R4: Scanner / bot "open" tagging for girke.dev/r/<code>

Date: 2026-11-14. Goal: tag (not drop) scanner, preview-bot, and ATS-prefetch hits on per-application tracked links.

Legend: **[V]** = verified in a fetched primary source. **[S]** = search-result snippet or third-party secondary source. **UNVERIFIED** = no source found, or only a claim I could not confirm.

---

## TL;DR

1. No major email security vendor publishes a scanner user-agent list or scanner IP list for link scanning. Only Google publishes IPs for its special crawlers, and Google-Safety is for abuse crawling of Google properties, not email. [V] Microsoft, Proofpoint, Mimecast, and Barracuda docs fetched did not list scanner UAs or IPs. Treat UA and IP as weak signals, not identifiers.
2. Timing and burst are the strongest documented signals. Vendors and ESPs describe clicks "within seconds of delivery", "multiple clicks within milliseconds", and "synchronized multi-link clicking". [V] Customer.io, [V] SendGrid, [S] Mailchimp.
3. Dub.co's open-source `detectBot` treats HEAD requests and a `?bot=` query param as bots, checks UA against a list, and checks referer and IP lists. Its bot handling is minimal: bots only skip recording when a link has a proxy. [V] raw source fetched.
4. Human confirmation via a JS beacon on the landing page is the right primary signal. Caveat: Microsoft says unrated URLs are "detonated asynchronously in the background", so a sandbox may run JS. Whether scanners execute JS is UNVERIFIED. Require interaction (active time plus scroll or pointer), not just "beacon fired".
5. Vercel exposes geo headers (`x-vercel-ip-*`) and the client IP (`x-real-ip`, `x-forwarded-for`). It documents no ASN header and no bot header. ASN needs an external DB (IPinfo Lite is CC BY-SA 4.0; MaxMind GeoLite2 requires attribution and has EULA redistribution limits). Datacenter detection needs a self-maintained hosting-ASN list (UNVERIFIED that a free official list exists).

---

## 1. Known scanner / preview behavior by vendor

| Actor | When it fetches | Documented UA? | Documented IPs? | Source |
|---|---|---|---|---|
| Microsoft Defender Safe Links | Rewrites URLs to `*.safelinks.protection.outlook.com`; checks "on click"; URLs "that don't have a valid reputation are detonated asynchronously in the background" (i.e., pre-click, no user action). If rewriting is off, a client-side Safe Links API call happens at click. | No. Not found in Microsoft docs. | No. Microsoft 365 endpoint list covers client connectivity, not scanner egress. | [V] https://learn.microsoft.com/en-us/defender-office-365/safe-links-about ; [V] https://learn.microsoft.com/en-us/microsoft-365/enterprise/urls-and-ip-address-ranges (no scanner IPs listed) |
| Microsoft UrlClickEvents (hunting) | Logs Safe Links clicks with `IPAddress`, `ReportId`, `AppName` (`Mail`), `UrlChain`. Tenant-side only. | n/a | n/a | [V] https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-urlclickevents-table |
| Google-Safety | Abuse crawling, mainly malware checks on links posted on Google properties. Ignores robots.txt. | UA token `Google-Safety` | Yes: `https://developers.google.com/static/crawling/ipranges/special-crawlers.json`; rDNS `rate-limited-proxy-*.google.com` | [V] https://developers.google.com/search/docs/crawling-indexing/google-special-case-crawlers |
| Proofpoint URL Defense | Rewrites to URL Defense Redirector; scans destination on click; predictive analysis may sandbox suspicious URLs in background before a human click. | UNVERIFIED (not found) | UNVERIFIED | [S] help.proofpoint.com snippet and university pages via search; primary doc fetch returned 404 |
| Mimecast | Layered check of destination on click. Says third-party scan-vendor IPs are not tracked or disclosed. | `WebClient/1.0` named only by a third party | No | [S] Vuture article: https://support.vutu.re/s/article/360020553657-Bot-Protection-for-Links-Clicked (third party). Mimecast support fetch returned 403. Treat `WebClient/1.0` as UNVERIFIED. |
| Barracuda Link Protection | Rewrites suspicious links; checks status "every time it's clicked, before the redirect is allowed". Gateway may click pre-delivery; third parties say those clicks look like humans. | No | No | [S] Barracuda Campus via search snippet: https://documentation.campus.barracuda.com/wiki/spaces/EGD/pages/2850935 . Pre-delivery click claim UNVERIFIED. |
| Slack | Fetches link metadata on post. | `Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)`; also `Slack-ImgProxy 0.19`, `Slackbot 1.0` | No IPs. "Each robot ... identifies itself uniquely through its user agent." Ignores robots.txt. Caches ~30 min. | [V] https://api.slack.com/robots |
| LinkedInBot | Fetches metadata for share previews. | `LinkedInBot/1.0 (compatible; Mozilla/5.0 ...)` variants | UNVERIFIED | [S] third-party directories only (botcrawl.com etc.). LinkedIn's own doc not found. |
| Microsoft Teams | Teams does not rewrite URLs; checks at time of click. Preview fetching UNVERIFIED. | UNVERIFIED | UNVERIFIED | [V] Teams section of https://learn.microsoft.com/en-us/defender-office-365/safe-links-about |
| Gmail / Google Workspace link scanning | UNVERIFIED for link clicks. Gmail's documented image proxy is not the same thing. | UNVERIFIED | UNVERIFIED | none fetched |

### ESP-level behavior (what email platforms do about it)

- **SendGrid:** Does not filter bot or security-scanner clicks or opens. Recommends: UA identification, "a high count of the same IP clicking links at the same time", and many events from one recipient in a short window. Flags Apple MPP opens via `sg_machine_open`. [V] https://support.sendgrid.com/hc/en-us/articles/4416801410459
- **Mailchimp:** Multilayer detection: device/browser fingerprinting, IP intelligence (maintained list of corporate-security and bot-network IPs), and behavioral analysis. Says "platform-level filters automatically screen out bot clicks across every report". Internal figure: "roughly 1 in 5 clicks are bots when you look with basic detection". No accuracy numbers given. [V] https://mailchimp.com/resources/bot-clicks-in-email-marketing/
- **Customer.io (learn article, vendor-authored):** Signals: clicks "within seconds of delivery", "multiple clicks within milliseconds", "synchronized multi-link clicking", "very high click-to-open ratios", "clicking every link in an email", datacenter/VPN/proxy IPs, "clicks without activation of tracking pixels", hidden links, predictable link order. Warns "overly aggressive detection can exclude legitimate engagements." The "reduced by over 70%" figure is a vendor claim, UNVERIFIED. [V] https://customer.io/learn/lifecycle-marketing/combating-automated-interactions
- **Barracuda/Marketo-style rapid-click rule:** Third-party product doc describes a rapid-click filter that "discounts multiple clicks from the same recipient within a given time period", default window half a second. [S] https://support.vutu.re/s/article/360020553657-Bot-Protection-for-Links-Clicked

---

## 2. Signal catalog (what to store and why)

| Signal | Evidence | Confidence as bot |
|---|---|---|
| UA matches known bot/scanner pattern | isbot, Dub UA_BOTS, Customer.io ("well-known user agents for identifying link validation") | High for named bots (Google-Safety, Slackbot-LinkExpanding). Low for generic UA lists; scanners can spoof. |
| HEAD request | Dub `detectBot` returns true for HEAD [V] raw source | Medium-high. Scanners often HEAD. Humans do not HEAD links. UNVERIFIED that Microsoft/Proofpoint use HEAD. |
| Timing from send to first hit | Customer.io, SendGrid, Mailchimp [V/S] | Medium. Needs a send/issue timestamp. |
| Burst: several links or codes from one IP in same second | SendGrid, Customer.io "synchronized multi-link clicking", Barracuda rapid-click [S] | High when many distinct codes arrive together. |
| Repeat hits same code within ms-seconds | Customer.io "multiple clicks within milliseconds" [V] | High. |
| Datacenter / hosting ASN | Customer.io "datacenter ranges, VPNs, proxies" [V]; SendGrid IP guidance [V] | Medium. Needs ASN source; no free hosting flag (IPinfo Lite has none). |
| No JS beacon from landing page | Customer.io "clicks without activation of tracking pixels" [V] | Medium-high for ATS/ scanners. Caveat: sandboxes may run JS (UNVERIFIED). |
| Interaction with landing page (scroll, pointer, active time) | Customer.io/SendGrid general guidance; UNVERIFIED as a specific rule | High, but needs JS. |
| Missing cookies | Mail filters and bots often lack cookies; SendGrid did not document cookie rules | Low. Many humans block cookies. |
| Geo mismatch vs recipient | Customer.io "IPs from regions inconsistent with the recipient location" [V] | Low. Recipient location unknown for job applications. |
| Apple MPP proxy | SendGrid `sg_machine_open` [V] | Applies to pixel opens, not link clicks. Not used for this app's link redirects. |

---

## 3. Libraries and platform data

### isbot (npm)
- Matches UA only, one regex built from community lists: Kikobeats/top-crawler-agents, Matomo device-detector, monperrus/crawler-user-agents, myip.ms, isbot, user-agents.net, ua-parser-js. [V] https://github.com/omrilotan/isbot
- API: `isBot(ua)`, `isBotNaive`, `getPattern`, `findBotMatch`, `createIsBot`. Latest referenced is v5. License Unlicense.
- Author: do not allowlist on UA alone; add reverse DNS. Fallback has about 1% FP and about 75% bot coverage (roughly a quarter missed). [V]
- Checks only the User-Agent header. [V]

### Matomo device-detector
- `isBot()` and `getBot()`. Bot list (`regexes/bots.yml` per common usage; file itself not fetched) is "might not be complete". License LGPL-3.0. Separate list of libraries (curl, Guzzle). [V] https://github.com/matomo-org/device-detector

### crawler-user-agents (monperrus)
- Source list used by isbot. Not fetched directly. UNVERIFIED as a current list.

### ua-parser
- Not fetched. UNVERIFIED in this run.

### Next.js `userAgent()`
- Returns `isBot` boolean. Source of the list is not documented. [V] https://nextjs.org/docs/app/api-reference/functions/userAgent

### Vercel request headers
- Geo: `x-vercel-ip-continent`, `x-vercel-ip-country`, `x-vercel-ip-country-region`, `x-vercel-ip-city`, `x-vercel-ip-latitude`, `x-vercel-ip-longitude`, `x-vercel-ip-timezone`, `x-vercel-ip-postal-code`.
- Client IP: `x-forwarded-for`, `x-vercel-forwarded-for`, `x-real-ip` (all public client IP). Overwritten behind a proxy; Enterprise trusted proxy option.
- **No ASN header and no bot-verdict header documented.** [V] https://vercel.com/docs/headers/request-headers (last updated 2025-12-13)
- **BotID:** Client-side challenge plus `checkBotId()` server call; Basic on all plans; Deep Analysis (Kasada-based) billed $1 per 1000 `checkBotId()` calls on Pro. Requires JS on the page that calls it. [V] https://vercel.com/docs/botid
  - Implication: BotID on the redirect route itself cannot verify a human before the redirect, because the challenge runs in the browser. Use the landing page instead.
- **WAF Custom Rules:** actions include `log`, `deny`, `challenge`, `bypass`, `redirect`; `log` continues rule evaluation. Persistent actions (Pro/Enterprise). [V] https://vercel.com/docs/vercel-firewall/vercel-waf/custom-rules . The rule-configuration page with the full field list was not fetched, so ASN as a WAF field is UNVERIFIED.
- **Bot Protection managed ruleset:** Log or Challenge; JS challenge for traffic "unlikely to be a browser". [V] https://vercel.com/docs/vercel-firewall/vercel-waf/managed-rulesets
- Recommended use: a WAF `log` rule can mirror suspicious hits to Vercel Firewall observability without code changes. Good for a second opinion; the app should still do its own scoring.

### Cloudflare (for reference only; site is on Vercel)
- Bot score 1–99 (1 = automated, 99 = human), groups: Automated, Likely automated (2–29), Likely human (30–99), Verified bot. Granular scores only on Enterprise Bot Management. [V] https://developers.cloudflare.com/bots/concepts/bot-score/
- Verified bots identified by Web Bot Auth, published IP list with stable UA, or reverse DNS. [V] https://developers.cloudflare.com/bots/concepts/bot/verified-bots/
- Origin header names not confirmed in fetched pages (UNVERIFIED: `cf-bot-score`, `cf.bot_management.score`).

### ASN / IP data
- **IPinfo Lite:** Free, unlimited. Fields: `asn`, `as_name`, `as_domain`, `country_code`, `country`, `continent_code`, `continent`. No hosting or datacenter flag in Lite; privacy detection is paid. License CC BY-SA 4.0, attribution required ("IP address data is powered by IPinfo"). Updated every 24 h. [V] https://ipinfo.io/lite . Share-alike implications for derived data UNVERIFIED legal question.
- **MaxMind GeoLite2:** Free, requires attribution ("This product includes GeoLite Data created by MaxMind"). Section 6.1: no disclosure to third parties without consent. Section 6.3: use updated versions promptly; destroy old versions within 30 days of release. Whether the ASN DB falls under the same EULA is UNVERIFIED (EULA text covers "GeoLite Databases" providing geographic data; ASN not mentioned). [V] https://www.maxmind.com/en/geolite2/eula
- **Datacenter detection:** No free official datacenter list was found. Practical option: maintain a hosting-ASN list from AS name patterns (AWS/Amazon, Google Cloud, Microsoft Azure, Hetzner, OVH, DigitalOcean, etc.). Microsoft's Exchange/Teams ranges are published for client connectivity (see section 1), but whether Safe Links detonation egress uses them is UNVERIFIED. Microsoft-owned ASN from the Vercel `x-real-ip` will appear as a hosting ASN; this is a good test case.

---

## 4. Human-confirmation patterns

### Dub.co (open source, primary source)
- File: `apps/web/lib/middleware/link.ts` (fetched from `main`). Calls `detectBot(req)`. If `isBot && proxy`, redirects to a `/proxy` page (no `recordClick`). Otherwise bots take the normal path and are recorded with no bot flag. Clicks recorded to Tinybird inside `ev.waitUntil(...)`. [V] https://raw.githubusercontent.com/dubinc/dub/main/apps/web/lib/middleware/link.ts
- File: `apps/web/lib/middleware/utils/detect-bot.ts`. Checks, in order: `?bot=` query param (true), HEAD method (true), UA via Next `userAgent().isBot` and `UA_BOTS` regexes (with `UA_FALSE_POSITIVES`), referer against `REFERRER_BOTS`, IP exact match `IP_BOTS` and CIDR `IP_RANGES_BOTS`. Lists come from `./bots-list` (not fetched). Does not use `isbot` package. [V] https://raw.githubusercontent.com/dubinc/dub/main/apps/web/lib/middleware/utils/detect-bot.ts
- Possible bug (inferred from the fetched code by a model, UNVERIFIED): the summary says `userAgent(req)` returns an object, so `if (ua)` is always true and the referer and IP checks are unreachable. Verify in source before relying on it.
- Dub's README and file list show no separate bot-filtering doc. Search for `isBot` in the repo returned nothing useful (forks only).

### Umami (open source, primary source)
- `src/app/api/send/route.ts`: `if (!process.env.DISABLE_BOT_CHECK && isbot(userAgent)) return json({ beep: 'boop' })`. Drops the event silently, before session creation and event save. Returns a normal-looking response. [V] https://raw.githubusercontent.com/umami-software/umami/master/src/app/api/send/route.ts
- Lesson: silent drop prevents audit. For this app, store the row and tag it, do not drop.

### Microsoft Safe Links interstitial
- Safe Links shows "scan in progress" notification when the scan is not finished; "Wait for URL scanning to complete" holds the message in delivery. [V] safe-links-about. This shows scanners can wait, not redirect, which is why redirect-first is not a clean human test.

### Recommended pattern for girke.dev
- Redirect (302) immediately to the job-specific page on girke.dev. Do not add a hard interstitial: ATS and human users with JS disabled would be blocked, and scanners that run JS would pass anyway. Source of truth for "human" = JS beacon on that page.
- Mint a random `open_id` per redirect and pass it to the landing page as an opaque query param (not PII). Beacon posts `open_id`, active_ms, first-interaction time, scroll depth.
- `js_confirmed` = beacon arrives for this `open_id` within 30 min AND (active_ms >= 2000 AND an interaction event). Beacon-only is weaker: sandbox JS is UNVERIFIED either way.

---

## 5. Recommended tagging ruleset

Principle: store every hit, never drop. Compute `verdict` and `reasons[]` at write time, re-score when beacon arrives later.

### 5.1 Fields per open row

| Field | Type | Source |
|---|---|---|
| `open_id` | uuid | server-generated on redirect |
| `code` | string | link code |
| `ts` | timestamp ms | server |
| `ref_ts` | timestamp ms | link issue time or application-submitted time (nearest known proxy for "send"; the app does not know the actual send time for ATS uploads) |
| `ms_since_ref` | int | ts - ref_ts |
| `method` | GET/HEAD/other | request |
| `ua` | string | `user-agent` |
| `ua_isbot` | bool | isbot(ua) |
| `ua_scanner` | string or null | matched named list (Google-Safety, Slackbot-*, LinkedInBot, WebClient/1.0 UNVERIFIED) |
| `ip_hash` | string | HMAC(ip, rotating daily salt). Store hash, not raw IP, unless retention is decided |
| `asn` | int | IPinfo Lite or MaxMind GeoLite2-ASN (see license notes) |
| `as_name` | string | same |
| `is_dc_asn` | bool | self-maintained hosting-ASN list |
| `country` | string | `x-vercel-ip-country` |
| `referer` | string or null | request |
| `purpose` | string or null | `Purpose` / `Sec-Purpose` header (prefetch) |
| `sec_fetch_dest`, `sec_fetch_mode` | string or null | request (browsers send these; many bots do not) |
| `same_ip_codes_5s` | int | distinct codes from same `ip_hash` in last 5 s, including this one |
| `same_ip_hits_1s` | int | hits from same `ip_hash` in ±1 s |
| `same_code_prior_30s` | int | prior hits on same code within 30 s |
| `js_confirmed` | bool | beacon with same `open_id` (see 4) |
| `active_ms` | int or null | beacon |
| `verdict` | enum | see 5.3 |
| `score` | int | see 5.2 |
| `reasons` | text[] | list of rule ids that fired |
| `scored_at` | timestamp | re-scored on beacon arrival |

### 5.2 Rules (tunable; thresholds are starting points, UNVERIFIED as optimal)

Hard rules (set verdict `automated` regardless of score, unless `js_confirmed` and no hard rule fired):

- **H1** `ua_scanner` not null → `automated`, reason `named_scanner_ua`.
- **H2** `method == HEAD` → `automated`, reason `head_request` (Dub precedent).
- **H3** `?bot=` query present → `automated`, reason `bot_param` (Dub precedent; internal test link).

Soft score (add points; sum; cap 100):

| Rule | Condition | Points | Basis |
|---|---|---|---|
| S1 | `ua_isbot` true (not named scanner) | +40 | isbot / Dub UA_BOTS |
| S2 | `ms_since_ref` < 2 000 | +30 | "clicks within milliseconds" (Customer.io) |
| S3 | `ms_since_ref` < 10 000 (and not S2) | +20 | "within seconds of delivery" (Customer.io, SendGrid) |
| S4 | `same_ip_codes_5s` >= 3 | +35 | "synchronized multi-link clicking" (Customer.io); same IP many clicks at once (SendGrid) |
| S5 | `same_ip_codes_5s` == 2 | +15 | weaker form of S4 |
| S6 | `same_code_prior_30s` >= 1 | +20 | repeat within seconds (Customer.io "multiple clicks within milliseconds") |
| S7 | `is_dc_asn` true | +25 | Customer.io datacenter IPs; SendGrid IP guidance |
| S8 | `referer` is a known scanner rewrite host (e.g., `*.safelinks.protection.outlook.com`, `protect.mimecast.com`, Proofpoint URL Defense) | +15 | referer-based; UNVERIFIED that scanners send these referers; a human clicking a rewritten link from Outlook will show the same referer |
| S9 | `purpose` contains `prefetch` or `prerender` | +30 | browser prefetch hint; UNVERIFIED for scanners |
| S10 | no `sec_fetch_dest` and no `accept-language` | +10 | weak: many bots lack these; many old clients too |
| S11 | `js_confirmed` false after 60 s from `ts` (evaluated at report time, not real-time) | +15 | Customer.io "clicks without tracking pixel activity" |

Human credit:

- **C1** `js_confirmed` true AND `active_ms` >= 2 000 AND interaction recorded → -40.
- **C2** `js_confirmed` true but no interaction → -20 (possible sandbox).

### 5.3 Verdicts

- `automated`: any hard rule fired, OR score >= 60.
- `suspect`: score 30–59.
- `human_confirmed`: `js_confirmed` AND not `automated` AND score < 30 after credit. Primary metric for "real opens".
- `human_candidate`: score < 30 and not confirmed (e.g., JS blocked, beacon lost, or redirect is the only signal).

Reporting: show raw hits, `human_confirmed`, and `human_candidate` separately. Do not present raw hits as opens.

### 5.4 Pseudocode

```
on_redirect(req, code):
  row = base_row(req, code)              // store everything
  row.ua_scanner = match_named(req.ua)
  row.ua_isbot = isbot(req.ua)
  row.ms_since_ref = now - ref_ts(code)
  row.same_ip_codes_5s = count(distinct code, ip_hash, last 5s)
  row.same_ip_hits_1s = count(ip_hash, last 1s)
  row.same_code_prior_30s = count(code, last 30s)
  row.is_dc_asn = hosting_asn_list.has(row.asn)
  apply(row)                             // hard rules, then soft score
  insert(row)
  return 302(job_url + "?o=" + open_id)  // no interstitial

on_beacon(open_id, active_ms, interacted):
  row = get(open_id)
  row.js_confirmed = true
  row.active_ms = active_ms
  apply(row) with credit rules
  update(row)

nightly_job():
  for rows with js_confirmed unset and ts < now-60s: apply S11, rescore
```

### 5.5 Validation plan (do before trusting)

1. Send a test résumé link to a Gmail, Outlook, and Workday or Greenhouse test account. Record first hit `ms_since_ref`, UA, IP ASN, method, and whether beacon fires. Repeat for Slack and LinkedIn share previews.
2. Measure the sample split: `automated` vs `human_confirmed` vs `suspect`.
3. Hand-label 50 rows from real traffic. Check precision of `automated`.
4. Re-run after each vendor change. Log the scanner UA list version.
5. Do not infer scanner identity from Microsoft or Mimecast UAs or IPs unless the logs confirm them.

---

## 6. Open questions and UNVERIFIED items

- UNVERIFIED: Microsoft Safe Links user agent and egress IPs (not in Microsoft docs fetched).
- UNVERIFIED: Whether Safe Links detonation and Proofpoint sandboxes execute JavaScript. This decides whether `js_confirmed` is enough.
- UNVERIFIED: `WebClient/1.0` as Mimecast UA (single third-party source).
- UNVERIFIED: Proofpoint, Barracuda, Gmail, and Teams UA strings and IP ranges.
- UNVERIFIED: LinkedInBot UA and verification (only third-party directories).
- UNVERIFIED: Whether ATS parsers (Workday, Greenhouse, Lever, Ashby) fetch links in résumé PDFs. No source found.
- UNVERIFIED: Dub `detect-bot.ts` unreachable-code claim (inferred from a fetch summary). Confirm in source.
- UNVERIFIED: Vercel WAF rule fields (ASN, datacenter) beyond what the custom-rules page lists.
- UNVERIFIED: Whether the MaxMind GeoLite2-ASN database is covered by the GeoLite2 EULA.
- UNVERIFIED: Whether IPinfo Lite CC BY-SA share-alike applies to derived scoring output. Needs legal read.
- UNVERIFIED: Mailchimp default filter status (one source says on from Aug 2025; Mailchimp page says "platform-level filters automatically screen out bot clicks"). Not used in ruleset.
- UNVERIFIED: All numeric thresholds in section 5 (2 s, 10 s, 3 codes/5 s, 60 s). These are starting heuristics derived from vendor wording ("seconds", "milliseconds", "same time"), not published values.
- Note: the Cloudflare origin-header names were not confirmed.
- Note: Plausible bot-filtering docs returned 404; not covered.

## Sources (primary, fetched)

- https://learn.microsoft.com/en-us/defender-office-365/safe-links-about
- https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-urlclickevents-table
- https://learn.microsoft.com/en-us/microsoft-365/enterprise/urls-and-ip-address-ranges
- https://developers.google.com/search/docs/crawling-indexing/google-special-case-crawlers
- https://api.slack.com/robots
- https://support.sendgrid.com/hc/en-us/articles/4416801410459
- https://mailchimp.com/resources/bot-clicks-in-email-marketing/
- https://customer.io/learn/lifecycle-marketing/combating-automated-interactions
- https://vercel.com/docs/headers/request-headers
- https://vercel.com/docs/botid
- https://vercel.com/docs/vercel-firewall/vercel-waf/custom-rules
- https://vercel.com/docs/vercel-firewall/vercel-waf/managed-rulesets
- https://nextjs.org/docs/app/api-reference/functions/userAgent
- https://github.com/omrilotan/isbot
- https://github.com/matomo-org/device-detector
- https://raw.githubusercontent.com/dubinc/dub/main/apps/web/lib/middleware/link.ts
- https://raw.githubusercontent.com/dubinc/dub/main/apps/web/lib/middleware/utils/detect-bot.ts
- https://raw.githubusercontent.com/umami-software/umami/master/src/app/api/send/route.ts
- https://developers.cloudflare.com/bots/concepts/bot-score/
- https://developers.cloudflare.com/bots/concepts/bot/verified-bots/
- https://ipinfo.io/lite
- https://www.maxmind.com/en/geolite2/eula

Secondary (search snippets or third-party, treat as leads): https://support.vutu.re/s/article/360020553657-Bot-Protection-for-Links-Clicked ; https://documentation.campus.barracuda.com/wiki/spaces/EGD/pages/2850935 ; https://botcrawl.com/bots/linkedinbot ; Proofpoint and Mimecast pages via search only.
