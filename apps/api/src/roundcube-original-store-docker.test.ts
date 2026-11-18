import { expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AccessContext } from "@quantself/auth";
import type { RoundcubeLookupIdentity, RoundcubeMailbox } from "./roundcube-original-association";
import { issueRoundcubeOriginal } from "./roundcube-original-issuer";
import { createRoundcubeOriginalStore } from "./roundcube-original-store";

const original: RoundcubeLookupIdentity = {
  account: "jobs@example.test", folder: "INBOX", uid: 42, uidValidity: 120,
  messageId: "<roundcube-proof@example.test>",
};
const replacement = { ...original, uid: 43, messageId: "<replacement@example.test>" };
const another = { ...original, uid: 44, messageId: "<concurrent@example.test>" };
const now = () => Math.floor(Date.now() / 1000);
const legacy = { folder: "INBOX", uid: 42 };
const python = fileURLToPath(new URL("../../../scripts/infra/mail/roundcube-association-fixture/observe.py", import.meta.url));

test.skipIf(process.env.QUANTSELF_ROUNDCUBE_STORE_FIXTURE !== "1")(
  "durable Owner confirmation, cross-Owner isolation, concurrent replacement, and fresh signed issuance",
  async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/roundcube_association_fixture") {
      throw new Error("Use a disposable PostgreSQL Roundcube association fixture.");
    }
    const { prisma } = await import("@quantself/db");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const ownerId = randomUUID();
    const applicationId = randomUUID();
    const web: AccessContext = {
      owner: { id: ownerId, email: "owner@example.test", name: "Fixture Owner" },
      client: { kind: "web", id: "web", name: "Fixture" },
      permissions: ["jobs:read", "jobs:write"],
    };
    const other: AccessContext = { ...web, owner: { ...web.owner, id: randomUUID() } };
    const job = {
      id: applicationId, company: "Fixture Co", role: "Operator", resumeTrack: "web" as const,
      sourceKey: randomUUID(), sourceUrl: "https://example.test/application", sourceReply: legacy,
    };
    const mailboxConfig = { enabled: true, mailboxAccount: original.account } as const;
    let imapRequests = 0;
    const loopback: RoundcubeMailbox = {
      ...mailboxConfig,
      examineMailbox: query => {
        imapRequests++;
        const run = Bun.spawnSync(["python3", "-B", python, "0"], { stdin: Buffer.from(JSON.stringify(query)) });
        if (run.exitCode !== 0) throw new Error(run.stderr.toString());
        return Promise.resolve(JSON.parse(run.stdout.toString()).observation);
      },
    };
    const { lookup, confirm, read } = createRoundcubeOriginalStore(prisma, loopback, now);
    const issue = (access: AccessContext, currentLookup = lookup) => issueRoundcubeOriginal(access, applicationId, {
      baseUrl: "https://roundcube.jobs.example.test/", audience: "roundcube.jobs.example.test",
      mailboxAccount: original.account, signingKey: privateKey, now, lookup: currentLookup,
    });
    try {
      await prisma.jobApplication.create({ data: { ...job, ownerId } });
      await prisma.jobEvent.create({ data: { ownerId, applicationId, kind: "receipt_recorded", payload: original } });
      const first = { expectedRevision: 0, message: original };
      expect(await issue(web)).toEqual({ kind: "missing" });
      expect(await confirm(other, applicationId, first)).toEqual({ kind: "missing" });
      const agent: AccessContext = { ...web, client: { id: "agent", kind: "agent", name: "Fixture Agent", avatar: null } };
      expect(await confirm(agent, applicationId, first)).toEqual({ kind: "denied" });
      expect(await confirm({ ...web, permissions: ["jobs:read"] }, applicationId, first)).toEqual({ kind: "denied" });
      expect(await confirm(web, applicationId, { ...first, message: legacy })).toEqual({ kind: "unverifiable" });
      expect(await createRoundcubeOriginalStore(prisma, { ...loopback, enabled: false }, now)
        .confirm(web, applicationId, first)).toEqual({ kind: "unverifiable" });
      expect(imapRequests).toBe(0);

      expect(await confirm(web, applicationId, { ...first, message: { ...original, uid: 41 } }))
        .toEqual({ kind: "unverifiable" });
      expect(await confirm(web, applicationId, first)).toEqual({ kind: "saved", revision: 1 });
      expect(await confirm(web, applicationId, first)).toEqual({ kind: "saved", revision: 1 });
      expect(imapRequests).toBe(2);

      // A separate application process must recover the confirmation and deduplicate a lost acknowledgement.
      const restarted = Bun.spawn([process.execPath, "-e", `
        import { prisma } from "@quantself/db";
        import { createRoundcubeOriginalStore } from "./roundcube-original-store";
        const [access, applicationId, input] = process.argv.slice(-3);
        const store = createRoundcubeOriginalStore(prisma, {
          enabled: true, mailboxAccount: "jobs@example.test",
          examineMailbox() { throw new Error("A replay must not invoke IMAP"); },
        }, () => Math.floor(Date.now() / 1000));
        const owner = JSON.parse(access);
        console.log(JSON.stringify([await store.read(owner, applicationId), await store.confirm(owner, applicationId, JSON.parse(input))]));
        await prisma.$disconnect();
      `, JSON.stringify(web), applicationId, JSON.stringify(first)], { cwd: import.meta.dir, stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(restarted.stdout).text(), new Response(restarted.stderr).text(), restarted.exited,
      ]);
      if (exitCode !== 0) throw new Error(stderr);
      expect(JSON.parse(stdout)).toEqual([{ revision: 1, message: original }, { kind: "saved", revision: 1 }]);

      await prisma.jobApplication.create({ data: { ...job, ownerId: other.owner.id } });
      expect(await read(other, applicationId)).toBeNull();
      expect(await issue(other)).toEqual({ kind: "missing" });
      expect(imapRequests).toBe(2);

      const accepted = await issue(web);
      if (accepted.kind !== "issued") throw new Error("Expected the persisted association to issue through IMAP.");
      const [version, payload, signature] = new URL(accepted.url).searchParams.get("_ref")!.split(".");
      expect(verify(null, Buffer.from(version + "." + payload), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
      expect(JSON.parse(Buffer.from(payload, "base64url").toString()).slice(1, 6))
        .toEqual([original.account, original.folder, original.uid, original.uidValidity, original.messageId]);

      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const inFlight = createRoundcubeOriginalStore(prisma, {
        ...loopback,
        examineMailbox: async query => {
          const observation = await loopback.examineMailbox(query);
          started.resolve();
          await release.promise;
          return observation;
        },
      }, now);
      const pending = issue(web, inFlight.lookup);
      await Promise.race([started.promise, pending.then(() => { throw new Error("Expected in-flight IMAP observation"); })]);
      try {
        const bothAtMailbox = Promise.withResolvers<void>();
        let arrivals = 0;
        const controlled = createRoundcubeOriginalStore(prisma, {
          ...mailboxConfig,
          examineMailbox: async query => {
            if (query.mode === "resolve") throw new Error("Expected an epoch-bound legacy confirmation");
            if (++arrivals === 2) bothAtMailbox.resolve();
            await bothAtMailbox.promise;
            const match = [replacement, another].find(candidate => candidate.messageId === query.messageId)!;
            return { ...query, account: original.account, observedAt: now(), matches: [match] };
          },
        }, now);
        const results = await Promise.all([replacement, another].map(message =>
          controlled.confirm(web, applicationId, { expectedRevision: 1, message })));
        expect(results.filter(result => result.kind === "saved")).toEqual([{ kind: "saved", revision: 2 }]);
        expect(results.filter(result => result.kind === "conflict")).toEqual([{ kind: "conflict" }]);
        const current = await read(web, applicationId);
        if (!current) throw new Error("Expected a persisted replacement.");
        expect(current.revision).toBe(2);
        expect([replacement, another]).toContainEqual(current.message);
        expect(await confirm(web, applicationId, first)).toEqual({ kind: "conflict" });
        expect(await issue(web)).toEqual({ kind: "missing" });
      } finally {
        release.resolve();
      }
      expect(await pending).toEqual({ kind: "unverifiable" });
      expect(await confirm(web, applicationId, { expectedRevision: 2, message: original })).toEqual({ kind: "saved", revision: 3 });
      expect((await issue(web)).kind).toBe("issued");

      const row = await prisma.jobApplication.findUniqueOrThrow({
        where: { ownerId_id: { ownerId, id: applicationId } },
        select: { sourceReply: true, lifecycleRevision: true, events: { select: { payload: true, kind: true } } },
      });
      expect(row.sourceReply).toEqual(legacy);
      expect(row.lifecycleRevision).toBe(0);
      expect(row.events.filter(event => event.kind === "roundcube_original_confirmed")).toHaveLength(3);
      expect(row.events.filter(event => event.kind !== "roundcube_original_confirmed"))
        .toEqual([{ kind: "receipt_recorded", payload: original }]);
    } finally {
      await prisma.$disconnect();
    }
  },
  15_000,
);
