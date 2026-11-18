# API-owned task read projection and live freshness

The Owner explicitly reversed the no-task-caching policy: GitHub remains authoritative, while the Quantself API owns a disposable Owner/repository-scoped PostgreSQL read projection and authenticated SSE updates for all Clients. This supersedes ADR 0027's cache restriction, while preserving fresh GitHub validation for mutations, durable capture/command evidence, and the absence of a general offline mutation queue. Next.js cache tags cannot own this boundary because API traffic and external Clients bypass Next.js.

Verified changes publish durable ordered events atomically with the projection; generations protect against stale refreshes and delayed pushes. Signed GitHub webhooks invalidate the projection, with foreground/periodic repair for lost deliveries; known access revocation clears protected records. Initially support one API coordinator; multiple replicas require shared refresh ownership before deployment.
