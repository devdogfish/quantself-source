# API-owned Better Auth

Quantself hosts Better Auth in the API, which is the only component that
validates Credentials and produces an Access Context. The built-in web Client
uses Better Auth passkeys and its default database-backed Owner Session cookie,
without JWTs, stateless sessions, or cookie caching; browsers send the session
same-origin, and Next.js forwards it when rendering through the private API
address. Native Clients use Better Auth's platform integration and secure
session storage. Headless Clients send revocable, least-privilege API Keys
through Better Auth's default `X-API-Key` header; the API verifies them directly
and does not turn them into Owner Sessions. This follows Better Auth's defaults,
keeps revocation immediate, and prevents Client credential types from changing
application authorization or giving the web app privileged database access.
