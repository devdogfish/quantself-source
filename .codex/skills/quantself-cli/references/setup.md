# Install and discover the Quantself CLI skill

From the Quantself checkout, run `bun install` and `bun run quantself --help`. To use `quantself` from any directory, build on the target machine and replace the output path with a writable location on its PATH.

```sh
bun build --compile packages/cli/src/index.ts --outfile /path/on/PATH/quantself
```

Run the compiled executable without the checkout or Bun installed.

Copy the whole `quantself-cli` directory, including `references/`, into one of the local skill directories below. Start a new session and ask it to use the `quantself-cli` skill and list operations using `--help`. Help works without a credential.

| Agent | Where to copy the directory | Discovery check |
| --- | --- | --- |
| Hermes | `~/.hermes/skills/` in the default profile | Run `hermes skills list` and look for `quantself-cli`. [Hermes skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) |
| Codex | `.agents/skills/` in the project or `~/.agents/skills/` for your user | Find `quantself-cli` in `/skills` or invoke `$quantself-cli`. [Codex skills](https://developers.openai.com/codex/skills/) |
| Claude Code | `.claude/skills/` in the project or `~/.claude/skills/` for your user | Invoke `/quantself-cli`. [Claude Code skills](https://code.claude.com/docs/en/skills) |

In the environment where the agent runs shell commands, set `QUANTSELF_API_URL` to the approved HTTPS API origin, such as `https://quantself.example.com`. Use loopback HTTP only for local mocks. Inject `QUANTSELF_API_KEY` from the host's secret store. The CLI supplies the key as `X-API-Key`. Keep the key out of command arguments, chat, and tracked files. Request the minimum grants for the operation. Use the same origin and credential for an idempotent retry.

Use `quantself --help` and `quantself listTodos --help` to check the executable and operation discovery without touching records. Only run API smoke commands against authorized test records or a mock.
