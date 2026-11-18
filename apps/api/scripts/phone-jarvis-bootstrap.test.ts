import { expect, test } from "bun:test";
import { bootstrapPhoneJarvis, type PhoneBootstrapReceipt } from "./phone-jarvis-bootstrap";
function fixture() {
  let receipt: PhoneBootstrapReceipt | null = null;
  let creates = 0, setups = 0, writes = 0;
  const deps = {
    ownerId: async () => "owner",
    load: async () => receipt,
    save: async (value: PhoneBootstrapReceipt) => { receipt = structuredClone(value); },
    createKey: async () => { creates++; return { id: "phone-key", secret: "private-key" }; },
    verifyKey: async (_secret: string) => ({ owner: { id: "owner" }, client: { id: "phone-key", kind: "api-key" }, permissions: ["todos:write", "todos:read"] }),
    setupAgent: async (_secret: string, _existing?: string) => { setups++; return "phone-agent"; },
    writeRuntime: async (_secret: string, _id: string) => { writes++; },
  };
  return { deps, get receipt() { return receipt; }, counts: () => ({ creates, setups, writes }) };
}
test("bootstrap verifies exact Owner/grants and reuses private key receipt", async () => {
  const f = fixture();
  await bootstrapPhoneJarvis(f.deps);
  expect(f.receipt).toMatchObject({ phase: "ready", keyId: "phone-key", agentId: "phone-agent" });
  await bootstrapPhoneJarvis(f.deps);
  expect(f.counts()).toEqual({ creates: 1, setups: 2, writes: 2 });
});
test("unknown key creation refuses retry instead of duplicating credentials", async () => {
  const f = fixture();
  f.deps.createKey = async () => { throw Error("lost response"); };
  await expect(bootstrapPhoneJarvis(f.deps)).rejects.toThrow();
  expect(f.receipt?.phase).toBe("creating-key");
  await expect(bootstrapPhoneJarvis(f.deps)).rejects.toThrow("uncertain");
  expect(f.counts().setups).toBe(0);
});
test("provider failure preserves key for retry, broader/revoked credentials never reach setup", async () => {
  const f = fixture();
  f.deps.setupAgent = async () => { throw Error("provider unavailable"); };
  await expect(bootstrapPhoneJarvis(f.deps)).rejects.toThrow();
  expect(f.receipt?.phase).toBe("key-created");
  f.deps.verifyKey = async () => ({ owner: { id: "owner" }, client: { id: "phone-key", kind: "api-key" }, permissions: ["todos:read", "todos:write", "todos:approve"] });
  await expect(bootstrapPhoneJarvis(f.deps)).rejects.toThrow("exact Owner/task-grant");
  expect(f.counts()).toEqual({ creates: 1, setups: 0, writes: 0 });
});
