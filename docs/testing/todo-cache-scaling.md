# Synthetic task-cache scaling — 2026-10-28 UTC

Reproduce with `bun apps/api/scripts/benchmark-todo-cache.ts`. Hardcoded synthetic
records and the existing memory-store/source seams; no network, real task writes,
credentials, PostgreSQL or browser. Bun 1.3.14, macOS arm64. Five warm samples per
path; values below are medians. Cold population is one sample, separately measured.
Route timings include Hono handling, JSON serialization and parsing. Payload bytes
are raw UTF-8, before transport compression. Host load/JIT affect these measurements.

Fixture: 25% timed, 20% closed, 20% native Due, with non-overlapping half-hour
intervals spread across dates. Each task has synthetic notes, native field values
and ordinary normalized metadata. No comments or recordings. This is a repeatable
mixed-load example, not a worst-case bound or a prediction of production latency.

| Tasks | Cold cache ms | Warm cache ms | Warm full API ms | Full JSON bytes | Warm seven-day API ms | Seven-day rows / bytes |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 4.66 | 0.46 | 4.54 | 152,548 | 2.38 | 40 / 62,509 |
| 1,000 | 30.73 | 6.08 | 11.56 | 1,530,634 | 13.98 | 178 / 278,759 |
| 10,000 | 214.21 | 54.60 | 150.70 | 15,365,440 | 139.88 | 178 / 278,759 |

Each cold population called the synthetic bulk source once and detail zero times.
Every warm path, across all sizes and samples, called both sources **zero times**.
There is no per-record upstream fan-out. These source counts are fixture calls,
not measured GitHub pagination requests. Real GitHub cold/warm measurements remain
in `implementation-117-acceptance.md`.

## Query shape and conclusions

The workspace intentionally loads the complete collection once for list/search,
calendar navigation, Trash and next-week context. Selected full detail is separate
and coalesced. Warm Postgres-backed reads check the indexed scope revision; an
unchanged generation avoids reloading projection rows. This benchmark substitutes
the memory store and does not measure those database round trips.

The current projection uses the `(scope, number)` key; it does **not** have indexed
Due/range filters. The API clones the collection, derives prerequisite readiness
and timing warnings, then filters a requested date range in memory. Hence the
seven-day payload stays small while processing time still grows with the complete
collection. Pairwise overlap analysis also remains a pre-existing quadratic path
for a heavily timed collection. The fixture does not stress dense overlapping
appointments or long dependency chains.

No new upstream fan-out or API payload-shape regression was observed in the bulk
read path. Do not silently narrow workspace reads or remove fields needed by
optimistic receipt reconciliation. No broad query/schema redesign was made.
The measured 15.4 MB uncompressed response at 10,000 tasks is a meaningful scaling
limit, not an instant-load guarantee. An optional compact collection contract and
indexed range/readiness strategy would require separate compatibility work.

One narrowly scoped payload follow-up is worth evaluating: targeted refresh/write
results can contain full detail comments, unlike bulk list rows. Excluding those
comments from disposable collection/SSE projections would retain on-demand detail
while avoiding accidental collection growth; it does not require dropping issue
body/provenance used by current clients. This benchmark deliberately contains no
comments and does not claim that follow-up is implemented.
