import { createAgentApiKey } from "./api-keys";
import { getOwnerUserId } from "./owner-record";

const usage = "Usage: bun run agent-key:create --name NAME --permission AREA:ACTION [--permission AREA:ACTION ...] [--avatar HTTPS_URL]";

type ProvisionedKey = {
  client: { id: string };
  credential: { id: string };
  secret: string;
};

type AgentKeyCliDependencies = {
  getOwnerUserId: () => Promise<string | null>;
  createKey: (input: Parameters<typeof createAgentApiKey>[0]) => Promise<ProvisionedKey>;
};

export async function runAgentKeyCli(
  argv: string[],
  dependencies: AgentKeyCliDependencies = {
    getOwnerUserId,
    createKey: createAgentApiKey,
  },
) {
  if (argv.length === 1 && argv[0] === "--help") return [usage];

  const permissionIds: string[] = [];
  let name: string | undefined;
  let avatar: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(usage);
    switch (flag) {
      case "--permission":
        permissionIds.push(value);
        break;
      case "--name":
        if (name !== undefined) throw new Error(usage);
        name = value;
        break;
      case "--avatar":
        if (avatar !== undefined) throw new Error(usage);
        avatar = value;
        break;
      default:
        throw new Error(usage);
    }
  }
  if (!name || permissionIds.length === 0) throw new Error(usage);

  const userId = await dependencies.getOwnerUserId();
  if (!userId) throw new Error("Restore the Owner record before provisioning an Agent key.");

  const { client, credential, secret } = await dependencies.createKey({
    ...(avatar !== undefined && { avatar }),
    name,
    permissionIds,
    userId,
  });
  return [`agent_id=${client.id}`, `credential_id=${credential.id}`, `api_key=${secret}`];
}

if (import.meta.main) {
  try {
    const lines = await runAgentKeyCli(process.argv.slice(2));
    console.log(lines.join("\n"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
