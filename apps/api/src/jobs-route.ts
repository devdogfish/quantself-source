import { getPublicOrigin } from "@quantself/auth/public-origin";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { prisma } from "@quantself/db";
import { Prisma, type PrismaClient } from "@quantself/db/generated/prisma/client";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { isPrismaWriteConflict, runIdempotentCommand } from "./idempotency";
import { editJobSummaryAsClient } from "./jobs-agent-write";
import { JobsError } from "./jobs-error";
import { JobsProviderImportRace } from "./jobs-provider-import";
import {
  jobsAddApplicationInput, jobsAddApplicationOutput, jobsImportApplicationsInput, jobsImportApplicationsOutput,
  jobsOwnerDecision, jobsResolveInput, jobsResolveOutput, jobsRunnerOutput, jobsRunnerPairingOutput, jobsRunnerPauseInput,
  jobsPilotPermitInput, jobsPilotPermitOutput, jobsPilotRevocationOutput, jobsPilotReviewInput, jobsPilotReviewOutput,
} from "./jobs-owner-contract";
import { addJobApplication, importJobsApplications, importScreenedJobsPilotDraft, resolveJobSubmission, setJobsRunnerPaused } from "./jobs-owner-write";
import { issueJobsPilotPermit, revokeJobsPilotPermit } from "./jobs-pilot-permit";
import { reviewJobsPilotCandidate } from "./jobs-pilot-review";
import { issueJobsRunnerKey } from "./jobs-runner-pairing";
import {
  jobsOverviewOutput, jobsSubmissionsOutput, readJobSubmission, readJobsOverview, readJobsSubmissions,
} from "./jobs-operations-read";
import {
  jobsApplicationAddressInput, jobsApplicationAddressOutput, jobsApplicationsExportInput, jobsApplicationsExportOutput, jobsApplicationsInput,
  jobsApplicationReplyInput, jobsApplicationsOutput, jobsReviewableInput, jobsReviewableOutput, jobsReviewApplicationOutput, jobsReviewApprovalOutput, jobsReviewEditInput,
  jobsReviewPatchOutput, jobsReviewSessionInput, jobsReviewSessionOutput, jobsPostingDetailsInput, jobsSaveBriefInput,
} from "./jobs-review-contract";
import { exportJobsApplications, readJobApplicationId, readJobsApplications, readReviewableJobIds } from "./jobs-applications-read";
import { readJobPdfReference, readJobReviewApplication, readJobReviewSession } from "./jobs-review-read";
import { decideJobReview, editJobReviewRevision, saveJobPostingDetails, saveMissingJobBrief } from "./jobs-review-write";
import {
  candidateContextOutput, getCandidateContext, patchCandidateContext, patchCandidateContextInput,
} from "./jobs-candidate-context";
import { changeJobLifecycle, readJobLifecycle } from "./jobs-lifecycle";
import {
  listNativeJobInterviews, readNativeJobInterview, reserveNativeJobInterview, saveJobInterview, updateNativeJobInterview,
} from "./jobs-interview";
import {
  jobInterviewInput, jobInterviewOutput, jobLifecycleInput, jobLifecycleOutput,
  nativeJobInterviewCommand, nativeJobInterviewDetail, nativeJobInterviewListOutput, nativeJobInterviewRange,
  scheduleJobInterviewInput, scheduleJobInterviewOutput,
} from "./jobs-lifecycle-contract";
import type { TodoWriter } from "./todos-write";
import { idempotencyHeader, jobIdInput } from "./jobs-contract";
import {
  listPrivateFieldsInput, patchPrivateFieldsInput, patchPrivateFieldsOutput, privateFieldsOutput, privateFieldValuesInput, privateFieldValuesOutput,
  registerPrivateRequirementsInput, registerPrivateRequirementsOutput,
} from "./jobs-private-fields-contract";
import { listPrivateFields, listPrivateFieldValues, patchPrivateFields, registerPrivateRequirements } from "./jobs-private-fields";
import { originalFiles } from "./original-files";
import { OriginalStorageError } from "./original-storage";

export const jobApplicationAddressLookupPath = "/api/v1/jobs/applications/by-address";
export const jobApplicationReplyLookupPath = "/api/v1/jobs/applications/resolve-reply";

type Env = { Variables: { accessContext: AccessContext | null } };
type Transaction = Prisma.TransactionClient;
type Permission = "jobs:read" | "jobs:write" | "jobs:import-tailored" | "jobs:revise" | "jobs:execute" | "jobs:schedule-interview";
type Credential = "either" | "owner" | "worker" | "agent";
const exampleId = "49db114d-041b-4e68-a82c-2050a3a47ac5";
const example = {
  id: exampleId, company: "Example Studio", role: "Web Engineer", sourceUrl: "https://example.com/jobs/123",
  track: "web", status: "draft", issue: null, verdict: null, dueAt: null, source: null,
  updatedAt: "2026-11-10T00:00:00Z", appliedAt: null,
};
const error = {
  description: "Jobs request failed.",
  content: { "application/json": {
    schema: z.object({ message: z.string() }),
    example: { message: "Refresh the application before trying again." },
  } },
};
const security: Record<Credential, Record<string, string[]>[]> = {
  either: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  owner: [{ ownerSession: [] }],
  worker: [{ apiKeyAuth: [] }],
  agent: [{ apiKeyAuth: [] }],
};

function authorize(permission: Permission[], credential: Credential) {
  return createMiddleware<Env>(async (c, next) => {
    c.header("Cache-Control", "no-store");
    const access = c.get("accessContext");
    if (!access) return c.json({ message: "Authentication required." }, 401);
    if (!permission.some(scope => access.permissions.includes(scope)) ||
      (credential === "owner" && access.client.kind !== "web") ||
      (credential === "worker" && access.client.kind !== "api-key") ||
      (credential === "agent" && access.client.kind !== "agent")) {
      return c.json({ message: "Missing Jobs permission." }, 403);
    }
    if (c.req.method !== "GET" && access.client.kind === "web" &&
      c.req.header("origin") !== (getPublicOrigin() ?? new URL(c.req.url).origin)) {
      return c.json({ message: "Invalid origin." }, 403);
    }
    if (c.req.method !== "GET" && !/^application\/json(?:;|$)/i.test(c.req.header("content-type") ?? "")) {
      return c.json({ message: "Send a JSON request body." }, 400);
    }
    await next();
  });
}

function json<Schema extends z.ZodType>(schema: Schema, example: unknown) {
  return { "application/json": { schema, example } };
}

function body<Schema extends z.ZodType>(schema: Schema, example: unknown) {
  return { required: true, content: json(schema, example) };
}

function metadata<Output extends z.ZodType>(config: {
  summary: string; operationId: string; output: Output; example: unknown; permission: Permission[];
  credential?: Credential; sideEffects: string; retry: string;
}) {
  const { summary, operationId, output, example, permission, sideEffects, retry, credential = "either" } = config;
  const authentication = { either: "Owner ingress or X-API-Key", owner: "Same-origin Owner access", worker: "X-API-Key", agent: "Scoped Agent X-API-Key" }[credential];
  return {
    summary, operationId, tags: ["Jobs"],
    description: `Authentication: ${authentication}. Required permissions: ${permission.join(" or ")}${credential === "worker" && permission.length > 1 ? " according to the work kind" : ""}. Inputs: ${summary}. Success response: JSON result. Failure responses: invalid input, access denied, missing record, conflict or service unavailable. Side effects: ${sideEffects}. Destructive: no. Retry safety: ${retry}.`,
    security: security[credential],
    "x-required-permissions": permission,
    "x-destructive": false,
    middleware: [authorize(permission, credential), bodyLimit({ maxSize: 1_500_000, onError: c => c.json({ message: "Jobs request is too large." }, 413) })],
    responses: {
      200: { description: summary, content: json(output, example) },
      400: error, 401: error, 403: error, 404: error, 409: error, 413: error, 503: error,
    },
  };
}

async function respond(c: Context<Env>, action: (access: AccessContext) => Promise<unknown>) {
  try {
    const result = await action(c.get("accessContext")!);
    return (result instanceof Response ? result : c.json(result as object)) as never;
  } catch (cause) {
    if (cause instanceof JobsError) return c.json({ message: cause.message }, cause.status) as never;
    if (isPrismaWriteConflict(cause) || (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002")) {
      return c.json({ message: "Jobs data changed. Refresh before trying again." }, 409) as never;
    }
    throw cause;
  }
}

async function idempotent<T extends Record<string, unknown>>(
  db: PrismaClient, access: AccessContext, operation: string, key: string, request: Record<string, unknown>,
  execute: (tx: Transaction) => Promise<T>,
  isolationLevel?: Prisma.TransactionIsolationLevel,
) {
  const result = await runIdempotentCommand({
    clientId: access.client.id,
    isolationLevel,
    operation,
    idempotencyKey: key,
    request: { ownerId: access.owner.id, ...request },
    execute: async tx => ({ kind: "success", status: 200, body: await execute(tx) }),
  }, db);
  if (result.kind === "conflict") throw new JobsError(409, result.message);
  return result.body;
}

const pilotPath = "/api/v1/jobs/pilot/permits";

// The same-owner pilot rehearsal opts in explicitly. The default application leaves this route closed.
export function registerJobsPilotReviewRoute(app: OpenAPIHono<Env>, db: PrismaClient) {
  const inputExample = { action: "release", applicationId: exampleId, expectedRevision: 1, sha256: "a".repeat(64) };
  app.openapi(createRoute({
    method: "post", path: pilotPath + "/{id}/review",
    ...metadata({
      summary: "Authorize pilot rendering or release an exact approved PDF", operationId: "reviewJobsPilotCandidate",
      output: jobsPilotReviewOutput, example: { action: "release", applicationId: exampleId, revision: 1, workId: exampleId, sha256: inputExample.sha256 },
      permission: ["jobs:write"], credential: "owner", sideEffects: "authorizes existing work for one held application and revision",
      retry: "reuse the same Idempotency-Key and payload to recover the original authorization",
    }),
    request: { params: jobIdInput, headers: idempotencyHeader, body: body(jobsPilotReviewInput, inputExample) },
  }), c => respond(c, access => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    return idempotent(db, access, "reviewJobsPilotCandidate", c.req.valid("header")["idempotency-key"], { id, ...input },
      tx => reviewJobsPilotCandidate(tx, access.owner.id, id, input));
  }));
}

// Registered only by the offline fixture until trusted screening settlement is available.
export function registerJobsPilotIntakeRoute(app: OpenAPIHono<Env>, db: PrismaClient) {
  const posting = {
    sourceIdentity: "greenhouse:global:example-studio:197", sourceUrl: "https://job-boards.greenhouse.io/example-studio/jobs/197",
    company: "Example Studio", role: "Editor", track: "web", postingText: "Maintain product pages.",
  };
  app.openapi(createRoute({
    method: "post", path: pilotPath + "/{id}/intake",
    ...metadata({
      summary: "Import one screened posting as a held Jobs draft", operationId: "importScreenedJobsPilotDraft",
      output: z.object({ applicationId: z.uuid(), revision: z.literal(0) }), example: { applicationId: exampleId, revision: 0 },
      permission: ["jobs:import-tailored"], credential: "worker",
      sideEffects: "creates one held draft and queues held enrichment after a settled keep result",
      retry: "reuse the same Idempotency-Key, permit and posting to recover the original import receipt",
    }),
    request: {
      params: jobIdInput, headers: idempotencyHeader,
      body: body(z.strictObject({ applications: jobsImportApplicationsInput.shape.applications.length(1) }), { applications: [posting] }),
    },
  }), c => respond(c, access => {
    const { id } = c.req.valid("param");
    const [input] = c.req.valid("json").applications;
    return idempotent(db, access, "importScreenedJobsPilotDraft", c.req.valid("header")["idempotency-key"], { id, posting: input },
      tx => importScreenedJobsPilotDraft(tx, access.owner.id, id, input), Prisma.TransactionIsolationLevel.ReadCommitted);
  }));
}

export function registerJobsRoutes(
  app: OpenAPIHono<Env>, db: PrismaClient = prisma, openPdf = originalFiles.open, writeTodo?: TodoWriter,
  readVerifiedOriginalReplyAvailability?: (access: AccessContext, applicationId: string) => Promise<
    Pick<z.output<typeof jobLifecycleOutput>, "verifiedOriginalReplyAvailable" | "verifiedOriginalReplies"
      | "verifiedOriginalRepliesBefore" | "canConfirmOriginalReply">
  >,
) {
  const permitExample = { sourceIdentity: "greenhouse:global:example-studio:197", expiresAt: "2026-11-20T14:30:00Z" };
  app.openapi(createRoute({
    method: "post", path: pilotPath,
    ...metadata({
      summary: "Grant a time-limited Jobs pilot permit for one Greenhouse posting", operationId: "issueJobsPilotPermit",
      output: jobsPilotPermitOutput, example: { id: exampleId, ...permitExample }, permission: ["jobs:write"], credential: "owner",
      sideEffects: "records an Owner permit for one unimported posting. Paid dispatch stays closed",
      retry: "reuse the same Idempotency-Key and payload to recover the original permit ID",
    }),
    request: { headers: idempotencyHeader, body: body(jobsPilotPermitInput, permitExample) },
  }), c => respond(c, access => {
    const { sourceIdentity, expiresAt } = c.req.valid("json");
    const input = { sourceIdentity, expiresAt: new Date(expiresAt).toISOString() };
    return idempotent(db, access, "issueJobsPilotPermit", c.req.valid("header")["idempotency-key"], input,
      tx => issueJobsPilotPermit(tx, access.owner.id, input));
  }));

  app.openapi(createRoute({
    method: "post", path: pilotPath + "/{id}/revoke",
    ...metadata({
      summary: "Revoke a Jobs pilot permit", operationId: "revokeJobsPilotPermit",
      output: jobsPilotRevocationOutput, example: { id: exampleId, revokedAt: "2026-11-20T14:00:00Z" },
      permission: ["jobs:write"], credential: "owner", sideEffects: "records revocation and preserves any held draft",
      retry: "repeat for the same permit to recover its revocation timestamp",
    }),
    request: { params: jobIdInput, body: body(z.strictObject({}), {}) },
  }), c => respond(c, access => db.$transaction(tx => revokeJobsPilotPermit(tx, access.owner.id, c.req.valid("param").id))));

  const applicationExample = { application: example };
  const lifecycleExample = { application: example, revision: 0, changedAt: null, transitions: [],
    sourceReplyLinked: false, sourceReplyUrl: null, appointments: [] };
  const lifecyclePath = "/api/v1/jobs/applications/{id}/lifecycle";
  const interviewStart = "2026-11-20T14:00:00Z", interviewEnd = "2026-11-20T14:30:00Z";
  app.openapi(createRoute({
    method: "get", path: lifecyclePath,
    ...metadata({
      summary: "Read application lifecycle and interview appointments", operationId: "getJobLifecycle", output: jobLifecycleOutput,
      example: lifecycleExample, permission: ["jobs:read"], sideEffects: "none", retry: "safe read",
    }),
    request: { params: jobIdInput },
  }), c => respond(c, async access => {
    const { id } = c.req.valid("param");
    const [detail, originals] = await Promise.all([
      readJobLifecycle(db, access.owner.id, id, access.client.kind === "web"),
      readVerifiedOriginalReplyAvailability?.(access, id) ?? { verifiedOriginalReplyAvailable: false },
    ]);
    return { ...detail, ...originals };
  }));

  app.openapi(createRoute({
    method: "post", path: "/api/v1/jobs/applications/{id}/interviews",
    ...metadata({
      summary: "Create one fixed appointment in the Job search category", operationId: "createJobInterview",
      output: jobInterviewOutput, permission: ["jobs:write"], credential: "owner",
      example: { id: exampleId, source: "github", todoNumber: 42, start: interviewStart, end: interviewEnd },
      sideEffects: "creates a linked To-Do Appointment after checking todos:write", retry: "retry the same application and time to reconcile",
    }),
    "x-required-permissions": ["jobs:write", "todos:write"],
    request: { params: jobIdInput, body: body(jobInterviewInput, { start: interviewStart, end: interviewEnd }) },
  }), c => respond(c, async access => {
    if (!access.permissions.includes("todos:write")) throw new JobsError(403, "Missing To-Do permission.");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    if (process.env.QUANTSELF_NATIVE_JOB_INTERVIEWS !== "1") return saveJobInterview(db, writeTodo, access.owner.id, id, input);
    const reserved = await db.$transaction(tx => reserveNativeJobInterview(tx, access, id, input), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
    return reserved ? reserved.appointment : saveJobInterview(db, writeTodo, access.owner.id, id, input, false);
  }));

  app.openapi(createRoute({
    method: "post", path: "/api/v1/jobs/applications/{id}/interviews/native",
    ...metadata({
      summary: "Schedule a fixed interview Appointment from the current lifecycle revision", operationId: "scheduleJobInterview",
      output: scheduleJobInterviewOutput, permission: ["jobs:schedule-interview"], credential: "agent",
      example: { appointment: { id: exampleId, source: "native", start: interviewStart, end: interviewEnd, revision: 1, cancelledAt: null } },
      sideEffects: "reserves the linked Appointment and records an Agent audit for Owner Undo. Recent Owner edits block new reservations",
      retry: "reuse the same Idempotency-Key, lifecycle revision and normalized start/end",
    }),
    request: {
      params: jobIdInput, headers: idempotencyHeader,
      body: body(scheduleJobInterviewInput, { start: interviewStart, end: interviewEnd, expectedRevision: 0 }),
    },
  }), c => respond(c, access => {
    if (process.env.QUANTSELF_NATIVE_JOB_INTERVIEWS !== "1") throw new JobsError(503, "Native interview scheduling is disabled.");
    const { id } = c.req.valid("param");
    const { start, end, expectedRevision } = c.req.valid("json");
    const input = { start: new Date(start).toISOString(), end: new Date(end).toISOString(), expectedRevision };
    return idempotent(db, access, "scheduleJobInterview", c.req.valid("header")["idempotency-key"], { id, ...input },
      async tx => {
        const result = await reserveNativeJobInterview(tx, access, id, input);
        if (!result) throw new JobsError(503, "The Owner must reconcile the GitHub Appointment.");
        return result;
      }, Prisma.TransactionIsolationLevel.ReadCommitted);
  }));

  const nativeAppointmentPath = "/api/v1/jobs/interview-appointments";
  const nativeAppointmentExample = {
    id: exampleId, source: "native", applicationId: exampleId, title: "Interview",
    start: interviewStart, end: interviewEnd, revision: 1, cancelledAt: null, fixed: true, allDay: false,
    category: "Job search", beforeMinutes: 0, afterMinutes: 0, alertMinutes: 10,
  };
  app.openapi(createRoute({
    method: "get", path: nativeAppointmentPath,
    ...metadata({
      summary: "Read native Appointments overlapping a bounded interval", operationId: "listNativeJobInterviews",
      output: nativeJobInterviewListOutput, example: { appointments: [nativeAppointmentExample], nextCursor: null },
      permission: ["jobs:read"], credential: "owner", sideEffects: "none", retry: "safe read",
    }),
    request: { query: nativeJobInterviewRange },
  }), c => respond(c, access => listNativeJobInterviews(db, access.owner.id, c.req.valid("query"))));

  app.openapi(createRoute({
    method: "get", path: nativeAppointmentPath + "/{id}",
    ...metadata({
      summary: "Read a native Appointment by UUID, including cancellation state", operationId: "getNativeJobInterview",
      output: nativeJobInterviewDetail, example: nativeAppointmentExample, permission: ["jobs:read"],
      credential: "owner", sideEffects: "none", retry: "safe read",
    }),
    request: { params: jobIdInput },
  }), c => respond(c, access => readNativeJobInterview(db, access.owner.id, c.req.valid("param").id)));

  app.openapi(createRoute({
    method: "patch", path: nativeAppointmentPath + "/{id}",
    ...metadata({
      summary: "Edit or cancel a native Appointment at the expected revision", operationId: "updateNativeJobInterview",
      output: nativeJobInterviewDetail, example: { ...nativeAppointmentExample, revision: 2, beforeMinutes: 15 },
      permission: ["jobs:write"], credential: "owner",
      sideEffects: "changes the native Appointment and invalidates earlier Undo and alert revisions",
      retry: "reuse the same Idempotency-Key and normalized command",
    }),
    request: {
      params: jobIdInput, headers: idempotencyHeader,
      body: body(nativeJobInterviewCommand, { action: "update", expectedRevision: 1, beforeMinutes: 15 }),
    },
  }), c => respond(c, access => {
    const { id } = c.req.valid("param");
    const command = c.req.valid("json");
    if (command.action === "update" && command.start !== undefined && command.end !== undefined) {
      command.start = new Date(command.start).toISOString();
      command.end = new Date(command.end).toISOString();
    }
    return idempotent(db, access, "updateNativeJobInterview", c.req.valid("header")["idempotency-key"], { id, ...command },
      tx => updateNativeJobInterview(tx, access.owner.id, id, command), Prisma.TransactionIsolationLevel.ReadCommitted);
  }));

  const privateFieldExample = { key: "firstName", label: "First name", type: "text", scope: { kind: "global" } };
  const contextExample = { markdown: "# Candidate context\n\nBuilt internal web tools.", version: 1 };
  const offline = { state: "offline", host: null, lastHeartbeatAt: null };
  app.openapi(createRoute({
    method: "get", path: "/api/v1/jobs/overview",
    ...metadata({
      summary: "Read the Jobs overview", operationId: "getJobsOverview", output: jobsOverviewOutput,
      example: { waitingOnYou: 0, waitingOnRunner: 0, runner: offline, metrics: { applied: 0, approvalRate: 0, responseRate: 0, medianDaysToApply: null },
        pipeline: { drafted: 0, reviewed: 0, approved: 0, applied: 0 }, weekly: [], alignment: [] },
      permission: ["jobs:read"], credential: "owner", sideEffects: "none", retry: "safe read",
    }),
  }), c => respond(c, access => readJobsOverview(db, access.owner.id)));

  app.openapi(createRoute({
    method: "get", path: "/api/v1/jobs/submissions",
    ...metadata({
      summary: "Read the submissions queue and runner status", operationId: "getJobsSubmissions", output: jobsSubmissionsOutput,
      example: { runner: offline, items: [] }, permission: ["jobs:read"], credential: "owner", sideEffects: "none", retry: "safe read",
    }),
  }), c => respond(c, access => readJobsSubmissions(db, access.owner.id)));

  app.openapi(createRoute({
    method: "post", path: "/api/v1/jobs/submissions/{id}/resolve",
    ...metadata({
      summary: "Resolve a submission issue", operationId: "resolveJobSubmission", output: jobsResolveOutput,
      example: { submission: { id: exampleId, status: "applied", receipt: "confirmation_message" } },
      permission: ["jobs:write"], credential: "owner", sideEffects: "records manual confirmation or schedules the approved work",
      retry: "reuse the same Idempotency-Key and payload",
    }),
    request: { params: jobIdInput, headers: idempotencyHeader, body: body(jobsResolveInput, { action: "mark_applied" }) },
  }), c => respond(c, access => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    return idempotent(db, access, "resolveJobSubmission", c.req.valid("header")["idempotency-key"], { id, ...input }, async tx => {
      await resolveJobSubmission(tx, access.owner.id, id, input);
      const submission = await readJobSubmission(tx, access.owner.id, id);
      if (!submission) throw new JobsError(404, "Application not found.");
      return { submission };
    });
  }));
  app.openapi(createRoute({
    method: "get", path: "/api/v1/jobs/candidate-context",
    ...metadata({
      summary: "Read the non-sensitive candidate context", operationId: "getJobCandidateContext",
      output: candidateContextOutput, example: contextExample, permission: ["jobs:read"],
      sideEffects: "none; masked references are returned as text", retry: "safe read",
    }),
  }), c => respond(c, access => getCandidateContext(db, access.owner.id)));

  app.openapi(createRoute({
    method: "patch", path: "/api/v1/jobs/candidate-context",
    ...metadata({
      summary: "Save candidate context at an exact version", operationId: "patchJobCandidateContext",
      output: candidateContextOutput, example: contextExample, permission: ["jobs:write"], credential: "owner",
      sideEffects: "saves a new version of the non-sensitive document",
      retry: "reuse the exact payload after an uncertain response; on conflict, read the current document before trying again",
    }),
    request: { body: body(patchCandidateContextInput, { markdown: contextExample.markdown, expectedVersion: 0 }) },
  }), c => respond(c, access => patchCandidateContext(db, access.owner.id, c.req.valid("json"))));

  app.openapi(createRoute({
    method: "get", path: "/api/v1/jobs/applications",
    ...metadata({
      summary: "List applications with counts by status", operationId: "listJobApplications", output: jobsApplicationsOutput,
      example: { rows: [example], total: 1, pageSize: 15, tabCounts: { all: 1, progress: 1, review: 0, attention: 0, applied: 0, closed: 0 } },
      permission: ["jobs:read"], sideEffects: "none", retry: "safe read",
    }),
    request: { query: jobsApplicationsInput },
  }), c => respond(c, access => readJobsApplications(db, access.owner.id, c.req.valid("query"))));

  app.openapi(createRoute({
    method: "post", path: "/api/v1/jobs/applications",
    ...metadata({
      summary: "Add an application and queue background enrichment", operationId: "addJobApplication", output: jobsAddApplicationOutput,
      example: { application: { id: exampleId, company: example.company, status: "draft" }, duplicate: false },
      permission: ["jobs:write"], sideEffects: "creates one application per canonical posting and schedules enrichment",
      retry: "reuse the same Idempotency-Key and payload",
    }),
    request: {
      headers: idempotencyHeader,
      body: body(jobsAddApplicationInput, { company: example.company, role: example.role, sourceUrl: example.sourceUrl, track: "web", postingText: "Maintain product pages." }),
    },
  }), c => respond(c, access => {
    const input = c.req.valid("json");
    return idempotent(db, access, "addJobApplication", c.req.valid("header")["idempotency-key"], input,
      tx => addJobApplication(tx, access.owner.id, input, access.client.kind === "web"));
  }));

  app.openapi(createRoute({
    method: "post", path: "/api/v1/jobs/applications/import",
    ...metadata({
      summary: "Import a batch of postings for background enrichment", operationId: "importJobApplications",
      output: jobsImportApplicationsOutput, example: { imported: 1, duplicates: 0 }, permission: ["jobs:write", "jobs:import-tailored"],
      sideEffects: "creates one application per canonical posting or supplied Greenhouse identity and schedules enrichment. The import-only grant accepts drafts using the configured résumé templates", retry: "reuse the same Idempotency-Key and payload",
    }),
    request: { headers: idempotencyHeader, body: body(jobsImportApplicationsInput, {
      applications: [{ company: example.company, role: example.role, sourceUrl: example.sourceUrl, track: example.track, postingText: "Maintain product pages." }],
    }) },
  }), c => respond(c, access => {
    const input = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    if (!access.permissions.includes("jobs:write") &&
        input.applications.some(row => row.recordedStatus !== undefined || row.resumeMarkdown !== undefined)) {
      throw new JobsError(403, "The import-only permission accepts drafts using the configured résumé templates.");
    }
    const run = () => idempotent(db, access, "importJobApplications", key, input,
      tx => importJobsApplications(tx, access.owner.id, input.applications, access.client.kind === "web"));
    return run().catch(error => {
      if (error instanceof JobsProviderImportRace) return run();
      throw error;
    });
  }));

  app.openapi(createRoute({
    method: "get", path: "/api/v1/jobs/applications/export",
    ...metadata({
      summary: "Export matching application IDs or CSV fields", operationId: "exportJobApplications",
      output: jobsApplicationsExportOutput, example: { ids: [exampleId] }, permission: ["jobs:read"], credential: "owner",
      sideEffects: "none", retry: "safe read",
    }),
    request: { query: jobsApplicationsExportInput },
  }), c => respond(c, access => exportJobsApplications(db, access.owner.id, c.req.valid("query"))));

  app.openapi(createRoute({
    method: "post", path: jobApplicationAddressLookupPath,
    ...metadata({
      summary: "Resolve one exact Application Address to its application ID", operationId: "resolveJobApplicationByAddress",
      output: jobsApplicationAddressOutput, example: { id: exampleId },
      permission: ["jobs:read"], sideEffects: "none", retry: "safe read",
    }),
    request: { body: body(jobsApplicationAddressInput, { address: "luigi.k7mq@luigigirke.com" }) },
  }), c => respond(c, access => readJobApplicationId(db, access.owner.id, { applicationAddress: c.req.valid("json").address })));

  app.openapi(createRoute({
    method: "post", path: jobApplicationReplyLookupPath,
    ...metadata({
      summary: "Resolve an exact Application Address or recorded SES reply reference, requiring both to match when supplied",
      operationId: "resolveJobApplicationReply", output: jobsApplicationAddressOutput, example: { id: exampleId },
      permission: ["jobs:read"], sideEffects: "none", retry: "safe read",
    }),
    request: {
      body: body(jobsApplicationReplyInput, { address: "luigi.k7mq@luigigirke.com", inReplyTo: "<fixture-ses-id@email.amazonses.com>" }),
    },
  }), c => respond(c, access => {
    const input = c.req.valid("json");
    const evidence = "address" in input
      ? { applicationAddress: input.address, ...(input.inReplyTo !== undefined && { sesMessageId: input.inReplyTo }) }
      : { sesMessageId: input.inReplyTo };
    return readJobApplicationId(db, access.owner.id, evidence);
  }));

  app.openapi(createRoute({
    method: "get", path: "/api/v1/jobs/applications/reviewable",
    ...metadata({
      summary: "Find applications eligible for Jobs Review", operationId: "getJobReviewableIds",
      output: jobsReviewableOutput, example: { ids: [exampleId] }, permission: ["jobs:read"], credential: "owner",
      sideEffects: "none", retry: "safe read",
    }),
    request: { query: jobsReviewableInput },
  }), c => respond(c, access => readReviewableJobIds(db, access.owner.id, c.req.valid("query"))));

  app.openapi(createRoute({
    method: "get", path: "/api/v1/jobs/review-session",
    ...metadata({
      summary: "Read saved Jobs Review details in the requested order", operationId: "getJobReviewSession",
      output: jobsReviewSessionOutput, example: { items: [] }, permission: ["jobs:read"], credential: "owner",
      sideEffects: "none", retry: "safe read",
    }),
    request: { query: jobsReviewSessionInput },
  }), c => respond(c, access => readJobReviewSession(db, access.owner.id, c.req.valid("query").ids)));

  app.openapi(createRoute({
    method: "get", path: "/api/v1/jobs/applications/{id}",
    ...metadata({
      summary: "Read an application", operationId: "getJobApplication", output: jobsReviewApplicationOutput,
      example: { application: {
        id: exampleId, company: example.company, role: example.role, track: example.track, status: example.status,
        issue: null, verdict: null, dueAt: null, source: null, sourceUrl: example.sourceUrl, updatedAt: example.updatedAt,
        appliedAt: null, brief: null, postingText: "", revision: 1, approvedRevision: null, summaryMarkdown: "", resumeMarkdown: "", pdfUrl: null,
      } }, permission: ["jobs:read"], sideEffects: "none", retry: "safe read",
    }),
    request: { params: jobIdInput },
  }), c => respond(c, access => {
    const { id } = c.req.valid("param");
    return readJobReviewApplication(db, access.owner.id, id, access.client.kind === "web");
  }));

  const pdfMetadata = metadata({
    summary: "Open the current résumé PDF", operationId: "getJobResumePdf",
    output: z.string(), example: "", permission: ["jobs:read"], credential: "owner",
    sideEffects: "none", retry: "safe read",
  });
  const pdfResponse = { description: "Current résumé PDF", content: { "application/pdf": { schema: z.string().openapi({ format: "binary" }) } } };
  app.openapi(createRoute({
    method: "get", path: "/api/v1/jobs/applications/{id}/resume.pdf",
    ...pdfMetadata, responses: { ...pdfMetadata.responses, 200: pdfResponse, 206: pdfResponse },
    request: { params: jobIdInput, query: z.object({ revision: z.coerce.number().int().nonnegative().optional() }) },
  }), c => respond(c, async access => {
    const reference = await readJobPdfReference(db, access.owner.id, c.req.valid("param").id, c.req.valid("query").revision);
    try { return await openPdf(reference, c.req.header("Range")); }
    catch (cause) {
      if (cause instanceof OriginalStorageError) throw new JobsError(cause.status === 404 ? 404 : 503, "This résumé PDF is unavailable.");
      throw cause;
    }
  }));

  app.openapi(createRoute({
    method: "patch", path: "/api/v1/jobs/runner",
    ...metadata({
      summary: "Pause or unpause new Jobs submissions", operationId: "setJobsRunnerPaused", output: jobsRunnerOutput,
      example: { runner: { state: "paused", host: null, lastHeartbeatAt: null } }, permission: ["jobs:write"], credential: "owner",
      sideEffects: "gates new submit claims", retry: "reuse the same Idempotency-Key and payload",
    }),
    request: { headers: idempotencyHeader, body: body(jobsRunnerPauseInput, { paused: true }) },
  }), c => respond(c, access => {
    const input = c.req.valid("json");
    return idempotent(db, access, "setJobsRunnerPaused", c.req.valid("header")["idempotency-key"], input,
      tx => setJobsRunnerPaused(tx, access.owner.id, input.paused));
  }));

  app.openapi(createRoute({
    method: "post", path: "/api/v1/jobs/runner/pairing",
    ...metadata({
      summary: "Issue a Mac runner key", operationId: "pairJobsRunner", output: jobsRunnerPairingOutput,
      example: { key: `qs_runner_${"A".repeat(43)}` }, permission: ["jobs:write"], credential: "owner",
      sideEffects: "replaces the previous key issued here and returns the new key once",
      retry: "explicitly issue a replacement if the previous response was lost",
    }),
    request: { body: body(z.strictObject({}), {}) },
  }), c => respond(c, access => issueJobsRunnerKey(db, access.owner.id)));

  app.openapi(createRoute({
    method: "patch", path: "/api/v1/jobs/applications/{id}",
    ...metadata({
      summary: "Edit a saved résumé or update the post-application lifecycle", operationId: "patchJobApplication",
      output: z.union([jobsReviewPatchOutput, jobLifecycleOutput]), example: lifecycleExample, permission: ["jobs:write"],
      sideEffects: "saves a résumé revision or changes the lifecycle at its own revision. Agent edits return an auditId and support Owner Undo",
      retry: "reuse the same Idempotency-Key and payload",
    }),
    request: { params: jobIdInput, headers: idempotencyHeader,
      body: body(z.union([jobsReviewEditInput, jobLifecycleInput]), { expectedRevision: 1, summaryMarkdown: "- Web engineer with API experience." }) },
  }), c => respond(c, access => {
    const input = c.req.valid("json");
    const { id } = c.req.valid("param");
    const key = c.req.valid("header")["idempotency-key"];
    if ("status" in input) {
      return idempotent(db, access, "changeJobLifecycle", key, { id, ...input },
        tx => changeJobLifecycle(tx, access.owner.id, id, input, access.client));
    }
    return idempotent(db, access, "editJobReviewRevision", key, { id, ...input },
      tx => access.client.kind === "web" ? editJobReviewRevision(tx, access.owner.id, id, input)
        : editJobSummaryAsClient(tx, access.owner.id, id, input, access.client));
  }));

  app.openapi(createRoute({
    method: "patch", path: "/api/v1/jobs/applications/{id}/posting-details",
    ...metadata({
      summary: "Save a digest of the employer posting", operationId: "saveJobPostingDetails",
      output: jobIdInput, example: { id: exampleId }, permission: ["jobs:write"], credential: "owner",
      sideEffects: "updates the saved posting text without revising the résumé or changing the application status",
      retry: "reuse the same Idempotency-Key and payload",
    }),
    request: { params: jobIdInput, headers: idempotencyHeader, body: body(jobsPostingDetailsInput, {
      expectedRevision: 3, previousText: "Catalog role.", postingText: "Maintain the Shopify catalog.", sourceWordCount: 20,
    }) },
  }), c => respond(c, access => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    return idempotent(db, access, "saveJobPostingDetails", c.req.valid("header")["idempotency-key"],
      { id, ...input }, tx => saveJobPostingDetails(tx, access.owner.id, id, input));
  }));

  app.openapi(createRoute({
    method: "patch", path: "/api/v1/jobs/applications/{id}/brief",
    ...metadata({
      summary: "Save the missing brief on a draft in review", operationId: "saveMissingJobBrief",
      output: jobIdInput, example: { id: exampleId }, permission: ["jobs:write"], credential: "owner",
      sideEffects: "fills the brief of the current review revision without changing the résumé, review state or work queue",
      retry: "reuse the same Idempotency-Key and payload",
    }),
    request: {
      params: jobIdInput, headers: idempotencyHeader,
      body: body(jobsSaveBriefInput, { expectedRevision: 3, brief: {
        doing: "Maintain the product catalog.", remote: "confirmed",
        companySize: { people: null, label: "Company size not stated" },
        automatable: "medium", humanContact: { level: "low", note: "Written updates" },
        meetings: { level: "weekly", note: "Weekly planning" },
        pay: { hourlyCad: { min: 35, max: 45 }, original: "CAD 35–45 per hour", converted: false },
      } }),
    },
  }), c => respond(c, access => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    return idempotent(db, access, "saveMissingJobBrief", c.req.valid("header")["idempotency-key"], { id, ...input },
      tx => saveMissingJobBrief(tx, access.owner.id, id, input));
  }));

  app.openapi(createRoute({
    method: "post", path: "/api/v1/jobs/applications/{id}/decision",
    ...metadata({
      summary: "Record an Owner decision on an exact revision", operationId: "decideJobApplication", output: jobsReviewApprovalOutput,
      example: applicationExample, permission: ["jobs:write"], credential: "owner",
      sideEffects: "saves the Owner decision on the current revision and queues eligible work",
      retry: "reuse the same Idempotency-Key and payload",
    }),
    request: {
      params: jobIdInput, headers: idempotencyHeader,
      body: body(jobsOwnerDecision, { expectedRevision: 2, action: "approve" }),
    },
  }), c => respond(c, access => {
    const input = c.req.valid("json");
    const { id } = c.req.valid("param");
    return idempotent(db, access, "decideJobReview", c.req.valid("header")["idempotency-key"], { id, ...input },
      tx => decideJobReview(tx, access.owner.id, id, input));
  }));

  app.openapi(createRoute({
    method: "get", path: "/api/v1/jobs/private-fields",
    ...metadata({
      summary: "List masked private job fields", operationId: "listJobPrivateFields", output: privateFieldsOutput,
      example: { fields: [] }, permission: ["jobs:read"], credential: "owner",
      sideEffects: "none; returns field metadata and saved-state flags only",
      retry: "safe to repeat",
    }),
    request: { query: listPrivateFieldsInput },
  }), c => respond(c, access => listPrivateFields(db, access.owner.id, c.req.valid("query").applicationId)));

  app.openapi(createRoute({
    method: "post", path: "/api/v1/jobs/private-fields/values",
    ...metadata({
      summary: "Load exact private job fields for Owner editing", operationId: "listJobPrivateFieldValues",
      output: privateFieldValuesOutput, example: { fields: [] }, permission: ["jobs:read"], credential: "owner",
      sideEffects: "none. Returns exact saved values only to the Owner form",
      retry: "safe to repeat",
    }),
    request: { body: body(privateFieldValuesInput, {}) },
  }), c => respond(c, access => db.$transaction(
    tx => listPrivateFieldValues(tx, access.owner.id, c.req.valid("json").applicationId),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  )));

  app.openapi(createRoute({
    method: "patch", path: "/api/v1/jobs/private-fields",
    ...metadata({
      summary: "Save encrypted private job fields", operationId: "patchJobPrivateFields", output: patchPrivateFieldsOutput,
      example: { fields: [] }, permission: ["jobs:write"], credential: "owner",
      sideEffects: "encrypts matching-version fields, clears values on null, and requeues verified pauses when all requested details are saved",
      retry: "refresh metadata after a conflict and preserve unsaved input",
    }),
    request: { body: body(patchPrivateFieldsInput, { fields: [{ ...privateFieldExample, expectedVersion: null }] }) },
  }), c => respond(c, access => db.$transaction(
    tx => patchPrivateFields(tx, access.owner.id, c.req.valid("json").fields),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  )));

  app.openapi(createRoute({
    method: "post", path: "/api/v1/jobs/private-fields/requirements",
    ...metadata({
      summary: "Register missing private job field metadata", operationId: "registerJobPrivateRequirements",
      output: registerPrivateRequirementsOutput, example: { registered: 1 }, permission: ["jobs:write"], credential: "worker",
      sideEffects: "creates empty field metadata; existing fields and values are preserved",
      retry: "safe to repeat",
    }),
    request: { body: body(registerPrivateRequirementsInput, { fields: [privateFieldExample] }) },
  }), c => respond(c, access => db.$transaction(
    tx => registerPrivateRequirements(tx, access.owner.id, c.req.valid("json").fields),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  )));
}
