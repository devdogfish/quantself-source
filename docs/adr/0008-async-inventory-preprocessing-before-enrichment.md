# Async Inventory Preprocessing Before Enrichment

Inventory capture saves source evidence quickly, then an asynchronous inventory preprocessing step transcribes audio/video, extracts OCR and semantic image text, and only then sends an inventory text bundle to inventory enrichment. If some preprocessing text succeeds, enrichment may continue with recorded failure notes; if no text is produced, enrichment is skipped and the item is marked needs review. Preprocessing and enrichment workers run outside the Next.js request path. This keeps capture low-friction, keeps enrichment text-only, and preserves manual review when preprocessing has no usable evidence.

Preprocessing has its own job state before enrichment:

- `QUEUED`: saved and waiting for a worker
- `PROCESSING`: worker has claimed the item
- `READY_FOR_ENRICHMENT`: all required preprocessing produced usable text
- `PARTIAL`: some usable text exists, but one or more preprocessing steps failed
- `NEEDS_REVIEW`: no usable text exists after preprocessing
- `FAILED`: worker or system failure prevented a reliable preprocessing result

Only `READY_FOR_ENRICHMENT` and `PARTIAL` items can continue to inventory enrichment.

Persisting either of those terminal preprocessing states and its matching
Inventory Enrichment job is one database transaction. The preprocessing worker
also performs one idempotent startup reconciliation for historical completed
jobs that have no matching enrichment input fingerprint. A handoff failure must
remain retry-visible; it must never be discarded after preprocessing is marked
complete.

The `Inventory Text Bundle` is the only enrichment input:

```ts
{
  item: {
    id: string;
    title: string | null;
    note: string | null;
    kind: string;
    status: string;
    importance: string;
    locations: {
      origin: string | null;
      current: string | null;
    };
    containerLabel: string | null;
  };
  captureText: string | null;
  mediaTexts: Array<{
    mediaId: string;
    type: "image" | "audio" | "video";
    transcript?: string;
    ocrText?: string;
    semanticCaption?: string;
  }>;
  failedSteps: Array<{
    mediaId?: string;
    step: "transcript" | "ocr" | "semantic-caption";
    message: string;
  }>;
  sourceRefs: Array<{
    kind: "item" | "media";
    id: string;
  }>;
}
```
