# R3: URL scheme for girke.dev application and post tracking

Date: 2026-11-14. Unverified claims are tagged **UNVERIFIED**. Sources are primary where possible; secondary sources are labelled.

## Recommendation (short)

- **Job applications:** keep the path-based redirect already built, `girke.dev/r/<code>[/sub/path]`. Use a 302 or 307 (not 301/308) with `Cache-Control: no-store`, log the open server-side, and set a first-party cookie so later page views can be attributed.
- **Social posts:** no redirect hop. Put UTM params on the destination URL, one `utm_campaign` per post, and add a `rel=canonical` to each page without params. Fall back to a server `/go/<slug>` redirect only if a platform is found to strip UTM.
- **Skip:** subdomains, separate short domain, `?ref=` on the homepage as the primary mechanism.

This matches the pattern of Dub: server-side click capture on a short path, `dub_id` appended as a query param on the destination, and a first-party cookie for later conversions.

## Options table

| Option | Looks on résumé | Robustness (copy, PDF, ATS, platforms) | Attribution carry-over | SEO / duplicates | Complexity |
|---|---|---|---|---|---|
| A. Query param on landing: `girke.dev/?ref=<code>` | Fine, longer | Custom param, not on known stripping lists (Safari LTP targets click IDs, see notes). Could be dropped by platforms or ATS (UNVERIFIED) | Page reads it directly; lost on navigation unless cookie is set | Creates parameterized duplicates; needs canonical | Low |
| B. UTM params on destination: `?utm_source=...&utm_campaign=...` | Long, ugly if printed | Good on platforms; UTM names generally not stripped by Safari LTP (secondary) | Standard analytics tools read it | Needs canonical; case-sensitive values | Low |
| C. Path redirect: `girke.dev/r/<code>` → 302 → destination | Clean, one path segment | Path always survives copy and paste, PDF, ATS; no param stripping | Server knows the code at the hop; cookie carries it on | Redirect, not indexed as content | Low (already built) |
| D. Subdomain: `r.girke.dev/<code>` or `go.girke.dev/<code>` | Looks like a shortener; hostname to trust | Same as C | Cookie needs `Domain=girke.dev` to reach main site (Dub doc, see notes) | Separate host from main site; extra DNS and Vercel domain setup | Medium |
| E. Separate short domain (e.g. `xyz.li/<code>`) | Least trusted on a PDF; not your brand | Same as C | Same as D, plus cross-domain cookie setup | Separate domain | High |
| F. Combo: C for résumé, B for posts, cookie carry-over | Clean | Best of both | Covered for both flows | Canonical on B pages | Low |

## Sourced notes

### 1. Industry structure (what link products do)

- **Dub** captures the click server-side, then redirects: "captures the click **server-side** before redirecting to your website" ([Dub attribution docs](https://dub.co/docs/concepts/attribution)). The click ID is appended to the destination: "The click is appended to your destination URL as a `dub_id` query parameter" (same page). Dub's client script stores it as a first-party cookie `dub_id`, default lifetime 90 days (`expiresInDays`) (same page). Dub's conversion docs say the script reads the `dub_id` query param and stores it as a first-party cookie ([Dub client-side conversion tracking](https://dub.co/docs/sdks/client-side/features/conversion-tracking)). So Dub uses a short path key plus query-param carry-over plus cookie.
- **Dub open source:** the repo is AGPLv3 for the core, with `/ee` under a commercial license ([github.com/dubinc/dub](https://github.com/dubinc/dub)). The README does not describe short-link URL structure. Dub's default short-domain format and custom-domain docs were not retrieved (custom-domains page returned 404). **UNVERIFIED:** Dub short links use `domain/key`.
- **Bitly:** custom domains replace `bit.ly` in links, available on some paid plans ([Bitly support](https://support.bitly.com/hc/en-us/articles/360033483331)). A separate vanity path on bitly.com is distinct from a branded short link on a dedicated domain ([Bitly blog](https://bitly.com/blog/brand-your-links-with-bitly)). The domain length limit is contradictory across sources. **UNVERIFIED.**
- **Short.io:** redirect types listed are 301 (permanent) and 302 (temporary) ([short.io llms index](https://short.io/llms.txt), via search). Link cloaking masks the destination. Default redirect type not verified. **UNVERIFIED.**
- **Rebrandly:** connect your own domain by DNS, then create links with back-halves on that domain ([Rebrandly support](https://support.rebrandly.com/en/collections/1123246-domain-management)). Not fetched in full.
- **HubSpot:** tracking URLs are a normal URL with parameters; HubSpot saves the info in the parameters ([HubSpot tracking URL help](https://knowledge.hubspot.com/Settings/How-do-I-create-a-tracking-URL?bbpage=1), via search snippet). Exact plan and menu details **UNVERIFIED.**
- **Takeaway:** the commercial products use a dedicated short domain because they host many customers' links and need the branding. The shared pattern is a path key, not a query key. For one personal domain, the domain is already the brand.

### 2. Query params vs redirect

- **UTM definitions:** `utm_source`, `utm_medium` and `utm_campaign` are required; `utm_term` and `utm_content` are optional. Analytics is case-sensitive: "`utm_source=google` is different from `utm_source=Google`" ([Google Analytics UTM help](https://support.google.com/analytics/answer/1033863)). The page has no length limit. The page is the legacy Universal Analytics article, so GA4 behaviour may differ **UNVERIFIED.**
- **Safari Link Tracking Protection:** removes known click IDs such as `fbclid` and `gclid`. Sources agree UTM parameters generally survive. The feature applies mainly in Private Browsing, Mail and Messages. Apple publishes no official list, and whether Safari 26 changed the default is disputed (secondary sources: [Terminus](https://www.terminusapp.com/blog/ios-17-link-tracking-protection-what-survives/), [Safari 26 gclid writeup](https://site-freelance-3ls.pages.dev/en/blog/safari-26-gclid-attribution/)). **UNVERIFIED** for custom params like `ref=`. Avoid click-ID-like names.
- **LinkedIn:** external links are sometimes wrapped as `linkedin.com/redir/redirect?url=...` with the destination in `url=`. Seen in a Mimecast threat report and a ClearURLs rule ([Mimecast](https://www.mimecast.com/it/threat-intelligence-hub/linkedin-redirect-abuse/), [ClearURLs MR](https://gitlab.com/ClearURLs/rules/-/merge_requests/88)). Whether LinkedIn post bodies are wrapped and whether UTM inside `url=` survives is **UNVERIFIED.** Test with a real post.
- **YouTube:** description links are wrapped as `youtube.com/redirect?q=<encoded URL>` (third-party sources only, [Clean YouTube Links](https://addons.mozilla.org/firefox/addon/clean-youtube-links)). The encoded `q` should carry the full destination, including UTM. **UNVERIFIED** by YouTube docs.
- **Referrer:** default `Referrer-Policy` is `strict-origin-when-cross-origin`. Cross-origin requests send origin only, path and query dropped ([MDN Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy)). Don't rely on referrer to carry the application code. Put it in the server-side path.
- **Google duplicates:** Google says rel=canonical is "a strong signal" for consolidating duplicate URLs. Its example is a `gclid` URL versus a clean URL, and it suggests preferring the clean one ([Google: consolidate duplicate URLs](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)). The Search Console URL Parameters tool was retired April 26, 2022 ([Google blog, 2022-03-28](https://developers.google.com/search/blog/2022/03/url-parameters-tool-deprecated)). So canonical tags are the mechanism, not a Search Console setting.
- **Résumé look:** a path like `girke.dev/r/k3Vw9QpX2nR7tLzA` is shorter than a `?utm_...` chain. No source for recruiter reaction; **UNVERIFIED** (judgement only).

### 3. Redirect hop vs direct landing: status codes and counting

- **308 cacheable by default:** RFC 7238 §3: "A 308 response is cacheable by default; i.e., unless otherwise indicated by the method definition or explicit cache controls" ([RFC 7238](https://www.rfc-editor.org/rfc/rfc7238.txt)). It notes 308 is "similar to 301." So 301 and 308 are cacheable by default. Consequence: a browser may skip your server on repeat opens, undercounting.
- **302 and 307:** not cacheable by default. Next.js says `permanent: false` gives 307, "temporary and is not cached," and `permanent: true` gives 308 "to cache the redirect forever" ([Next.js redirects](https://nextjs.org/docs/app/api-reference/config/next-config-js/redirects)). Next.js also allows a `statusCode` property instead of `permanent`, for custom codes such as 302 ("but not both", same page).
- **MDN on 302:** "temporarily moved" ([MDN 302](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/302)). MDN's redirect guide does not state caching behaviour in the text retrieved ([MDN Redirections](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Redirections)).
- **Google:** "If you just want to send users to a different page temporarily, use a temporary redirect" ([Google 301 redirects](https://developers.google.com/search/docs/crawling-indexing/301-redirects), via fetch). A tracking redirect is temporary by intent.
- **Cloaking/sneaky redirect risk:** Google defines cloaking as "presenting different content to users and search engines," and sneaky redirects as deceptive redirects ([Google spam policies](https://developers.google.com/search/docs/essentials/spam-policies)). A plain tracking redirect to the same content is not that. **UNVERIFIED** that Google would not flag it; reasoning from the definitions.
- **Recommendation for counting:** use 302 or 307 plus explicit `Cache-Control: no-store`. RFC note: explicit cache controls override defaults (secondary: [Redirect code summary](https://cutt.ly/resources/encyclopedia/redirect-301-302-307-308/)).

### 4. Bots and unfurl crawlers inflating opens

- **LinkedIn preview crawler:** secondary sources say redirect chains of 3+ hops can make LinkedIn give up, and that the preview cache is keyed by exact URL string. Cache duration conflicts (days vs weeks). **UNVERIFIED** (third-party guides only, [link.boo](https://link.boo/guides/linkedin-link-preview-not-showing), [flowpoint](https://blog.flowpoint.ai/post/v2/this-is-what-causes-your-screenshot-to-be-cached-too-soon-on-linkedin-and-how-to-fix-it/)). Implication: a crawler hitting `/r/<code>` logs a fake open. Filter known bot user agents.
- **Microsoft Safe Links:** rewrites inbound email links and checks them again at click time. The rewritten link routes the click through Microsoft's service ([Microsoft Safe Links policies](https://learn.microsoft.com/en-us/defender-office-365/safe-links-policies-configure), [Microsoft Safe Links training](https://learn.microsoft.com/en-us/training/modules/manage-safe-links-microsoft-365/2-protect-use-safe-links)). A scanner fetching `/r/<code>` may log an open. Whether PDF-attached links are scanned: **UNVERIFIED.**
- **Mitigation:** count an open on the first request per cookie or session, and filter bots by UA. Count link-scanner hits separately if the scanner UA is identifiable.

### 5. Subdomains

- **Cookie scope:** a host-only cookie (no `Domain`) "is not made available to subdomains," while `Domain=example.com` sends it to all subdomains ([MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)). So a `r.girke.dev` redirect host needs `Domain=girke.dev` to share a cookie with the main site. Dub's docs say the same for subdomain installs: set the cookie domain option `.example.com` ([Dub cross-domain tracking](https://dub.co/docs/sdks/client-side/features/cross-domain-tracking)).
- **`__Host-` prefix:** requires Secure, no `Domain`, `Path=/` ([MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)). Useful for the carry-over cookie on the apex domain, no subdomain needed.
- **Vercel setup:** adding a subdomain needs a CNAME. Vercel's docs say to use the project-specific target shown in Settings → Domains, not a generic value; the CNAME should include a trailing period ([Vercel custom domain](https://vercel.com/docs/domains/set-up-custom-domain), [Vercel troubleshooting](https://vercel.com/docs/domains/troubleshooting), via search). Generic `cname.vercel-dns.com` appears only in third-party guides. **UNVERIFIED** as current.
- **Reputation and deliverability:** Twilio's docs say spam filters judge link trust by root domain reputation, and link branding moves that check to your own domain ([Twilio SendGrid link branding](https://www.twilio.com/docs/sendgrid/api-reference/link-branding.md), via search). Secondary sources say public shorteners share reputation ([Suped](https://www.suped.com/learn/email-deliverability/how-to-shorten-long-sendgrid-branded-tracking-links)). Relevance here: a PDF résumé and social posts are not bulk email. So reputation is a weak reason for a subdomain. Keeping everything on `girke.dev` is the same advice.
- **Google host treatment:** separate hosts are treated separately for crawling and ranking. **UNVERIFIED** (not retrieved from Google docs).

### 6. Carrying code to the landing page

- **Dub pattern:** `dub_id` in query, read by script, stored as cookie for 90 days, read on conversion (sources in section 1).
- **Safari ITP:** Safari caps JavaScript-written cookies after link decoration from classified trackers, and deletes website data after 30 days of browser use without interaction (WebKit's ITP 2.0 post, via secondary). Secondary sources also cite a 7-day rule for `document.cookie` (conflicting; Simo Ahava says the mechanism changed in 2022). **UNVERIFIED** for exact rules. Girke.dev is not a classified tracker, so this should not apply to a first-party server-set cookie. Prefer `Set-Cookie` from the server response.
- **Firefox redirect tracking protection:** clears storage of origins classified as trackers that stored data within 72 hours. It excludes origins with user interaction in the last 45 days ([MDN redirect tracking protection](https://developer.mozilla.org/en-US/docs/Web/Privacy/Redirect_tracking_protection)). girke.dev is not a tracker, so no clearing is expected. **UNVERIFIED** as a non-issue.
- **Cookie design (proposed):** on `/r/<code>`, respond with `Set-Cookie: rc=<code>; Path=/; Max-Age=2592000; Secure; SameSite=Lax; HttpOnly` (30 days, host-only). The landing site reads it server-side for attribution. Last-touch wins. Limit: works only in the same browser; cookie is not sent to other hosts. Design choice, not a sourced rule.

## Recommended URL scheme

### Job applications

Code: 96 bits. Base64url is 6 bits per char, so 16 chars = 96 bits. Hex would need 24 chars.

| Use | URL |
|---|---|
| Résumé PDF link | `https://girke.dev/r/k3Vw9QpX2nR7tLzA` |
| GitHub profile | `https://girke.dev/r/k3Vw9QpX2nR7tLzA/profile/github` |
| Project | `https://girke.dev/r/k3Vw9QpX2nR7tLzA/project/rbc` |
| Project demo | `https://girke.dev/r/k3Vw9QpX2nR7tLzA/project/rbc/demo` |

Behavior: server looks up the code, logs an open (skipping bot UAs), sets the `rc` cookie, returns 302 (or 307) with `Cache-Control: no-store`, `Location:` the real destination. The destination carries no code in its URL. Keep the existing `/r` and `/go` routes working, either as redirects to `/r/...` or unchanged.

### Social posts

Destination with UTM, lowercase values, one campaign per post:

| Platform | URL |
|---|---|
| LinkedIn post | `https://girke.dev/projects/rbc?utm_source=linkedin&utm_medium=social&utm_campaign=rbc-writeup-2026-11` |
| YouTube description | `https://girke.dev/projects/rbc?utm_source=youtube&utm_medium=video&utm_campaign=rbc-demo-2026-11&utm_content=<video-id>` |
| GitHub README | `https://girke.dev/?utm_source=github&utm_medium=readme&utm_campaign=profile` |

Every page gets `<link rel="canonical" href="https://girke.dev/projects/rbc">` with no params, so UTM variants consolidate.

Fallback (only if a test post shows UTM stripped by a platform): `https://girke.dev/go/linkedin-rbc-writeup` → 302 → destination plus UTM, with the same logging as `/r`.

Verify before relying on it: post a test link on LinkedIn and YouTube, click it, confirm `utm_*` arrives on the destination.

## Open items (UNVERIFIED list)

1. Whether LinkedIn post bodies wrap external links and whether UTM survives (test).
2. Whether YouTube description `q=` carries UTM intact (test).
3. Whether Safari or Firefox strip custom params like `rc` or `ref` in any mode (test in Private Browsing).
4. Dub's default short-link format and custom-domain docs (404 on fetch).
5. Whether Google treats the `/r` redirect pattern as anything but a normal redirect.
6. LinkedIn preview crawler redirect-hop limit and cache behaviour (only secondary sources).
7. Current Vercel CNAME target (use the one in the project dashboard).

## Sources

- Dub attribution: https://dub.co/docs/concepts/attribution
- Dub client-side conversion tracking: https://dub.co/docs/sdks/client-side/features/conversion-tracking
- Dub cross-domain tracking: https://dub.co/docs/sdks/client-side/features/cross-domain-tracking
- Dub repo: https://github.com/dubinc/dub
- Bitly custom domain: https://support.bitly.com/hc/en-us/articles/360033483331
- Bitly blog: https://bitly.com/blog/brand-your-links-with-bitly
- Short.io index: https://short.io/llms.txt
- Rebrandly domain management: https://support.rebrandly.com/en/collections/1123246-domain-management
- HubSpot tracking URL: https://knowledge.hubspot.com/Settings/How-do-I-create-a-tracking-URL?bbpage=1
- Google Analytics UTM: https://support.google.com/analytics/answer/1033863
- Google consolidate duplicate URLs: https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls
- Google URL Parameters tool retired (2022-03-28): https://developers.google.com/search/blog/2022/03/url-parameters-tool-deprecated
- Google 301 redirects: https://developers.google.com/search/docs/crawling-indexing/301-redirects
- Google spam policies: https://developers.google.com/search/docs/essentials/spam-policies
- MDN Referrer-Policy: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy
- MDN 302: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/302
- MDN Redirections guide: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Redirections
- MDN Set-Cookie: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie
- MDN redirect tracking protection: https://developer.mozilla.org/en-US/docs/Web/Privacy/Redirect_tracking_protection
- RFC 7238 (308): https://www.rfc-editor.org/rfc/rfc7238.txt
- RFC 9110 (not retrieved in full; section 15.1 list not confirmed): https://www.rfc-editor.org/rfc/rfc9110.html
- Next.js redirects: https://nextjs.org/docs/app/api-reference/config/next-config-js/redirects
- Vercel custom domain: https://vercel.com/docs/domains/set-up-custom-domain
- Vercel troubleshooting: https://vercel.com/docs/domains/troubleshooting
- Twilio SendGrid link branding: https://www.twilio.com/docs/sendgrid/api-reference/link-branding.md
- Microsoft Safe Links policies: https://learn.microsoft.com/en-us/defender-office-365/safe-links-policies-configure
- WebKit ITP 2.0 (secondary, via search): https://webkit.org/blog/8311/intelligent-tracking-prevention-2-0/
- WebKit "Full Third-Party Cookie Blocking and More": https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- Safari LTP secondary (Terminus): https://www.terminusapp.com/blog/ios-17-link-tracking-protection-what-survives/
- LinkedIn redirect wrapper (Mimecast): https://www.mimecast.com/it/threat-intelligence-hub/linkedin-redirect-abuse/
- ClearURLs rule: https://gitlab.com/ClearURLs/rules/-/merge_requests/88
- Clean YouTube Links (YouTube wrapper, third-party): https://addons.mozilla.org/firefox/addon/clean-youtube-links
- LinkedIn preview caching (secondary): https://link.boo/guides/linkedin-link-preview-not-showing
- Suped (shorteners and SendGrid, secondary): https://www.suped.com/learn/email-deliverability/how-to-shorten-long-sendgrid-branded-tracking-links
