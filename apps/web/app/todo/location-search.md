# Location suggestions

The task popover searches addresses and named places with [Photon](https://github.com/komoot/photon), using OpenStreetMap data. Selecting a result saves its full display address into the existing Location field through the task's optimistic command queue. Manual locations remain supported. No browser geolocation is requested. Coordinates are retained only in a bounded in-memory preview cache; the task still stores only its address text.

The default endpoint is `https://photon.komoot.io/api/`. Photon explicitly permits reasonable project usage of its public demo server, supports search-as-you-type, and needs no API key. It provides no availability guarantee; excessive traffic may be throttled. This default suits the owner's occasional lookups. For higher traffic or guaranteed availability, set `NEXT_PUBLIC_PHOTON_URL` to a compatible hosted/self-hosted Photon `/api/` endpoint before building the web app. The endpoint must allow browser CORS requests. Public Nominatim is not used: its usage policy forbids autocomplete.

Only the typed query or opened task's address is sent to the geocoder, anonymously with credentials omitted and no referrer. No saved task collection, notes, or browser location are sent. Search begins after three characters and 500 ms of idle typing, requests at most five suggestions, aborts on changes/blur/unmount, ignores stale responses, and times out after eight seconds. There are no automatic retries. The response includes all address information needed for selection, avoiding a second detail request. Attribution remains beside results.

Suggestions float in an anchored portal above the task card without resizing its
layout. Search state stays independent of saving, so results and deferred lookups
survive the three-second autosave and same-value task refreshes while focused.
They close on selection, Escape, blur or an outside interaction.

Location edits save on blur or after three seconds without typing; selecting a suggestion saves immediately. Enter chooses the keyboard-highlighted suggestion, or saves free text if none is highlighted. Escape restores the current saved/optimistic value. Search errors leave the field editable and display a manual-entry fallback.

Tests hold lookup responses open and verify one request per settled query, zero requests below three characters, cancellation/stale suppression, keyboard selection, and later edits against the optimistic baseline. A live smoke request for Halifax Central Library returned one matching feature and `Access-Control-Allow-Origin: *` (October 28, 2026); availability/latency can vary.

Local smoke timing on October 28, 2026: the first public lookup took 1,096 ms;
a repeat in the same process took 798 ms. Each returned 3 results / 1,439 bytes
with one request. These network measurements exclude the deliberate 500 ms typing
debounce and are samples, not service guarantees. Task-detail read counts are unchanged.

## Map preview

Opening a task with a location shows a noninteractive Leaflet/OpenStreetMap preview below notes. It uses the current optimistic address, debounces changes for 500 ms, and discards stale responses. Autocomplete suggestions seed the coordinate cache, so a selected suggestion needs no second lookup. A cold saved address makes one bounded Photon request; concurrent requests for the same address coalesce. The cache holds at most 100 addresses for one day. Lookups time out after eight seconds without retries. No-match, geocoder failures, and tile failures retain a clickable address fallback. Only the open task requests a preview.

OpenStreetMap tiles load directly in the browser with normal HTTP caching and visible attribution; no tile prefetch or offline download is performed. The preview opens the location in Apple Maps. Its appearance uses OpenStreetMap cartography, not Apple's authenticated MapKit service.

The optional footer shows today's local weather in Celsius from Open-Meteo, rather than a forecast for the event date. Coordinates are rounded to three decimals for weather requests. One request returns the current condition and today's high/low; a 100-entry, 15-minute memory cache coalesces repeated requests. Weather times out after eight seconds and hides silently on failure. Provider attribution stays visible.

Preview smoke measurement (October 28, 2026, Halifax City Hall): one cold geocoder request took 1,576 ms, and one cold weather request took 233 ms. Repeating both in the same process made zero additional requests and resolved in under 1 ms. These samples exclude the UI debounce and map-tile loading; a live browser preview rendered two 256-pixel map tiles. No task API requests were added.
