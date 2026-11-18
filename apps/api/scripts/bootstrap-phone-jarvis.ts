import { mkdir, readFile, writeFile, rename, stat, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { bootstrapPhoneJarvis, type PhoneBootstrapReceipt } from "./phone-jarvis-bootstrap";

if (!process.argv.includes("--apply")) throw Error("Server bootstrap requires --apply; run only inside the production API container with phone disabled.");
if (process.env.QUANTSELF_PHONE_ENABLED === "1") throw Error("Disable Phone Jarvis before bootstrap.");
if (!process.env.DATABASE_URL || !process.env.QUANTSELF_PHONE_PUBLIC_URL || !process.env.QUANTSELF_ELEVENLABS_API_KEY || !process.env.QUANTSELF_ELEVENLABS_AGENT_ID) throw Error("Bootstrap requires existing production database, public origin and ElevenLabs source configuration.");
const root = join(process.env.QUANTSELF_TODO_CAPTURE_ROOT ?? "/app/storage/todo-captures", ".phone-bootstrap");
await mkdir(root, { recursive: true, mode: 0o700 });
const directory = await stat(root);
if ((directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()) throw Error("Phone bootstrap directory must be owned by the current user with mode 0700.");
const lock = join(root, "bootstrap.lock");
const handle = await open(lock, "wx", 0o600).catch(() => { throw Error("Phone bootstrap already running or interrupted; reconcile private lock before retrying."); });
async function privateWrite(path: string, data: string) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}
try {
  const { prisma } = await import("@quantself/db");
  const { createApiKey } = await import("@quantself/auth");
  try {
    await bootstrapPhoneJarvis({
      async ownerId() {
        const owners = await prisma.authOwner.findMany({ select: { userId: true }, take: 2 });
        if (owners.length !== 1) throw Error("Exactly one established Owner is required.");
        return owners[0]!.userId;
      },
      async load() {
        const path = join(root, "receipt.json");
        const existing = await stat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
        if (!existing) return null;
        if ((existing.mode & 0o077) !== 0 || existing.uid !== process.getuid?.()) throw Error("Unsafe bootstrap receipt permissions.");
        return JSON.parse(await readFile(path, "utf8")) as PhoneBootstrapReceipt;
      },
      save: receipt => privateWrite(join(root, "receipt.json"), JSON.stringify(receipt)),
      async createKey(ownerId) {
        const result = await createApiKey({ name: "Phone Jarvis production", preset: "custom", permissionIds: ["todos:read", "todos:write"], userId: ownerId });
        return { id: result.credential.id, secret: result.secret };
      },
      async verifyKey(secret) {
        const response = await fetch("http://127.0.0.1:3001/api/v1/access-context", { headers: { "X-API-Key": secret }, redirect: "error", signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw Error("Phone key could not authenticate against the running production API.");
        return response.json();
      },
      async setupAgent(secret, agentId) {
        const child = Bun.spawn(["bun", join(import.meta.dir, "setup-phone-jarvis.ts"), "--apply"], { env: { ...process.env, QUANTSELF_PHONE_API_KEY: secret, QUANTSELF_PHONE_SETUP_RECEIPT_ROOT: join(root, "provider"), ...(agentId ? { QUANTSELF_ELEVENLABS_PHONE_AGENT_ID: agentId } : {}) }, stdout: "pipe", stderr: "pipe" });
        const output = await new Response(child.stdout).text();
        // Provider diagnostics may contain private backup paths; keep them server-side.
        const errors = await new Response(child.stderr).text();
        const exit = await child.exited;
        await privateWrite(join(root, "provider-last-run.log"), output + errors);
        if (exit !== 0) throw Error("Phone provider setup failed; inspect private server diagnostics.");
        const id = /^QUANTSELF_ELEVENLABS_PHONE_AGENT_ID=([\w-]+)$/m.exec(output)?.[1];
        if (!id) throw Error("Phone provider setup did not return a verified agent ID.");
        return id;
      },
      async writeRuntime(secret, agentId) {
        if ([secret, agentId].some(value => /[\n\r'$]/.test(value))) throw Error("Phone runtime values require unsupported dotenv escaping.");
        await privateWrite(join(root, "runtime.env"), `QUANTSELF_PHONE_API_KEY='${secret}'\nQUANTSELF_ELEVENLABS_PHONE_AGENT_ID='${agentId}'\n`);
      },
    });
    console.log("Phone bootstrap verified. Private runtime.env ready; phone remains disabled.");
  } finally { await prisma.$disconnect(); }
} finally {
  await handle.close();
  await unlink(lock);
}
