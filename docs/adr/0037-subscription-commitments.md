# Subscriptions own their billing terms; calendars and forecasts derive payments

Status: accepted, 2026-11-08.

A Subscription has its own owner-scoped database record and API. Putting its lifecycle inside Budget Note entries would make direct management, discovery, links, and revision conflicts depend on unrelated plan edits. Creating separate recurring expense rows or calendar events would introduce duplicate financial sources and cleanup jobs on cancellation.

Instead, a Subscription owns a validated, bounded array of dated Billing Terms. Scalar fields hold its identity, links, lifecycle, inference evidence, and concurrency revision. Terms stay together because each update and its historical validation form one small aggregate; they are not an arbitrary OCR blob. Keep earlier terms immutable via normal edits and append effective changes. Matching actual charges retain their own immutable bank records. A later need for SQL reporting across term versions could normalize this array without changing the public contract.

A shared pure recurrence package produces stable, date-keyed Expected Subscription Payments. The API merges unpaid expectations into the existing forecast, while Calendar renders expected and matched paid occurrences. An actual transaction replaces an expectation; future expectations never become transactions. Subscription writes and bank imports invoke the same conservative matcher, with owner isolation and serializable transactions. Generic Budget Note patches cannot overwrite subscriptions.

No cron scheduler, extra service, duplicate bill entry, or external logo request is required. Static provider logos are bundled locally. Cancellation is an explicit no-more-charges cutoff, not an integration that cancels a service externally. Unscheduled candidates remain visible without speculative costs in forecasts.
