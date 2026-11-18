export type PhoneBootstrapReceipt = {
  phase: "creating-key" | "key-created" | "ready";
  ownerId: string;
  keyId?: string;
  secret?: string;
  agentId?: string;
};
export type PhoneBootstrapDependencies = {
  ownerId(): Promise<string>;
  load(): Promise<PhoneBootstrapReceipt | null>;
  save(receipt: PhoneBootstrapReceipt): Promise<void>;
  createKey(ownerId: string): Promise<{ id: string; secret: string }>;
  verifyKey(secret: string): Promise<{ owner: { id: string }; client: { id: string; kind: string }; permissions: string[] }>;
  setupAgent(secret: string, existingAgentId?: string): Promise<string>;
  writeRuntime(secret: string, agentId: string): Promise<void>;
};

/** Raw credentials stay in trusted server files and child environment only. */
export async function bootstrapPhoneJarvis(deps: PhoneBootstrapDependencies) {
  const ownerId = await deps.ownerId();
  let receipt = await deps.load();
  if (receipt && receipt.ownerId !== ownerId) throw Error("Phone bootstrap Owner changed; manual reconciliation required.");
  if (receipt?.phase === "creating-key") throw Error("Previous phone key creation is uncertain; reconcile credentials before retrying.");
  if (!receipt) {
    await deps.save({ phase: "creating-key", ownerId });
    const key = await deps.createKey(ownerId);
    if (!key.id || !key.secret) throw Error("Phone key creation returned an invalid credential.");
    receipt = { phase: "key-created", ownerId, keyId: key.id, secret: key.secret };
    await deps.save(receipt);
  }
  if (!receipt.secret || !receipt.keyId) throw Error("Phone bootstrap receipt is incomplete.");
  const access = await deps.verifyKey(receipt.secret);
  if (access.owner.id !== ownerId || access.client.id !== receipt.keyId || access.client.kind !== "api-key" || JSON.stringify([...access.permissions].sort()) !== JSON.stringify(["todos:read", "todos:write"])) throw Error("Phone credential failed exact Owner/task-grant verification.");
  const agentId = await deps.setupAgent(receipt.secret, receipt.agentId);
  if (!/^[\w-]+$/.test(agentId)) throw Error("Phone agent returned an invalid identifier.");
  receipt = { ...receipt, phase: "ready", agentId };
  await deps.save(receipt);
  await deps.writeRuntime(receipt.secret!, agentId);
}
