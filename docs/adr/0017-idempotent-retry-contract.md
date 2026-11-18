# Idempotent retry contract

Quantself requires an `Idempotency-Key` for non-idempotent API commands,
including Product Capture and adding, moving, or removing units. Keys are
scoped to the authenticated Client and operation; replaying the same key and
request returns the original result, while reusing a key with a different
request returns `409 Conflict`. This lets mobile apps, automations, and agents
retry uncertain network outcomes without duplicating Products or quantities.
