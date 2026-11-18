import { describe, expect, test } from "bun:test";
import { assertUnchangedJarvisPrompt, assertUnchangedJarvisTool, assertVerifiedJarvisPrompt, jarvisPromptPatch } from "./jarvis-task-sync-guards";

const agent = () => ({ conversation_config: { agent: { prompt: { prompt: "original", tool_ids: ["one"] } }, asr: {} }, platform_settings: { auth: { enable_auth: true }, widget: {} } });

describe("Jarvis prompt-only synchronization", () => {
  test("rejects concurrent prompt and attached tool changes", () => {
    const original = agent();
    for (const prompt of [{ prompt: "edited", tool_ids: ["one"] }, { prompt: "original", tool_ids: ["two"] }]) {
      const latest = agent(); latest.conversation_config.agent.prompt = prompt;
      expect(() => assertUnchangedJarvisPrompt(original, latest)).toThrow();
    }
    expect(() => assertUnchangedJarvisTool({ description: "original" }, { description: "edited" })).toThrow();
  });
  test("rejects loss of private authentication during guard and verification", () => {
    const latest = agent(); latest.platform_settings.auth.enable_auth = false;
    expect(() => assertUnchangedJarvisPrompt(agent(), latest)).toThrow();
    expect(() => assertVerifiedJarvisPrompt(agent(), latest)).toThrow();
  });
  test("unrelated concurrent settings remain outside narrow PATCH and comparison", () => {
    const original = agent();
    const latest = { ...agent(), platform_settings: { ...agent().platform_settings, widget: { transcript_speech_sync_enabled: true } }, conversation_config: { ...agent().conversation_config, asr: { keyterm_libraries: [] } } };
    expect(() => assertUnchangedJarvisPrompt(original, latest)).not.toThrow();
    const patch = jarvisPromptPatch("updated");
    expect(patch).toEqual({ conversation_config: { agent: { prompt: { prompt: "updated" } } } });
    const actual = structuredClone(latest);
    Object.assign(actual.conversation_config.agent.prompt, patch.conversation_config.agent.prompt);
    const expected = agent(); expected.conversation_config.agent.prompt.prompt = "updated";
    expect(() => assertVerifiedJarvisPrompt(expected, actual)).not.toThrow();
    expect(actual.platform_settings).toEqual(latest.platform_settings);
    expect(actual.conversation_config.asr).toEqual(latest.conversation_config.asr);
    actual.conversation_config.agent.prompt.prompt = "unexpected";
    expect(() => assertVerifiedJarvisPrompt(expected, actual)).toThrow();
  });
});
