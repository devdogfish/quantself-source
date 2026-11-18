import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRoundcubeOriginalLookup } from "./roundcube-original-association";
import { issueRoundcubeOriginal } from "./roundcube-original-issuer";

type AdapterDependencies = Parameters<typeof createRoundcubeOriginalLookup>[0];
const target = { ownerId: "owner-1", applicationId: "job-1" };
const message = {
  account: "jobs@example.test", folder: "INBOX", uid: 42, uidValidity: 120,
  messageId: "<roundcube-proof@example.test>",
};
const confirmed = { ...target, provenance: "owner-confirmed", message };
const { privateKey } = generateKeyPairSync("ed25519");
const now = () => Math.floor(Date.now() / 1000);
const python = fileURLToPath(new URL("../../../scripts/infra/mail/roundcube-association-fixture/observe.py", import.meta.url));

function issue(adapt: AdapterDependencies) {
  return issueRoundcubeOriginal({
    owner: { id: target.ownerId, name: "Fixture owner", email: "owner@example.test" },
    client: { id: "fixture", name: "Fixture", kind: "web" },
    permissions: ["jobs:read"],
  }, target.applicationId, {
    baseUrl: "https://roundcube.jobs.example.test/",
    audience: "roundcube.jobs.example.test",
    mailboxAccount: message.account,
    signingKey: privateKey,
    now,
    lookup: createRoundcubeOriginalLookup(adapt),
  });
}

function syntheticObservation(query: Parameters<AdapterDependencies["examineMailbox"]>[0]) {
  return {
    challenge: query.challenge, account: message.account, folder: message.folder,
    uidValidity: message.uidValidity, observedAt: now(),
    matches: [{ uid: message.uid, messageId: message.messageId }],
  };
}

const dependencies: AdapterDependencies = {
  enabled: true,
  mailboxAccount: message.account,
  readAssociation: async () => confirmed,
  examineMailbox: async query => syntheticObservation(query),
};

test("disabled lookup reads neither the confirmation store nor IMAP", async () => {
  let calls = 0;
  const unavailable = async () => { calls++; return null; };
  expect(await issue({ ...dependencies, enabled: undefined, readAssociation: unavailable, examineMailbox: unavailable }))
    .toEqual({ kind: "unverifiable" });
  expect(calls).toBe(0);
});

test("legacy coordinates, recipient traces and cross-application replay cannot query IMAP", async () => {
  let mailboxReads = 0;
  for (const record of [
    { folder: message.folder, uid: message.uid },
    { ...confirmed, provenance: "smtp_recipient" },
    { ...confirmed, provenance: "unverified-trace" },
    { ...confirmed, applicationId: "job-2" },
    { ...confirmed, ownerId: "owner-2" },
  ]) {
    const result = await issue({
      ...dependencies,
      readAssociation: async () => record,
      examineMailbox: async query => { mailboxReads++; return syntheticObservation(query); },
    });
    expect(result).toEqual({ kind: "unverifiable" });
  }
  expect(mailboxReads).toBe(0);
});

test("same-second replay of a prior mailbox observation cannot mint a second link", async () => {
  let first: ReturnType<typeof syntheticObservation> | undefined;
  const adapter = {
    ...dependencies,
    examineMailbox: async (query: Parameters<AdapterDependencies["examineMailbox"]>[0]) => first ??= syntheticObservation(query),
  };
  expect((await issue(adapter)).kind).toBe("issued");
  expect(await issue(adapter)).toEqual({ kind: "unverifiable" });
});

test.each([
  ["0", "issued", 1],
  ["lookup-duplicate", "ambiguous", 1],
  ["lookup-epoch", "unverifiable", 0],
  ["other-account", "unverifiable", 1],
] as const)("IMAP %s returns %s", async (mode, expected, fetches) => {
  let request: typeof target | undefined;
  let commands: string[] | undefined;
  let error: string | undefined;
  const result = await issue({
    ...dependencies,
    readAssociation: async application => {
      request = application;
      return confirmed;
    },
    examineMailbox: async query => {
      const run = Bun.spawnSync(["python3", "-B", python, mode], {
        stdin: Buffer.from(JSON.stringify(query)),
      });
      if (run.exitCode !== 0) {
        error = run.stderr.toString();
        return null;
      }
      const proof = JSON.parse(run.stdout.toString());
      commands = proof.commands;
      return proof.observation;
    },
  });
  if (error !== undefined) throw new Error(error);
  if (!commands) throw new Error("IMAP fixture returned no command journal");
  expect(request).toEqual(target);
  expect(commands.filter(entry => entry === "EXAMINE")).toHaveLength(1);
  expect(commands.filter(entry => entry === "UID SEARCH")).toHaveLength(1);
  expect(commands.filter(entry => entry === "UID FETCH")).toHaveLength(fetches);
  expect(commands).not.toContain("STORE");
  expect(result.kind).toBe(expected);
});
