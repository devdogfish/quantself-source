# Website analytics

The Owner dashboard reads two session-authenticated reports from the Quantself API. **Website** (`/website-analytics`) uses `GET /api/v1/website-analytics/website` with `range` (7, 30, or 90 days) and optional `channel`, `project`, and `device` filters. **Job search** (`/website-analytics/job-search`) uses `GET /api/v1/website-analytics/job-search`. Add `?applicationId=` to the Job search page URL to open one application. The web types come from OpenAPI. `bun run preview:website-analytics` runs both pages against fictional reports.

## Native reports

Apply the Quantself migrations for [website ingest](website-analytics-ingest.md) and tracked links to the Docker development database. Start the main API and web with their normal local auth settings. Sign in as the Owner and open `/website-analytics`. The reports read the primary PostgreSQL database.

- Website reads the selected UTC range and the same number of days immediately before it. Both periods use identical channel, project, and device filters. Comparison counts reflect recorded rows, including imported history.
- A session's channel comes from the first qualifying view. The registered `via` takes precedence over UTM source and referrer. Direct sessions and unrecognized sources use the direct and other channels respectively.
- A tracked visit needs engagement from the exact `via` in the same browser session. Proof is at least five seconds active, a positive scroll, or a click. A page view or bare redirect does not establish a human visit.
- Scanner opens are HEAD requests, known bot user agents, or opens from the recorded send time up to ten seconds after it. A burst of different destinations of the same code within two seconds from one pseudonymous IP is also a signal. Matching browser engagement can clear a burst-only flag. A matched hard scanner and its browser events stay out of traffic counts. Job search shows scanner opens separately.
- Posts show distinct browser visitors per UTC day for the first seven days, including zeros. Inquiry status comes from `website_inquiry`. Its recorded link supplies the channel. Inquiry records lack device and project attribution, so those traffic filters do not change the inquiry list. The Owner can mark an inquiry replied in the dashboard.
- Job search includes issued links with no activity and uses the first confirmed submission time. Jobs supplies the current interview and rejection outcomes. Reply coverage depends on [#196](https://github.com/devdogfish/quantself/issues/196). Outcome timestamps remain unpopulated.

The portfolio sends new events and inquiries through Gate to Keep. The frozen Umami history was imported into Quantself. The [ingest and import handoff](website-analytics-ingest.md) covers read-only reimport and the preserved Hostinger rollback collector.

## Tracked links

The portfolio owns destinations and resolves both application and share links at `/r/<code>` or `/r/<code>/<key>`. New codes use eight random base62 characters. Existing 16-character and 24-character application codes stay registered.

Quantself stores both kinds in PostgreSQL's `tracked_link` table. Put three distinct credentials in the API environment and supply the matching credential to its caller in `X-API-Key`.

| Call | API credential | Response |
| --- | --- | --- |
| `GET /api/v1/tracked-links/{code}` | `QUANTSELF_TRACKED_LINKS_READ_TOKEN` | `{code, kind: "application", track}` or `{code, kind: "share", track}` |
| `POST /api/v1/tracked-links/applications` | `QUANTSELF_TRACKED_LINKS_APPLICATION_TOKEN` | Send `{applicationId, company, role, track, revision}` to receive `{code}` |
| `POST /api/v1/tracked-links/shares` | `QUANTSELF_TRACKED_LINKS_SHARE_TOKEN` | Send `{title, track?}` to receive `{code}` |

Lookup uses one primary-key read. Successful responses use `Cache-Control: public, max-age=86400` and `Vary: X-API-Key`. A missing code returns 404 and an unavailable registry returns 503. Errors are not cached. The portfolio calls this endpoint server-side. Company, role and application ID remain private.

Application registration keeps the code on an exact retry or a higher revision. A stale or contradictory revision returns 409. Each share registration issues a fresh code. Omit the share track for the default portfolio view.

Application links support Web / CMS, Admin / Excel, DevOps, Frontend, Backend and Full Stack. Shares also support Client. Previously issued Software codes open Backend. The existing Jobs engineering résumé uses Backend for portfolio links.

Set `QUANTSELF_API_URL` and `QUANTSELF_TRACKED_LINKS_SHARE_TOKEN` in the Owner CLI environment, then run:

```sh
bun run links:share --title "Kristina Girke footer" --track client
```

The command prints `https://girke.dev/r/<code>`. Website analytics shows opens and engaged site visits for each share by title. Opens include automated requests.

For tracked résumé rendering, set `applicationTracking.registryUrl` in the local Jobs private configuration to the API's full HTTPS application registration URL and set `applicationTracking.token` to the application credential. The renderer reads the public portfolio catalog once without credentials, registers the revision once directly with Quantself, and writes flat redirect URLs. Existing résumé mail routes keep their tracking disabled.

The portfolio catalog retains its discovery lists and adds a source URL map. The synthetic renderer fixture uses this shape:

```json
{
  "schemaVersion": 1,
  "destinations": [
    {"key": null, "sourceUrls": ["https://girke.dev", "https://girke.dev/", "https://luigigirke.com"]},
    {"key": "github", "sourceUrls": ["https://github.com/example-owner"]},
    {"key": "rbc-demo", "sourceUrls": ["https://demo.example.org/"]}
  ]
}
```

The home entry includes the compiler's own portfolio links. Each source URL belongs to one entry. A catalogue error stops rendering before registration. The PDF check verifies registered replacements and direct HTTP(S) links explicitly included in the edited résumé Markdown.
