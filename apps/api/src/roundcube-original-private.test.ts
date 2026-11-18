import { expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { issueRoundcubeOriginal } from "./roundcube-original-issuer";
import { configurePrivateRoundcubeOriginals } from "./roundcube-original-private";
import { observerSocketPath } from "./roundcube-observer-wire";

type Db = Parameters<typeof configurePrivateRoundcubeOriginals>[0];
type Configured = NonNullable<ReturnType<typeof configurePrivateRoundcubeOriginals>>;
const account = "luigi@luigigirke.com";
const message = { account, folder: "INBOX" as const, uid: 42, uidValidity: 120, messageId: "<roundcube-proof@example.test>" };
const now = () => Math.floor(Date.now() / 1000);
const { privateKey } = generateKeyPairSync("ed25519");
const fixture = fileURLToPath(new URL("../../../agents/sam/jobs-mail/test_roundcube_observer.py", import.meta.url));

function database() {
  let reads = 0;
  const db = {
    $queryRaw: async () => {
      reads++;
      return [{ eventId: "confirmation", eventKey: "roundcube-original:0000000001", message }];
    },
  } as unknown as Db;
  return { db, get reads() { return reads; } };
}

function env(socket: string) {
  return {
    QUANTSELF_JOBS_ROUNDCUBE_ORIGINALS_ENABLED: "1",
    QUANTSELF_JOBS_ROUNDCUBE_URL: "https://roundcube.jobs.example.test/",
    QUANTSELF_JOBS_ROUNDCUBE_OBSERVER_SOCKET: socket,
    QUANTSELF_JOBS_ROUNDCUBE_MAILBOX_ACCOUNT: account,
  };
}

function configure(db: Db, socket: string) {
  const configured = configurePrivateRoundcubeOriginals(db, env(socket), now);
  if (!configured) throw new Error("Expected the private fixture config to be accepted");
  return configured;
}

function issue(configured: Configured) {
  return issueRoundcubeOriginal({
    owner: { id: "owner", name: "Owner", email: "owner@example.test" },
    client: { id: "web", kind: "web", name: "Web" },
    permissions: ["jobs:read"],
  }, "application", {
    baseUrl: configured.baseUrl, audience: new URL(configured.baseUrl).hostname, mailboxAccount: configured.mailboxAccount,
    signingKey: privateKey, now, lookup: configured.store.lookup,
  });
}

test("private assembly requires explicit enablement, HTTPS, absolute socket and account", () => {
  const { db } = database();
  const ready = env("/run/private/roundcube.sock");
  for (const config of [
    { ...ready, QUANTSELF_JOBS_ROUNDCUBE_ORIGINALS_ENABLED: undefined },
    { ...ready, QUANTSELF_JOBS_ROUNDCUBE_URL: "http://roundcube.jobs.example.test/" },
    { ...ready, QUANTSELF_JOBS_ROUNDCUBE_URL: "https://other@roundcube.jobs.example.test/" },
    { ...ready, QUANTSELF_JOBS_ROUNDCUBE_OBSERVER_SOCKET: "relative.sock" },
    { ...ready, QUANTSELF_JOBS_ROUNDCUBE_MAILBOX_ACCOUNT: undefined },
  ]) expect(configurePrivateRoundcubeOriginals(db, config)).toBeNull();
});

test("dedicated transport spawns only for a fresh observation", async () => {
  const launch = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("Simulated client launch failure");
  });
  try {
    const fixtureDb = database();
    const dedicated = { ...env(observerSocketPath), QUANTSELF_JOBS_ROUNDCUBE_OBSERVER_TRANSPORT: "dedicated" };
    expect(configurePrivateRoundcubeOriginals(fixtureDb.db,
      { ...dedicated, QUANTSELF_JOBS_ROUNDCUBE_ORIGINALS_ENABLED: undefined }, now)).toBeNull();
    expect(configurePrivateRoundcubeOriginals(fixtureDb.db,
      { ...dedicated, QUANTSELF_JOBS_ROUNDCUBE_OBSERVER_SOCKET: "/tmp/other-observer.sock" }, now)).toBeNull();
    const enabled = configurePrivateRoundcubeOriginals(fixtureDb.db, dedicated, now)!;
    const availability = await enabled.store.read({
      owner: { id: "owner", name: "Owner", email: "owner@example.test" },
      client: { id: "web", kind: "web", name: "Web" },
      permissions: ["jobs:read"],
    }, "application");
    expect(availability?.revision).toBe(1);
    expect(launch).not.toHaveBeenCalled();
    expect((await issue(enabled)).kind).toBe("unverifiable");
    expect(launch).toHaveBeenCalledTimes(1);
  } finally {
    launch.mockRestore();
  }
});

test("private Unix socket carries identity and optional part evidence over pinned TLS", async () => {
  const directory = await mkdtemp("/tmp/qs-roundcube-");
  const path = join(directory, "worker.sock");
  const child = Bun.spawn(["python3", "-B", fixture, "--bridge", path, "--requests", "2"], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    if (Buffer.from(ready.value ?? []).toString().trim() !== "ready") {
      throw new Error("Loopback bridge failed: " + await new Response(child.stderr).text());
    }
    const fixtureDb = database();
    const configured = configure(fixtureDb.db, path);
    expect((await issue(configured)).kind).toBe("issued");
    const evidence = await configured.store.lookup({ ownerId: "owner", applicationId: "application" }, {
      includeAttachmentParts: true,
    });
    expect(evidence.kind === "complete" && evidence.matches).toEqual([{ ...message, attachmentParts: ["2.2", "3"] }]);
    expect(fixtureDb.reads).toBe(4);
    expect(await child.exited).toBe(0);
  } finally {
    child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
});

test("private response rejects replay, mismatched identity, excess bytes and invalid part evidence", async () => {
  const directory = await mkdtemp("/tmp/qs-roundcube-");
  const path = join(directory, "worker.sock");
  let calls = 0;
  let firstResponse = "";
  const challenges = new Set<string>();
  const server = createServer(socket => {
    let request = "";
    socket.on("error", () => {});
    socket.on("data", data => {
      request += data.toString();
      if (!request.endsWith("\n")) return;
      const query = JSON.parse(request);
      challenges.add(query.challenge);
      const reply = {
        challenge: query.challenge, account, folder: query.folder, uidValidity: query.uidValidity,
        matches: [{ uid: message.uid, messageId: query.messageId }], observedAt: now(),
      };
      const response = JSON.stringify(reply) + "\n";
      const [match] = reply.matches;
      const call = calls++;
      if (call === 0) firstResponse = response;
      socket.end([
        response, firstResponse, JSON.stringify({ ...reply, account: "other@example.test" }) + "\n",
        JSON.stringify({ ...reply, uidValidity: 121 }) + "\n", " ".repeat(4096) + response,
        response + "{}\n",
        response,
        ...[
          { ...match, attachmentParts: ["2", "2"] },
          { ...match, attachmentParts: ["2.MIME"] },
          { ...match, uid: 43, attachmentParts: ["2.1"] },
        ].map(partMatch => JSON.stringify({ ...reply, matches: [partMatch] }) + "\n"),
      ][call]);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    const fixtureDb = database();
    const configured = configure(fixtureDb.db, path);
    expect((await issue(configured)).kind).toBe("issued");
    for (const _ of Array(5)) expect(await issue(configured)).toEqual({ kind: "unverifiable" });
    for (const _ of Array(4)) {
      expect(await configured.store.lookup({ ownerId: "owner", applicationId: "application" }, {
        includeAttachmentParts: true,
      })).toEqual({ kind: "unavailable" });
    }
    expect(challenges.size).toBe(10);
    expect(fixtureDb.reads).toBe(11);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
