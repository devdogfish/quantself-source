import { isDeepStrictEqual } from "node:util";
import {
  prepareJarvisHabitConfiguration,
  jarvisHabitToolNames,
} from "./jarvis-habits";
import type { JarvisConfigurationTransport } from "./todos-jarvis-planning-sync";
import type { JarvisTaskTool } from "./todos-jarvis-task-config";

/** Recover a partially attached sync by discovering exact named Quantself server tools. */
export async function syncJarvisHabitConfiguration(
  transport: JarvisConfigurationTransport,
  agentId: string,
  apply = false,
) {
  if (!/^[\w-]+$/.test(agentId)) throw Error("Invalid agent ID.");
  const { request } = transport;
  const agent = await request(`agents/${agentId}`);
  const ids = agent.conversation_config?.agent?.prompt?.tool_ids;
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== "string" || !/^[\w-]+$/.test(id))
  )
    throw Error("Unexpected tool IDs.");
  const tools: JarvisTaskTool[] = [];
  for (let offset = 0; offset < ids.length; offset += 4)
    tools.push(
      ...(await Promise.all(
        ids
          .slice(offset, offset + 4)
          .map(
            async (id) =>
              ({ ...(await request(`tools/${id}`)), id }) as JarvisTaskTool,
          ),
      )),
    );
  let prepared = prepareJarvisHabitConfiguration(agent, tools);
  for (const name of jarvisHabitToolNames) {
    if (tools.some((tool) => tool.tool_config.name === name)) continue;
    const candidates: JarvisTaskTool[] = [],
      cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await request(
        `tools?${new URLSearchParams({ search: name, page_size: "100", ...(cursor ? { cursor } : {}) })}`,
      );
      if (!Array.isArray(page.tools))
        throw Error("Unexpected habit tool listing.");
      for (const tool of page.tools)
        if (
          tool.tool_config?.name === name &&
          tool.tool_config.type === "webhook" &&
          isDeepStrictEqual(
            tool.tool_config,
            prepared.desired.find((t) => t.toolConfig.name === name)!
              .toolConfig,
          )
        )
          candidates.push(tool);
      if (!page.has_more) break;
      if (
        typeof page.next_cursor !== "string" ||
        !page.next_cursor ||
        cursors.has(page.next_cursor)
      )
        throw Error("Incomplete habit tool pagination.");
      cursor = page.next_cursor;
      cursors.add(cursor);
    } while (true);
    if (candidates.length > 1)
      throw Error(`Multiple reusable ${name} tools; resolve duplicates.`);
    if (candidates.length) {
      const candidate = candidates[0];
      if (typeof candidate.id !== "string" || !/^[\w-]+$/.test(candidate.id))
        throw Error("Invalid reusable tool ID.");
      const current = await request(`tools/${candidate.id}`);
      const desired = prepared.desired.find(
        (tool) => tool.toolConfig.name === name,
      )!;
      if (!isDeepStrictEqual(current.tool_config, desired.toolConfig))
        throw Error(
          `Unattached ${name} is not this Quantself contract; refusing to reuse.`,
        );
      tools.push({ ...current, id: candidate.id } as JarvisTaskTool);
    }
  }
  prepared = prepareJarvisHabitConfiguration(agent, tools);
  if (!apply) return { applied: false, ...prepared };
  const snapshot = { agent, tools, createdToolIds: [] as string[] };
  await transport.backup(snapshot);
  const assertUnchanged = async (updated: boolean) => {
    const current = await request(`agents/${agentId}`);
    const expected = structuredClone(agent.conversation_config);
    if (updated && Array.isArray(expected.agent.prompt.tools))
      expected.agent.prompt.tools = expected.agent.prompt.tools.map(
        (tool: any) =>
          prepared.desired.find(
            (value) => value.id && value.toolConfig.name === tool.name,
          )?.toolConfig ?? tool,
      );
    if (
      !isDeepStrictEqual(current.conversation_config, expected) ||
      !isDeepStrictEqual(current.platform_settings, agent.platform_settings)
    )
      throw Error("Agent changed during preparation; rerun.");
  };
  await assertUnchanged(false);
  for (const tool of prepared.desired)
    if (
      tool.id &&
      !isDeepStrictEqual(
        (await request(`tools/${tool.id}`)).tool_config,
        tools.find((value) => value.id === tool.id)!.tool_config,
      )
    )
      throw Error("Habit tool changed during preparation; rerun.");
  for (const tool of prepared.desired) {
    if (!tool.id) {
      // Never retry a POST automatically. A later run discovers the created tool.
      const created = await request("tools", "POST", {
        tool_config: tool.toolConfig,
      });
      if (typeof created.id !== "string" || !/^[\w-]+$/.test(created.id))
        throw Error("Tool creation uncertain; rerun for discovery.");
      snapshot.createdToolIds.push(created.id);
      await transport.backup(snapshot);
      const current = await request(`tools/${created.id}`);
      if (!isDeepStrictEqual(current.tool_config, tool.toolConfig))
        throw Error("Created tool differs; inspect backup.");
      tools.push({ ...current, id: created.id } as JarvisTaskTool);
    } else if (
      !isDeepStrictEqual(
        tool.toolConfig,
        tools.find((value) => value.id === tool.id)!.tool_config,
      )
    )
      await request(`tools/${tool.id}`, "PATCH", {
        tool_config: tool.toolConfig,
      });
  }
  prepared = prepareJarvisHabitConfiguration(agent, tools);
  await assertUnchanged(true);
  const expected = prepared.expectedAgent.conversation_config.agent.prompt;
  if (!isDeepStrictEqual(expected, agent.conversation_config.agent.prompt))
    await request(`agents/${agentId}`, "PATCH", {
      conversation_config: {
        agent: {
          prompt: { prompt: expected.prompt, tool_ids: expected.tool_ids },
        },
      },
    });
  const verified = await request(`agents/${agentId}`);
  if (
    !isDeepStrictEqual(
      verified.conversation_config,
      prepared.expectedAgent.conversation_config,
    ) ||
    !isDeepStrictEqual(verified.platform_settings, agent.platform_settings)
  )
    throw Error("Habit agent verification failed; inspect backup.");
  for (const tool of prepared.desired)
    if (
      !isDeepStrictEqual(
        (await request(`tools/${tool.id}`)).tool_config,
        tool.toolConfig,
      )
    )
      throw Error("Habit tool verification failed; inspect backup.");
  return { applied: true, ...prepared };
}
