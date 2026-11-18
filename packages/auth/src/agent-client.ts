export const AGENT_CLIENT_METADATA_KEY = "quantselfAgentClient";

export type AgentClient = {
  avatar: string | null;
  id: string;
  kind: "agent";
  name: string;
};

export function hasAgentClientMetadata(
  metadata: unknown,
): metadata is { [AGENT_CLIENT_METADATA_KEY]: unknown } {
  return typeof metadata === "object" && metadata !== null &&
    Object.hasOwn(metadata, AGENT_CLIENT_METADATA_KEY);
}

export function agentClientFromMetadata(metadata: unknown): AgentClient | null {
  if (!hasAgentClientMetadata(metadata)) return null;

  const agent = metadata[AGENT_CLIENT_METADATA_KEY];
  if (
    typeof agent !== "object" || agent === null ||
    !("id" in agent) || !("name" in agent) || !("avatar" in agent)
  ) return null;

  const { id, name, avatar } = agent;
  if (
    typeof id !== "string" || !id.trim() ||
    typeof name !== "string" || !name.trim() ||
    (avatar !== null && typeof avatar !== "string")
  ) return null;

  return { id, name, avatar, kind: "agent" };
}
