import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncJarvisCategoryConfiguration } from "../src/todos-jarvis-category-sync";
const key = process.env.QUANTSELF_ELEVENLABS_API_KEY;
const agentId = process.env.QUANTSELF_ELEVENLABS_AGENT_ID;
if (!key || !agentId) throw Error("Jarvis configuration unavailable.");
const backup = join(tmpdir(), `quantself-jarvis-categories-${Date.now()}.json`);
const result = await syncJarvisCategoryConfiguration({
  async request(path, method = "GET", body) {
    const response = await fetch(`https://api.elevenlabs.io/v1/convai/${path}`, { method, redirect: "error", signal: AbortSignal.timeout(20000), headers: { "xi-api-key": key, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw Error(`Jarvis category configuration failed: HTTP ${response.status}`);
    return response.json();
  },
  async backup(snapshot) { await writeFile(backup, JSON.stringify(snapshot, null, 2), { mode: 0o600 }); },
}, agentId, process.argv.includes("--apply"));
console.log(result.applied ? `Updated and verified Jarvis category client tools. Backup: ${backup}` : "Dry run: attach category filter and optimistic category/priority controls. Add --apply to sync.");
