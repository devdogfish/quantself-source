import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sitePath = join(import.meta.dir, "site.example.json");
const renderer = join(import.meta.dir, "shared/render.py");
const roles = ["sam", "stacy", "tyler"] as const;
const enabled = "file terminal web browser computer_use vision memory skills session_search todo clarify delegation code_execution hq quantself_vaultwarden".split(" ");
const disabled = "cronjob catalog connections desktop_ui project kanban image_gen video_gen video tts x_search discord discord_admin feishu_doc feishu_drive".split(" ");

function render(role: (typeof roles)[number], settings: string, output: string) {
  return Bun.spawnSync(["python3", "-B", renderer, role, settings, "/home/hermes", output]);
}

test.each(roles)("%s renders the approved Managed Scope and fleet policy", async (role) => {
  const output = await mkdtemp(join(tmpdir(), "quantself-agent-policy-"));
  try {
    const site = await Bun.file(sitePath).json();
    const result = render(role, sitePath, output);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const config = Bun.YAML.parse(await Bun.file(join(output, "config.yaml")).text()) as Record<string, any>;
    expect(config.model).toEqual({ provider: "openai-codex", default: "gpt-6.1-sol" });
    expect(config.api_server.extra.model_name).toBe(role);
    expect(config.agent.disabled_toolsets.toSorted()).toEqual(disabled.toSorted());
    const toolsets = role === "sam" ? [...enabled, "quantself_jobs_mail"] : enabled;
    expect(config.platform_toolsets.cli.toSorted()).toEqual(toolsets.toSorted());
    expect(config.platform_toolsets.api_server.toSorted()).toEqual(toolsets.toSorted());
    expect(config.approvals).toEqual({
      mode: "smart", cron_mode: "deny", single_query_mode: "deny", unattended_mode: "deny",
    });
    expect(config.secrets.command).toMatchObject({ enabled: true, helper_timeout_seconds: 15 });
    expect(config.secrets.bitwarden.enabled).toBe(false);
    expect(config.vault.bitwarden.enabled).toBe(false);
    expect(Object.keys(config.mcp_servers)).toEqual(["hq"]);
    expect(config.mcp_servers.hq).toMatchObject({
      url: site.agents[role].hq_mcp_url, headers: { Authorization: "Bearer ${BOT_HQ_MCP_TOKEN}" },
    });
    const gateway = await Bun.file(join(output, "hermes-gateway.service")).text();
    expect(gateway).toContain(
      "BindReadOnlyPaths=/etc/hermes/agent-profile.yaml:/home/hermes/.hermes/config.yaml",
    );
    expect(gateway).toContain("BindReadOnlyPaths=/etc/hermes/.env:/home/hermes/.hermes/.env");
    expect(gateway).toContain(
      "BindReadOnlyPaths=/etc/hermes/plugins/quantself-vaultwarden:/home/hermes/.hermes/plugins/quantself-vaultwarden",
    );
    expect(gateway.includes(
      "BindReadOnlyPaths=/etc/hermes/plugins/quantself-jobs-mail:/home/hermes/.hermes/plugins/quantself-jobs-mail",
    )).toBe(role === "sam");
    const startProbe = gateway.replaceAll(/\\\n\s*/g, " ").split("\n").find((line) => line.startsWith("ExecStartPost="));
    expect(startProbe).toContain("--retry-connrefused");
    expect(startProbe?.endsWith(`http://${site.agents[role].api_host}:${site.agents[role].api_port}/health`)).toBe(true);
    const plugins = ["honcho", "quantself-vaultwarden"];
    if (role === "sam") plugins.push("quantself-jobs-mail");
    expect(Bun.YAML.parse(await Bun.file(join(output, "agent-profile.yaml")).text())).toEqual({
      secrets: config.secrets,
      memory: config.memory,
      ...(role === "sam" && { plugins: { enabled: plugins } }),
    });
    expect(config.memory.provider).toBe("honcho");
    expect(config.plugins.enabled).toEqual(plugins);
    expect(config.plugins.entries["quantself-vaultwarden"].mcp_allowlist).toEqual(["hq"]);
    expect(await Bun.file(join(output, "honcho.json")).json()).toEqual({
      baseUrl: site.honcho_url, workspace: site.honcho_workspace, peerName: site.honcho_owner_peer,
      aiPeer: role, pinUserPeer: true, sessionAiPeerPrefix: true, saveMessages: true,
    });
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("the CLI profile can be seeded before the Honcho SDK is available", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "quantself-agent-seed-"));
  try {
    const profile = join(fixture, "config.yaml");
    const seed = join(import.meta.dir, "shared/seed-profile.py");
    const secrets = { command: { enabled: true } };
    // JSON keeps the fixture independent of the pinned Hermes serializer and SDK.
    await Promise.all([
      Bun.write(join(fixture, "hermes_bootstrap.py"), ""),
      Bun.write(join(fixture, "utils.py"), `
import json

fast_safe_load = json.loads

def _roundtrip_load(path):
    return None, json.loads(path.read_text())

def _roundtrip_dump(path, parser, config):
    path.write_text(json.dumps(config))
`),
      Bun.write(profile, JSON.stringify({
        memory: { max_recall_tokens: 100 },
        display: { theme: "dark" },
        mcp_servers: { legacy: {} },
      })),
    ]);
    const result = Bun.spawnSync(["python3", "-BIS", seed, fixture, profile], {
      stdin: Buffer.from(JSON.stringify({ secrets, memory: { provider: "honcho" } })),
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(await Bun.file(profile).json()).toEqual({
      secrets, memory: { provider: "honcho", max_recall_tokens: 100 },
      display: { theme: "dark" },
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("the fleet file rejects an Agent-specific Honcho workspace", async () => {
  const output = await mkdtemp(join(tmpdir(), "quantself-honcho-workspace-"));
  try {
    const site = await Bun.file(sitePath).json();
    site.agents.sam.honcho_workspace = "another-workspace";
    const settings = join(output, "invalid.json");
    await Bun.write(settings, JSON.stringify(site));
    const result = render("sam", settings, join(output, "rendered"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("exact per-Agent fields");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("the fleet file can grow in rollout order without changing shared Honcho settings", async () => {
  const output = await mkdtemp(join(tmpdir(), "quantself-agent-rollout-"));
  try {
    const site = await Bun.file(sitePath).json();
    const settings = join(output, "site.json");
    const agents = { tyler: site.agents.tyler };
    await Bun.write(settings, JSON.stringify({ ...site, agents }));

    const tyler = join(output, "tyler");
    const first = render("tyler", settings, tyler);
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    const tylerHoncho = await Bun.file(join(tyler, "honcho.json")).json();
    const missing = render("sam", settings, join(output, "sam"));
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain("Provide settings for sam");

    const stacy = join(output, "stacy");
    await Bun.write(settings, JSON.stringify({ ...site, agents: { ...agents, stacy: site.agents.stacy } }));
    const second = render("stacy", settings, stacy);
    expect(second.exitCode, second.stderr.toString()).toBe(0);
    expect(await Bun.file(join(stacy, "honcho.json")).json()).toEqual({ ...tylerHoncho, aiPeer: "stacy" });

    for (const [additionalAgents, error] of [
      [{ other: site.agents.sam }, "Use Agent names"],
      [{ stacy: { ...site.agents.stacy, api_host: site.agents.tyler.api_host } }, "distinct Tailscale address"],
    ] as const) {
      await Bun.write(settings, JSON.stringify({ ...site, agents: { ...agents, ...additionalAgents } }));
      const invalid = render("tyler", settings, join(output, "invalid"));
      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr.toString()).toContain(error);
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
