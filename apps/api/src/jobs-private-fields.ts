import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Prisma, type JobApplication, type JobPrivateField, type PrismaClient } from "@quantself/db/generated/prisma/client";
import {
  parseStoredFieldValue, renderIdentityKeys, validFieldValue, type FieldPatch, type FieldRequirement, type FieldScope,
  type FieldValue, type PrivateFieldMetadata,
} from "./jobs-private-fields-contract";
import { getCandidateContext } from "./jobs-candidate-context";
import { JobsError } from "./jobs-error";
import { approvedJobSnapshot, lockPrivateJobDetails, privatePauseSchema } from "./jobs-private-pause";

const perScopeLimit = 100;
const trackScopes = ["track:engineering", "track:web", "track:admin"] as const;
const personalKeys = new Set([...renderIdentityKeys, "fullName"]);
const applicantContactKeys = renderIdentityKeys.filter(key => key !== "email");
const metadataSelect = {
  id: true, scopeKey: true, key: true, label: true, type: true, options: true,
  hasValue: true, version: true, updatedAt: true,
} as const satisfies Prisma.JobPrivateFieldSelect;
type MetadataRow = Pick<JobPrivateField, keyof typeof metadataSelect>;
type CipherIdentity = Pick<JobPrivateField, "ownerId" | "scopeKey" | "key" | "type">;
const unavailable = () => new JobsError(503, "Private Jobs fields are unavailable.");
const conflict = () => new JobsError(409, "Private Jobs fields changed. Refresh before trying again.");
const missingApplication = () => new JobsError(404, "Job application not found.");

function scopeKey(scope: FieldScope) {
  if (scope.kind === "track") return `track:${scope.track}`;
  if (scope.kind === "listing") return `listing:${scope.applicationId}`;
  return "global";
}

function scopeFor(key: string): FieldScope {
  if (key === "global") return { kind: "global" };
  if (key.startsWith("listing:")) return { kind: "listing", applicationId: key.slice("listing:".length) };
  switch (key) {
    case "track:engineering": return { kind: "track", track: "engineering" };
    case "track:web": return { kind: "track", track: "web" };
    case "track:admin": return { kind: "track", track: "admin" };
    default: throw unavailable();
  }
}

function metadata(row: MetadataRow): PrivateFieldMetadata {
  const { scopeKey, updatedAt, id, key, label, type, options, hasValue, version } = row;
  return { id, key, label, type, scope: scopeFor(scopeKey), options, hasValue, version, updatedAt: updatedAt.toISOString() };
}

async function loadEncryptionKey(): Promise<Buffer> {
  const envKey = process.env.QUANTSELF_JOBS_PRIVATE_FIELDS_KEY;
  if (envKey !== undefined) {
    const key = Buffer.from(envKey, "base64url");
    if (key.length !== 32 || key.toString("base64url") !== envKey) throw unavailable();
    return key;
  }
  if (process.env.NODE_ENV === "production") throw unavailable();
  const directory = process.env.QUANTSELF_JOBS_HOME || join(homedir(), ".local/share/quantself/jobs");
  try {
    const handle = await open(join(directory, "private-fields.key"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== 32 || (stat.mode & 0o777) !== 0o600 ||
        (process.getuid && stat.uid !== process.getuid())) throw unavailable();
      const buffer = Buffer.alloc(32);
      const read = await handle.read(buffer);
      if (read.bytesRead !== 32) throw unavailable();
      return buffer;
    } finally { await handle.close(); }
  } catch { throw unavailable(); }
}

const aad = (row: CipherIdentity) => Buffer.from(JSON.stringify([row.ownerId, row.scopeKey, row.key, row.type]));

function encrypt(key: Buffer, row: CipherIdentity, value: FieldValue) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(row));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), bytes.toString("base64url")].join(".");
}

function decrypt(key: Buffer, row: CipherIdentity & { ciphertext: string | null; options: string[] }) {
  try {
    if (!row.ciphertext || row.ciphertext.length > 32_000) throw unavailable();
    const [version, nonce, tag, bytes, extra] = row.ciphertext.split(".");
    if (version !== "v1" || !nonce || !tag || !bytes || extra !== undefined) throw unavailable();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"), { authTagLength: 16 });
    decipher.setAAD(aad(row));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(bytes, "base64url")), decipher.final()]);
    const value = parseStoredFieldValue(row.type, JSON.parse(plaintext.toString("utf8")), row.options);
    if (value === undefined) throw unavailable();
    return value;
  } catch { throw unavailable(); }
}

async function privateFieldScopes(db: Pick<PrismaClient, "jobApplication">, ownerId: string, applicationId?: string) {
  if (!applicationId) return ["global", ...trackScopes];
  const application = await db.jobApplication.findUnique({
    where: { ownerId_id: { ownerId, id: applicationId } }, select: { resumeTrack: true },
  });
  if (!application) throw missingApplication();
  return ["global", `track:${application.resumeTrack}`, `listing:${applicationId}`];
}

export async function listPrivateFields(db: PrismaClient, ownerId: string, applicationId?: string) {
  const scopes = await privateFieldScopes(db, ownerId, applicationId);
  const rows = await db.jobPrivateField.findMany({
    where: { ownerId, scopeKey: { in: scopes } }, select: metadataSelect,
    orderBy: [{ scopeKey: "asc" }, { key: "asc" }], take: scopes.length * perScopeLimit,
  });
  return { fields: rows.map(metadata) };
}

export async function listPrivateFieldValues(tx: Prisma.TransactionClient, ownerId: string, applicationId?: string) {
  const scopes = await privateFieldScopes(tx, ownerId, applicationId);
  const rows = await tx.jobPrivateField.findMany({
    where: { ownerId, scopeKey: { in: scopes } },
    select: { ...metadataSelect, ownerId: true, ciphertext: true },
    orderBy: [{ scopeKey: "asc" }, { key: "asc" }], take: scopes.length * perScopeLimit,
  });
  const encryptionKey = rows.some(row => row.hasValue) ? await loadEncryptionKey() : undefined;
  try {
    return { fields: rows.map(row => ({ ...metadata(row), value: row.hasValue ? decrypt(encryptionKey!, row) : null })) };
  } finally { encryptionKey?.fill(0); }
}

type Target = { scopeKey: string; key: string };
const idFor = (target: Target) => JSON.stringify([target.scopeKey, target.key]);

function targetsFor(fields: FieldRequirement[]) {
  const targets = fields.map(field => ({ scopeKey: scopeKey(field.scope), key: field.key }));
  if (new Set(targets.map(idFor)).size !== targets.length) throw new JobsError(400, "A private field appears more than once.");
  for (const field of fields) {
    if (personalKeys.has(field.key)) {
      const type = field.key === "email" ? "email" : field.key === "phone" ? "phone" :
        ["linkedin", "website"].includes(field.key) ? "url" : "text";
      if (field.type !== type) throw new JobsError(400, "A personal alias must match its field type.");
    }
    if (!field.key.startsWith("question.")) continue;
    const key = "question." + createHash("sha256").update(field.label.normalize("NFKC").trim().replace(/\s+/gu, " ")).digest("hex");
    if (field.scope.kind !== "listing" || field.key !== key) throw new JobsError(400, "A private screening question must match its listing and label.");
  }
  return targets;
}

async function countScopes(tx: Prisma.TransactionClient, ownerId: string, targets: Target[]) {
  const scopes = [...new Set(targets.map(target => target.scopeKey))];
  const listingIds = scopes.filter(key => key.startsWith("listing:")).map(key => key.slice("listing:".length));
  const [counts, listings] = await Promise.all([
    tx.jobPrivateField.groupBy({ by: ["scopeKey"], where: { ownerId, scopeKey: { in: scopes } }, _count: { _all: true } }),
    listingIds.length ? tx.jobApplication.count({ where: { ownerId, id: { in: listingIds } } }) : 0,
  ]);
  if (listings !== listingIds.length) throw missingApplication();
  return new Map(counts.map(row => [row.scopeKey, row._count._all]));
}

function addToScope(counts: Map<string, number>, key: string) {
  const count = (counts.get(key) ?? 0) + 1;
  if (count > perScopeLimit) throw new JobsError(400, "This private field scope is full.");
  counts.set(key, count);
}

const supportsOptions = (type: FieldRequirement["type"]) => type === "option" || type === "options";

export async function registerPrivateRequirements(tx: Prisma.TransactionClient, ownerId: string, fields: FieldRequirement[]) {
  await lockPrivateJobDetails(tx, ownerId);
  return registerRequirements(tx, ownerId, fields);
}

async function registerRequirements(tx: Prisma.TransactionClient, ownerId: string, fields: FieldRequirement[]) {
  const targets = targetsFor(fields);
  if (fields.some(field => (!personalKeys.has(field.key) && !field.key.startsWith("question.")) ||
      (!supportsOptions(field.type) && field.options?.length))) {
    throw new JobsError(400, "Invalid private field requirement.");
  }
  const [existing, counts] = await Promise.all([
    tx.jobPrivateField.findMany({ where: { ownerId, OR: targets }, select: { scopeKey: true, key: true } }),
    countScopes(tx, ownerId, targets),
  ]);
  const known = new Set(existing.map(idFor));
  const rows = fields.flatMap((field, index) => {
    const target = targets[index];
    if (known.has(idFor(target))) return [];
    addToScope(counts, target.scopeKey);
    return [{ ownerId, ...target, label: field.label, type: field.type, options: field.options ?? [] }];
  });
  if (!rows.length) return { registered: 0 };
  const result = await tx.jobPrivateField.createMany({ data: rows, skipDuplicates: true });
  return { registered: result.count };
}

export async function patchPrivateFields(tx: Prisma.TransactionClient, ownerId: string, fields: FieldPatch[], now = new Date()) {
  await lockPrivateJobDetails(tx, ownerId);
  const targets = targetsFor(fields);
  const [existing, scopeCounts] = await Promise.all([
    tx.jobPrivateField.findMany({ where: { ownerId, OR: targets }, select: { ...metadataSelect, ciphertext: true } }),
    countScopes(tx, ownerId, targets),
  ]);
  const prior = new Map(existing.map(row => [idFor(row), row]));
  const encryptionKey = fields.some(field => field.value !== undefined && field.value !== null) ? await loadEncryptionKey() : undefined;
  const values = fields.map((field, index) => {
    const target = targets[index];
    const previous = prior.get(idFor(target));
    if ((previous?.version ?? null) !== field.expectedVersion) throw conflict();
    if (!previous) addToScope(scopeCounts, target.scopeKey);
    const options = field.options ?? previous?.options ?? [];
    const invalidPersonalPhone = field.key === "phone" && typeof field.value === "string" &&
      (!/^\+?[0-9 ().-]+$/.test(field.value) || !/^\d{10,15}$/.test(field.value.replace(/\D/g, "")));
    if (invalidPersonalPhone) {
      throw new JobsError(400, "Use a number like +1 902 555 0123.");
    }
    if ((!supportsOptions(field.type) && options.length) ||
      (field.value != null && (!validFieldValue(field.type, field.value, options) ||
        (Array.isArray(field.value) && field.value.length === 0) ||
        (personalKeys.has(field.key) && field.type === "text" &&
          (typeof field.value !== "string" || field.value.length > 255 || /[\r\n\t]/.test(field.value)))))) {
      throw new JobsError(400, "A private field has an invalid value or options.");
    }
    if (previous?.hasValue && field.value === undefined &&
      (previous.type !== field.type || JSON.stringify(previous.options) !== JSON.stringify(options))) {
      throw new JobsError(400, "Supply a new value when changing a saved field’s type or options.");
    }
    const identity = { ownerId, ...target, type: field.type };
    const ciphertext = field.value === undefined ? (previous?.ciphertext ?? null)
      : field.value === null ? null : encrypt(encryptionKey!, identity, field.value);
    const optionsSql = options.length ? Prisma.sql`ARRAY[${Prisma.join(options)}]::text[]` : Prisma.sql`ARRAY[]::text[]`;
    return Prisma.sql`(${ownerId}, ${randomUUID()}, ${target.scopeKey}, ${target.key}, ${field.label},
      ${field.type}::"JobPrivateFieldType", ${optionsSql}, ${ciphertext}, ${ciphertext !== null}::boolean, ${(field.expectedVersion ?? 0) + 1}::int, ${now}::timestamp(3))`;
  });
  const rows = await tx.$queryRaw<MetadataRow[]>`
    INSERT INTO "job_private_field" ("ownerId", "id", "scopeKey", "key", "label", "type", "options", "ciphertext", "hasValue", "version", "updatedAt", "valueAddedAt")
    SELECT incoming.*, CASE WHEN incoming."hasValue" THEN incoming."updatedAt" END
    FROM (VALUES ${Prisma.join(values)}) AS incoming(
      "ownerId", "id", "scopeKey", "key", "label", "type", "options", "ciphertext", "hasValue", "version", "updatedAt"
    )
    ON CONFLICT ("ownerId", "scopeKey", "key") DO UPDATE SET
      "label" = EXCLUDED."label", "type" = EXCLUDED."type", "options" = EXCLUDED."options",
      "ciphertext" = EXCLUDED."ciphertext", "hasValue" = EXCLUDED."hasValue",
      "version" = EXCLUDED."version", "updatedAt" = EXCLUDED."updatedAt",
      "valueAddedAt" = CASE
        WHEN NOT EXCLUDED."hasValue" THEN NULL
        WHEN "job_private_field"."hasValue" THEN "job_private_field"."valueAddedAt"
        ELSE EXCLUDED."valueAddedAt"
      END
    WHERE "job_private_field"."version" = EXCLUDED."version" - 1
    RETURNING "id", "scopeKey", "key", "label", "type", "options", "hasValue", "version", "updatedAt"
  `;
  if (rows.length !== fields.length) throw conflict();
  const saved = new Map(rows.map(row => [idFor(row), row]));
  const newlyAnswered = rows.filter(row => row.hasValue && !prior.get(idFor(row))?.hasValue);
  const resumedApplicationIds = newlyAnswered.length ? await resumePrivatePauses(tx, ownerId, newlyAnswered) : [];
  return { fields: targets.map(target => metadata(saved.get(idFor(target))!)),
    ...(resumedApplicationIds.length ? { resumedApplicationIds } : {}) };
}

type PauseJob = Pick<JobApplication, "id" | "resumeTrack" | "summary" | "sourceUrl" | "company" | "role" | "resumeMarkdown">;
type PauseField = Target & { type: FieldRequirement["type"]; options: string[]; hasValue: boolean };

function applies(job: PauseJob, target: Target) {
  return ["global", `track:${job.resumeTrack}`, `listing:${job.id}`].includes(target.scopeKey);
}

function fieldMatches(row: PauseField | undefined, field: FieldRequirement) {
  return row?.type === field.type && JSON.stringify(row.options) === JSON.stringify(field.options ?? []);
}

// Do not turn legal sign-off, privacy agreements or identity challenges into saved facts.
const personalConsent = /\b(?:i (?:agree|consent|accept|certify|acknowledge|attest|hereby)|(?:accept|agree to|acknowledge) (?:the|our|this)|electronic signature|privacy (?:policy|notice|agreement)|terms (?:and conditions|of (?:use|service))|captcha)\b/iu;

export async function preparePrivatePause(
  tx: Prisma.TransactionClient, ownerId: string, job: PauseJob, fields: FieldRequirement[],
  approvalRevision: number, previewDigest: string | null, claimStartedAt: Date,
) {
  const targets = targetsFor(fields);
  if (fields.some((field, index) => {
    if (!applies(job, targets[index])) return true;
    if (personalKeys.has(field.key)) return !!previewDigest && renderIdentityKeys.includes(field.key);
    return !field.key.startsWith("question.") || personalConsent.test(field.label);
  })) return;
  const scopeKeys = ["global", `track:${job.resumeTrack}`, `listing:${job.id}`];
  const existing = await tx.jobPrivateField.findMany({
    where: { ownerId, scopeKey: { in: scopeKeys }, key: { in: fields.map(field => field.key) } },
    select: { key: true, scopeKey: true, hasValue: true, type: true, options: true, valueAddedAt: true },
  });
  const byTarget = new Map(existing.map(row => [idFor(row), row]));
  const keys = targets.map(idFor);
  const requiredTargets = new Set(keys);
  // An Owner save can arrive before the runner's result. Count only exact
  // answers first added during this claim, not edits to existing values.
  if (existing.some(row => row.hasValue && (!requiredTargets.has(idFor(row)) ||
      !row.valueAddedAt || row.valueAddedAt < claimStartedAt)) || fields.some((field, index) => {
    const row = byTarget.get(keys[index]);
    return row !== undefined && !fieldMatches(row, field);
  })) return;
  const ready = keys.every(key => byTarget.get(key)?.hasValue);
  if (!ready) await registerRequirements(tx, ownerId, fields);
  return {
    ready,
    pause: { approvalRevision, previewDigest, snapshot: approvedJobSnapshot(job), fields, keys },
  };
}

async function resumePrivatePauses(tx: Prisma.TransactionClient, ownerId: string, newlyAnswered: Target[]) {
  const touched = new Set(newlyAnswered.map(idFor));
  const pauses = await tx.jobApplication.findMany({
    where: { ownerId, status: "needs_attention", issueCode: "manual_required", approvedRevision: { not: null },
      OR: [...touched].map(key => ({ privatePause: { path: ["keys"], array_contains: [key] } })),
    },
    select: {
      id: true, revision: true, approvedRevision: true, privatePause: true,
      resumeTrack: true, summary: true, company: true, role: true, sourceUrl: true, resumeMarkdown: true,
    },
  });
  const candidates = pauses.flatMap(job => {
    const parsed = privatePauseSchema.safeParse(job.privatePause);
    if (!parsed.success || parsed.data.approvalRevision !== job.approvedRevision ||
        parsed.data.snapshot !== approvedJobSnapshot(job) || !parsed.data.keys.some(key => touched.has(key))) return [];
    return [{ job, pause: parsed.data, targets: targetsFor(parsed.data.fields) }];
  });
  if (!candidates.length) return [];
  const allTargets = new Map(candidates.flatMap(({ targets }) => targets.map(target => [idFor(target), target] as const)));
  const fields = await tx.jobPrivateField.findMany({
    where: { ownerId, OR: [...allTargets.values()], hasValue: true },
    select: { key: true, scopeKey: true, hasValue: true, type: true, options: true },
  });
  const byTarget = new Map(fields.map(row => [idFor(row), row]));
  const ready = candidates.filter(({ pause, targets }) => targets.every((target, index) =>
    fieldMatches(byTarget.get(idFor(target)), pause.fields[index])));
  const resumable = ready.filter(({ job, pause }) => pause.previewDigest && job.revision === pause.approvalRevision);
  const pins = resumable.map(({ job, pause }) => Prisma.sql`(${job.id}::text, ${job.revision}::int, ${pause.previewDigest}::text)`);
  const resumed = resumable.length ? await tx.$queryRaw<Array<{ id: string; revision: number; workId: string; attempt: number }>>`
    WITH eligible AS (
      SELECT job.id, job.revision
      FROM job_application AS job
      JOIN (VALUES ${Prisma.join(pins)}) AS pause(id, revision, digest)
        ON job.id = pause.id AND job.revision = pause.revision
      JOIN job_revision AS saved
        ON saved."ownerId" = job."ownerId" AND saved."applicationId" = job.id AND saved.revision = job.revision
      WHERE job."ownerId" = ${ownerId} AND job.status = 'needs_attention'
        AND job."issueCode" = 'manual_required' AND job."approvedRevision" = job.revision
        AND job."approvedPreviewDigest" = pause.digest AND saved."pdfSha256" = pause.digest AND saved."pdfReference" IS NOT NULL
      ORDER BY job.id FOR UPDATE OF job
    ), queued_work AS (
      UPDATE job_work_item AS work
      SET state = 'queued', "availableAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP,
          "claimedBy" = NULL, "leaseTokenHash" = NULL, "leaseUntil" = NULL, "failureCode" = NULL
      FROM eligible
      WHERE work."ownerId" = ${ownerId} AND work."applicationId" = eligible.id AND work.revision = eligible.revision
        AND work.kind = 'submit' AND work.state = 'failed' AND work."failureCode" = 'manual_required'
      RETURNING work."applicationId", work.revision, work.id, work.attempts
    )
    UPDATE job_application AS job
    SET status = 'queued', "issueCode" = NULL, "privatePause" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP, "lastOwnerEditedAt" = CURRENT_TIMESTAMP
    FROM queued_work
    WHERE job."ownerId" = ${ownerId} AND job.id = queued_work."applicationId"
    RETURNING job.id, job.revision, queued_work.id AS "workId", queued_work.attempts AS attempt
  ` : [];
  if (resumed.length) await tx.jobEvent.createMany({ data: resumed.map(({ id, revision, workId, attempt }) => ({
    ownerId, applicationId: id, revision, kind: "private_details_resumed", payload: { workId, attempt },
  })) });
  return resumed.map(row => row.id);
}

export async function readRunnerJobFields(tx: Prisma.TransactionClient, ownerId: string,
  application: { id: string; resumeTrack: string; applicationAddress: string }, kind: "render" | "submit") {
  const [fields, candidateContext] = await Promise.all([
    effectiveFields(tx, ownerId, application, kind === "render" ? applicantContactKeys : undefined, "email"),
    kind === "render" ? { markdown: "", version: 0 } : getCandidateContext(tx, ownerId),
  ]);
  return { fields: [...fields, {
    key: "email", label: "Application Address", type: "email" as const,
    scope: { kind: "listing" as const, applicationId: application.id }, value: application.applicationAddress,
  }], candidateContext };
}

async function effectiveFields(
  tx: Prisma.TransactionClient, ownerId: string, application: { id: string; resumeTrack: string }, keys?: string[], excludeKey?: string,
) {
  const scopeKeys = ["global", `track:${application.resumeTrack}`, `listing:${application.id}`];
  const rows = await tx.jobPrivateField.findMany({
    where: { ownerId, scopeKey: { in: scopeKeys }, hasValue: true, ...(keys ? { key: { in: keys } } : excludeKey ? { key: { not: excludeKey } } : {}) },
    select: { ownerId: true, scopeKey: true, key: true, label: true, type: true, options: true, ciphertext: true },
    orderBy: { key: "asc" }, take: scopeKeys.length * perScopeLimit,
  });
  if (!rows.length) return [];
  const fields = new Map<string, typeof rows[number]>();
  rows.sort((a, b) => scopeKeys.indexOf(a.scopeKey) - scopeKeys.indexOf(b.scopeKey));
  for (const row of rows) fields.set(row.key, row);
  const encryptionKey = await loadEncryptionKey();
  try {
    return [...fields.values()].map(row => ({
      key: row.key, label: row.label, type: row.type, scope: scopeFor(row.scopeKey), value: decrypt(encryptionKey, row),
    }));
  } finally { encryptionKey.fill(0); }
}
