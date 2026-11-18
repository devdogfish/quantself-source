import { isDevelopmentOrigin } from "../../../scripts/dev-tunnel";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncJarvisHabitConfiguration } from "../src/jarvis-habits-sync";

// Deliberately separate from bootstrap: never grants permissions or enables calls.
const environment = process.argv
  .find((arg) => arg.startsWith("--environment="))
  ?.split("=")[1];
const channel = process.argv
  .find((arg) => arg.startsWith("--channel="))
  ?.split("=")[1];
if (
  !["production", "development"].includes(environment ?? "") ||
  !["web", "phone"].includes(channel ?? "")
)
  throw Error(
    "Specify --environment=production|development and --channel=web|phone.",
  );
const key = process.env.QUANTSELF_ELEVENLABS_API_KEY;
let agentId: string | undefined;
if (environment === "development") {
  agentId =
    channel === "phone"
      ? process.env.QUANTSELF_DEV_ELEVENLABS_PHONE_AGENT_ID
      : process.env.QUANTSELF_DEV_ELEVENLABS_AGENT_ID;
} else {
  agentId =
    channel === "phone"
      ? process.env.QUANTSELF_ELEVENLABS_PHONE_AGENT_ID
      : process.env.QUANTSELF_ELEVENLABS_AGENT_ID;
}
const origin = process.env.QUANTSELF_JARVIS_HABIT_ORIGIN;
if (
  !key ||
  !agentId ||
  !origin ||
  new URL(origin).origin !== origin ||
  !origin.startsWith("https://")
)
  throw Error(
    "Explicit HTTPS QUANTSELF_JARVIS_HABIT_ORIGIN and target agent credentials required.",
  );
const development = isDevelopmentOrigin(
  origin,
  process.env.QUANTSELF_DEV_TUNNEL_ORIGIN,
);
if ((environment === "development") !== development)
  throw Error(
    "Environment and callback origin disagree. Development requires a known dedicated tunnel.",
  );
if (
  environment === "development" &&
  [
    process.env.QUANTSELF_ELEVENLABS_AGENT_ID,
    process.env.QUANTSELF_ELEVENLABS_PHONE_AGENT_ID,
  ].includes(agentId)
)
  throw Error("Development must use a separate agent.");
const apply = process.argv.includes("--apply");
if (apply && !process.argv.includes("--owner-granted-habits"))
  throw Error(
    "Owner must explicitly grant habits:read/write to this agent's existing API key before live enablement. Then pass --owner-granted-habits. Never grant habits:delete for logging.",
  );
const backup = join(
  tmpdir(),
  `quantself-jarvis-habits-${environment}-${channel}-${Date.now()}.json`,
);
let validatedOrigin = false;
const result = await syncJarvisHabitConfiguration(
  {
    async request(path, method = "GET", body) {
      // Verify the actual attached task endpoint before any provider mutation.
      if (method !== "GET" && !validatedOrigin)
        throw Error("Target callback origin was not verified.");
      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/${path}`,
        {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(20000),
          headers: {
            "xi-api-key": key,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as {
          detail?: { loc?: (string | number)[]; type?: string }[];
        } | null;
        // Provider errors may echo credentials in input; report only field paths/types.
        const fields = Array.isArray(failure?.detail)
          ? failure.detail.slice(0, 8)
              .map((issue) => `${issue.loc?.join(".")}: ${issue.type}`)
              .join("; ")
          : "";
        throw Error(
          `Jarvis habit sync failed: HTTP ${response.status}${fields ? ` (${fields})` : ""}`,
        );
      }
      const result = (await response.json()) as Record<string, any>;
      if (result.tool_config?.name === "read_tasks") {
        if (new URL(result.tool_config.api_schema.url).origin !== origin)
          throw Error(
            "Attached task endpoint differs from explicit target origin; refusing cross-environment sync.",
          );
        validatedOrigin = true;
      }
      return result;
    },
    async backup(snapshot) {
      await writeFile(backup, JSON.stringify(snapshot, null, 2), {
        mode: 0o600,
      });
    },
  },
  agentId,
  apply,
);
console.log(
  result.applied
    ? `Verified ${environment} ${channel} habit tools and prompt. Backup: ${backup}. Live voice logging still requires deployed read/write/replay checks.`
    : `Dry run: ${environment} ${channel}, ${origin}. Add --apply --owner-granted-habits after explicit Owner grants.`,
);
