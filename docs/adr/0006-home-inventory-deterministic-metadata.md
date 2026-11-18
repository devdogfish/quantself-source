# Home Inventory Deterministic Metadata

Inventory capture must stay fast and local. The MVP therefore generates
category, tags, aliases, search text, and metadata synchronously in the Next app
from submitted fields and image filenames/captions/OCR placeholders.

No inventory enrichment, vision/OCR, speech-to-text, embeddings, or external API call is in
the save path.

Persisted metadata records:

- generator version
- source fields
- future hook names for inventory enrichment, OCR, STT, embeddings, vision captions, and
  reindexing

Later AI enrichment can update the same Inventory Item records without changing
the capture contract.
