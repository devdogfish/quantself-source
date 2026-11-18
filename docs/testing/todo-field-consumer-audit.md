# Task field and request audit (#121)

GitHub remains task authority. This audit retains all native fields, unknown field
values, comments, source evidence and managed extensions; it removes no data.

| Data | Consumers and preservation |
| --- | --- |
| Title, description/body, issue identity | Capture, list, detail, calendar and Jarvis. Description edits preserve comment-delimited metadata and source evidence. |
| Commitment | Inbox/Active/Someday filtering and planning eligibility; independent of closure. |
| Category | Native category options/colors, category filters, list and calendar. Renames retain option identity. |
| Rank, Top priority | Existing list order and priority controls; planning/context reuse that order. Never discarded as field cleanup. |
| Due | Native date-only deadline; range reads, flags, detail, facts editor and Jarvis. No migration write for existing dates. |
| Location, Client | Existing task facts/editor and Jarvis. Location remains native text. |
| Estimate, Cost of waiting, Waiting since | Existing facts and planning/advice inputs; omitted values remain unknown. |
| URL, Alert | Optional native values remain readable. URL opens directly from calendar/list/detail. Existing Alert presentation is preserved; notification delivery is deferred. |
| Native closure, duplicate target, relationships | Completion, recoverable Trash, prerequisites/readiness and explicit execution approval. Parent/child relationships do not imply blocking. |
| Managed timing and prep | One active range; calendar, editor, API and Jarvis share it. Prep remains independent of deadline. Malformed/ambiguous legacy timing stays visible for review. |
| Managed deadline time | Optional `quantself:deadline` extension paired with native Due; external date changes retain evidence and expose a diagnostic. |
| Managed Trash, provenance and unknown extensions | Existing lifecycle/retry semantics, source links and archives remain intact through unrelated edits. |

`canonicalTodoFields` in `apps/api/src/todos-github.ts` validates ten organization
field definitions. URL/Alert are optional read-through fields; arbitrary additional
field values remain in `fieldValues`. Task edits use the existing native-field
writer, not a second database model or new per-field fetch flow.

Bulk issue/field reads remain completely paginated. Calendar Due flags, list
metadata and direct links consume the shared collection projection with no per-row
fetch. Native field writes batch changed values; deletion uses the required
per-field endpoint with bounded concurrency. Selected detail retains its existing
GraphQL/REST read seam; context and the detail panel coalesce identical in-flight
reads. Cache reads do not replace fresh revision/prerequisite checks on writes.

Measured isolated GitHub fixture #8: cold detail including App setup took seven
requests/1276 ms; warm detail took two requests/499 ms. A partial timing edit used
four requests/one write; adding native Due plus managed deadline time used seven
requests/two writes. An identical deadline retry used three reads/zero writes.
Rendered delayed Trash→Restore→Undo used one collection read and three writes;
calendar presentation and link rendering add no requests. These are individual
measurements, not scaling or latency guarantees. Full deployment/device evidence
and other acceptance results are in `implementation-117-acceptance.md`.
