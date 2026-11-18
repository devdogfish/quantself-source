# Keep task AI outside Quantself

Superseded by [ADR 0027](0027-github-backed-todos-and-embedded-voice.md). The text below records the earlier design, not the current storage or integration boundary.

Quantself owns the structured task data, shared task rules, and API that authorized Clients use. External AI Clients handle recordings, interpret unstructured input, and choose when to write tasks through that API; Quantself does not implement their models, recording workflow, orchestration, or platform integrations. This keeps the task system small and self-contained while allowing AI tooling and capture policies to change independently.

The primary capture ritual is a low-friction voice note recorded and submitted before bed to prepare for the following day, replacing cumbersome manual task writing. The external capture workflow preserves the original audio as a backup in a separate archive; the owner's NAS is a possible location, not a settled choice. A transcript feeds the external AI Client, which extracts structured task data and writes it to Quantself. Quantself's database holds the essential structured task information; original recordings and transcripts are not required task records.
