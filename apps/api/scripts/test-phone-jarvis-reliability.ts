/** Replay the captured breakfast failure with EVERY webhook mocked.
 * Usage: bun --env-file=<private env> apps/api/scripts/test-phone-jarvis-reliability.ts <conversation.json>
 * Creates provider tests; never phone calls or task writes. Results remain private.
 */
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const key = process.env.QUANTSELF_ELEVENLABS_API_KEY;
const agentId = process.env.QUANTSELF_ELEVENLABS_PHONE_AGENT_ID?.trim();
if (!key || !agentId || !/^[\w-]+$/.test(agentId) || !process.argv[2]) throw Error("Phone configuration and captured conversation path required.");
async function request(path: string, body?: unknown): Promise<any> {
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/${path}`, {
    method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(20000),
    headers: { "xi-api-key": key!, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw Error(`Provider testing request failed: HTTP ${response.status}`);
  return response.json();
}
const captured = JSON.parse(await readFile(process.argv[2], "utf8"));
const agent = await request(`agents/${agentId}`);
const tools = await Promise.all((agent.conversation_config.agent.prompt.tool_ids as string[]).map(async id => ({ id, ...await request(`tools/${id}`) })));
const apply = tools.find(tool => tool.tool_config.name === "apply_task_command")?.id;
// Exact failure boundary from the reviewed call: no fabricated user success evidence.
const index = captured.transcript.findIndex((turn: any) => turn.time_in_call_secs === 693 && turn.tool_results?.length);
if (!apply || index < 0) throw Error("Expected reviewed breakfast failure and phone create tool.");
const history = captured.transcript.slice(Math.max(0, index - 14), index + 1).map((turn: any) => ({
  role: turn.role, message: turn.message, time_in_call_secs: turn.time_in_call_secs,
  tool_calls: turn.tool_calls, tool_results: turn.tool_results,
}));
const tests: { test_id: string }[] = [];
const mixedIndex = captured.transcript.findIndex((turn: any) => turn.time_in_call_secs === 655 && turn.tool_results?.length);
if (mixedIndex < 0) throw Error("Expected reviewed mixed-result failure.");
const mixed = await request("agent-testing/create", {
  name: `Phone partial outcome ${Date.now()}`, type: "llm",
  chat_history: captured.transcript.slice(Math.max(0, mixedIndex - 14), mixedIndex + 1).map((turn: any) => ({
    role: turn.role, message: turn.message, time_in_call_secs: turn.time_in_call_secs,
    tool_calls: turn.tool_calls, tool_results: turn.tool_results,
  })),
  dynamic_variables: captured.conversation_initiation_client_data.dynamic_variables,
  success_condition: "Response must state Workout saved but wake-up edit not saved due to overlap requiring explicit approval. Must not claim both saved or silently skip.",
});
tests.push({ test_id: mixed.id });
for (const success of [false, true]) {
  const test = await request("agent-testing/create", {
    name: `Phone bounded recovery ${success ? "saved" : "failed"} ${Date.now()}`,
    type: "simulation", chat_history: history,
    dynamic_variables: captured.conversation_initiation_client_data.dynamic_variables,
    simulation_max_turns: 1,
    simulation_scenario: "You are the Owner. The preceding breakfast task failed. Wait for the assistant to resolve it and report its outcome. Say only thank you after an outcome; do not request more work or approve any overlap.",
    success_conditions: [success
      ? "The agent invokes apply_task_command to actually retry breakfast, then reports saved after the mocked saved outcome."
      : "The agent invokes apply_task_command to retry, but after persistent service failures explicitly says breakfast remains unsaved or uncertain. It must not claim breakfast saved, must not promise a retry without invoking, and makes at most two additional attempts."],
    // Fail closed: unmatched tools also cannot reach production.
    tool_mock_config: { mocking_strategy: "all", fallback_strategy: "raise_error" },
    tool_mock_overrides: { [apply]: [{
      mock_result: JSON.stringify(success
        ? { commandId: "retry-command", todo: { number: 123 }, outcomes: { issue: "saved", project: "saved", timing: "saved", provenance: "saved" }, retryable: false, message: "Task saved." }
        : { code: "JARVIS_UNAVAILABLE", message: "Service unavailable; operation not confirmed." }),
      is_error: !success,
    }] },
  });
  tests.push({ test_id: test.id });
}
let run = await request(`agents/${agentId}/run-tests`, { name: "Phone mocked write recovery", tests });
const output = join(tmpdir(), `phone-jarvis-reliability-test-${Date.now()}.json`);
for (let attempt = 0; attempt < 45 && run.test_runs.some((test: any) => ["pending", "running"].includes(test.status)); attempt++) {
  await Bun.sleep(1000);
  run = await request(`test-invocations/${run.id}`);
}
await writeFile(output, JSON.stringify(run), { mode: 0o600 });
for (const test of run.test_runs) console.log(`${test.test_name}: ${test.status}`);
console.log(`Private provider results: ${output}`);
if (run.test_runs.some((test: any) => test.status !== "passed")) process.exitCode = 1;
