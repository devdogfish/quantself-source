# Dawnshift Agent configuration

Config-as-code for [#195](https://github.com/devdogfish/quantself/issues/195).
The [approved Hermes setup spec](../docs/agents/hermes-setup.md) and the rollout
issues govern when to apply it.

| Agent | Dedicated host | Profile and installer |
| --- | --- | --- |
| Tyler Scott | `tyler` | [tyler/](tyler/) |
| Stacy Ross | `stacy` | [stacy/](stacy/) |
| Sam Lee | `vm sam` on `atlas` | [sam/](sam/) |

All three use the dedicated locked `hermes` user and its default profile.
The shared policy and role template render to root-owned `/etc/hermes/config.yaml`.
The adjacent managed `.env` contains only host settings. Hermes is pinned to
[v0.23.1 at 3b421578588243f920886e6fe79a6faa87ea026e](https://github.com/NousResearch/hermes-agent/tree/3b421578588243f920886e6fe79a6faa87ea026e).
Honcho uses the memory-provider revision from that release's catalog.
The shared Owner peer uses `pinUserPeer`, and each Agent's AI peer prefixes its
sessions to avoid collisions in the shared workspace.

Codex subscription supplies reasoning and tools. The `draft.py` helper takes a
brief on stdin and returns unsent text from
[Anthropic Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide).
The installer compiles the Quantself CLI from this checkout and stages its
existing skill, plus `obsidian` and `llm-wiki` from the pinned Hermes tree.
Hermes's bundled-skills opt-out still seeds the built-in `hermes-agent` skill,
which upstream marks essential. Agent-authored skills and Owner corrections
remain in the profile during a reinstall.

## Host inputs

- Dedicated systemd Linux host with Tailscale and the locked `hermes` user.
  For Debian 13, preview the host packages needed by both the Agent and
  Vaultwarden installers. `x11-utils` supplies `xdpyinfo`. The pinned Hermes
  installer uses `libatomic1` for its Linux Node.js runtime.

  ```sh
  apt-get --simulate --no-install-recommends install ca-certificates curl git \
    chromium xvfb xauth x11-utils openbox x11vnc websockify socat \
    python3-venv libpsl5t64 libatomic1
  ```

  During the approved host setup, apply the reviewed transaction with
  `--yes` in place of `--simulate`. For amd64, verify both archives in the
  download directory before extracting `bun-linux-x64-baseline/bun` and `bw`.
  Place those executables in `/usr/local/bin`. [Bun v1.3.14 amd64 archive](https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64-baseline.zip) · [Bitwarden CLI v2026.10.1 amd64 archive](https://github.com/bitwarden/clients/releases/download/cli-v2026.10.1/bw-linux-2026.10.1.zip)

  ```sh
  sha256sum -c - <<'SHA256'
  a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7  bun-linux-x64-baseline.zip
  eb09c3715291c21cf744819b873a255c1247b1b8b45bae138621a644ec7ad8f5  bw-linux-2026.10.1.zip
  SHA256
  ```

  For another architecture, use the matching archives and checksums from the
  same releases. [Bun release](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14) · [Bitwarden CLI release](https://github.com/bitwarden/clients/releases/tag/cli-v2026.10.1)
- A shared brain checkout at `<hermes home>/dev/brain` and the agreed Work
  access. The Private Brain stays off Agent hosts. [#194](https://github.com/devdogfish/quantself/issues/194)
- Copy [site.example.json](site.example.json) outside the checkout and use the
  same fleet file for all three installers. Set the shared Quantself and Honcho
  endpoints, Honcho workspace and Owner peer once. Use `https://qs.girke.dev`
  for `quantself_url`. [Production cutover](https://github.com/devdogfish/quantself/issues/209#issuecomment-6898372932)
- Start `agents` with Tyler's Tailscale IPv4, service ports and Bot HQ MCP
  URL. Add Stacy and Sam to the same file as they enter rollout. Obtain the
  per-Agent HTTPS MCP URL and token from Bot HQ. Keep URL userinfo, query
  parameters and credentials out of the file. [#354](https://github.com/devdogfish/quantself/issues/354)
- Apply the Owner-approved tailnet policy before starting either service.
  Bindings use the Agent's Tailscale IP. Bot HQ's tag controls access to the
  API, screen WebSocket and CDP. The VNC server and browser debug listener
  themselves listen on loopback.

From the Agent host, verify that `hermes` reaches the production Quantself API
over trusted TLS. This read without credentials should return HTTP 401.
Verify the Agent's authorized reads and denied scopes after enrollment.

```sh
test "$(sudo -u hermes curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
  https://qs.girke.dev/api/v1/todo-categories)" = 401
```

## Vaultwarden integration

[#376](https://github.com/devdogfish/quantself/issues/376) owns accounts, the
`bw` cache, automatic unlock and relock, and the separate service. The Owner
provisions the machine-bound encrypted credential with `systemd-creds` for that
service's user. The [unlock service installer](vaultwarden/README.md) supplies
`/usr/local/libexec/quantself-vaultwarden-keys NAME [NAME ...]`. It returns one
`NAME=VALUE` line per requested item on stdout and accepts no interactive input.
The client allows 14 seconds, including time queued behind another startup
request. The adapter rejects missing or extra keys. Hermes's helper timeout is
15 seconds.

Vault items for startup are `ANTHROPIC_API_KEY`, `HONCHO_API_KEY`,
`API_SERVER_KEY`, `QUANTSELF_API_KEY` and `BOT_HQ_MCP_TOKEN`. The screen
requests `VNC_PASSWORD` separately. Classic VNC uses eight characters. The
screen places its password in a private systemd runtime directory under
`/run` for x11vnc. Website login/TOTP and mailbox items stay in Vaultwarden.
Codex device sign-in lives in Hermes's `auth.json`.

Managed Scope disables stock Bitwarden browser fill. The repo-owned website
sign-in tool returns status. Agents report blocked sign-ins in Bot HQ. Complete the
private browser checks in the [approved spec](../docs/agents/hermes-setup.md#website-sign-in-service-376)
before rollout.
The startup helper intentionally returns service keys to Hermes. Managed Scope
and redaction protect configured use, while local terminal code runs as the
same OS user. #376 must validate the model/tool credential boundary before
live use. The Agent instructions also keep encrypted Quantself fields out of
the conversation, since Honcho saves conversations.

## Register in Bot HQ before the first gateway start

1. Open the Agent's bot in Bot HQ. In **Engine → Agent connection → MCP settings**,
   put the returned HTTPS URL into `hq_mcp_url`. Put the token after `Bearer `
   in the Agent's `BOT_HQ_MCP_TOKEN` vault note. The managed config adds the
   `Bearer` prefix.
2. Set **Hermes API URL** to `http://<api_host>:<api_port>` and
   **Websockify URL** to `ws://<api_host>:<websockify_port>/websockify`.
   Use the Agent's literal Tailscale IPv4 for both URLs and enter its
   **Chrome DevTools port**. Bot HQ uses the Websockify host for CDP.
3. Copy the Agent's `API_SERVER_KEY` and eight-character `VNC_PASSWORD` from its
   vault into the matching private fields and select **Save connection**.
   Bot HQ can save while the Agent is offline. [Bot HQ registration](https://github.com/devdogfish/bot-hq/blob/cf1f84bf94e436f8f7505f06b00df2f9b1cacc62/docs/remote-agents.md)

## Apply after approval

Run the role's `install.sh /path/to/site.json` as root on the dedicated host.
It runs the pinned upstream installer non-interactively as `hermes`, installs
the pinned Honcho memory provider and writes the managed settings and system
units. The repo-owned units run the stock gateway and screen as `hermes`. This
uses systemd directly so root never executes the Hermes runtime from the
Agent-writable home. The installer seeds the pinned `secrets` section for
direct CLI runs and takes MCP settings from Managed Scope. The gateway binds
the profile YAML, managed `.env` and Honcho JSON read-only. Hermes
reads the vault helper settings before applying Managed Scope. The bound
`.env` keeps legacy profile variables from redirecting the browser or enabling
other integrations. The installer enables boot startup and leaves immediate
startup to the rollout. Apply settings by rerunning the role's installer.
Keep any active services stopped during an approved update.

The gateway unit checks `/health` on its configured Tailscale address before
reporting active. If the listener never starts, systemd retries the gateway
so Hermes loads startup keys again. Journal output from the check contains
no keys or response body.

On the approved Agent host, run device sign-in from the private console
using the pinned launcher. Enter the displayed code on the Owner's device.

```sh
hermes_home=$(getent passwd hermes | cut -d: -f6)
test -n "$hermes_home" &&
  sudo -u hermes -H env HERMES_HOME="$hermes_home/.hermes" HERMES_MANAGED_DIR=/etc/hermes \
    "$hermes_home/.hermes/hermes-agent/.hermes/bin/hermes" auth add openai-codex
```

After sign-in and the vault startup-key check pass, start
`hermes-gateway.service`, which starts `hermes-screen.service`. Before the
first turn, verify the Agent's virtual alias in the authenticated `/v1/models`
response and save it in Bot HQ under **Engine → Model**. The alias is `tyler`,
`stacy` or `sam`. Run **Check Chrome**, then verify **Watch**, **Take control**
and **Hand back**.
Use Bot HQ for routines. A denied command goes back to the Owner through Bot HQ.

Verify Tyler, then Stacy, then Sam. Check the release and commit, `hermes
doctor`, managed-key write refusal, toolsets and skills, an isolated boot and
crash restart, reachability from Bot HQ's tag, approved Quantself operations
and scope, the Honcho peers, and the introduction and pause in Bot HQ. Rebuild a
disposable profile with the same inputs before rollout. Recheck approvals and
cancellation against the deployed Bot HQ Runs path verified in [Bot HQ PR #1](https://github.com/devdogfish/bot-hq/pull/1). [Tyler and Stacy](https://github.com/devdogfish/quantself/issues/356)
[Sam](https://github.com/devdogfish/quantself/issues/355)
