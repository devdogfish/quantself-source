# GitHub Actions owns production deployment

Production deployments are owned by a manually dispatched GitHub Actions workflow rather than direct local SSH commands or automatic deploy-on-push. `bun run prod` validates and pushes `main`, dispatches and monitors one uniquely identified workflow, verifies production, then attaches to remote Compose logs; this preserves an intentional single-command release boundary, central deployment history, serialized execution, and deployment continuity if the initiating laptop disconnects.

Pushing `main` alone does not deploy. `bun run prod` is the production release boundary and must be run explicitly whenever the current committed `main` revision should reach production.
