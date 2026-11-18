# Public API is the application boundary

Quantself's versioned HTTP API is the sole application and database boundary
for all Clients, including the built-in web app. The API owns authorization,
validation, use cases, transactions, and persistence; the web app performs no
direct domain database access and uses a generated typed API client for both
reads and writes. Server Components call the API over the private deployment
network while browsers use the same-origin public route, accepting a small
internal HTTP cost to keep one contract, make every capability available to
external Clients, and prevent web/API behavior from diverging.

The web server is limited to Server Component rendering and streaming,
Credential transport, API calls, UI view-model formatting, navigation,
Next.js cache coordination, and static assets. It contains no database access,
authentication decisions, domain use cases, transactions, media persistence,
worker protocols, or domain integration secrets.
