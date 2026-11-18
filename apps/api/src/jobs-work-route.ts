import { timingSafeEqual } from "node:crypto";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { getOwnerUserId } from "@quantself/auth/owner-record";
import { prisma } from "@quantself/db";
import { Prisma, type PrismaClient } from "@quantself/db/generated/prisma/client";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { createCurrencyConverter, FxUnavailable } from "./budget-fx";
import { runIdempotentCommand } from "./idempotency";
import { JobsError } from "./jobs-error";
import { readRunnerJobFields } from "./jobs-private-fields";
import { hashJobWorkToken, lockPrivateJobDetails } from "./jobs-private-pause";
import { jobsRunnerKeyPattern, matchesJobsRunnerKey } from "./jobs-runner-pairing";
import {
  jobsRunnerHeartbeatInput, jobsSubmissionEventInput, jobsWorkClaimInput, jobsWorkPdfHeaders,
  jobsWorkPdfUploadHeaders, jobsWorkPrivateFieldsInput, jobsWorkerPath,
} from "./jobs-work-contract";
import {
  claimJobsWork, completeJobsWork, failJobsWork, jobWorkRevision, lockJobsWork, markJobsPdfReady,
  recordJobsSubmissionEvent, requireActiveJobsWork, requireCurrentJobsClaim, requireJobsWork, requirePilotRunnerAuthorization, withJobsWorkTransaction, type JobsWorker,
} from "./jobs-work-service";
import { originalFiles } from "./original-files";
import { sha256 } from "./original-storage";

const accepted = { accepted: true } as const;
const uuid = z.uuid();
const maxPdfBytes = 16 * 1024 * 1024;
const resultHeader = z.looseObject({ resultId: uuid, leaseToken: z.string().min(16).max(200) });
const pdfParams = z.object({ id: uuid, revision: z.coerce.number().int().nonnegative() });
const credentials = () => ({ codex: process.env.JOBS_WORKER_SECRET, runner: process.env.JOBS_RUNNER_SECRET });

export type JobsWorkerRouteOptions = {
  db?: PrismaClient;
  now?: () => Date;
  secrets?: typeof credentials;
  pdfStore?: Pick<typeof originalFiles, "put" | "open">;
  pilotReview?: boolean;
};

function envRoleFor(bearer: string | undefined, secrets: ReturnType<typeof credentials>): JobsWorker["role"] | undefined {
  const { codex, runner } = secrets;
  if (codex && runner && codex === runner) throw new JobsError(503, "Jobs worker credentials must be distinct.");
  if (bearer) {
    const supplied = Buffer.from(hashJobWorkToken(bearer), "hex");
    for (const role of ["codex", "runner"] as const) {
      const secret = secrets[role];
      if (secret && secret.length >= 32 && timingSafeEqual(supplied, Buffer.from(hashJobWorkToken(secret), "hex"))) return role;
    }
  }
}

async function requestJson(request: Request) {
  try { return await request.json() as unknown; }
  catch { throw new JobsError(400, "Invalid Jobs work request."); }
}

export function registerJobsWorkerRoutes(app: OpenAPIHono<any>, {
  db = prisma, now = () => new Date(), secrets = credentials, pdfStore = originalFiles, pilotReview = false,
}: JobsWorkerRouteOptions = {}) {
  const rates = createCurrencyConverter(db);
  async function respond(c: Context, operation: (worker: JobsWorker) => Promise<Response>, role?: JobsWorker["role"]): Promise<Response> {
    c.header("Cache-Control", "private, no-store");
    try {
      const bearer = c.req.header("Authorization")?.match(/^Bearer (\S+)$/i)?.[1];
      let kind = envRoleFor(bearer, secrets());
      if (!kind && (!bearer || !jobsRunnerKeyPattern.test(bearer))) throw new JobsError(401, "Jobs worker authentication required.");
      if (role && kind && role !== kind) throw new JobsError(403, "This credential cannot use this Jobs work route.");
      const ownerId = await getOwnerUserId(db);
      if (!ownerId) throw new JobsError(503, "The Jobs owner has not been configured.");
      if (!kind) {
        if (!bearer || !await matchesJobsRunnerKey(db, ownerId, bearer)) throw new JobsError(401, "Jobs worker authentication required.");
        kind = "runner";
        if (role && role !== kind) throw new JobsError(403, "This credential cannot use this Jobs work route.");
      }
      return await operation({ ownerId, role: kind });
    } catch (error) {
      if (error instanceof JobsError) return Response.json({ message: error.message }, { status: error.status });
      if (error instanceof z.ZodError) return Response.json({ message: "Invalid Jobs work request." }, { status: 400 });
      if (error instanceof FxUnavailable) return Response.json({ message: error.message }, { status: 503 });
      throw error;
    }
  }

  app.post(`${jobsWorkerPath}/work/claim`, bodyLimit({ maxSize: 64 * 1024 }), c => respond(c, async worker => {
    const input = jobsWorkClaimInput.parse(await requestJson(c.req.raw));
    return c.json(await withJobsWorkTransaction(db, tx => claimJobsWork(tx, worker, input, now(), pilotReview)));
  }));

  for (const action of ["complete", "fail"] as const) {
    app.post(`${jobsWorkerPath}/work/:id/${action}`, bodyLimit({ maxSize: 64 * 1024 }), c => respond(c, async worker => {
      const id = uuid.parse(c.req.param("id"));
      const envelope = resultHeader.parse(await requestJson(c.req.raw));
      const canPause = worker.role === "runner" && action === "fail" && envelope.code === "manual_required" && envelope.requirements !== undefined;
      // A matching completed command returns before checking the mutable lease. The ledger survives a new lease or requeue.
      const result = await runIdempotentCommand({
        clientId: `jobs-worker:${worker.ownerId}:${worker.role}`, operation: "reportJobsWork", idempotencyKey: envelope.resultId,
        request: { workId: id, action, input: envelope }, timeoutMs: 15_000,
        // A concurrent answer must be visible after we acquire the same private-fields lock.
        ...(canPause && { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }),
        execute: async tx => {
          if (canPause) await lockPrivateJobDetails(tx, worker.ownerId);
          if (worker.role === "runner") await lockJobsWork(tx, worker.ownerId, id);
          const work = await requireJobsWork(tx, worker, id, envelope.leaseToken);
          // A submit lease is never reassigned. The original claim can still settle its receipt or uncertainty.
          if (work.kind === "submit") requireCurrentJobsClaim(work);
          else requireActiveJobsWork(work, now());
          if (action === "complete") await completeJobsWork(tx, work, envelope, rates);
          else await failJobsWork(tx, work, envelope, now());
          return { kind: "success", body: accepted, status: 200 };
        },
      }, db);
      if (result.kind === "conflict") throw new JobsError(409, result.message);
      return c.json(result.body);
    }));
  }

  app.post(`${jobsWorkerPath}/work/:id/private-fields`, bodyLimit({ maxSize: 64 * 1024 }), c => respond(c, async worker => {
    const id = uuid.parse(c.req.param("id"));
    const input = jobsWorkPrivateFieldsInput.parse(await requestJson(c.req.raw));
    return c.json(await withJobsWorkTransaction(db, async tx => {
      const work = await requireJobsWork(tx, worker, id, input.leaseToken);
      requireActiveJobsWork(work, now());
      if (work.kind !== "render" && work.kind !== "submit") throw new JobsError(403, "Private fields require a runner claim.");
      return readRunnerJobFields(tx, worker.ownerId, work.application, work.kind);
    }));
  }, "runner"));

  app.post(`${jobsWorkerPath}/runner/heartbeat`, bodyLimit({ maxSize: 64 * 1024 }), c => respond(c, async worker => {
    const { host } = jobsRunnerHeartbeatInput.parse(await requestJson(c.req.raw));
    const data = { host, lastHeartbeatAt: now() };
    await db.jobRunner.upsert({ where: { ownerId: worker.ownerId }, create: { ownerId: worker.ownerId, ...data }, update: data });
    return c.json(accepted);
  }, "runner"));

  app.post(`${jobsWorkerPath}/submissions/:id/events`, bodyLimit({ maxSize: 64 * 1024 }), c => respond(c, async worker => {
    const applicationId = uuid.parse(c.req.param("id"));
    const { workId, leaseToken, ...event } = jobsSubmissionEventInput.parse(await requestJson(c.req.raw));
    return c.json(await withJobsWorkTransaction(db, async tx => {
      if (event.step === "submit_started") await lockJobsWork(tx, worker.ownerId, workId);
      const work = await requireJobsWork(tx, worker, workId, leaseToken);
      requireActiveJobsWork(work, now());
      if (work.kind !== "submit" || work.applicationId !== applicationId) throw new JobsError(409, "Submission does not match this Jobs work.");
      const earlier = await tx.jobEvent.findUnique({ where: { ownerId_applicationId_eventKey: { ownerId: worker.ownerId, applicationId, eventKey: event.eventId } } });
      if (earlier) {
        const data = z.object({
          workId: z.string(), attempt: z.number(), step: z.string(), state: z.string(),
          durationMs: z.number().optional(), code: z.string().optional(), channel: z.literal("ses").optional(),
        }).parse(earlier.payload);
        if (data.workId !== workId || data.attempt !== work.attempts || data.step !== event.step || data.state !== event.state ||
            data.durationMs !== event.durationMs || data.code !== event.code || data.channel !== event.channel) throw new JobsError(409, "Submission event differs from the original report.");
      } else {
        if (event.step === "submit_started" && event.state !== "failed") {
          if (work.application.pilotHeldAt && !pilotReview) throw new JobsError(409, "Pilot submission is disabled.");
          await requirePilotRunnerAuthorization(tx, work);
        }
        await recordJobsSubmissionEvent(tx, work, event);
      }
      return accepted;
    }));
  }, "runner"));

  const pdfPath = `${jobsWorkerPath}/applications/:id/revisions/:revision/pdf`;
  app.put(pdfPath, bodyLimit({ maxSize: maxPdfBytes }), c => respond(c, async worker => {
    const { id, revision } = pdfParams.parse(c.req.param());
    const headers = jobsWorkPdfUploadHeaders.parse(c.req.header());
    if (!/^application\/pdf(?:;|$)/i.test(c.req.header("Content-Type") ?? "")) throw new JobsError(400, "Supply a Jobs PDF.");
    const bytes = Buffer.from(await c.req.arrayBuffer());
    const digest = sha256(bytes);
    if (bytes.length < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-" || digest !== headers["x-content-sha256"]) {
      throw new JobsError(400, "Jobs PDF digest or format is invalid.");
    }
    async function check(tx: Pick<PrismaClient, "jobWorkItem" | "jobRevision">) {
      const work = await requireJobsWork(tx, worker, headers["x-job-work-id"], headers["x-job-lease-token"]);
      if (work.kind !== "render" || work.applicationId !== id || work.revision !== revision) throw new JobsError(409, "PDF does not match this render claim.");
      if (work.state === "done") {
        const rendered = await jobWorkRevision(tx, work);
        if (!rendered?.pdfReference || rendered.pdfSha256 !== digest) throw new JobsError(409, "A different Jobs PDF was already stored.");
      } else requireActiveJobsWork(work, now());
      return work;
    }
    if ((await check(db)).state === "done") return c.json(accepted);
    const reference = await pdfStore.put(`jobs:${worker.ownerId}:${id}:${revision}:${digest}`, bytes, "application/pdf", "Jobs", "resume.pdf");
    return c.json(await withJobsWorkTransaction(db, async tx => {
      const work = await check(tx);
      if (work.state !== "done") await markJobsPdfReady(tx, work, reference, digest);
      return accepted;
    }));
  }, "runner"));

  app.get(pdfPath, c => respond(c, async worker => {
    const { id, revision } = pdfParams.parse(c.req.param());
    const headers = jobsWorkPdfHeaders.parse(c.req.header());
    const work = await requireJobsWork(db, worker, headers["x-job-work-id"], headers["x-job-lease-token"]);
    requireActiveJobsWork(work, now());
    if (work.kind !== "submit" || work.applicationId !== id || work.revision !== revision) throw new JobsError(409, "PDF does not match this submission claim.");
    const pdf = await jobWorkRevision(db, work);
    if (!pdf?.pdfReference || pdf.pdfSha256 !== work.application.approvedPreviewDigest) throw new JobsError(409, "Approved Jobs PDF is unavailable.");
    return pdfStore.open(pdf.pdfReference);
  }, "runner"));
}
