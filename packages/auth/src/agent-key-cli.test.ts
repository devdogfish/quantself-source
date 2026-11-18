import { expect, test } from "bun:test";
import { runAgentKeyCli } from "./agent-key-cli";

test("operator provisioning uses the configured Owner and prints the new Agent key once", async () => {
  const lines = await runAgentKeyCli([
    "--name", "Sam Lee",
    "--permission", "jobs:read",
    "--permission", "jobs:write",
  ], {
    getOwnerUserId: async () => "configured-owner",
    createKey: async (input) => {
      expect(input).toEqual({ name: "Sam Lee", permissionIds: ["jobs:read", "jobs:write"], userId: "configured-owner" });
      return { client: { id: "agent-id" }, credential: { id: "key-id" }, secret: "qs_key_secret" };
    },
  });
  expect(lines).toEqual(["agent_id=agent-id", "credential_id=key-id", "api_key=qs_key_secret"]);
});

test("operator provisioning requires a configured Owner and explicit permissions", async () => {
  const dependencies = {
    getOwnerUserId: async () => null,
    createKey: async () => { throw new Error("Must not issue a key."); },
  };
  await expect(runAgentKeyCli(["--name", "Sam"], dependencies)).rejects.toThrow("--permission");
  await expect(runAgentKeyCli(["--name", "Sam", "--permission", "jobs:read"], dependencies)).rejects.toThrow("Restore the Owner record");
});
