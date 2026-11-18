# Website visitors book meetings in Quantself

Status: proposed, 2026-11-15.

Portfolio visitors book a 30-minute call with the Owner. Quantself owns availability and bookings, and the Quantself Calendar is the only calendar the Owner reads. There is no external calendar or scheduling service, and nothing to sync.

**Flow.** The booking UI is the portfolio's own `/book` page, built with the portfolio's UI. It lists open slots and takes a name, email and optional note. The Quantself web app stays reachable only over Tailscale. Visitors' browsers never contact Quantself; only the portfolio server does. It sends a scoped token whose only permission is booking meetings (ADR 0015). Gate's public ingress (#209) allows exactly these paths and returns 404 for everything else:

- `GET /api/v1/meetings/availability?from&to` returns open slot start times. It never says what is busy or why.
- `POST /api/v1/meetings` books a slot. The API rechecks the slot inside the same transaction and returns a conflict if it is gone. Requests are idempotent (ADR 0017).
- `POST /api/v1/meetings/cancel` cancels the meeting that matches a guest's cancel token. The portfolio's `/book/cancel/<token>` page calls it.

The routes validate input strictly, cap the request body size, and return only slot times and a booking confirmation. If the token leaks, it can only read open slots and book or cancel meetings.

Booking confirms instantly. There is no Owner approval step.

**Availability.** There is one meeting type: 30 minutes, starting on the hour or half hour. Open slots are the Owner's weekly booking hours, in the Owner's timezone, minus:

- scheduled tasks (including all-day events), native appointments, timed habit routines, and existing meetings, with at least 15 minutes of clearance on either side. Longer prep and travel buffers still apply.
- slots inside the minimum notice period
- slots beyond the booking horizon

Hours, notice and horizon are Owner settings. Date-only reminders such as deadlines and payments do not reserve time.

**Meeting.** Each booking stores the time, guest name, email and note, and gets a random Jitsi room on the public Funnel link (ADR 0045). The Owner still signs in as Jitsi host to start the room. Meetings are a Calendar Source (ADR 0035): a read-only lane that opens the meeting's details and room link.

**Email.** Quantself sends through SES on the Owner's domain (ADR 0040):

- an `.ics` confirmation to the guest and the Owner
- a reminder one hour before
- a cancellation notice

Each guest email includes a cancel link built from an unguessable token. Rescheduling means cancelling and booking again.

**Abuse.** The portfolio checks a Cloudflare Turnstile token before calling the API. The API rate-limits per scoped token and per guest email, and it caps how many future meetings one email can hold.

Considered:

- **Cal.com, cloud or self-hosted:** it is ready-made and has a Jitsi integration, but it would move availability into a second calendar that has to sync with Quantself both ways. Self-hosting it would also add another app and database to run.
- **Owner approval per request:** rejected; instant confirmation is simpler for visitors.
