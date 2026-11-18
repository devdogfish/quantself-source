import { equal, ok, rejects } from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { issueRoundcubeOriginal } from "../../../../../apps/api/src/roundcube-original-issuer";
import { configurePrivateRoundcubeOriginals } from "../../../../../apps/api/src/roundcube-original-private";
import { observerDeadlineMs, observerSocketPath } from "../../../../../apps/api/src/roundcube-observer-wire";

type Db = Parameters<typeof configurePrivateRoundcubeOriginals>[0];
const keyPath = "/api-private/signing.pem";
const childEntry = "/app/apps/api/src/roundcube-observer-client.ts";
const account = "luigi@luigigirke.com";
const message = { account, folder: "INBOX", uid: 42, uidValidity: 120, messageId: "<roundcube-proof@example.test>" };
const now = () => Math.floor(Date.now() / 1000);
const owner = { owner: { id: "owner", name: "Owner", email: "owner@example.test" },
  client: { id: "web", kind: "web" as const, name: "Web" }, permissions: ["jobs:read"] };
const { privateKey } = generateKeyPairSync("ed25519");
let reads = 0;
const db = { $queryRaw: async () => {
  reads++;
  return [{ eventId: "confirmation", eventKey: "roundcube-original:0000000001", message }];
} } as unknown as Db;
const env = {
  QUANTSELF_JOBS_ROUNDCUBE_ORIGINALS_ENABLED: "1",
  QUANTSELF_JOBS_ROUNDCUBE_URL: "https://roundcube.example.test/",
  QUANTSELF_JOBS_ROUNDCUBE_OBSERVER_SOCKET: observerSocketPath,
  QUANTSELF_JOBS_ROUNDCUBE_MAILBOX_ACCOUNT: account,
  QUANTSELF_JOBS_ROUNDCUBE_OBSERVER_TRANSPORT: "dedicated",
};

function issue(transport: "dedicated" | "direct") {
  const config = configurePrivateRoundcubeOriginals(db, { ...env, QUANTSELF_JOBS_ROUNDCUBE_OBSERVER_TRANSPORT: transport }, now);
  if (!config) throw new Error("Invalid fixture configuration");
  return issueRoundcubeOriginal(owner, "application", {
    baseUrl: config.baseUrl, mailboxAccount: config.mailboxAccount, audience: new URL(config.baseUrl).hostname,
    now, signingKey: privateKey, lookup: config.store.lookup,
  });
}

if (process.argv[2] === "child-failure") {
  equal((await issue("dedicated")).kind, "unverifiable");
  console.log("PASS dedicated child failure with an absent socket");
} else {
  equal(process.getuid?.(), 0);
  await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  await access(keyPath);
  await rejects(writeFile("/run/quantself-roundcube-observer/tamper", "blocked", { flag: "wx" }), { code: "EROFS" });
  const identity = ["/sbin/su-exec", "41001:41002"];
  equal(Bun.spawnSync([...identity, "/bin/busybox", "test", "-r", keyPath], { env: {} }).exitCode, 1);
  const groups = Bun.spawnSync([...identity, "/bin/busybox", "id", "-G"], { env: {} }).stdout.toString().trim().split(/\s+/);
  equal([...new Set(groups)].join(" "), "41002");
  equal(Bun.spawnSync(["/sbin/su-exec", "41004:41002", "/usr/local/bin/bun", "--no-env-file", childEntry],
    { env: {}, stdin: Buffer.from("{}\n") }).exitCode, 1);
  equal(Bun.spawnSync([...identity, "/usr/local/bin/bun", "--no-env-file", childEntry],
    { env: {}, stdin: Buffer.from("{}\n{}\n") }).exitCode, 1);
  equal(configurePrivateRoundcubeOriginals(db, { ...env, QUANTSELF_JOBS_ROUNDCUBE_ORIGINALS_ENABLED: "0" }, now), null);
  equal(reads, 0);
  const enabled = configurePrivateRoundcubeOriginals(db, env, now);
  ok(enabled);
  equal((await enabled.store.read(owner, "application"))?.revision, 1);
  equal(reads, 1);
  equal((await issue("direct")).kind, "unverifiable");
  const started = performance.now();
  equal((await issue("dedicated")).kind, "issued");
  const elapsed = performance.now() - started;
  for (const control of ["wrong UID", "missing credential", "oversized reply"]) {
    equal((await issue("dedicated")).kind, "unverifiable", control);
  }
  const waiting = performance.now();
  equal((await issue("dedicated")).kind, "unverifiable");
  const timeout = performance.now() - waiting;
  ok(timeout >= observerDeadlineMs - 100 && timeout < observerDeadlineMs + 500, `timeout was ${timeout.toFixed(1)} ms`);
  console.log(`PASS dedicated transport, disabled/lifecycle gates, and signer isolation (${elapsed.toFixed(1)} ms incl. TLS; deadline ${timeout.toFixed(1)} ms)`);
}
