import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncJarvisPlanningConfiguration } from "../src/todos-jarvis-planning-sync";

const key = process.env.QUANTSELF_ELEVENLABS_API_KEY;
const agentId = process.env.QUANTSELF_ELEVENLABS_AGENT_ID;
if (!key || !agentId) throw Error("Jarvis configuration unavailable.");
const backupPath = join(tmpdir(), `quantself-jarvis-planning-${Date.now()}.json`);
let backedUp = false;
try {
  const result = await syncJarvisPlanningConfiguration({
    async request(path, method = "GET", body) {
      const response = await fetch(`https://api.elevenlabs.io/v1/convai/${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(20000),
        headers: { "xi-api-key": key, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw Error(`Jarvis configuration request failed: HTTP ${response.status}`);
      return response.json();
    },
    async backup(snapshot) {
      await writeFile(backupPath, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
      backedUp = true;
    },
  }, agentId, process.argv.includes("--apply"));
  console.log(result.applied
    ? `Verified ordinary conversational task configuration. Backup: ${backupPath}`
    : `Dry run: detach retired planning tools; update ordinary task/timing/intent contracts. Add --apply to sync.`);
} catch (error) {
  if (backedUp) console.error(`Partial sync may exist; inspect backup and rerun. Backup: ${backupPath}`);
  throw error;
}
