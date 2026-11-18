# Contextual priority and scheduling review (#116, PRD #103)

External AI Clients read `GET /api/v1/todos` without date filters for the entire task graph: Due, Cost of waiting, Waiting since, Commitment, Estimate, Rank, Top priority, original prose, sessions, blockedBy and prerequisite states. Follow prerequisite chains; consider work enabling the Owner's important blocked outcomes, including Someday prerequisites without activating them. No server importance formula or automatic scheduling.

The Web Client's **Planning suggestions** control provides an active review UUID. An authorized AI Client publishes individual explained operations to `POST /api/v1/todo-suggestions/{reviewId}` (todos:write). Example:

```json
{
  "number": 12,
  "revision": "2026-10-26T12:00:00Z",
  "reason": "Allow enough time to prepare the prerequisite for your selected client outcome.",
  "command": {
    "commandId": "5d72f10e-99cc-4d46-8bf8-d09f420ba453",
    "fields": {"Estimate": {"before": 30, "after": 45}}
  }
}
```

Use the task's actual updatedAt revision and before values. Allowed proposals: Rank, Top priority, Estimate and flexible session patches (including preparation and travel estimates). Session commands also carry revision; retain stable session IDs and explicit timing certainty. Each operation has a stable UUID. Repeated publication must retain identical input. Fixed Appointment changes and commitment activation require separate explicit task edits.

Refresh suggestions to read the review. The API's `POST /api/v1/todo-suggestions/review` requires only todos:read, checks current sources, rejects fixed Appointment edits, and changes no task or review facts. Owner edits proposed field values or opens the ordinary task editor, then explicitly applies or dismisses. The UI rechecks before first application and sends the ordinary task PATCH with source revision and before values. Each task operation applies independently; inspect every returned outcome. Partial/uncertain applications retain exact commands across refresh for reconciliation. Changing a reviewed operation after an attempted delivery requires a new ordinary command, never reuse its ID with new input.

Dismissal writes only Owner-scoped review command metadata, shared between authorized Clients. It survives refresh and identical publication retries. New review IDs can reconsider changed context. Review metadata uses existing generic command receipts; it is neither canonical task storage nor a dated plan snapshot. Task facts remain exclusively on issues. The current review and exact attempted commands remain in browser session storage; review selection does not survive clearing that storage.

Deterministic checks: HTTP tests in todos-route, todos-suggestions and todos-write; rendered review/edit/apply/dismiss test in todo-suggestions.test.tsx. Live provider/deployment acceptance remains release work; no executor or production task writes are exercised by these tests.
