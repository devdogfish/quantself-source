import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../../../../apps/api/src/app";
import { prisma } from "../../../../packages/db";
import { observerSocketPath } from "../../../../apps/api/src/roundcube-observer-wire";

assert.equal(process.env.DATABASE_URL, "postgresql://fixture@postgres:5432/roundcube_joined_fixture");
const state = "/fixture-state";
const origin = "http://127.0.0.1:3000";
const target = "https://roundcube.jobs.example.test/";
const ownerProof = randomBytes(32).toString("hex");
process.env.QUANTSELF_PUBLIC_ORIGIN = origin;
process.env.QUANTSELF_OWNER_INGRESS_TOKEN = ownerProof;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
await mkdir("/tmp/roundcube-signer", { mode: 0o700 });
const signer = "/tmp/roundcube-signer/key.pem";
await writeFile(signer, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
const ownerId = randomUUID(), id = randomUUID();
const message = { account: "jobs@example.test", folder: "INBOX", uid: 42, uidValidity: 120,
  messageId: "<roundcube-proof@example.test>" };
try {
  await prisma.authOwner.create({ data: { id: "singleton", user: { create: {
    id: ownerId, name: "Fixture Owner", email: "owner@example.test",
  } } } });
  await prisma.jobApplication.create({ data: {
    ownerId, id, company: "Fixture", role: "Fixture", resumeTrack: "web",
    sourceKey: id, sourceUrl: "https://example.test/job", sourceReply: { folder: message.folder, uid: message.uid },
  } });
  const app = createApp({ jobsWorkers: { db: prisma }, emitAccessLog() {}, jobsRoundcubeEnv: {
    QUANTSELF_JOBS_ROUNDCUBE_ORIGINALS_ENABLED: "1",
    QUANTSELF_JOBS_ROUNDCUBE_ATTACHMENT_PARTS_ENABLED: "1",
    QUANTSELF_JOBS_ROUNDCUBE_SOURCE_ENABLED: process.env.QS_ROUNDCUBE_FIXTURE_SOURCE,
    QUANTSELF_JOBS_ROUNDCUBE_URL: target,
    QUANTSELF_JOBS_ROUNDCUBE_OBSERVER_SOCKET: observerSocketPath,
    QUANTSELF_JOBS_ROUNDCUBE_OBSERVER_TRANSPORT: "dedicated",
    QUANTSELF_JOBS_ROUNDCUBE_MAILBOX_ACCOUNT: message.account,
    QUANTSELF_JOBS_ROUNDCUBE_SIGNING_KEY_FILE: signer,
  } });
  const route = origin + "/api/owner/jobs/applications/" + id + "/original-reply";
  const headers = { "x-quantself-owner-proof": ownerProof };
  const confirmed = await app.request(route + "/confirmation", { method: "PUT",
    headers: { ...headers, Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: 0, message }),
  });
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  assert.deepEqual(await confirmed.json(), { revision: 1 });
  const start = performance.now();
  const opened = await app.request(route, { headers });
  assert.equal(opened.status, 303, await opened.clone().text());
  assert.equal(opened.headers.get("referrer-policy"), "no-referrer");
  const url = new URL(opened.headers.get("location")!);
  assert.equal(url.origin + url.pathname, target);
  const [version, encoded, signature] = url.searchParams.get("_ref")!.split(".");
  assert.equal(version, "qs-original-v1");
  assert(verify(null, Buffer.from(version + "." + encoded), publicKey, Buffer.from(signature, "base64url")));
  const claims = JSON.parse(Buffer.from(encoded, "base64url").toString());
  assert.deepEqual(claims.slice(0, 8), [
    url.hostname, message.account, message.folder, message.uid, message.uidValidity, message.messageId, "show", null,
  ]);
  const parts = url.searchParams.get("_parts");
  assert(parts);
  const part = process.env.QS_ROUNDCUBE_FIXTURE_SPOOL === "1" ? "2.1" : "2";
  assert.deepEqual(parts.split("!").map(entry => entry.split("~")[0]), [part, "3"]);
  const { x } = publicKey.export({ format: "jwk" });
  assert(x);
  const references: Record<string, unknown> = { ownerOpenOriginal: url.href, applicationId: id, message };
  if (process.env.QS_ROUNDCUBE_FIXTURE_SOURCE === "1") {
    assert.match(url.searchParams.get("_source") ?? "", /^[A-Za-z0-9_-]{86}$/);
    // Synthetic negative controls. The successful source token must come from the API's handoff.
    const changedSource = (position: number, value: number) => {
      const payload = [...claims];
      payload[position] = value;
      payload[6] = "source";
      const signed = version + "." + Buffer.from(JSON.stringify(payload)).toString("base64url");
      return signed + "." + sign(null, Buffer.from(signed), privateKey).toString("base64url");
    };
    references.sourceControls = {
      stale: changedSource(4, message.uidValidity - 1),
      wrongIdentity: changedSource(3, message.uid + 1).split(".")[2],
      wrongExpiry: changedSource(9, claims[9] + 1).split(".")[2],
    };
  }
  await Promise.all([
    writeFile(join(state, "public.key"), Buffer.from(x, "base64url")),
    writeFile(join(state, "attachment-links.json"), "{}"),
    writeFile(join(state, "references.json"), JSON.stringify(references)),
  ]);
  console.log(`Owner confirmation 200 and Open original 303, ${Math.round(performance.now() - start)} ms; `
    + `Location ${Buffer.byteLength(url.href)} bytes, request target ${Buffer.byteLength(url.pathname + url.search)} bytes, `
    + `_parts ${Buffer.byteLength(parts)} bytes`);
} finally {
  await prisma.$disconnect();
}
