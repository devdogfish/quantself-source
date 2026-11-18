# Quantself CLI

From a checkout with Bun, run `bun run --silent quantself --help`. Command names are OpenAPI operation IDs. `bun run --silent quantself listTodos --help` shows the input schema and required permission. Commands emit JSON to stdout. Failures emit JSON to stderr and exit nonzero.

Set `QUANTSELF_API_URL` to the Quantself HTTPS origin and provide `QUANTSELF_API_KEY` through the process environment. Local loopback origins can use HTTP. Use a scoped key for the requested operation. See the portable Agent skill for examples, credential types, and safe retries. [Agent skill](../../.codex/skills/quantself-cli/SKILL.md)

```sh
bun run --silent quantself listTodos --query '{"from":"2026-11-16","through":"2026-11-22","timeZone":"America/Halifax"}'
bun build --compile packages/cli/src/index.ts --outfile /path/on/PATH/quantself
```

Build the executable on the target machine. It contains the command metadata and runs without the checkout or a separate Bun installation.

Use an Agent key with `todos:write` for an Owner Inbox To-do. Keep the key and body identical on retries. The response includes the audit ID for Owner Undo.

```sh
bun run --silent quantself createAgentInboxTodo --idempotency-key 4a674911-c89e-4f55-b2f2-9dc3e45c361f --body '{"title":"Call the plumber"}'
```

## Regeneration

After `bun install --frozen-lockfile` and `bun run db:generate`, run `bun run generate:cli` and commit `src/generated/commands.ts`. `bun run generate:cli --check` detects drift. The generator reads the in-process API contract. No running API or database connection is needed. Prisma client generation needs a `DATABASE_URL` to parse its config. For offline generation, use a placeholder such as `postgresql://offline:offline@127.0.0.1:1/quantself`.

You can pass a local Quantself OpenAPI JSON file to `bun run generate:cli` when working from an exported contract.
