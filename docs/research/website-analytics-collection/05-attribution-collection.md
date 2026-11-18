# R5: Attribution and engagement analytics for girke.dev

Date: 2026-11-14. Legal items are research notes, not legal advice. Tags: **UNVERIFIED** = claim from secondary source, search snippet, or inference; primary text not read.

---

## 0. Summary

- Referrers are unreliable for per-post and per-job attribution. Default policy trims cross-origin referrers to origin, and in-app and app-to-web flows often send none. Use explicit URL params for intent, referrer host only as fallback.
- Persist only a non-identifying attribution label per tab (sessionStorage) or propagate params through internal links. Avoid cookies. EU visitors make this a consent question; Canadian (PIPEDA) exposure is lower but IP is treated as personal info.
- Engagement: copy the Plausible algorithm (visible+focused timer, flush on hide). Flush with `sendBeacon` on `visibilitychange` hidden, `pagehide` as fallback. Never `unload`.
- Transport: same-origin neutral path, server relay enriches (device class, geo, hash) and discards raw IP/UA, batches with `event_id` for idempotent dedupe.
- Vercel Web Analytics is not the system of record: 2 custom props on Pro, 12-month window on Pro, 1-month on Hobby.

---

## 1. Referrer reality

### 1.1 Policy baseline (verified)
- Default is `strict-origin-when-cross-origin`. Cross-origin HTTPS→HTTPS sends origin only (e.g. `https://www.linkedin.com/`, no path or query). HTTPS→HTTP sends nothing. Sources: [MDN Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referrer-Policy), [W3C Referrer Policy §3 and §3.7](https://w3c.github.io/webappsec-referrer-policy/).
- Consequence: a referrer can identify the *host* but never the *post or job*. Per-post and per-job attribution must come from URL params on the destination URL.
- MDN: `Referer` is trimmed of fragments and userinfo; a site can set `Referrer-Policy` to change this. Source: [MDN Referer](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referer).

### 1.2 Per-source notes

| Source | What you can expect | Evidence |
|---|---|---|
| LinkedIn desktop web | Outbound links pass through LinkedIn redirect pages (`/redir/redirect?url=`, `/safety/go?url=`). Destination query string should survive inside the `url=` param. Your referrer is probably the LinkedIn origin, not the post. | ClearURLs rule MR describing the two redirect paths: [gitlab.com/ClearURLs/rules/-/merge_requests/88](https://gitlab.com/ClearURLs/rules/-/merge_requests/88). Query survival: **UNVERIFIED** (test). |
| `lnkd.in` | LinkedIn's shortener. Some analytics tools classify it as External, not Social. Chartbeat reports LinkedIn app traffic under `lnkd.in`. | Adobe community (2014 thread, stale): [link](https://experienceleaguecommunities.adobe.com/t5/adobe-analytics-questions/linkedin-traffic-low-adobe-analytics-vs-linkedin-analytics/m-p/382012). Chartbeat: [blog.chartbeat.com/?p=3744](https://blog.chartbeat.com/?p=3744). Current behavior: **UNVERIFIED**. |
| LinkedIn iOS / Android app | Likely opens in an in-app webview. App-to-web navigation has no previous page, so `document.referrer` is empty and traffic lands as Direct. Adobe user saw `android-app://com.linkedin.android/` for Android, nothing for iOS. | Ionic forum (app-to-web no referrer): [forum.ionicframework.com/t/…/189007](https://forum.ionicframework.com/t/postmessage-in-iframe-fails-because-document-referrer-returns-empty-string-in-ios/189007). Adobe report: [link](https://experienceleaguecommunities.adobe.com/t5/adobe-analytics-questions/incoming-traffic-from-ads-on-social-media-apps/m-p/627821/highlight/true). Analogy from Pinterest iOS in-app traffic showing Direct: [community.pinterest.biz](https://community.pinterest.biz/t/pinterest-ios-in-app-browser-traffic-not-being-attributed-to-referrer-in-google-analytics/40839). LinkedIn-specific: **UNVERIFIED**. |
| YouTube description links | Clicks go through `youtube.com/redirect`. App clicks may open an in-app browser with thin or no referrer, filed as Direct. Description links marked nofollow. | Vendor blog only: [leadjourney.io/integrations/youtube](https://leadjourney.io/integrations/youtube). Moz forum: [mozprod.nodebb.com/…/3](https://mozprod.nodebb.com/community/q/topic/57657/youtube-traffic-page-url-referral/3). Redirect referrer behavior: **UNVERIFIED** (not tested, no primary doc found). |
| GitHub | Standard policy applies: origin only. Repo README links often go through `github.com` directly. | Policy from MDN above. GitHub-specific: **UNVERIFIED**. |
| Google search | Origin only, `https://www.google.com/`. No query, no keyword. | MDN policy above. |
| Gmail / Google web | Gmail wraps external links in a `google.com/url?q=` hop. Matomo reported email traffic counted as Google search for this reason. `data-saferedirecturl` plus `source=gmail` in the query was reported as a signal. | Matomo issue: [issues.matomo.org/4339](https://issues.matomo.org/4339). Gmail param behavior: **UNVERIFIED**. |
| Apple Mail, Outlook, other mail | Commonly no referrer, so Direct. Mail clients that wrap links in redirects (e.g. Marketo, mgclicks) strip referrer on the redirect. | Adobe redirect note: [experienceleague.adobe.com/…/technotes/redirects](https://experienceleague.adobe.com/en/docs/analytics/technotes/redirects) (states the browser clears the referring URL on a redirect to a different URL). Apple Mail specifics: **UNVERIFIED**. |
| PDF viewers (résumé PDF) | Chrome/Safari/Acrobat PDF viewers: referrer behavior **UNVERIFIED**. Assume none. Measure résumé access by the link *on the site* (click event), not by PDF requests. | None found. |
| Safari / iOS privacy | WebKit bug reports say `document.referrer` on iOS is truncated to origin while `Referer` header carries more. Safari 17.1 private browsing with fingerprinting protection emptied iframe referrer. | WebKit: [auto-bugs.webkit.org/show_bug.cgi?id=217758](https://auto-bugs.webkit.org/show_bug.cgi?id=217758). Apple dev thread: [discussions-cn-prz.apple.com/thread/255330283](https://discussions-cn-prz.apple.com/thread/255330283). Both **UNVERIFIED** in current Safari. |
| Redirect hops | Fetch spec §4.5 (HTTP-redirect fetch) governs referrer across redirects. Could not read section (page truncated). Adobe says the referrer is cleared on redirect to a different URL. | Fetch spec: [fetch.spec.whatwg.org/#http-redirect-fetch](https://fetch.spec.whatwg.org/#http-redirect-fetch). Redirect rule: **UNVERIFIED** from primary. |

### 1.3 Test matrix (needed; nothing above is measured on girke.dev)
Log `document.referrer`, `location.href`, server-seen `Referer`, UA class, and params for: desktop Chrome, desktop Safari, iOS Safari, LinkedIn iOS app, LinkedIn Android app, YouTube iOS app and desktop link, GitHub README link, Google result, Gmail web link, Apple Mail link, résumé PDF in Chrome and Preview. Use a throwaway `?src=test` param to separate tests.

---

## 2. Carrying attribution through a visit

### 2.1 Options compared

| Option | Stores | Survives | Consent (EU) | Consent (Canada) | Notes |
|---|---|---|---|---|---|
| A. Params on every internal link | Nothing (URL) | Client-side nav if propagated by router; lost on new tab or hard nav without the param | None for storage itself | Low | Most private. Needs a helper that appends attribution to internal `href`s. |
| B. sessionStorage (attribution label only) | Label string per tab | Reloads and SPA nav in same tab; cleared when tab closes | Likely applies: Art. 5(3) covers storing info in terminal equipment, and EDPB treats storage of any info (personal or not) as in scope. Exemption only if strictly necessary for a service the user requested. **UNVERIFIED** whether a portfolio analytics label qualifies. | Lower. | Store label only, never a visitor ID. |
| C. First-party cookie | ID or label | Across tabs and days | Consent needed for analytics | Lower risk, same notice duty | Avoid. Creates persistent ID. |
| D. Server-side session | Server-side record keyed by ID | Needs an ID in client storage or cookie | Same as C for the ID | Same | No benefit over B. |
| E. Cookieless daily-hash visitor count | Nothing persistent, salt deleted daily | 24h only | Vendor claim: no consent banner. Legal status **UNVERIFIED** (EDPB/CNIL position on hashed IP+UA is not checked here). | Better | Use for unique visitors only, not attribution. |

Sources:
- CNIL audience-measurement exemption (applies only if conditions met; most big vendors do not qualify): [cnil.fr/en/sheet-ndeg16-use-analytics-your-websites-and-applications](https://www.cnil.fr/en/sheet-ndeg16-use-analytics-your-websites-and-applications).
- EDPB Guidelines 2/2023 on Art. 5(3) technical scope: [edpb.europa.eu/…/guidelines-22023-on-technical-scope-of-art-53-of-eprivacy-directive_en](https://www.edpb.europa.eu/public-consultations/guidelines-22023-on-technical-scope-of-art-53-of-eprivacy-directive_en). Secondary summary says scope covers personal and non-personal info. Full text not read: **UNVERIFIED** wording.
- Directive 2002/58/EC Art. 5(3) text: [eur-lex.europa.eu/eli/dir/2002/58/oj/eng](https://eur-lex.europa.eu/eli/dir/2002/58/oj/eng). Fetch returned empty. Exact wording **UNVERIFIED**.
- PIPEDA: IP address treated as personal info when combined with other data, per OPC site terms (search excerpt): [priv.gc.ca/en/privacy-and-transparency-at-the-opc/terms-and-conditions-of-use/](https://priv.gc.ca/en/privacy-and-transparency-at-the-opc/terms-and-conditions-of-use/). Meaningful-consent guidance, Principle 4.3 and "reasonable expectations": [priv.gc.ca …/consent/gl_omc_201805/](https://www.priv.gc.ca/en/privacy-topics/collecting-personal-information/consent/gl_omc_201805/). Analytics-specific OPC guidance: not found (**UNVERIFIED** absence).
- Quebec Law 25 (if Quebec visitors): not researched. **UNVERIFIED**.

### 2.2 How cookieless counters work (primary-ish sources)
- **Plausible**: no cookies, browser cache, or localStorage for identity. Visitor ID = hash(daily_salt + domain + IP + UA). Salt "rotated and deleted every 24 hours". Raw IP and UA not stored. The script reads a `plausible_ignore` localStorage flag (read only). Source: [plausible.io/data-policy](https://plausible.io/data-policy). Engagement code: [github.com/plausible/analytics/blob/master/tracker/src/engagement.js](https://github.com/plausible/analytics/blob/master/tracker/src/engagement.js). Entry module: [github.com/plausible/analytics/blob/master/tracker/src/plausible.js](https://github.com/plausible/analytics/blob/master/tracker/src/plausible.js) (SPA hook code not in entry module; **UNVERIFIED** where pushState is hooked).
- **Fathom** (search excerpt of usefathom.com): visitor signature rotates at midnight UTC, resets daily, hashes IP and UA with salt. [usefathom.com/why-fathom-analytics/cookieless-analytics](https://usefathom.com/why-fathom-analytics/cookieless-analytics). Not verified on docs page.
- **Umami**: server route derives session/visit IDs via `resolveIdentifiedSession` with salt, IP, UA, distinctId, and a signed cache token. Source: [raw.githubusercontent.com/umami-software/umami/master/src/app/api/send/route.ts](https://raw.githubusercontent.com/umami-software/umami/master/src/app/api/send/route.ts). The salt rotation logic is in `collection-session`, not fetched: **UNVERIFIED** rotation period. Umami tracker source (`src/tracker/index.js`) returned 404: **UNVERIFIED**.
- **Vercel Web Analytics**: identifies visitors by a hash of the incoming request, no third-party cookies, session data discarded after 24h. Source: [vercel.com/docs/analytics/privacy-policy](https://vercel.com/docs/analytics/privacy-policy). Stores referrer, filtered query params, geo, device type, browser (table on same page).

### 2.3 Recommended persistence for girke.dev
Order of preference:
1. **URL params as source of truth.** Every intentional link carries `src`, `post`, `job`, `utm_*`. Internal links are rewritten client-side to carry the visit attribution label, so SPA nav keeps it without storage.
2. **sessionStorage label (no ID).** On landing, write `{channel, source, landed_at}` to `sessionStorage` key like `attr`. Read on every event. Cleared when the tab closes. Do not store a visitor or session ID there. EU consent: treat as a decision for the owner (see §2.1 row B).
3. **Visit ID** random per tab, kept in memory only (not storage). Used only to join events within a page load and across SPA nav. Lost on reload, which is acceptable.
4. **Unique visitors**: Plausible-style daily salted hash computed in the relay, not in the browser. Discard raw IP and UA after hashing and device/geo derivation.
5. **Do not** use cookies, localStorage IDs, or fingerprinting.

Rules:
- Explicit params (`utm_*`, `src`, `post`, `job`) always overwrite the stored label on a new landing.
- Referrer classification only sets the label when no label exists for this tab.
- Same-origin referrers never change the label.
- Expected channel buckets: `resume`, `linkedin`, `youtube`, `github`, `google`, `direct`, `other`. Add `email` when `utm_medium=email` or `google.com/url` + `utm_source=gmail`.

---

## 3. Engagement, scroll, and transport

### 3.1 Active time (copy Plausible's approach)
- Time is `Date.now()` deltas, not a timer. Clock runs while `visibilityState === visible` and window focused. Stops on `visibilitychange` hidden or `blur`. Accumulate into `currentEngagementTime`. No idle timeout. Scroll, mouse, and keyboard do not count.
- Send when page hidden (or SPA nav) if engaged time ≥ 3000 ms or max scroll increased. Reset counters after send.
- Source: [github.com/plausible/analytics/blob/master/tracker/src/engagement.js](https://github.com/plausible/analytics/blob/master/tracker/src/engagement.js) (read via raw; verified).

### 3.2 Lifecycle events
- `visibilitychange` (hidden) is the recommended end-of-session signal. Source: [web.dev/articles/bfcache](https://web.dev/articles/bfcache) and [MDN pagehide](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event).
- `pagehide` fallback. It is bfcache compatible; `unload` is not. MDN: pagehide "is the best option" for unload detection. Source: [MDN pagehide](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event).
- Never `unload`: incompatible with bfcache; Firefox disqualifies pages with unload listeners. Source: [web.dev/articles/bfcache](https://web.dev/articles/bfcache).
- bfcache restore: listen to `pageshow`, check `event.persisted`, restart timer and count a view if you want restores counted. Source: [web.dev/articles/bfcache](https://web.dev/articles/bfcache).
- Page Visibility API: `hidden` includes tab background, minimized window, and device screen off. Source: [MDN Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API). Reliability on mobile for session end: MDN does not claim; pagehide page says events are unreliable on mobile. Source: [MDN pagehide](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event).

### 3.3 Scroll depth
- Track max scroll percent on a throttled scroll listener (`passive: true`, rAF). Plausible does this for max depth. Source: [engagement.js](https://github.com/plausible/analytics/blob/master/tracker/src/engagement.js).
- Milestones (25/50/75/100) via IntersectionObserver sentinels. MDN notes that scroll-driven main-thread work causes performance problems and that IO avoids it. Source: [MDN Intersection Observer](https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API). Milestone choice is my recommendation, not sourced.

### 3.4 Transport
- `navigator.sendBeacon`: payload queued limit 64 KiB; returns true when queued, not when delivered. Accepts Blob/string/FormData etc. Source: [MDN sendBeacon](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon). Use on visibility hidden.
- `fetch` with `keepalive: true`: lets the request outlive the page; can use non-POST and read the response. MDN lists it as an advantage over sendBeacon. Source: [MDN Request.keepalive](https://developer.mozilla.org/en-US/docs/Web/API/Request/keepalive) and [MDN Using Fetch](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch). Its byte budget is not stated on MDN: the 64 KiB figure is **UNVERIFIED** for keepalive. Use fetch keepalive for non-hidden flushes and sendBeacon for hide.
- Batching: keep batches under 32 KiB to stay under the 64 KiB combined queue. Batch size and count-based flush: engineering judgment **UNVERIFIED** as best practice.
- Retries: exponential backoff, max 3 attempts, then drop: engineering judgment, no source. Idempotency: generate `event_id` (UUID v4) client-side; relay dedupes on `event_id` (insert ignore). Idempotency design: judgment.

### 3.5 Routing through the site
- Next.js rewrites can proxy a path to an external destination; the browser URL stays the same. Source: [nextjs.org/docs/app/api-reference/config/next-config-js/rewrites](https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites). Rewrites pass query params through to the destination only if no param is used in the destination path.
- Recommended: a route handler (not rewrite) on a neutral same-origin path (e.g. `/_m/e`) that enriches (device class, geo, hash) then forwards to the self-hosted store with a server-side key. Keeps store URL and key off the client.
- Ad-blockers: same-origin path helps. Vercel's own Web Analytics uses a random seed in the intake URL ("Resilient Intake") to avoid a predictable path. Source: [vercel.com/docs/analytics/privacy-policy](https://vercel.com/docs/analytics/privacy-policy). Blocklist effects on custom paths: **UNVERIFIED**.

### 3.6 Library vs. custom tracker
- Custom tracker: the schema is small (~10 events), the relay already exists, and attribution rules are custom. Plausible's engagement and attribution logic is short enough to copy. Bundle size of Plausible's script: **UNVERIFIED**.
- OpenPanel's SDK wrapper auto-attaches `__referrer: document.referrer` to events, hooks `pushState`/`popstate` for screen views, and sends `link_out` on external clicks. Source: [raw.githubusercontent.com/openpanel-dev/openpanel/main/packages/sdks/web/src/index.ts](https://raw.githubusercontent.com/openpanel-dev/openpanel/main/packages/sdks/web/src/index.ts). Base SDK transport and session logic not included in that file.
- PostHog persistence: with `persistence: "memory"` (common when no cookie consent), each page load gets a new distinct_id. Source: [posthog.com/docs/web-analytics/campaign-attribution-troubleshooting.md](https://posthog.com/docs/web-analytics/campaign-attribution-troubleshooting.md) (search excerpt).
- Recommendation: custom tracker. Reuse only the Plausible engagement pattern.

### 3.7 Vercel Web Analytics: retention and export
- Reporting window by plan: Hobby 1 month; Pro 12 months; Pro + Web Analytics Plus 24 months; Enterprise 24 months. Source: [vercel.com/docs/analytics/limits-and-pricing](https://vercel.com/docs/analytics/limits-and-pricing).
- Custom event properties: Pro 2; Plus 8; Hobby none. Custom events on Pro and above. Source: same page.
- Custom event limits: nested objects unsupported, values string/number/boolean/null, name/key/value ≤255 chars. Source: [vercel.com/docs/analytics/custom-events](https://vercel.com/docs/analytics/custom-events).
- Export: Vercel Drains can stream Web Analytics page views and custom events to an HTTP endpoint (JSON/NDJSON/Protobuf). Plan availability and pricing from search excerpts only: [vercel.com/kb/drains](https://vercel.com/kb/drains), [vercel.com/changelog/export-more-data-with-vercel-drains](https://vercel.com/changelog/export-more-data-with-vercel-drains). Drain specifics **UNVERIFIED** (not fetched).
- Implication: keep own store as system of record. Vercel is a cross-check for pageviews and referrers.

---

## 4. Event taxonomy

### 4.1 Naming rules
- PostHog: lowercase only; snake_case; `category:object_action` (object before action, e.g. `signup_flow:pricing_page_view`); present-tense verbs; fixed event names, variable values go into properties. Properties: `object_adjective`; booleans prefixed `is_`/`has_`; dates end `_date`/`_timestamp`. Source: [posthog.com/docs/product-analytics/best-practices.md](https://posthog.com/docs/product-analytics/best-practices.md).
- Plausible custom-goal names are free text matched by exact string. Source: [plausible.io/docs/custom-event-goals](https://plausible.io/docs/custom-event-goals).
- Segment Track and Amplitude conventions: could not fetch (Segment returned 403). **UNVERIFIED**.

### 4.2 Property limits (for the self-hosted store to match or exceed)
- Plausible: 30 props per event, names ≤300 chars, values ≤2000 chars, scalars only. Source: [plausible.io/docs/custom-props/introduction](https://plausible.io/docs/custom-props/introduction).
- Vercel: see 3.7.

### 4.3 Proposed events for girke.dev
Common properties on every event: `event_id` (uuid), `ts` (server time), `visit_id` (in-memory random), `path` (no query string unless allowlisted), `channel`, `source` (post slug or job id), `device_class` (`mobile|tablet|desktop`), `script_v`.

Channel and attribution fields on `page:view`: `channel`, `source`, `referrer_host` (host only), `utm_source`, `utm_medium`, `utm_campaign`, `attr_origin` (`param|referrer|direct`).

| Event | When | Properties (beyond common) |
|---|---|---|
| `page:view` | Landing, SPA route change, bfcache restore | `referrer_host`, `utm_source`, `utm_medium`, `utm_campaign`, `attr_origin`, `is_restore` |
| `page:engagement` | Hide or nav, if engaged ≥3 s or scroll increased | `engaged_ms`, `max_scroll_pct` |
| `cta:click` | Any CTA the owner tags | `cta_id` (stable slug), `location` (`header|hero|footer|post_end|job_page`), `href_host`, `is_external` |
| `outbound:click` | External link click | `href_host`, `link_kind` (`linkedin|github|youtube|email|other`) |
| `resume:open` | Click on résumé link or view button | `format` (`pdf|html`), `is_download` |
| `job:view` | Job-application landing (per-job page) | `job_id`, `job_status` (if known server-side) |
| `contact_form:submit` | Submit attempt | `form_id`, `result` (`ok|validation_error|server_error`), `inquiry_type` (`recruiting|client|other`) |
| `contact_form:error` | Client or server failure | `form_id`, `error_code` |

No names, emails, or message text in any event. Form content stays server-side only.

Event count per visit is bounded by batching and by flush-on-hide, not by per-scroll events.

---

## 5. Concrete recommendation

### 5.1 Attribution precedence (first match wins for channel, except explicit params always overwrite the stored label on a new landing)
1. Explicit campaign params: `src`, `post`, `job`, `utm_source`, `utm_medium`, `utm_campaign` on the landing URL.
2. Site-owned link markers on own pages (résumé link `?src=resume`, post links `?src=linkedin&post=<slug>`, job links `?job=<id>`). Same schema as 1.
3. Referrer host, only when no label exists for the tab:
   - `linkedin.com`, `lnkd.in` → `linkedin`
   - `youtube.com`, `m.youtube.com`, `youtube.com/redirect` path → `youtube`
   - `github.com` → `github`
   - `google.*` except `google.com/url` with `utm_source=gmail` → `google`
   - `google.com/url` + Gmail signal → `email`
   - other known search engines → `other`
   - other host → `other`
4. Empty referrer with no params → `direct`. This includes app-to-web, PDFs, and mail clients that strip referrer.
5. Same-origin referrer never changes the label.

Rationale: referrer is coarse (host only, often empty). Params carry intent. Mail and app traffic cannot be classified from referrer at all.

### 5.2 What to persist, where
- `sessionStorage["attr"]`: `{channel, source, landed_at}` only. No ID. Per tab.
- Memory: `visit_id` (random), current route label.
- Server: daily-salted hash for uniques (computed in relay). Discard raw IP and UA after hashing and device/geo derivation.
- Not stored: cookies, localStorage IDs, fingerprints, emails or message text in analytics.
- Decision for owner: whether the sessionStorage label is acceptable without an EU consent banner. Research says Art. 5(3) likely reaches it; the CNIL audience-measurement exemption does not clearly cover a self-hosted label store. **UNVERIFIED** legal call. If no banner: use URL-param propagation only (option A), which writes nothing.

### 5.3 Tracker approach
- Custom 1–2 KB (estimate, **UNVERIFIED**) script, no dependencies.
- Engagement timer per §3.1. Flush: `visibilitychange` hidden → `sendBeacon`; `pagehide` fallback; `pageshow` persisted → restart timer. Never `unload`.
- Non-hidden flushes: `fetch` keepalive, POST to same-origin path, batch ≤32 KiB, retry up to 3 times with backoff, drop after that.
- Each event carries `event_id` (uuid v4). Relay dedupes.
- Relay (Next.js route handler): enrich, hash IP/UA, derive device class, strip query params except allowlist, forward to self-hosted store.

### 5.4 Open items
- Test matrix in §1.3 (nothing measured yet).
- Read Directive 2002/58/EC Art. 5(3) and EDPB 2/2023 full text (fetch failed).
- Confirm Fetch spec §4.5 redirect referrer rule.
- Confirm keepalive byte limit (MDN silent).
- Confirm Vercel drain plan availability and pricing (search excerpts only).
- Check Umami tracker and Plausible SPA hook code (not retrieved).
- Quebec Law 25 check if Quebec visitors matter.
- Segment and Amplitude naming rules (not retrieved).

---

## 6. Source index

Referrer and policy:
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referrer-Policy
- https://w3c.github.io/webappsec-referrer-policy/
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referer
- https://gitlab.com/ClearURLs/rules/-/merge_requests/88
- https://blog.chartbeat.com/?p=3744
- https://experienceleaguecommunities.adobe.com/t5/adobe-analytics-questions/linkedin-traffic-low-adobe-analytics-vs-linkedin-analytics/m-p/382012
- https://experienceleague.adobe.com/en/docs/analytics/technotes/redirects
- https://issues.matomo.org/4339
- https://leadjourney.io/integrations/youtube
- https://mozprod.nodebb.com/community/q/topic/57657/youtube-traffic-page-url-referral/3
- https://forum.ionicframework.com/t/postmessage-in-iframe-fails-because-document-referrer-returns-empty-string-in-ios/189007
- https://community.pinterest.biz/t/pinterest-ios-in-app-browser-traffic-not-being-attributed-to-referrer-in-google-analytics/40839
- https://auto-bugs.webkit.org/show_bug.cgi?id=217758
- https://discussions-cn-prz.apple.com/thread/255330283
- https://fetch.spec.whatwg.org/#http-redirect-fetch

Cookieless and consent:
- https://plausible.io/data-policy
- https://github.com/plausible/analytics/blob/master/tracker/src/engagement.js
- https://github.com/plausible/analytics/blob/master/tracker/src/plausible.js
- https://raw.githubusercontent.com/umami-software/umami/master/src/app/api/send/route.ts
- https://usefathom.com/why-fathom-analytics/cookieless-analytics
- https://vercel.com/docs/analytics/privacy-policy
- https://www.cnil.fr/en/sheet-ndeg16-use-analytics-your-websites-and-applications
- https://www.edpb.europa.eu/public-consultations/guidelines-22023-on-technical-scope-of-art-53-of-eprivacy-directive_en
- https://eur-lex.europa.eu/eli/dir/2002/58/oj/eng
- https://priv.gc.ca/en/privacy-and-transparency-at-the-opc/terms-and-conditions-of-use/
- https://www.priv.gc.ca/en/privacy-topics/collecting-personal-information/consent/gl_omc_201805/
- https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/pipeda_brief/

Engagement and transport:
- https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon
- https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event
- https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
- https://developer.mozilla.org/en-US/docs/Web/API/Request/keepalive
- https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch
- https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API
- https://web.dev/articles/bfcache
- https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites
- https://raw.githubusercontent.com/openpanel-dev/openpanel/main/packages/sdks/web/src/index.ts
- https://posthog.com/docs/web-analytics/campaign-attribution-troubleshooting.md

Vercel:
- https://vercel.com/docs/analytics/limits-and-pricing
- https://vercel.com/docs/analytics/custom-events
- https://vercel.com/kb/drains
- https://vercel.com/changelog/export-more-data-with-vercel-drains

Taxonomy:
- https://posthog.com/docs/product-analytics/best-practices.md
- https://plausible.io/docs/custom-event-goals
- https://plausible.io/docs/custom-props/introduction
