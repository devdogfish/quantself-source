import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prisma } from "@quantself/db/generated/prisma/client";
import { parseResumeDocument, resumeHeader } from "../../../scripts/jobs/resume-document";
import { readAnthropicPilotReceipt } from "./jobs-pilot-anthropic-receipt";
import { jobsPilotPolicyDigest, jobsPilotRequestBody, readJobsPilotReply, reportJobsPilotModelWork, runJobsPilotModelWork, type JobsPilotLedger } from "./jobs-pilot-dispatch";
import type { JobsImportApplication } from "./jobs-owner-contract";
import { jobsBrief } from "./jobs-work-contract";
import { claimJobsWork, withJobsWorkTransaction } from "./jobs-work-service";

const startedAt = new Date("2040-01-01T00:00:00Z");
const expiresAt = new Date(startedAt.getTime() + 300_000);
const policy = {
  id: "fixture-provider-only", model: "claude-haiku-5-5", inputTokens: 100, maxOutputTokens: 384,
  inputNanoUsdPerToken: 100_000n, outputNanoUsdPerToken: 110_000n, maximumNanoUsd: 60_000_000n,
};
const expectedCharge = 12_200_000n;
const allowanceNanoUsd = 100_000_000n;
const postingText = "Synthetic enrichment posting";
const approvedBody = jobsPilotRequestBody(policy, { track: "web", candidateContext: "", postingText });
const digest = (body: string) => createHash("sha256").update(body).digest("hex");
const output = {
  doing: "Edit pages.", remote: "not_stated", companySize: { people: null, label: "Unknown" }, automatable: "medium",
  humanContact: { level: "low", note: "Some coordination" }, meetings: { level: "rare", note: "As needed" },
  eligible: true, verdict: "review", pay: null, dueDate: null, ineligibleReason: null,
};

type Target = Parameters<JobsPilotLedger["reserve"]>[1];
type Policy = Parameters<JobsPilotLedger["reserve"]>[2];
type Phase = JobsPilotLedger["phase"];
type ScreeningTarget = Omit<Target, "applicationId" | "revision"> & {
  sourceIdentity: string; applicationId: null; revision: null;
};
type PermitTarget = (Target & { sourceIdentity?: string }) | ScreeningTarget;

test.skipIf(process.env.QUANTSELF_JOBS_PILOT_ALLOWANCE_FIXTURE !== "1")(
  "offline Jobs pilot dispatch binds exact bytes and preserves allowance across contention, expiry, and lost replies",
  async () => {
    const database = new URL(process.env.DATABASE_URL ?? "");
    const n8n = process.env.QUANTSELF_JOBS_PILOT_N8N_FIXTURE === "1";
    const fixtureHost = n8n ? "db" : "127.0.0.1";
    if (database.protocol !== "postgresql:" || database.hostname !== fixtureHost || !database.port || database.pathname !== "/jobs_pilot_allowance_fixture") {
      throw new Error("Use a disposable Docker jobs_pilot_allowance_fixture database.");
    }
    const [{ prisma }, { intakeHeldJobsDraft }] = await Promise.all([import("@quantself/db"), import("./jobs-owner-write")]);
    const ownerId = randomUUID();

    async function insertPermit(tx: Prisma.TransactionClient, target: PermitTarget, limit: bigint,
      permitExpiresAt: Date, bodies: Partial<Record<Phase, string>>) {
      const digests = JSON.stringify(Object.fromEntries(Object.entries(bodies).map(([phase, body]) => [phase, digest(body)])));
      await tx.$executeRaw`
        INSERT INTO fixture_pilot_permit (id, owner_id, source_identity, application_id, revision, policy_digest, expires_at,
          limit_nano_usd, maximum_phase_nano_usd, phase_digests, ordered)
        VALUES (${target.permitId}, ${target.ownerId}, ${target.sourceIdentity ?? null}, ${target.applicationId}, ${target.revision},
          ${jobsPilotPolicyDigest(policy)}, ${permitExpiresAt}, ${limit}, ${policy.maximumNanoUsd}, ${digests}::jsonb, ${Boolean(target.sourceIdentity)})
      `;
    }

    async function issueSyntheticPermit(limit = allowanceNanoUsd, permitExpiresAt = expiresAt): Promise<Target> {
      const { permitId, applicationId, revision } = { permitId: randomUUID(), applicationId: randomUUID(), revision: 0 };
      const target = { permitId, ownerId, applicationId, revision, workerId: "fixture-pilot" };
      await prisma.$transaction(async tx => {
        await tx.jobApplication.create({ data: {
          id: applicationId, ownerId, company: "Synthetic Studio", role: "Editor", resumeTrack: "web",
          sourceKey: applicationId, sourceUrl: `https://example.test/jobs/${applicationId}`,
          description: postingText, revision, pilotHeldAt: startedAt,
        } });
        await tx.jobWorkItem.create({ data: { ownerId, applicationId, revision, kind: "enrich", availableAt: startedAt } });
        await insertPermit(tx, target, limit, permitExpiresAt, { screen: approvedBody, enrich: approvedBody });
      });
      return target;
    }

    async function reserveSlot(tx: Prisma.TransactionClient, target: PermitTarget, policy: Policy, now: Date, phase: Phase) {
      const { permitId, ownerId, applicationId, revision } = target;
      const [{ approved_digest } = {}] = await tx.$queryRaw<{ approved_digest: string }[]>`
        UPDATE fixture_pilot_permit SET reserved_nano_usd = reserved_nano_usd + ${policy.maximumNanoUsd}
        WHERE id = ${permitId} AND owner_id = ${ownerId}
          AND source_identity IS NOT DISTINCT FROM ${target.sourceIdentity ?? null}
          AND application_id IS NOT DISTINCT FROM ${applicationId} AND revision IS NOT DISTINCT FROM ${revision}
          AND (${phase} = 'screen' OR application_id IS NOT NULL)
          AND policy_digest = ${jobsPilotPolicyDigest(policy)} AND expires_at > ${now}
          AND maximum_phase_nano_usd = ${policy.maximumNanoUsd}
          AND reserved_nano_usd + spent_nano_usd <= limit_nano_usd - ${policy.maximumNanoUsd}
          AND (phase_digests ->> ${phase}::text) IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM fixture_pilot_reservation WHERE permit_id = ${permitId} AND phase = ${phase})
          AND (NOT ordered OR ${phase} = 'screen' OR EXISTS (
            SELECT 1 FROM fixture_pilot_reservation
            WHERE permit_id = ${permitId} AND state = 'reported'
              AND phase = CASE WHEN ${phase} = 'enrich' THEN 'screen' ELSE 'enrich' END
          ))
        RETURNING phase_digests ->> ${phase}::text AS approved_digest
      `;
      if (!approved_digest) return null;
      await tx.$executeRaw`
        INSERT INTO fixture_pilot_reservation (permit_id, phase, amount_nano_usd)
        VALUES (${permitId}, ${phase}, ${policy.maximumNanoUsd})
      `;
      return approved_digest;
    }

    const ledgerFor = (phase: Phase) => ({
      phase,
      reserve: (tx, target: PermitTarget, policy, now) => reserveSlot(tx, target, policy, now, phase),
      async beginDispatch(tx, target: PermitTarget, digest, claim, now) {
        const [marked] = await tx.$queryRaw<{ expires_at: Date }[]>`
          UPDATE fixture_pilot_reservation AS reservation
          SET state = 'dispatching', payload_digest = ${digest}, work_id = ${"workId" in claim ? claim.workId : null},
            lease_token_hash = ${"leaseTokenHash" in claim ? claim.leaseTokenHash : null},
            result_id = ${claim.resultId}, worker_id = ${target.workerId}
          FROM fixture_pilot_permit AS permit
          WHERE reservation.permit_id = permit.id AND permit.id = ${target.permitId}
            AND permit.owner_id = ${target.ownerId} AND permit.source_identity IS NOT DISTINCT FROM ${target.sourceIdentity ?? null}
            AND permit.application_id IS NOT DISTINCT FROM ${target.applicationId} AND permit.revision IS NOT DISTINCT FROM ${target.revision}
            AND permit.phase_digests ->> ${phase}::text = ${digest} AND permit.expires_at > ${now}
            AND reservation.phase = ${phase} AND reservation.state = 'reserved'
          RETURNING permit.expires_at
        `;
        return marked?.expires_at ?? null;
      },
      async recordReply(tx, target: PermitTarget, reply) {
        return 1 === await tx.$executeRaw`
          UPDATE fixture_pilot_reservation AS reservation SET state = 'replied', request_id = ${reply.requestId},
            result = ${JSON.stringify(reply.result)}::jsonb, usage = ${JSON.stringify(reply.usage)}::jsonb,
            charge_nano_usd = ${reply.chargeNanoUsd}
          FROM fixture_pilot_permit AS permit
          WHERE reservation.permit_id = permit.id AND permit.id = ${target.permitId}
            AND permit.owner_id = ${target.ownerId} AND permit.source_identity IS NOT DISTINCT FROM ${target.sourceIdentity ?? null}
            AND permit.application_id IS NOT DISTINCT FROM ${target.applicationId} AND permit.revision IS NOT DISTINCT FROM ${target.revision}
            AND phase = ${phase} AND state = 'dispatching'
            AND worker_id = ${target.workerId} AND result_id = ${reply.usage.resultId}
            AND payload_digest = ${reply.usage.requestDigest}
        `;
      },
      async readReport(tx, target: PermitTarget) {
        const [row] = await tx.$queryRaw<{
          state: "replied" | "reported"; work_id: string | null; lease_token_hash: string | null; result_id: string;
          result: unknown; expires_at: Date;
        }[]>`
          SELECT reservation.state, work_id, lease_token_hash, result_id, result, permit.expires_at
          FROM fixture_pilot_reservation AS reservation
          JOIN fixture_pilot_permit AS permit ON permit.id = reservation.permit_id
          WHERE permit.id = ${target.permitId} AND permit.owner_id = ${target.ownerId}
            AND permit.source_identity IS NOT DISTINCT FROM ${target.sourceIdentity ?? null}
            AND permit.application_id IS NOT DISTINCT FROM ${target.applicationId} AND permit.revision IS NOT DISTINCT FROM ${target.revision}
            AND reservation.worker_id = ${target.workerId} AND reservation.phase = ${phase}
            AND reservation.state IN ('replied', 'reported')
        `;
        if (!row) return null;
        if (row.state === "reported") return { state: row.state, resultId: row.result_id };
        const claim = row.work_id && row.lease_token_hash
          ? { workId: row.work_id, leaseTokenHash: row.lease_token_hash, resultId: row.result_id }
          : null;
        return { state: row.state, resultId: row.result_id, claim, result: row.result, permitExpiresAt: row.expires_at };
      },
      async settleReport(tx, target: PermitTarget, resultId, now) {
        return 1 === await tx.$executeRaw`
          WITH settled AS (
            UPDATE fixture_pilot_reservation AS reservation SET state = 'reported'
            FROM fixture_pilot_permit AS permit
            WHERE reservation.permit_id = permit.id AND permit.id = ${target.permitId}
              AND permit.owner_id = ${target.ownerId} AND permit.source_identity IS NOT DISTINCT FROM ${target.sourceIdentity ?? null}
              AND permit.application_id IS NOT DISTINCT FROM ${target.applicationId} AND permit.revision IS NOT DISTINCT FROM ${target.revision}
              AND permit.expires_at > ${now} AND reservation.worker_id = ${target.workerId}
              AND reservation.phase = ${phase} AND reservation.state = 'replied' AND reservation.result_id = ${resultId}
            RETURNING reservation.permit_id, reservation.amount_nano_usd, reservation.charge_nano_usd
          )
          UPDATE fixture_pilot_permit AS permit
          SET reserved_nano_usd = reserved_nano_usd - settled.amount_nano_usd,
            spent_nano_usd = spent_nano_usd + settled.charge_nano_usd
          FROM settled
          WHERE permit.id = settled.permit_id AND permit.reserved_nano_usd >= settled.amount_nano_usd
        `;
      },
    }) satisfies JobsPilotLedger;
    const ledger = ledgerFor("enrich");

    const workFor = (target: Target) => prisma.jobWorkItem.findUniqueOrThrow({
      where: { ownerId_applicationId_kind_revision: {
        ownerId, applicationId: target.applicationId, kind: "enrich", revision: target.revision,
      } }, select: { state: true, attempts: true, leaseUntil: true },
    });
    const balanceFor = async (target: Pick<Target, "permitId">) => (await prisma.$queryRaw<{ held: bigint; spent: bigint }[]>`
      SELECT reserved_nano_usd AS held, spent_nano_usd AS spent FROM fixture_pilot_permit WHERE id = ${target.permitId}
    `)[0];
    const reservedFor = async (target: Target) => (await balanceFor(target)).held;
    const slotsFor = (target: Target) => prisma.$queryRaw<{
      phase: Phase; state: string; amount_nano_usd: bigint; payload_digest: string | null; request_id: string | null; result: unknown;
    }[]>`SELECT phase, state, amount_nano_usd, payload_digest, request_id, result
      FROM fixture_pilot_reservation WHERE permit_id = ${target.permitId}`;
    const calls: string[] = [];
    type Binding = Parameters<Parameters<typeof runJobsPilotModelWork>[2]["fakeProvider"]>[1];
    const fakeProvider = async (body: string, binding: Binding) => {
      calls.push(body);
      return { requestId: "synthetic-reply", output: JSON.stringify(output),
        usage: { ...binding, model: policy.model, inputTokens: policy.inputTokens, outputTokens: 20 } };
    };
    const run = (target: Target, overrides: Partial<Parameters<typeof runJobsPilotModelWork>[2]> = {}, db = prisma) =>
      runJobsPilotModelWork(db, target, { ledger, policy, fakeProvider, now: () => startedAt, ...overrides });
    const report = (target: Target, reportAt = startedAt, db = prisma) => reportJobsPilotModelWork(db, target, {
      ledger, now: () => reportAt,
      rates: { async convertMany() { throw new Error("Unexpected fixture FX call"); } },
    });

    function interceptCommitResponse(afterCommit: () => void | Promise<void>) {
      return new Proxy(prisma, {
        get(client, key, receiver) {
          if (key !== "$transaction") return Reflect.get(client, key, receiver);
          return async <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel }) => {
            const result = await client.$transaction(operation, options);
            await afterCommit();
            return result;
          };
        },
      });
    }

    async function expectUnansweredDispatch(target: Target) {
      expect(await reservedFor(target)).toBe(policy.maximumNanoUsd);
      expect(await slotsFor(target)).toEqual([{
        phase: "enrich", state: "dispatching", amount_nano_usd: policy.maximumNanoUsd,
        payload_digest: digest(approvedBody), request_id: null, result: null,
      }]);
      const work = await workFor(target);
      expect(work).toMatchObject({ state: "claimed", attempts: 1 });
      if (!work.leaseUntil) throw new Error("Expected a committed lease");
      return { ...work, leaseUntil: work.leaseUntil };
    }

    try {
      await prisma.$executeRaw`
        CREATE TABLE fixture_pilot_permit (
          id text PRIMARY KEY, owner_id text NOT NULL, source_identity text, application_id text, revision int,
          policy_digest text NOT NULL, expires_at timestamptz NOT NULL, phase_digests jsonb NOT NULL, ordered boolean NOT NULL,
          limit_nano_usd bigint NOT NULL, maximum_phase_nano_usd bigint NOT NULL, reserved_nano_usd bigint NOT NULL DEFAULT 0,
          spent_nano_usd bigint NOT NULL DEFAULT 0,
          UNIQUE (owner_id, application_id, revision),
          UNIQUE (owner_id, source_identity),
          CHECK ((application_id IS NULL) = (revision IS NULL)),
          CHECK (source_identity IS NOT NULL OR application_id IS NOT NULL),
          CHECK (reserved_nano_usd >= 0 AND spent_nano_usd >= 0 AND reserved_nano_usd + spent_nano_usd <= limit_nano_usd)
        )
      `;
      await prisma.$executeRaw`
        CREATE TABLE fixture_pilot_reservation (
          permit_id text NOT NULL REFERENCES fixture_pilot_permit(id), phase text NOT NULL CHECK (phase IN ('screen', 'enrich', 'tailor')),
          amount_nano_usd bigint NOT NULL CHECK (amount_nano_usd > 0), payload_digest text, request_id text, result jsonb,
          usage jsonb, charge_nano_usd bigint CHECK (charge_nano_usd > 0 AND charge_nano_usd <= amount_nano_usd),
          work_id text, lease_token_hash text, result_id text, worker_id text,
          state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'dispatching', 'replied', 'reported')),
          CHECK (state NOT IN ('replied', 'reported') OR (usage IS NOT NULL AND charge_nano_usd IS NOT NULL)),
          PRIMARY KEY (permit_id, phase)
        )
      `;
      await prisma.user.create({ data: { id: ownerId, name: "Synthetic Owner", email: "pilot-allowance@example.test" } });

      const limited = await issueSyntheticPermit(policy.maximumNanoUsd - 1n);
      const changed = await issueSyntheticPermit();
      const approved = await issueSyntheticPermit(policy.maximumNanoUsd + expectedCharge - 1n);
      const stale = await issueSyntheticPermit();
      await prisma.jobApplication.update({ where: { ownerId_id: { ownerId, id: changed.applicationId } }, data: { description: "Changed posting" } });
      await prisma.jobApplication.update({ where: { ownerId_id: { ownerId, id: stale.applicationId } }, data: { revision: 1 } });
      let clockReads = 0;
      const denied = await Promise.all([
        run(limited), run(changed), run(stale), run({ ...approved, permitId: randomUUID() }),
        run(approved, { policy: { ...policy, id: "unapproved" } }),
        run(approved, { policy: { ...policy, maxOutputTokens: policy.maxOutputTokens + 1 } }),
        run(approved, { policy: { ...policy, outputNanoUsdPerToken: policy.outputNanoUsdPerToken + 1n } }),
        run(approved, { now: () => expiresAt }),
        run(approved, { now: () => ++clockReads >= 3 ? expiresAt : startedAt }),
      ]);
      for (const outcome of denied) expect(outcome).toBe("denied");
      expect(calls).toEqual([]);
      for (const target of [limited, changed, stale, approved]) {
        expect(await workFor(target)).toEqual({ state: "queued", attempts: 0, leaseUntil: null });
        expect(await reservedFor(target)).toBe(0n);
        expect(await slotsFor(target)).toEqual([]);
      }

      const observed = await run(approved, { fakeProvider: async (body, binding) => {
        expect(await reservedFor(approved)).toBe(policy.maximumNanoUsd);
        const [slot] = await slotsFor(approved);
        expect(slot.state).toBe("dispatching");
        expect(slot.payload_digest).toBe(digest(body));
        expect((await workFor(approved)).attempts).toBe(1);
        return fakeProvider(body, binding);
      } });
      expect(observed).toBe("replied");
      expect(calls).toEqual([approvedBody]);
      expect(await slotsFor(approved)).toEqual([{
        phase: "enrich", state: "replied", amount_nano_usd: policy.maximumNanoUsd,
        payload_digest: digest(approvedBody), request_id: "synthetic-reply", result: output,
      }]);
      expect(await run(approved)).toBe("denied");

      const invalidUsages: Array<Partial<Awaited<ReturnType<typeof fakeProvider>>["usage"]> | undefined> = [
        undefined, { model: "different-model" }, { inputTokens: policy.inputTokens + 1 },
        { inputTokens: 1.5 }, { outputTokens: policy.maxOutputTokens + 1 }, { outputTokens: -1 },
        { requestDigest: digest("different-request") }, { resultId: randomUUID() },
      ];
      for (const patch of invalidUsages) {
        const target = await issueSyntheticPermit();
        const callsBefore = calls.length;
        expect(await run(target, { fakeProvider: async (body, binding) => {
          const reply = await fakeProvider(body, binding);
          return { ...reply, usage: patch && { ...reply.usage, ...patch } };
        } })).toBe("uncertain");
        expect(await report(target)).toBeNull();
        expect(await run(target)).toBe("denied");
        await expectUnansweredDispatch(target);
        expect(await balanceFor(target)).toEqual({ held: policy.maximumNanoUsd, spent: 0n });
        expect(calls.slice(callsBefore)).toEqual([approvedBody]);
      }

      const callsBeforeDeadlines = calls.length;
      const latePermit = await issueSyntheticPermit();
      let permitClock = startedAt;
      expect(await run(latePermit, {
        now: () => permitClock,
        ledger: { ...ledger, async beginDispatch(...args) {
          const deadline = await ledger.beginDispatch(...args);
          if (deadline) permitClock = deadline;
          return deadline;
        } },
      })).toBe("uncertain");
      const permitWork = await expectUnansweredDispatch(latePermit);
      expect(permitClock).toEqual(expiresAt);
      expect(permitWork.leaseUntil.getTime()).toBeGreaterThan(permitClock.getTime());

      const longPermitExpiresAt = new Date(startedAt.getTime() + 1_200_000);
      const lateLease = await issueSyntheticPermit(allowanceNanoUsd, longPermitExpiresAt);
      let leaseClock = startedAt;
      expect(await run(lateLease, { now: () => leaseClock }, interceptCommitResponse(async () => {
        const { leaseUntil } = await workFor(lateLease);
        if (!leaseUntil) throw new Error("Expected a committed lease");
        leaseClock = leaseUntil;
      }))).toBe("uncertain");
      expect(leaseClock.getTime()).toBeGreaterThan(startedAt.getTime());
      expect(leaseClock.getTime()).toBeLessThan(longPermitExpiresAt.getTime());
      await expectUnansweredDispatch(lateLease);
      expect(calls).toHaveLength(callsBeforeDeadlines);

      const lostCommit = await issueSyntheticPermit(policy.maximumNanoUsd * 2n);
      const lostCommitResponse = new Error("Synthetic PostgreSQL commit response lost");
      const callsBeforeCommitLoss = calls.length;
      await expect(run(lostCommit, {}, interceptCommitResponse(() => { throw lostCommitResponse; })))
        .rejects.toBe(lostCommitResponse);
      const committedWork = await expectUnansweredDispatch(lostCommit);
      expect(await run(lostCommit)).toBe("denied");
      expect(await expectUnansweredDispatch(lostCommit)).toEqual(committedWork);
      expect(calls).toHaveLength(callsBeforeCommitLoss);

      const racing = await issueSyntheticPermit();
      const barrier = Promise.withResolvers<void>();
      let contenders = 0;
      async function beforeDebit(tx: Prisma.TransactionClient) {
        // Give both serializable transactions a snapshot before either performs the debit.
        await tx.$queryRaw`SELECT id FROM fixture_pilot_permit WHERE id = ${racing.permitId}`;
        if (++contenders >= 2) barrier.resolve();
        await barrier.promise;
      }
      const raceStarted = performance.now();
      const [enrich, screen] = await Promise.all([
        run(racing, { ledger: { ...ledger, reserve: async (...args) => { await beforeDebit(args[0]); return ledger.reserve(...args); } } }),
        withJobsWorkTransaction(prisma, async tx => {
          await beforeDebit(tx);
          return reserveSlot(tx, racing, policy, startedAt, "screen");
        }),
      ]);
      const raceMs = Math.round(performance.now() - raceStarted);
      expect(contenders).toBe(3);
      expect(Number(enrich === "replied") + Number(screen !== null)).toBe(1);
      expect(await reservedFor(racing)).toBe(policy.maximumNanoUsd);
      expect((await slotsFor(racing)).map(slot => slot.phase)).toEqual([screen ? "screen" : "enrich"]);
      expect((await workFor(racing)).attempts).toBe(Number(enrich === "replied"));

      const lost = await issueSyntheticPermit(policy.maximumNanoUsd * 2n);
      const entered = Promise.withResolvers<void>();
      const close = Promise.withResolvers<void>();
      const callsBeforeLost = calls.length;
      const pending = run(lost, { fakeProvider: async body => {
        calls.push(body);
        entered.resolve();
        await close.promise;
        throw new Error("Synthetic provider reply lost");
      } });
      try {
        await Promise.race([entered.promise, pending.then(() => { throw new Error("Expected the provider call"); })]);
        expect(await run(lost)).toBe("denied");
        expect(await reservedFor(lost)).toBe(policy.maximumNanoUsd);
      } finally {
        close.resolve();
      }
      expect(await pending).toBe("uncertain");
      const unanswered = await expectUnansweredDispatch(lost);
      const { leaseUntil } = unanswered;
      const replayAt = new Date(startedAt.getTime() + 1);
      expect(replayAt.getTime()).toBeLessThan(Math.min(expiresAt.getTime(), leaseUntil.getTime()));
      expect(await run(lost, { now: () => replayAt })).toBe("denied");
      expect(await expectUnansweredDispatch(lost)).toEqual(unanswered);
      expect(await report(lost, replayAt)).toBeNull();
      expect(calls.slice(callsBeforeLost)).toEqual([approvedBody]);

      expect(await run(lost, { now: () => new Date(leaseUntil.getTime() + 1) })).toBe("denied");
      expect(await expectUnansweredDispatch(lost)).toEqual(unanswered);
      expect(calls.slice(callsBeforeLost)).toEqual([approvedBody]);

      const reportStarted = performance.now();
      const callsBeforeReport = calls.length;
      expect(await report({ ...approved, workerId: "different-worker" })).toBeNull();
      expect(await report({ ...approved, revision: approved.revision + 1 })).toBeNull();
      expect(await report(approved, expiresAt)).toBeNull();
      const approvedWork = { ownerId_applicationId_kind_revision: {
        ownerId, applicationId: approved.applicationId, kind: "enrich" as const, revision: approved.revision,
      } };
      const { leaseTokenHash } = await prisma.jobWorkItem.findUniqueOrThrow({ where: approvedWork, select: { leaseTokenHash: true } });
      await prisma.jobWorkItem.update({ where: approvedWork, data: { leaseTokenHash: digest("replacement-lease") } });
      expect(await report(approved)).toBeNull();
      await prisma.jobWorkItem.update({ where: approvedWork, data: { leaseTokenHash } });
      const reportState = () => prisma.jobWorkItem.findMany({
        where: { ownerId, applicationId: approved.applicationId },
        orderBy: { kind: "asc" },
        select: { kind: true, state: true, resultId: true },
      });
      const events = () => prisma.jobEvent.count({ where: { ownerId, applicationId: approved.applicationId, kind: "enriched" } });
      expect(await reportState()).toEqual([{ kind: "enrich", state: "claimed", resultId: null }]);
      expect(await events()).toBe(0);
      expect(await balanceFor(approved)).toEqual({ held: policy.maximumNanoUsd, spent: 0n });

      const lostReportResponse = new Error("Synthetic Jobs report commit response lost");
      await expect(report(approved, startedAt, interceptCommitResponse(() => { throw lostReportResponse; })))
        .rejects.toBe(lostReportResponse);
      const committed = await reportState();
      const resultId = committed[0]?.resultId;
      if (!resultId) throw new Error("Expected the committed pilot result ID");
      expect(committed).toEqual([
        { kind: "enrich", state: "done", resultId },
        { kind: "tailor", state: "queued", resultId: null },
      ]);
      expect(await events()).toBe(1);
      expect(await balanceFor(approved)).toEqual({ held: 0n, spent: expectedCharge });
      expect(await Promise.all([report(approved), report(approved, expiresAt)])).toEqual([{ resultId }, { resultId }]);
      expect(await reportState()).toEqual(committed);
      expect(await events()).toBe(1);
      expect(await balanceFor(approved)).toEqual({ held: 0n, spent: expectedCharge });
      expect((await slotsFor(approved)).map(slot => slot.state)).toEqual(["reported"]);
      expect(await withJobsWorkTransaction(prisma, tx => reserveSlot(tx, approved, policy, startedAt, "screen"))).toBeNull();
      expect(await withJobsWorkTransaction(prisma, tx => claimJobsWork(tx, { ownerId, role: "codex" },
        { workerId: "ordinary", kinds: ["tailor"] }, startedAt))).toEqual({ work: null });
      expect(calls).toHaveLength(callsBeforeReport);

      const workflowStarted = performance.now();
      const template = parseResumeDocument(`${resumeHeader}## Summary\n\n- Edited product pages\n\n## Experience\n\n- Maintained catalogs\n`).markdown;
      const { eligible: _eligible, verdict: _verdict, ineligibleReason: _reason, dueDate: _due, pay: _pay, ...briefFields } = output;
      const brief = jobsBrief.parse({ ...briefFields, pay: { hourlyCad: null, original: null, converted: false } });
      const tailorBody = jobsPilotRequestBody(policy, { track: "web", candidateContext: "", brief, resumeMarkdown: template }, "tailor");
      const native = n8n ? await import(new URL("../../../automation/n8n/jobs-feed/smoke/pilot-posting.mjs", import.meta.url).href) as {
        screenBody: string; importBody: string; result: { decision: "keep"; category: "web"; fitNote: string };
      } : null;
      const posting: JobsImportApplication & { sourceIdentity: string } = native ? JSON.parse(native.importBody).applications[0] : {
        company: "Synthetic Studio", role: "Editor", track: "web", postingText,
        sourceUrl: "https://job-boards.greenhouse.io/synthetic-studio/jobs/197",
        sourceIdentity: "greenhouse:global:synthetic-studio:197",
      };
      const screenBody = native?.screenBody ?? JSON.stringify({
        sourceIdentity: posting.sourceIdentity, postingText: posting.postingText, criteria: "Web publishing",
        maxOutputTokens: policy.maxOutputTokens,
      });
      const chainEnrichBody = jobsPilotRequestBody(policy, { track: "web", candidateContext: "", postingText: posting.postingText });
      const screenTarget: ScreeningTarget = {
        permitId: randomUUID(), ownerId, sourceIdentity: posting.sourceIdentity,
        applicationId: null, revision: null, workerId: "fixture-pilot",
      };
      const approval = { id: screenTarget.permitId, ownerId, sourceIdentity: posting.sourceIdentity };
      const screening = ledgerFor("screen");
      const tailoring = ledgerFor("tailor");
      const callsBeforeWorkflow = calls.length;
      await withJobsWorkTransaction(prisma, tx => insertPermit(tx, screenTarget, allowanceNanoUsd, expiresAt,
        { screen: screenBody, enrich: chainEnrichBody, tailor: tailorBody }));
      const permitBinding = async () => (await prisma.$queryRaw<{ applicationId: string | null; revision: number | null }[]>`
        SELECT application_id AS "applicationId", revision FROM fixture_pilot_permit WHERE id = ${screenTarget.permitId}
      `)[0];
      const postingDrafts = () => prisma.jobApplication.count({ where: { ownerId, sourceUrl: posting.sourceUrl } });
      let bindWrites = 0;
      const intake = async (db = prisma) => {
        const [allowed] = await prisma.$queryRaw<{ id: string }[]>`
          SELECT permit.id FROM fixture_pilot_permit AS permit
          JOIN fixture_pilot_reservation AS slot ON slot.permit_id = permit.id
          WHERE permit.id = ${approval.id} AND permit.owner_id = ${approval.ownerId}
            AND permit.source_identity = ${approval.sourceIdentity} AND permit.expires_at > ${startedAt}
            AND slot.phase = 'screen' AND slot.state = 'reported' AND slot.result ->> 'decision' = 'keep'
        `;
        if (!allowed) return null;
        const draft = await intakeHeldJobsDraft(db, approval, ownerId, posting, startedAt);
        bindWrites += await prisma.$executeRaw`
          UPDATE fixture_pilot_permit AS permit
          SET application_id = ${draft.applicationId}, revision = ${draft.revision}
          WHERE permit.id = ${approval.id} AND permit.owner_id = ${draft.ownerId}
            AND permit.source_identity = ${approval.sourceIdentity} AND permit.application_id IS NULL
            AND EXISTS (
              SELECT 1 FROM job_provider_posting AS posting
              JOIN job_application AS draft ON draft."ownerId" = posting."ownerId" AND draft.id = posting."applicationId"
              WHERE posting."ownerId" = permit.owner_id AND posting."sourceIdentity" = permit.source_identity
                AND draft.id = ${draft.applicationId} AND draft.revision = ${draft.revision}
                AND draft.status = 'draft' AND draft."pilotHeldAt" IS NOT NULL
            )
        `;
        const binding = await permitBinding();
        if (binding?.applicationId !== draft.applicationId || binding.revision !== draft.revision) {
          throw new Error("Screening permit did not bind the held draft");
        }
        return draft;
      };
      expect(await intake()).toBeNull();
      expect(await permitBinding()).toEqual({ applicationId: null, revision: null });
      expect(await postingDrafts()).toBe(0);
      const screenBinding = { resultId: randomUUID(), requestDigest: digest(screenBody) };
      await withJobsWorkTransaction(prisma, async tx => {
        expect(await screening.reserve(tx, { ...screenTarget, sourceIdentity: "greenhouse:global:other:197" }, policy, startedAt)).toBeNull();
        expect(await screening.reserve(tx, { ...screenTarget, ownerId: randomUUID() }, policy, startedAt)).toBeNull();
      });
      const dispatchScreen = async (raw: string) => {
        if (digest(raw) !== screenBinding.requestDigest) return null;
        const dispatched = await withJobsWorkTransaction(prisma, async tx => {
          const reserved = await screening.reserve(tx, screenTarget, policy, startedAt);
          if (!reserved) return false;
          if (reserved !== screenBinding.requestDigest ||
              !await screening.beginDispatch(tx, screenTarget, reserved, screenBinding, startedAt)) {
            throw new Error("Screening reservation did not match dispatch");
          }
          return true;
        });
        if (!dispatched) return null;
        const result = native?.result ?? { decision: "keep" };
        const { usage } = await fakeProvider(raw, screenBinding);
        const body = { id: "msg_fixture", model: policy.model, type: "message", role: "assistant", stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(result) }],
          usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, service_tier: "standard", speed: "standard", inference_geo: "global" } };
        const headers = new Headers({ "request-id": "req_fixture", "anthropic-workspace-id": "wrkspc_fixture" });
        const receipt = readAnthropicPilotReceipt({
          ...screenBinding, workspaceId: "wrkspc_fixture", model: policy.model,
          maxInputTokens: policy.inputTokens, maxOutputTokens: policy.maxOutputTokens,
        }, { status: 200, body, headers, sent: { body: new TextEncoder().encode(raw), resultId: screenBinding.resultId } });
        const screenReply = receipt && readJobsPilotReply(policy, screenBinding, receipt, value => {
          expect(value).toEqual(result);
          return value;
        });
        if (!screenReply) throw new Error("Expected a validated synthetic screening reply");
        expect(await withJobsWorkTransaction(prisma, tx => screening.recordReply(tx, screenTarget, screenReply))).toBe(true);
        expect(await intake()).toBeNull();
        expect(await postingDrafts()).toBe(0);
        expect(await balanceFor(screenTarget)).toEqual({ held: policy.maximumNanoUsd, spent: 0n });
        expect(await withJobsWorkTransaction(prisma, tx => screening.settleReport(tx, screenTarget, screenBinding.resultId, startedAt))).toBe(true);
        expect(await balanceFor(screenTarget)).toEqual({ held: 0n, spent: expectedCharge });
        return Response.json(body, { headers });
      };

      const templates = await mkdtemp(join(tmpdir(), "qs-jobs-pilot-intake-"));
      const previousTemplates = process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR;
      let draft: Awaited<ReturnType<typeof intakeHeldJobsDraft>>;
      try {
        await writeFile(join(templates, "web.md"), template);
        process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR = templates;
        if (native) {
          const completed = Promise.withResolvers<NonNullable<Awaited<ReturnType<typeof intake>>>>();
          let imported: string | undefined;
          const server = Bun.serve({
            hostname: "127.0.0.1", port: 3001,
            async fetch(request) {
              const route = new URL(request.url).pathname;
              if (route === "/ready" && request.method === "GET") return Response.json({ permit: approval.id });
              if (request.headers.get("x-fixture-permit") !== approval.id) return new Response(null, { status: 403 });
              if (request.method !== "POST") return new Response(null, { status: 405 });
              const raw = await request.text();
              if (route === "/screen") return await dispatchScreen(raw) ?? new Response(null, { status: 409 });
              if (route !== "/held-import") return new Response(null, { status: 404 });
              if (raw !== native.importBody) return new Response(null, { status: 409 });
              const key = request.headers.get("idempotency-key");
              if (!key?.startsWith("n8n-jobs-import-") || (imported && imported !== key)) return new Response(null, { status: 409 });
              const accepted = await intake();
              if (!accepted) return new Response(null, { status: 409 });
              if (imported) completed.resolve(accepted);
              imported = key;
              return Response.json({ imported: 1, duplicates: 0 });
            },
          });
          try {
            const send = (route: string, body: string, permit = approval.id) => fetch(new URL(route, server.url), {
              method: "POST", body, headers: { "x-fixture-permit": permit, "idempotency-key": "n8n-jobs-import-fixture-test" },
            });
            expect((await send("/screen", screenBody, randomUUID())).status).toBe(403);
            expect((await send("/held-import", native.importBody, randomUUID())).status).toBe(403);
            expect((await send("/screen", screenBody + " ")).status).toBe(409);
            expect((await send("/held-import", native.importBody)).status).toBe(409);
            expect(await postingDrafts()).toBe(0);
            draft = await completed.promise;
            expect((await send("/screen", screenBody)).status).toBe(409);
            expect((await send("/held-import", native.importBody + " ")).status).toBe(409);
            expect((await send("/held-import", native.importBody)).status).toBe(409);
          } finally {
            await server.stop();
          }
        } else {
          expect(await dispatchScreen(screenBody)).not.toBeNull();
          const lostIntakeResponse = new Error("Synthetic pilot intake commit response lost");
          await expect(intake(interceptCommitResponse(() => { throw lostIntakeResponse; }))).rejects.toBe(lostIntakeResponse);
          expect(await permitBinding()).toEqual({ applicationId: null, revision: null });
          expect(await postingDrafts()).toBe(1);
          const recovered = await intake();
          if (!recovered) throw new Error("Expected the settled screening to admit the held draft");
          draft = recovered;
        }
      } finally {
        if (previousTemplates === undefined) delete process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR;
        else process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR = previousTemplates;
        await rm(templates, { recursive: true, force: true });
      }
      expect(draft).toMatchObject({ ownerId, revision: 0 });
      const draftFilter = { ownerId, applicationId: draft.applicationId };
      const initialWork = await prisma.jobWorkItem.findMany({ where: draftFilter, select: { id: true, kind: true, state: true, revision: true } });
      expect(initialWork).toEqual([{ id: expect.any(String), kind: "enrich", state: "queued", revision: 0 }]);
      expect(await prisma.jobProviderPosting.findUniqueOrThrow({
        where: { ownerId_sourceIdentity: { ownerId, sourceIdentity: posting.sourceIdentity } },
        select: { applicationId: true },
      })).toEqual({ applicationId: draft.applicationId });
      const target = { ...screenTarget, ...draft };
      expect(await run(target, { kind: "tailor", ledger: tailoring })).toBe("denied");
      expect(await balanceFor(target)).toEqual({ held: 0n, spent: expectedCharge });

      expect(await run(target)).toBe("replied");
      expect(await run(target, { kind: "tailor", ledger: tailoring })).toBe("denied");
      expect(await report(target)).not.toBeNull();
      expect(await balanceFor(target)).toEqual({ held: 0n, spent: expectedCharge * 2n });
      const summaryMarkdown = "- Maintained product pages\n- Updated catalog content\n- Reviewed publication details";
      expect(await run(target, {
        kind: "tailor", ledger: tailoring,
        fakeProvider: async (body, binding) => ({ ...await fakeProvider(body, binding), output: JSON.stringify({ summaryMarkdown }) }),
      })).toBe("replied");
      expect(await balanceFor(target)).toEqual({ held: policy.maximumNanoUsd, spent: expectedCharge * 2n });
      const reportTailor = (db = prisma) => reportJobsPilotModelWork(db, target, {
        kind: "tailor", ledger: tailoring, now: () => startedAt,
        rates: { async convertMany() { throw new Error("Unexpected fixture FX call"); } },
      });
      await expect(reportTailor(interceptCommitResponse(() => { throw lostReportResponse; }))).rejects.toBe(lostReportResponse);
      const tailored = await reportTailor();
      expect(tailored).toMatchObject({ resultId: expect.any(String) });
      expect(await reportTailor()).toEqual(tailored);
      expect(await intake()).toEqual(draft);
      expect(bindWrites).toBe(1);
      expect(await withJobsWorkTransaction(prisma, tx => screening.reserve(tx, target, policy, startedAt))).toBeNull();
      expect(await balanceFor(target)).toEqual({ held: 0n, spent: expectedCharge * 3n });
      const charges = await prisma.$queryRaw<{ phase: Phase; state: string; charge: bigint }[]>`
        SELECT phase, state, charge_nano_usd AS charge
        FROM fixture_pilot_reservation WHERE permit_id = ${target.permitId} ORDER BY phase
      `;
      expect(charges).toEqual((["enrich", "screen", "tailor"] as const).map(phase => ({ phase, state: "reported", charge: expectedCharge })));
      expect(await prisma.jobApplication.findUniqueOrThrow({
        where: { ownerId_id: { ownerId, id: target.applicationId } },
        select: { status: true, revision: true, pilotHeldAt: true },
      })).toEqual({ status: "review", revision: 1, pilotHeldAt: startedAt });
      expect(await prisma.jobRevision.count({ where: { ownerId, applicationId: target.applicationId } })).toBe(1);
      expect(await prisma.jobEvent.count({ where: { ownerId, applicationId: target.applicationId, kind: "tailored" } })).toBe(1);
      expect(await prisma.jobApplication.count({ where: { ownerId, sourceUrl: posting.sourceUrl } })).toBe(1);
      expect(await prisma.jobEvent.count({ where: { ...draftFilter, kind: "imported" } })).toBe(1);
      expect(await prisma.jobWorkItem.findMany({ where: { ...draftFilter, kind: "enrich" },
        select: { id: true, state: true } })).toEqual([{ id: initialWork[0].id, state: "done" }]);
      expect(calls.slice(callsBeforeWorkflow)).toEqual([screenBody, chainEnrichBody, tailorBody]);
      console.info("Shared Jobs pilot allowance", JSON.stringify({ charges: charges.length, fakeCalls: calls.length - callsBeforeWorkflow,
        spentNanoUsd: (expectedCharge * 3n).toString(), heldNanoUsd: "0", importedDrafts: 1, enrichmentItems: 1, tailoredRevisions: 1,
        elapsedMs: Math.round(performance.now() - workflowStarted), providerRequests: 0 }));

      console.info("Jobs pilot dispatch proof", JSON.stringify({ denied: denied.length, raceMs, raceReservations: 1, raceTransactionAttempts: contenders,
        fakeCalls: calls.length, latePermitCalls: 0, lateLeaseCalls: 0, lostCommitAndReplayCalls: 0,
        lostReplyCalls: 1, reportReplays: 2, enrichedEvents: 1, heldSuccessors: 1, reportFakeCalls: 0,
        reportMs: Math.round(performance.now() - reportStarted), invalidUsages: invalidUsages.length,
        settledNanoUsd: expectedCharge.toString(), uncertainHeldNanoUsd: policy.maximumNanoUsd.toString(), providerRequests: 0 }));
    } finally {
      await prisma.$disconnect();
    }
  },
  process.env.QUANTSELF_JOBS_PILOT_N8N_FIXTURE === "1" ? 120_000 : 15_000,
);
