# Responsive interaction

Quantself should feel immediate, dependable and enjoyable during frequent daily use. Every unnecessary wait or repeated action discourages returning. Treat low friction and positive reinforcement as product requirements, alongside correctness and access control.

## Default behavior

- Render reversible intent in the same interaction: selection, scheduling, resizing, priority, ordering, task edits, completion and recoverable trash. An asynchronous save must not block the next independent action.
- Make Undo and Redo immediate too. Record intent when accepted locally; acknowledgements must not duplicate history, clear Redo, or restore an older visual state.
- Keep editing, navigating and dismissing panels available. Preserve in-progress drafts and focus when background results arrive. Show useful local content while details load.
- Use quiet pending feedback. Reserve success announcements for outcomes that need attention; use clear, actionable errors for rejected or uncertain work. Optimistic appearance is not proof of persistence.
- Share pending changes across every view of the same record. Serialize dependent writes, apply current verified revisions before dispatch, and keep in-flight command IDs and payloads unchanged for retries. Prefer returned records to collection reloads.
- Roll back only rejected changes and dependent intent that cannot safely apply. Preserve unrelated work. Keep uncertain intent visible with retry/reconciliation; explain conflicts instead of overwriting external changes.
- Preserve authorization, validation, prerequisite checks and constraints such as the three-priority limit against the optimistic state too.

## Server-confirmed boundaries

Irreversible actions, execution approval, external side effects, and operations whose result cannot be predicted need authoritative confirmation. Their controls should acknowledge intent immediately and leave unrelated UI usable. Document the concrete reason when an action cannot follow the optimistic default.

## Verification

Hold the first network response open, perform multiple actions and Undo/Redo, and verify each visible state before resolving the request. Deliver older responses while newer intent remains pending; the latest visual state must survive. Cover rejection, uncertain delivery with identical retries, partial saves, and external conflicts. Measure interaction-to-render time and request counts separately from server latency. Check keyboard behavior and reduced motion. A fast local server is not evidence of optimistic behavior.

## Current task implementation

Calendar timing uses a serial command queue and shared optimistic projections; history changes at interaction time. The same standards apply to list and task-detail actions. The task README describes supported actions and any specific limitations. This requirement applies to new and modified UI throughout the repository, including Inventory; do not copy a blocking legacy interaction merely for consistency.
