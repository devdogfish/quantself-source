# Private Codex SDK Inventory Enrichment Worker

Inventory enrichment uses a trusted private single-user Codex SDK worker after inventory preprocessing. The normal production target is a separate Docker Compose worker service on the VPS that runs beside the deployed API and Next.js app at `dashboard.example.com`. The worker runs outside Next.js and API request handling, consumes inventory text bundles only, returns proposed derived fields, and must not be exposed as a public backend for arbitrary users because Codex execution and ChatGPT-plan auth belong in trusted automation contexts. Capture still saves source evidence first, and inventory proposals preserve the source-fact rule before search-visible fields change.

The enrichment worker entrypoint is `apps/web/scripts/run-inventory-codex-enrichment-worker.ts` and it runs with `bun`. This keeps the Codex-specific enrichment worker distinct from the preprocessing worker at `apps/web/scripts/run-inventory-preprocessing-worker.ts`.

The production worker is wired as a private Compose service, not as a local Mac tunnel. It calls the deployed API through the internal Compose network at `http://api:3001` and uses authenticated worker endpoints for claim, image fetch, success, and failure submission. The Compose topology includes both worker services and a persistent Codex home volume. Caddy rejects the API-internal route prefix so the worker protocol is not reachable through the public gateway.

The worker uses the Codex SDK with a cached ChatGPT login stored in a persistent `CODEX_HOME` volume. It should not require `OPENAI_API_KEY` or API-key Codex auth unless this decision is explicitly revisited. The first server deploy requires a one-time `codex login` inside the worker container/volume; after that, deploys should reuse the persisted auth state.

Worker API calls are authenticated with `INVENTORY_ENRICHMENT_WORKER_SECRET`. The API may expose private claim/success/failure/image endpoints on the internal network, but those endpoints must only execute the inventory worker protocol; they must not expose arbitrary Codex execution or a general public inventory API.

The Codex SDK worker must return strict JSON only:

```ts
{
  title?: string;
  category?: string;
  tags?: string[];
  aliases?: string[];
  status?: "KEEP" | "DONATE" | "TRASH" | "UNSURE";
  importance?: "HIGH" | "MEDIUM" | "LOW";
  note?: string;
  confidence: number;
  rationale: string;
}
```

These fields are proposals. They are derived values, not source facts.

Inventory proposals require approval by default. Auto-apply is allowed only when an explicit setting disables approvals, because applied enrichment changes search-visible fields such as title, category, tags, aliases, status, importance, and note.
