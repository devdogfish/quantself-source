import {
  INVENTORY_ACQUISITION_SOURCE_VALUES,
  INVENTORY_CATEGORY_VALUES,
  INVENTORY_IMPORTANCE_VALUES,
  INVENTORY_ITEM_STATUSES,
  normalizeInventoryAcquisitionSource,
  normalizeInventoryCategory,
  readInventoryItemManualFieldLocks,
  type InventoryItemRecord,
} from "./inventory-service";
import type {
  InventoryPreprocessingJobRecord,
  InventoryTextBundle,
} from "./inventory-preprocessing-service";

export const INVENTORY_ENRICHMENT_JOB_KINDS = [
  "INVENTORY_ITEM_ENRICHMENT",
  "INVENTORY_ITEM_IMAGE_ENRICHMENT",
] as const;

export const INVENTORY_ENRICHMENT_JOB_STATUSES = [
  "QUEUED",
  "CLAIMED",
  "PENDING_APPROVAL",
  "APPLIED",
  "REJECTED",
  "FAILED",
  "CANCELLED",
] as const;

export type InventoryEnrichmentJobKind =
  (typeof INVENTORY_ENRICHMENT_JOB_KINDS)[number];
export type InventoryEnrichmentJobStatus =
  (typeof INVENTORY_ENRICHMENT_JOB_STATUSES)[number];

export type InventoryEnrichmentJobTarget = {
  itemId: string;
  imageId: string | null;
  kind: "ITEM" | "IMAGE";
};

export type InventoryEnrichmentSnapshotItem = {
  id: string;
  kind: InventoryItemRecord["kind"];
  title: string | null;
  note: string | null;
  captureText?: string | null;
  status: InventoryItemRecord["status"];
  importance: InventoryItemRecord["importance"];
  originLocationName: string | null;
  locationName: string | null;
  containerLabel: string | null;
  capturedAt: string;
};

export type InventoryEnrichmentSnapshotMetadata = {
  aliases: string[];
  category: InventoryItemRecord["category"];
  metadata: Record<string, unknown>;
  searchText: string;
  tags: string[];
};

export type InventoryEnrichmentSnapshotImage = {
  id: string | null;
  originalName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  caption: string | null;
  ocrText: string | null;
  mediaUrl: string | null;
};

export type InventoryEnrichmentLegacyInputSnapshot = {
  schemaVersion: 1;
  sourceFingerprint: string;
  target: InventoryEnrichmentJobTarget;
  item: InventoryEnrichmentSnapshotItem;
  deterministicMetadata: InventoryEnrichmentSnapshotMetadata;
  images: InventoryEnrichmentSnapshotImage[];
};

export type InventoryEnrichmentTextBundleSnapshot = {
  schemaVersion: 1;
  sourceFingerprint: string;
  target: {
    itemId: string;
    imageId: null;
    kind: "ITEM";
  };
  textBundle: InventoryTextBundle;
};

export type InventoryEnrichmentInputSnapshot =
  | InventoryEnrichmentLegacyInputSnapshot
  | InventoryEnrichmentTextBundleSnapshot;

type InventoryEnrichmentLegacySnapshotWithoutFingerprint = Omit<
  InventoryEnrichmentLegacyInputSnapshot,
  "sourceFingerprint"
>;
type InventoryEnrichmentTextBundleSnapshotWithoutFingerprint = Omit<
  InventoryEnrichmentTextBundleSnapshot,
  "sourceFingerprint"
>;

export type InventoryEnrichmentResultPayload = {
  aliases: string[];
  acquisitionSource: InventoryItemRecord["acquisitionSource"];
  category: InventoryItemRecord["category"];
  costCents: InventoryItemRecord["costCents"];
  imageCaption: string | null;
  imageOcrText: string | null;
  importance: InventoryItemRecord["importance"] | null;
  metadata: Record<string, unknown> | null;
  note: string | null;
  searchTextAdditions: string[];
  status: InventoryItemRecord["status"] | null;
  tags: string[];
  title: string | null;
};

export type InventoryEnrichmentFailureDetail = {
  attempt: number;
  failedAt: string;
  leaseClaimedAt: string;
  message: string;
  retryable: boolean;
};

export interface InventoryEnrichmentJobRecord {
  id: string;
  kind: InventoryEnrichmentJobKind;
  targetItemId: string;
  targetImageId: string | null;
  status: InventoryEnrichmentJobStatus;
  attempts: number;
  maxAttempts: number;
  claimedBy: string | null;
  claimedAt: Date | null;
  leaseExpiresAt: Date | null;
  inputSnapshot: InventoryEnrichmentInputSnapshot;
  inputFingerprint: string;
  resultPayload: InventoryEnrichmentResultPayload | null;
  resultId: string | null;
  failureDetail: InventoryEnrichmentFailureDetail | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type InventoryEnrichmentNewJobRecord = Omit<
  InventoryEnrichmentJobRecord,
  "id" | "status" | "attempts" | "createdAt" | "updatedAt"
>;

export interface InventoryEnrichmentSettingsRecord {
  approvalsRequired: boolean;
  updatedAt: Date;
}

export type InventoryEnrichmentDiffEntry = {
  field: string;
  before: unknown;
  after: unknown;
};

export type InventoryEnrichmentProposal = {
  job: InventoryEnrichmentJobRecord;
  diff: InventoryEnrichmentDiffEntry[];
};

export interface InventoryEnrichmentRepository {
  enqueueInventoryEnrichmentJobs(
    jobs: InventoryEnrichmentNewJobRecord[],
  ): Promise<InventoryEnrichmentJobRecord[]>;
  listClaimableInventoryEnrichmentJobs(input: {
    limit: number;
    now: Date;
  }): Promise<InventoryEnrichmentJobRecord[]>;
  listInventoryEnrichmentJobs(input?: {
    status?: InventoryEnrichmentJobStatus;
    limit?: number;
    targetItemId?: string;
  }): Promise<InventoryEnrichmentJobRecord[]>;
  updateInventoryEnrichmentJob(
    job: InventoryEnrichmentJobRecord,
  ): Promise<InventoryEnrichmentJobRecord>;
  getInventoryEnrichmentJob(
    id: string,
  ): Promise<InventoryEnrichmentJobRecord | null>;
  getInventoryEnrichmentSettings(): Promise<InventoryEnrichmentSettingsRecord>;
  updateInventoryEnrichmentSettings(
    settings: InventoryEnrichmentSettingsRecord,
  ): Promise<InventoryEnrichmentSettingsRecord>;
  getInventoryItem(id: string): Promise<InventoryItemRecord | null>;
  applyInventoryItemEnrichment(input: {
    itemId: string;
    title: string | null;
    note: string | null;
    status: InventoryItemRecord["status"];
    importance: InventoryItemRecord["importance"];
    acquisitionSource: InventoryItemRecord["acquisitionSource"];
    category: InventoryItemRecord["category"];
    costCents: InventoryItemRecord["costCents"];
    tags: string[];
    aliases: string[];
    searchText: string;
    metadata: Record<string, unknown>;
  }): Promise<InventoryItemRecord>;
  applyInventoryImageEnrichment(input: {
    itemId: string;
    imageId: string;
    caption: string | null;
    ocrText: string | null;
    metadata: Record<string, unknown> | null;
  }): Promise<void>;
}

export type InventoryEnrichmentQueueRepository = Pick<
  InventoryEnrichmentRepository,
  "enqueueInventoryEnrichmentJobs"
>;

export interface InventoryEnrichmentRetryRepository
  extends InventoryEnrichmentQueueRepository {
  getInventoryItem(id: string): Promise<InventoryItemRecord | null>;
  listInventoryEnrichmentJobs(input?: {
    status?: InventoryEnrichmentJobStatus;
    limit?: number;
    targetItemId?: string;
  }): Promise<InventoryEnrichmentJobRecord[]>;
  listInventoryPreprocessingJobs(input?: {
    limit?: number;
    targetItemId?: string;
  }): Promise<InventoryPreprocessingJobRecord[]>;
}

export class InventoryEnrichmentRetryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryEnrichmentRetryConflictError";
  }
}

export class InventoryEnrichmentRetryNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryEnrichmentRetryNotAllowedError";
  }
}

const DEFAULT_MAX_ATTEMPTS = 3;
const ENRICHMENT_METADATA_SCHEMA_VERSION = 1;
const ALLOWED_ENRICHMENT_RESULT_KEYS = new Set([
  "aliases",
  "acquisitionSource",
  "category",
  "costCents",
  "imageCaption",
  "imageOcrText",
  "importance",
  "metadata",
  "note",
  "searchTextAdditions",
  "status",
  "tags",
  "title",
]);
const ITEM_ENRICHMENT_RESULT_KEYS = new Set([
  "aliases",
  "acquisitionSource",
  "category",
  "costCents",
  "importance",
  "metadata",
  "note",
  "searchTextAdditions",
  "status",
  "tags",
  "title",
]);
const IMAGE_ENRICHMENT_RESULT_KEYS = new Set([
  "imageCaption",
  "imageOcrText",
  "metadata",
]);
const TEXT_BUNDLE_ALLOWED_KEYS = new Set([
  "schemaVersion",
  "item",
  "captureText",
  "mediaTexts",
  "failedSteps",
  "sourceRefs",
]);
const TEXT_BUNDLE_ITEM_ALLOWED_KEYS = new Set([
  "id",
  "title",
  "note",
  "kind",
  "status",
  "importance",
  "containerLabel",
  "containerLocation",
]);
const TEXT_BUNDLE_MEDIA_TEXT_ALLOWED_KEYS = new Set([
  "mediaId",
  "type",
  "ocrText",
  "ocrLines",
  "transcript",
  "transcriptSegments",
  "provider",
  "providerModel",
  "providerJobId",
  "sourceMetadata",
]);
const TEXT_BUNDLE_TRANSCRIPT_SEGMENT_ALLOWED_KEYS = new Set([
  "start",
  "end",
  "text",
]);
const TEXT_BUNDLE_FAILED_STEP_ALLOWED_KEYS = new Set([
  "mediaId",
  "step",
  "code",
  "message",
  "retryable",
]);
const TEXT_BUNDLE_SOURCE_REF_ALLOWED_KEYS = new Set(["kind", "id"]);
const UNSAFE_PROMPT_KEY_FRAGMENTS = [
  "authorization",
  "header",
  "secret",
  "token",
  "url",
];
const BEARER_TOKEN_PATTERN = /\bbearer\s+\S+/i;
const LOCAL_STORAGE_PATH_PATTERN = /\bstorage\/inventory-(?:audio|images)\//i;
const LOCAL_FILE_URI_PATTERN = /\bfile:\/\/\S+/i;
const ABSOLUTE_FILE_PATH_PATTERN =
  /(?:^|[\s"'`])(?:\/(?:home|tmp|var|Users)\/\S+|[A-Za-z]:\\\S+)/;
const COMPLETED_ENRICHMENT_JOB_STATUSES = new Set<InventoryEnrichmentJobStatus>(
  ["APPLIED", "REJECTED", "FAILED", "CANCELLED"],
);

class InventoryEnrichmentStaleInputError extends Error {
  constructor() {
    super("Inventory enrichment result is stale for current inventory input.");
    this.name = "InventoryEnrichmentStaleInputError";
  }
}

export function isInventoryEnrichmentRepository(
  repository: unknown,
): repository is InventoryEnrichmentRepository {
  return (
    repository !== null &&
    typeof repository === "object" &&
    "enqueueInventoryEnrichmentJobs" in repository &&
    "listClaimableInventoryEnrichmentJobs" in repository &&
    "updateInventoryEnrichmentJob" in repository &&
    "getInventoryEnrichmentSettings" in repository
  );
}

export async function queueInventoryEnrichmentCapture(
  repository: InventoryEnrichmentRepository,
  item: InventoryItemRecord,
): Promise<InventoryEnrichmentJobRecord[]> {
  const itemSnapshot = buildInventoryEnrichmentSnapshot(item, {
    imageId: null,
    kind: "ITEM",
  });
  const imageSnapshots = item.images
    .filter((image) => image.id)
    .map((image) =>
      buildInventoryEnrichmentSnapshot(item, {
        imageId: image.id ?? null,
        kind: "IMAGE",
      }),
    );

  return repository.enqueueInventoryEnrichmentJobs([
    buildInventoryEnrichmentJobInput("INVENTORY_ITEM_ENRICHMENT", itemSnapshot),
    ...imageSnapshots.map((snapshot) =>
      buildInventoryEnrichmentJobInput(
        "INVENTORY_ITEM_IMAGE_ENRICHMENT",
        snapshot,
      ),
    ),
  ]);
}

export async function queueInventoryEnrichmentTextBundle(
  repository: InventoryEnrichmentQueueRepository,
  item: InventoryItemRecord,
  textBundle: InventoryTextBundle,
): Promise<InventoryEnrichmentJobRecord[]> {
  return repository.enqueueInventoryEnrichmentJobs([
    buildInventoryEnrichmentTextBundleJobInput(item, textBundle),
  ]);
}

export function buildInventoryEnrichmentTextBundleJobInput(
  item: InventoryItemRecord,
  textBundle: InventoryTextBundle,
): InventoryEnrichmentNewJobRecord {
  return buildInventoryEnrichmentJobInput(
    "INVENTORY_ITEM_ENRICHMENT",
    buildInventoryEnrichmentTextBundleSnapshot(item, textBundle),
  );
}

export async function retryInventoryEnrichment(
  repository: InventoryEnrichmentRetryRepository,
  input: { targetItemId: string },
): Promise<InventoryEnrichmentJobRecord> {
  const [item, enrichmentJobs, preprocessingJobs] = await Promise.all([
    repository.getInventoryItem(input.targetItemId),
    repository.listInventoryEnrichmentJobs({
      limit: 50,
      targetItemId: input.targetItemId,
    }),
    repository.listInventoryPreprocessingJobs({
      limit: 50,
      targetItemId: input.targetItemId,
    }),
  ]);

  if (!item) {
    throw new Error("Inventory item not found.");
  }

  const textBundle = preprocessingJobs.find(
    (job) => job.textBundle !== null,
  )?.textBundle;

  if (!textBundle) {
    throw new InventoryEnrichmentRetryNotAllowedError(
      "No Inventory Text Bundle is available for enrichment retry.",
    );
  }

  const retryInput = buildInventoryEnrichmentJobInput(
    "INVENTORY_ITEM_ENRICHMENT",
    buildInventoryEnrichmentTextBundleSnapshot(item, textBundle),
  );
  const itemJobs = enrichmentJobs.filter(
    (job) => job.kind === "INVENTORY_ITEM_ENRICHMENT",
  );
  const equivalentActiveJob = itemJobs.find(
    (job) =>
      (job.status === "QUEUED" || job.status === "CLAIMED") &&
      job.inputFingerprint === retryInput.inputFingerprint,
  );

  if (equivalentActiveJob) {
    throw new InventoryEnrichmentRetryConflictError(
      "Equivalent Inventory enrichment is already queued or processing.",
    );
  }

  const latestJob = itemJobs[0];

  if (
    latestJob &&
    (latestJob.status !== "FAILED" ||
      latestJob.failureDetail?.retryable !== true)
  ) {
    throw new InventoryEnrichmentRetryNotAllowedError(
      "Latest Inventory enrichment failure is not retryable.",
    );
  }

  const [job] = await repository.enqueueInventoryEnrichmentJobs([retryInput]);

  if (!job) {
    throw new Error("Inventory enrichment retry job was not created.");
  }

  return job;
}

export async function claimInventoryEnrichmentJobs(
  repository: InventoryEnrichmentRepository,
  input: {
    limit: number;
    leaseSeconds: number;
    now?: Date;
    workerId?: string | null;
  },
): Promise<InventoryEnrichmentJobRecord[]> {
  const now = input.now ?? new Date();
  const limit = clampInteger(input.limit, 1, 50);
  const leaseSeconds = clampInteger(input.leaseSeconds, 1, 60 * 60);
  await autoApplyPendingInventoryEnrichmentProposals(repository, now);
  const jobs = await repository.listClaimableInventoryEnrichmentJobs({
    limit,
    now,
  });

  return Promise.all(
    jobs.map((job) =>
      repository.updateInventoryEnrichmentJob({
        ...job,
        attempts: job.attempts + 1,
        claimedAt: now,
        claimedBy: cleanString(input.workerId),
        leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000),
        status: "CLAIMED",
        updatedAt: now,
      }),
    ),
  );
}

export async function submitInventoryEnrichmentSuccess(
  repository: InventoryEnrichmentRepository,
  input: {
    jobId: string;
    leaseClaimedAt?: Date | null;
    result: unknown;
    resultId?: string | null;
    now?: Date;
  },
): Promise<InventoryEnrichmentJobRecord> {
  const now = input.now ?? new Date();
  const job = await requireInventoryEnrichmentJob(repository, input.jobId);
  const resultId = cleanString(input.resultId);
  const result = parseInventoryEnrichmentResult(input.result, job.kind);

  if (isMatchingInventoryEnrichmentSuccess(job, result, resultId)) {
    return job;
  }

  if (isCompletedJob(job)) {
    throw new Error("Inventory enrichment job is already completed.");
  }

  assertActiveInventoryEnrichmentLease(job, input.leaseClaimedAt, now);
  try {
    await assertFreshInventoryEnrichmentInput(repository, job);
  } catch (error) {
    if (!(error instanceof InventoryEnrichmentStaleInputError)) {
      throw error;
    }

    return repository.updateInventoryEnrichmentJob({
      ...job,
      claimedAt: null,
      claimedBy: null,
      decidedAt: now,
      failureDetail: null,
      leaseExpiresAt: null,
      resultId: null,
      resultPayload: null,
      status: "CANCELLED",
      updatedAt: now,
    });
  }
  const settings = await repository.getInventoryEnrichmentSettings();
  const stagedJob = {
    ...job,
    claimedAt: null,
    claimedBy: null,
    failureDetail: null,
    leaseExpiresAt: null,
    resultId,
    resultPayload: result,
    updatedAt: now,
  } satisfies InventoryEnrichmentJobRecord;

  if (settings.approvalsRequired) {
    return repository.updateInventoryEnrichmentJob({
      ...stagedJob,
      status: "PENDING_APPROVAL",
    });
  }

  await applyInventoryEnrichmentResult(repository, stagedJob, now, "auto");

  return repository.updateInventoryEnrichmentJob({
    ...stagedJob,
    decidedAt: now,
    status: "APPLIED",
  });
}

export async function submitInventoryEnrichmentFailure(
  repository: InventoryEnrichmentRepository,
  input: {
    jobId: string;
    leaseClaimedAt?: Date | null;
    message?: unknown;
    retryable?: unknown;
    now?: Date;
  },
): Promise<InventoryEnrichmentJobRecord> {
  const now = input.now ?? new Date();
  const job = await requireInventoryEnrichmentJob(repository, input.jobId);

  if (shouldIgnoreEnrichmentFailure(job)) {
    return job;
  }

  const message = parseInventoryEnrichmentFailureMessage(input.message);
  const retryable = parseInventoryEnrichmentFailureRetryable(input.retryable);

  if (
    isMatchingInventoryEnrichmentFailure(
      job,
      input.leaseClaimedAt,
      message,
      retryable,
    )
  ) {
    return job;
  }

  assertActiveInventoryEnrichmentLease(job, input.leaseClaimedAt, now);
  const canRetry = retryable && job.attempts < job.maxAttempts;

  return repository.updateInventoryEnrichmentJob({
    ...job,
    claimedAt: null,
    claimedBy: null,
    failureDetail: buildInventoryEnrichmentFailureDetail(
      job,
      message,
      retryable,
      now,
    ),
    leaseExpiresAt: null,
    status: canRetry ? "QUEUED" : "FAILED",
    updatedAt: now,
  });
}

export async function listInventoryEnrichmentProposals(
  repository: InventoryEnrichmentRepository,
  input: { limit?: number; targetItemId?: string } = {},
): Promise<InventoryEnrichmentProposal[]> {
  const jobs = await repository.listInventoryEnrichmentJobs({
    limit: input.limit ?? 50,
    status: "PENDING_APPROVAL",
    targetItemId: input.targetItemId,
  });
  const proposals: InventoryEnrichmentProposal[] = [];

  for (const job of jobs) {
    const item = await repository.getInventoryItem(job.targetItemId);

    if (!item) {
      continue;
    }

    proposals.push({
      job,
      diff: buildInventoryEnrichmentDiff(job, item),
    });
  }

  return proposals;
}

export async function approveInventoryEnrichmentProposal(
  repository: InventoryEnrichmentRepository,
  input: { jobId: string; now?: Date },
): Promise<InventoryEnrichmentJobRecord> {
  const now = input.now ?? new Date();
  const job = await requireInventoryEnrichmentJob(repository, input.jobId);

  if (job.status === "APPLIED") {
    return job;
  }

  if (job.status !== "PENDING_APPROVAL") {
    throw new Error("Inventory enrichment job is not pending approval.");
  }

  await assertFreshInventoryEnrichmentInput(repository, job);
  await applyInventoryEnrichmentResult(repository, job, now, "approval");

  return repository.updateInventoryEnrichmentJob({
    ...job,
    decidedAt: now,
    status: "APPLIED",
    updatedAt: now,
  });
}

export async function rejectInventoryEnrichmentProposal(
  repository: InventoryEnrichmentRepository,
  input: { jobId: string; now?: Date },
): Promise<InventoryEnrichmentJobRecord> {
  const now = input.now ?? new Date();
  const job = await requireInventoryEnrichmentJob(repository, input.jobId);

  if (job.status === "REJECTED") {
    return job;
  }

  if (job.status !== "PENDING_APPROVAL") {
    throw new Error("Inventory enrichment job is not pending approval.");
  }

  return repository.updateInventoryEnrichmentJob({
    ...job,
    claimedAt: null,
    claimedBy: null,
    decidedAt: now,
    failureDetail: null,
    leaseExpiresAt: null,
    status: "REJECTED",
    updatedAt: now,
  });
}

export async function getInventoryEnrichmentSettings(
  repository: InventoryEnrichmentRepository,
): Promise<InventoryEnrichmentSettingsRecord> {
  return repository.getInventoryEnrichmentSettings();
}

export async function updateInventoryEnrichmentSettings(
  repository: InventoryEnrichmentRepository,
  input: { approvalsRequired: boolean; now?: Date },
): Promise<InventoryEnrichmentSettingsRecord> {
  const now = input.now ?? new Date();
  const settings = await repository.updateInventoryEnrichmentSettings({
    approvalsRequired: input.approvalsRequired,
    updatedAt: now,
  });

  if (!settings.approvalsRequired) {
    await autoApplyPendingInventoryEnrichmentProposals(repository, now);
  }

  return settings;
}

async function autoApplyPendingInventoryEnrichmentProposals(
  repository: InventoryEnrichmentRepository,
  now: Date,
): Promise<void> {
  const settings = await repository.getInventoryEnrichmentSettings();

  if (settings.approvalsRequired) {
    return;
  }

  const jobs = await repository.listInventoryEnrichmentJobs({
    limit: 50,
    status: "PENDING_APPROVAL",
  });

  for (const job of jobs) {
    try {
      await assertFreshInventoryEnrichmentInput(repository, job);
    } catch (error) {
      if (!(error instanceof InventoryEnrichmentStaleInputError)) {
        throw error;
      }

      await repository.updateInventoryEnrichmentJob({
        ...job,
        claimedAt: null,
        claimedBy: null,
        decidedAt: now,
        failureDetail: null,
        leaseExpiresAt: null,
        resultId: null,
        resultPayload: null,
        status: "CANCELLED",
        updatedAt: now,
      });
      continue;
    }

    await applyInventoryEnrichmentResult(repository, job, now, "auto");
    await repository.updateInventoryEnrichmentJob({
      ...job,
      claimedAt: null,
      claimedBy: null,
      decidedAt: now,
      failureDetail: null,
      leaseExpiresAt: null,
      status: "APPLIED",
      updatedAt: now,
    });
  }
}

export function buildInventoryEnrichmentDiff(
  job: InventoryEnrichmentJobRecord,
  item: InventoryItemRecord,
): InventoryEnrichmentDiffEntry[] {
  const result = job.resultPayload;

  if (!result) {
    return [];
  }

  if (job.kind === "INVENTORY_ITEM_IMAGE_ENRICHMENT") {
    return buildInventoryEnrichmentImageDiff(job, item, result);
  }

  return buildInventoryEnrichmentItemDiff(job, item, result);
}

function buildInventoryEnrichmentImageDiff(
  job: InventoryEnrichmentJobRecord,
  item: InventoryItemRecord,
  result: InventoryEnrichmentResultPayload,
): InventoryEnrichmentDiffEntry[] {
  const image = item.images.find(
    (candidate) => candidate.id === job.targetImageId,
  );
  const diff: InventoryEnrichmentDiffEntry[] = [];

  if (result.imageCaption !== null) {
    diff.push({
      after: result.imageCaption,
      before: image?.caption ?? null,
      field: "image.caption",
    });
  }

  if (result.imageOcrText !== null) {
    diff.push({
      after: result.imageOcrText,
      before: image?.ocrText ?? null,
      field: "image.ocrText",
    });
  }

  if (result.metadata !== null) {
    diff.push({
      after: addResultIdToEnrichmentMetadata(result.metadata, job.resultId),
      before: null,
      field: "metadata.enrichment",
    });
  }

  return diff;
}

function buildInventoryEnrichmentItemDiff(
  job: InventoryEnrichmentJobRecord,
  item: InventoryItemRecord,
  result: InventoryEnrichmentResultPayload,
): InventoryEnrichmentDiffEntry[] {
  const diff: InventoryEnrichmentDiffEntry[] = [];

  if (result.title !== null && result.title !== item.title) {
    diff.push({
      after: result.title,
      before: item.title,
      field: "title",
    });
  }

  if (result.note !== null && result.note !== item.note) {
    diff.push({
      after: result.note,
      before: item.note,
      field: "note",
    });
  }

  if (result.status !== null && result.status !== item.status) {
    diff.push({
      after: result.status,
      before: item.status,
      field: "status",
    });
  }

  if (result.importance !== null && result.importance !== item.importance) {
    diff.push({
      after: result.importance,
      before: item.importance,
      field: "importance",
    });
  }

  if (result.category !== null && result.category !== item.category) {
    diff.push({
      after: result.category,
      before: item.category,
      field: "category",
    });
  }

  if (
    result.acquisitionSource !== null &&
    result.acquisitionSource !== item.acquisitionSource
  ) {
    diff.push({
      after: result.acquisitionSource,
      before: item.acquisitionSource,
      field: "acquisitionSource",
    });
  }

  if (result.costCents !== null && result.costCents !== item.costCents) {
    diff.push({
      after: result.costCents,
      before: item.costCents,
      field: "costCents",
    });
  }

  addTermDiff(diff, "tags", item.tags, result.tags);
  addTermDiff(diff, "aliases", item.aliases, result.aliases);

  if (result.searchTextAdditions.length > 0) {
    diff.push({
      after: result.searchTextAdditions,
      before: [],
      field: "searchTextAdditions",
    });
  }

  if (result.metadata !== null) {
    diff.push({
      after: addResultIdToEnrichmentMetadata(result.metadata, job.resultId),
      before: item.metadata.enrichment ?? null,
      field: "metadata.enrichment",
    });
  }

  return diff;
}

function addTermDiff(
  diff: InventoryEnrichmentDiffEntry[],
  field: string,
  existingTerms: string[],
  resultTerms: string[],
): void {
  if (resultTerms.length === 0) {
    return;
  }

  diff.push({
    after: mergeInventoryTerms(existingTerms, resultTerms),
    before: existingTerms,
    field,
  });
}

function buildResultMetadata(
  metadata: Record<string, unknown> | null,
  resultId: string | null,
): Record<string, unknown> | null {
  if (metadata === null) {
    return null;
  }

  return addResultIdToEnrichmentMetadata(metadata, resultId);
}

function buildItemEnrichmentMetadata(
  item: InventoryItemRecord,
  result: InventoryEnrichmentResultPayload,
  resultId: string | null,
  now: Date,
): Record<string, unknown> {
  const enrichment =
    buildResultMetadata(result.metadata, resultId) ?? item.metadata.enrichment;

  return {
    ...item.metadata,
    enrichment,
    enrichmentAppliedAt: now.toISOString(),
    enrichmentSchemaVersion: ENRICHMENT_METADATA_SCHEMA_VERSION,
  };
}

function buildImageEnrichmentMetadata(
  item: InventoryItemRecord,
  imageId: string,
  result: InventoryEnrichmentResultPayload,
  resultId: string | null,
  now: Date,
): Record<string, unknown> {
  return {
    ...item.metadata,
    enrichmentAppliedAt: now.toISOString(),
    enrichmentImages: {
      ...recordValue(item.metadata.enrichmentImages),
      [imageId]: buildResultMetadata(result.metadata, resultId),
    },
    enrichmentSchemaVersion: ENRICHMENT_METADATA_SCHEMA_VERSION,
  };
}

function buildItemSearchText(
  item: InventoryItemRecord,
  input: {
    acquisitionSource: InventoryItemRecord["acquisitionSource"];
    aliases: string[];
    category: InventoryItemRecord["category"];
    costCents: InventoryItemRecord["costCents"];
    importance: InventoryItemRecord["importance"];
    note: string | null;
    searchTextAdditions: string[];
    status: InventoryItemRecord["status"];
    tags: string[];
    title: string | null;
  },
): string {
  return buildEnrichmentSearchText(item, {
    acquisitionSource: input.acquisitionSource,
    aliases: input.aliases,
    category: input.category,
    costCents: input.costCents,
    importance: input.importance,
    note: input.note,
    searchTextAdditions: input.searchTextAdditions,
    status: input.status,
    tags: input.tags,
    title: input.title,
  });
}

function buildImageSearchText(
  item: InventoryItemRecord,
  imageId: string,
  result: InventoryEnrichmentResultPayload,
): string {
  return buildEnrichmentSearchText(item, {
    images: item.images.map((image) =>
      image.id === imageId
        ? {
            ...image,
            caption: result.imageCaption ?? image.caption,
            ocrText: result.imageOcrText ?? image.ocrText,
          }
        : image,
    ),
  });
}

async function applyInventoryEnrichmentResult(
  repository: InventoryEnrichmentRepository,
  job: InventoryEnrichmentJobRecord,
  now: Date,
  applyMode: "approval" | "auto",
): Promise<void> {
  const result = job.resultPayload;

  if (!result) {
    throw new Error("Inventory enrichment job has no result payload.");
  }

  const item = await repository.getInventoryItem(job.targetItemId);

  if (!item) {
    throw new Error("Inventory item not found.");
  }

  if (job.kind === "INVENTORY_ITEM_IMAGE_ENRICHMENT") {
    await applyInventoryEnrichmentImageResult(
      repository,
      job,
      item,
      result,
      now,
    );
    return;
  }

  await applyInventoryEnrichmentItemResult(
    repository,
    job,
    item,
    result,
    now,
    applyMode,
  );
}

async function applyInventoryEnrichmentImageResult(
  repository: InventoryEnrichmentRepository,
  job: InventoryEnrichmentJobRecord,
  item: InventoryItemRecord,
  result: InventoryEnrichmentResultPayload,
  now: Date,
): Promise<void> {
  if (!job.targetImageId) {
    throw new Error("Inventory enrichment image job is missing image target.");
  }

  const metadata = buildImageEnrichmentMetadata(
    item,
    job.targetImageId,
    result,
    job.resultId,
    now,
  );
  const searchText = buildImageSearchText(item, job.targetImageId, result);

  await repository.applyInventoryImageEnrichment({
    caption: result.imageCaption,
    imageId: job.targetImageId,
    itemId: job.targetItemId,
    metadata: result.metadata,
    ocrText: result.imageOcrText,
  });
  await repository.applyInventoryItemEnrichment({
    acquisitionSource: item.acquisitionSource,
    aliases: item.aliases,
    category: item.category,
    costCents: item.costCents,
    importance: item.importance,
    itemId: item.id,
    metadata,
    note: item.note,
    searchText,
    status: item.status,
    tags: item.tags,
    title: item.title,
  });
}

async function applyInventoryEnrichmentItemResult(
  repository: InventoryEnrichmentRepository,
  job: InventoryEnrichmentJobRecord,
  item: InventoryItemRecord,
  result: InventoryEnrichmentResultPayload,
  now: Date,
  applyMode: "approval" | "auto",
): Promise<void> {
  const manualFieldLocks = new Set(
    readInventoryItemManualFieldLocks(item.metadata),
  );
  const title = manualFieldLocks.has("title")
    ? item.title
    : (result.title ?? item.title);
  const note = manualFieldLocks.has("note")
    ? item.note
    : (result.note ?? item.note);
  const status = manualFieldLocks.has("status")
    ? item.status
    : (result.status ?? item.status);
  const importance = manualFieldLocks.has("importance")
    ? item.importance
    : (result.importance ?? item.importance);
  const tags = manualFieldLocks.has("tags")
    ? item.tags
    : mergeInventoryTerms(item.tags, result.tags);
  const aliases = manualFieldLocks.has("aliases")
    ? item.aliases
    : mergeInventoryTerms(item.aliases, result.aliases);
  const category = manualFieldLocks.has("category")
    ? item.category
    : resolveStructuredFactValue(
        item.category,
        result.category,
        applyMode,
      );
  const acquisitionSource = manualFieldLocks.has("acquisitionSource")
    ? item.acquisitionSource
    : resolveStructuredFactValue(
        item.acquisitionSource,
        result.acquisitionSource,
        applyMode,
      );
  const costCents = manualFieldLocks.has("costCents")
    ? item.costCents
    : resolveStructuredFactValue(
        item.costCents,
        result.costCents,
        applyMode,
      );

  await repository.applyInventoryItemEnrichment({
    acquisitionSource,
    aliases,
    category,
    costCents,
    importance,
    itemId: item.id,
    metadata: buildItemEnrichmentMetadata(item, result, job.resultId, now),
    note,
    searchText: buildItemSearchText(item, {
      acquisitionSource,
      aliases,
      category,
      costCents,
      importance,
      note,
      searchTextAdditions: result.searchTextAdditions,
      status,
      tags,
      title,
    }),
    status,
    tags,
    title,
  });
}

async function assertFreshInventoryEnrichmentInput(
  repository: InventoryEnrichmentRepository,
  job: InventoryEnrichmentJobRecord,
): Promise<void> {
  if (isInventoryEnrichmentTextBundleSnapshot(job.inputSnapshot)) {
    const item = await repository.getInventoryItem(job.targetItemId);

    if (!item) {
      throw new Error("Inventory item not found.");
    }

    const currentFingerprint = stableFingerprint(
      buildCurrentTextBundleFreshnessInput(item),
    );

    if (currentFingerprint !== job.inputFingerprint) {
      throw new InventoryEnrichmentStaleInputError();
    }

    return;
  }

  const item = await repository.getInventoryItem(job.targetItemId);

  if (!item) {
    throw new Error("Inventory item not found.");
  }

  const currentFingerprint = buildInventoryEnrichmentSnapshot(item, {
    imageId: job.targetImageId,
    kind: job.targetImageId ? "IMAGE" : "ITEM",
  }).sourceFingerprint;

  if (currentFingerprint !== job.inputFingerprint) {
    throw new InventoryEnrichmentStaleInputError();
  }
}

function buildInventoryEnrichmentJobInput(
  kind: InventoryEnrichmentJobKind,
  inputSnapshot: InventoryEnrichmentInputSnapshot,
): InventoryEnrichmentNewJobRecord {
  return {
    claimedAt: null,
    claimedBy: null,
    decidedAt: null,
    failureDetail: null,
    inputFingerprint: inputSnapshot.sourceFingerprint,
    inputSnapshot,
    kind,
    leaseExpiresAt: null,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    resultId: null,
    resultPayload: null,
    targetImageId: inputSnapshot.target.imageId,
    targetItemId: inputSnapshot.target.itemId,
  };
}

function buildInventoryEnrichmentSnapshot(
  item: InventoryItemRecord,
  target: Pick<InventoryEnrichmentJobTarget, "imageId" | "kind">,
): InventoryEnrichmentLegacyInputSnapshot {
  const snapshotWithoutFingerprint = {
    schemaVersion: 1 as const,
    sourceFingerprint: "",
    target: {
      imageId: target.imageId,
      itemId: item.id,
      kind: target.kind,
    },
    item: {
      capturedAt: item.capturedAt.toISOString(),
      containerLabel: item.containerLabel,
      captureText: item.captureText ?? null,
      id: item.id,
      importance: item.importance,
      kind: item.kind,
      locationName: item.locationName,
      note: item.note,
      originLocationName: item.originLocationName,
      status: item.status,
      title: item.title,
    },
    deterministicMetadata: {
      aliases: item.aliases,
      category: item.category,
      metadata: item.metadata,
      searchText: item.searchText,
      tags: item.tags,
    },
    images: item.images.map((image) => ({
      caption: image.caption ?? null,
      height: image.height ?? null,
      id: image.id ?? null,
      mediaUrl: image.id
        ? `/api/internal/inventory/enrichment/images/${image.id}`
        : null,
      mimeType: image.mimeType ?? null,
      ocrText: image.ocrText ?? null,
      originalName: image.originalName ?? null,
      sizeBytes: image.sizeBytes ?? null,
      width: image.width ?? null,
    })),
  };
  const sourceFingerprint = stableFingerprint({
    ...buildInventoryEnrichmentSourceFingerprintInput(
      snapshotWithoutFingerprint,
    ),
    ...(target.kind === "ITEM"
      ? { structuredFacts: buildStructuredFactFreshnessInput(item) }
      : {}),
  });

  return {
    ...snapshotWithoutFingerprint,
    sourceFingerprint,
  };
}

function buildInventoryEnrichmentTextBundleSnapshot(
  item: InventoryItemRecord,
  textBundle: InventoryTextBundle,
): InventoryEnrichmentTextBundleSnapshot {
  assertInventoryEnrichmentTextBundleContract(textBundle);

  const snapshotWithoutFingerprint = {
    schemaVersion: 1 as const,
    sourceFingerprint: "",
    target: {
      imageId: null,
      itemId: item.id,
      kind: "ITEM" as const,
    },
    textBundle,
  };

  return {
    ...snapshotWithoutFingerprint,
    sourceFingerprint: stableFingerprint(
      buildQueuedTextBundleFreshnessInput(item, textBundle),
    ),
  };
}

function buildInventoryEnrichmentSourceFingerprintInput(
  snapshot:
    | InventoryEnrichmentLegacySnapshotWithoutFingerprint
    | InventoryEnrichmentTextBundleSnapshotWithoutFingerprint,
): Record<string, unknown> {
  if ("textBundle" in snapshot) {
    return {
      schemaVersion: snapshot.schemaVersion,
      target: snapshot.target,
      textBundle: snapshot.textBundle,
    };
  }

  return {
    images: snapshot.images.map((image) => ({
      height: image.height,
      id: image.id,
      mediaUrl: image.mediaUrl,
      mimeType: image.mimeType,
      originalName: image.originalName,
      sizeBytes: image.sizeBytes,
      width: image.width,
    })),
    item: snapshot.item,
    schemaVersion: snapshot.schemaVersion,
    target: snapshot.target,
  };
}

function buildQueuedTextBundleFreshnessInput(
  item: InventoryItemRecord,
  textBundle: InventoryTextBundle,
): Record<string, unknown> {
  return {
    captureText: textBundle.captureText,
    item: textBundle.item,
    sourceRefs: sortSourceRefs(textBundle.sourceRefs),
    structuredFacts: buildStructuredFactFreshnessInput(item),
  };
}

function buildCurrentTextBundleFreshnessInput(
  item: InventoryItemRecord,
): Record<string, unknown> {
  return {
    captureText: item.captureText ?? null,
    item: {
      containerLabel: item.containerLabel,
      containerLocation: item.locationName,
      id: item.id,
      importance: item.importance,
      kind: item.kind,
      note: item.note,
      status: item.status,
      title: item.title,
    },
    sourceRefs: sortSourceRefs([
      { id: item.id, kind: "item" as const },
      ...item.images
        .filter((image): image is typeof image & { id: string } =>
          Boolean(image.id),
        )
        .map((image) => ({
          id: image.id,
          kind: "image" as const,
        })),
      ...(item.audioNotes ?? [])
        .filter((audioNote): audioNote is typeof audioNote & { id: string } =>
          Boolean(audioNote.id),
        )
        .map((audioNote) => ({
          id: audioNote.id,
          kind: "audio" as const,
        })),
      ...(item.assets ?? [])
        .filter((asset): asset is typeof asset & { id: string } =>
          Boolean(asset.id),
        )
        .map((asset) => ({
          id: asset.id,
          kind: "asset" as const,
        })),
    ]),
    structuredFacts: buildStructuredFactFreshnessInput(item),
  };
}

function buildStructuredFactFreshnessInput(
  item: InventoryItemRecord,
): Record<
  string,
  | InventoryItemRecord["acquisitionSource"]
  | InventoryItemRecord["category"]
  | InventoryItemRecord["costCents"]
> {
  return {
    acquisitionSource: item.acquisitionSource,
    category: item.category,
    costCents: item.costCents,
  };
}

function sortSourceRefs(
  sourceRefs: Array<{ id: string; kind: string }>,
): Array<{ id: string; kind: string }> {
  return [...sourceRefs].sort((left, right) =>
    `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`),
  );
}

function parseInventoryEnrichmentResult(
  value: unknown,
  jobKind: InventoryEnrichmentJobKind,
): InventoryEnrichmentResultPayload {
  if (!isRecord(value)) {
    throw new Error("Inventory enrichment result must be an object.");
  }

  for (const key of Object.keys(value)) {
    if (!ALLOWED_ENRICHMENT_RESULT_KEYS.has(key)) {
      throw new Error(
        `Inventory enrichment result field is not allowed: ${key}`,
      );
    }

    if (!isInventoryEnrichmentResultKeyAllowedForKind(jobKind, key)) {
      throw new Error(
        `Inventory enrichment result field is not allowed for ${jobKind}: ${key}`,
      );
    }
  }

  return {
    aliases: cleanStringArray(value.aliases),
    acquisitionSource: parseOptionalInventoryAcquisitionSource(
      value.acquisitionSource,
    ),
    category: parseOptionalInventoryCategory(value.category),
    costCents: parseOptionalInventoryCostCents(value.costCents),
    imageCaption: parseOptionalString(value.imageCaption, "imageCaption"),
    imageOcrText: parseOptionalString(value.imageOcrText, "imageOcrText"),
    importance: parseOptionalEnum(
      value.importance,
      INVENTORY_IMPORTANCE_VALUES,
      "importance",
    ),
    metadata: parseOptionalJsonObject(value.metadata, "metadata"),
    note: parseOptionalString(value.note, "note"),
    searchTextAdditions: cleanStringArray(value.searchTextAdditions),
    status: parseOptionalEnum(value.status, INVENTORY_ITEM_STATUSES, "status"),
    tags: cleanStringArray(value.tags),
    title: parseOptionalString(value.title, "title"),
  };
}

function isInventoryEnrichmentResultKeyAllowedForKind(
  jobKind: InventoryEnrichmentJobKind,
  key: string,
): boolean {
  return jobKind === "INVENTORY_ITEM_IMAGE_ENRICHMENT"
    ? IMAGE_ENRICHMENT_RESULT_KEYS.has(key)
    : ITEM_ENRICHMENT_RESULT_KEYS.has(key);
}

function addResultIdToEnrichmentMetadata(
  metadata: Record<string, unknown>,
  resultId: string | null,
): Record<string, unknown> {
  return resultId ? { ...metadata, resultId } : metadata;
}

function mergeInventoryTerms(
  existing: string[],
  additions: string[],
): string[] {
  const terms = new Map<string, string>();

  for (const term of [...existing, ...additions]) {
    const cleaned = cleanString(term);

    if (cleaned) {
      terms.set(cleaned.toLowerCase(), cleaned);
    }
  }

  return [...terms.values()].sort((left, right) => left.localeCompare(right));
}

function buildEnrichmentSearchText(
  item: InventoryItemRecord,
  input: {
    acquisitionSource?: InventoryItemRecord["acquisitionSource"];
    aliases?: string[];
    category?: string | null;
    costCents?: InventoryItemRecord["costCents"];
    importance?: InventoryItemRecord["importance"];
    images?: InventoryItemRecord["images"];
    note?: string | null;
    searchTextAdditions?: string[];
    status?: InventoryItemRecord["status"];
    tags?: string[];
    title?: string | null;
  },
): string {
  const currentBaseTokens = buildEnrichmentBaseSearchTokens(item);
  const currentBaseTokenSet = new Set(currentBaseTokens);
  const extraTokens = collectEnrichmentSearchTokens([item.searchText]).filter(
    (token) => !currentBaseTokenSet.has(token),
  );

  return joinEnrichmentSearchTokens([
    ...buildEnrichmentBaseSearchTokens(item, input),
    ...extraTokens,
    ...collectEnrichmentSearchTokens(input.searchTextAdditions ?? []),
  ]);
}

function buildEnrichmentBaseSearchTokens(
  item: InventoryItemRecord,
  input: {
    acquisitionSource?: InventoryItemRecord["acquisitionSource"];
    aliases?: string[];
    category?: string | null;
    costCents?: InventoryItemRecord["costCents"];
    importance?: InventoryItemRecord["importance"];
    images?: InventoryItemRecord["images"];
    note?: string | null;
    status?: InventoryItemRecord["status"];
    tags?: string[];
    title?: string | null;
  } = {},
): string[] {
  return collectEnrichmentSearchTokens([
    input.title ?? item.title,
    input.note ?? item.note,
    input.status ?? item.status,
    input.importance ?? item.importance,
    item.kind,
    item.containerLabel,
    item.container?.location?.name ?? item.locationName,
    input.category ?? item.category,
    input.acquisitionSource ?? item.acquisitionSource,
    formatEnrichmentCostSearchText(input.costCents ?? item.costCents),
    ...(input.tags ?? item.tags),
    ...(input.aliases ?? item.aliases),
    ...collectEnrichmentImageSearchValues(input.images ?? item.images),
  ]);
}

function collectEnrichmentImageSearchValues(
  images: InventoryItemRecord["images"],
): Array<string | null | undefined> {
  return images.flatMap((image) => [
    image.originalName,
    image.caption,
    image.ocrText,
  ]);
}

function collectEnrichmentSearchTokens(
  values: Array<string | null | undefined>,
): string[] {
  const words = new Set<string>();

  for (const value of values) {
    const normalized = value
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

    if (!normalized) {
      continue;
    }

    for (const word of normalized.split(/\s+/)) {
      words.add(word);
    }
  }

  return [...words];
}

function joinEnrichmentSearchTokens(tokens: string[]): string {
  return [...new Set(tokens)].join(" ");
}

function assertInventoryEnrichmentTextBundleContract(
  textBundle: InventoryTextBundle,
): void {
  assertAllowedObjectKeys(
    textBundle,
    TEXT_BUNDLE_ALLOWED_KEYS,
    "Inventory enrichment text bundle",
  );
  assertAllowedObjectKeys(
    textBundle.item,
    TEXT_BUNDLE_ITEM_ALLOWED_KEYS,
    "Inventory enrichment text bundle item",
  );

  for (const [index, mediaText] of textBundle.mediaTexts.entries()) {
    assertAllowedObjectKeys(
      mediaText,
      TEXT_BUNDLE_MEDIA_TEXT_ALLOWED_KEYS,
      `Inventory enrichment text bundle mediaTexts[${index}]`,
    );

    for (const [segmentIndex, segment] of (
      mediaText.transcriptSegments ?? []
    ).entries()) {
      assertAllowedObjectKeys(
        segment,
        TEXT_BUNDLE_TRANSCRIPT_SEGMENT_ALLOWED_KEYS,
        `Inventory enrichment text bundle mediaTexts[${index}].transcriptSegments[${segmentIndex}]`,
      );
    }
  }

  for (const [index, failedStep] of textBundle.failedSteps.entries()) {
    assertAllowedObjectKeys(
      failedStep,
      TEXT_BUNDLE_FAILED_STEP_ALLOWED_KEYS,
      `Inventory enrichment text bundle failedSteps[${index}]`,
    );
  }

  for (const [index, sourceRef] of textBundle.sourceRefs.entries()) {
    assertAllowedObjectKeys(
      sourceRef,
      TEXT_BUNDLE_SOURCE_REF_ALLOWED_KEYS,
      `Inventory enrichment text bundle sourceRefs[${index}]`,
    );
  }

  assertSafePromptMaterial(textBundle, "Inventory enrichment text bundle");
}

function assertAllowedObjectKeys(
  value: unknown,
  allowedKeys: Set<string>,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `${label} contains unsupported raw-media input at ${key}.`,
      );
    }
  }
}

function assertSafePromptMaterial(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (containsUnsafePromptString(value)) {
      throw new Error(
        `${path} contains unsupported path, url, or secret-shaped prompt material.`,
      );
    }

    return;
  }

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertSafePromptMaterial(entry, `${path}[${index}]`);
    }

    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (isUnsafePromptKey(key)) {
      throw new Error(
        `${path}.${key} contains unsupported path, url, or secret-shaped prompt material.`,
      );
    }

    assertSafePromptMaterial(entry, `${path}.${key}`);
  }
}

function containsUnsafePromptString(value: string): boolean {
  return (
    BEARER_TOKEN_PATTERN.test(value) ||
    LOCAL_STORAGE_PATH_PATTERN.test(value) ||
    LOCAL_FILE_URI_PATTERN.test(value) ||
    ABSOLUTE_FILE_PATH_PATTERN.test(value)
  );
}

function isUnsafePromptKey(key: string): boolean {
  const lowered = key.toLowerCase();

  return UNSAFE_PROMPT_KEY_FRAGMENTS.some((fragment) =>
    lowered.includes(fragment),
  );
}

function isInventoryEnrichmentTextBundleSnapshot(
  snapshot: InventoryEnrichmentInputSnapshot,
): snapshot is InventoryEnrichmentTextBundleSnapshot {
  return "textBundle" in snapshot;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseOptionalString(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(
      `Inventory enrichment result ${fieldName} must be a string.`,
    );
  }

  return cleanString(value);
}

function parseOptionalInventoryCategory(
  value: unknown,
): InventoryItemRecord["category"] {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error("Inventory enrichment result category must be a string.");
  }

  const category = normalizeInventoryCategory(value);

  if (!category) {
    throw new Error(
      `Inventory enrichment result category must be one of ${INVENTORY_CATEGORY_VALUES.join(", ")}.`,
    );
  }

  return category;
}

function parseOptionalInventoryAcquisitionSource(
  value: unknown,
): InventoryItemRecord["acquisitionSource"] {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(
      "Inventory enrichment result acquisitionSource must be a string.",
    );
  }

  const acquisitionSource = normalizeInventoryAcquisitionSource(value);

  if (!acquisitionSource) {
    throw new Error(
      `Inventory enrichment result acquisitionSource must be one of ${INVENTORY_ACQUISITION_SOURCE_VALUES.join(", ")}.`,
    );
  }

  return acquisitionSource;
}

function parseOptionalInventoryCostCents(
  value: unknown,
): InventoryItemRecord["costCents"] {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      "Inventory enrichment result costCents must be a non-negative integer.",
    );
  }

  return value;
}

function parseOptionalEnum<const TValue extends string>(
  value: unknown,
  allowedValues: readonly TValue[],
  fieldName: string,
): TValue | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string" || !allowedValues.includes(value as TValue)) {
    throw new Error(
      `Inventory enrichment result ${fieldName} must be one of ${allowedValues.join(", ")}.`,
    );
  }

  return value as TValue;
}

function cleanStringArray(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(
      "Inventory enrichment result list fields must be string arrays.",
    );
  }

  return mergeInventoryTerms([], value);
}

function parseJsonObject(
  value: unknown,
  fieldName: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(
      `Inventory enrichment result ${fieldName} must be an object.`,
    );
  }

  assertJsonValue(value, fieldName);

  return value;
}

function parseOptionalJsonObject(
  value: unknown,
  fieldName: string,
): Record<string, unknown> | null {
  if (value === undefined || value === null) {
    return null;
  }

  return parseJsonObject(value, fieldName);
}

function assertJsonValue(value: unknown, path: string): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertJsonValue(entry, `${path}[${index}]`),
    );
    return;
  }

  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertJsonValue(child, `${path}.${key}`);
    }
    return;
  }

  throw new Error(
    `Inventory enrichment result ${path} must be JSON serializable.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stableFingerprint(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJsonValue(child)]),
    );
  }

  return value;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function resolveStructuredFactValue<T>(
  currentValue: T | null,
  proposedValue: T | null,
  applyMode: "approval" | "auto",
): T | null {
  if (proposedValue === null) {
    return currentValue;
  }

  if (applyMode === "auto" && currentValue !== null) {
    return currentValue;
  }

  return proposedValue;
}

function formatEnrichmentCostSearchText(
  costCents: number | null,
): string | null {
  if (costCents === null) {
    return null;
  }

  const dollars = Math.floor(costCents / 100);
  const cents = String(costCents % 100).padStart(2, "0");

  return `cad ${dollars}.${cents} ${costCents} cents`;
}

function isCompletedJob(job: InventoryEnrichmentJobRecord): boolean {
  return COMPLETED_ENRICHMENT_JOB_STATUSES.has(job.status);
}

function isMatchingInventoryEnrichmentSuccess(
  job: InventoryEnrichmentJobRecord,
  result: InventoryEnrichmentResultPayload,
  resultId: string | null,
): boolean {
  return (
    job.resultPayload !== null &&
    job.resultId === resultId &&
    stableFingerprint(job.resultPayload) === stableFingerprint(result)
  );
}

function isMatchingInventoryEnrichmentFailure(
  job: InventoryEnrichmentJobRecord,
  leaseClaimedAt: Date | null | undefined,
  message: string,
  retryable: boolean,
): boolean {
  if (!job.failureDetail || !leaseClaimedAt || job.status === "CLAIMED") {
    return false;
  }

  return (
    job.failureDetail.leaseClaimedAt === leaseClaimedAt.toISOString() &&
    job.failureDetail.message === message &&
    job.failureDetail.retryable === retryable
  );
}

function shouldIgnoreEnrichmentFailure(
  job: InventoryEnrichmentJobRecord,
): boolean {
  return (
    isCompletedJob(job) ||
    job.status === "PENDING_APPROVAL" ||
    job.resultPayload !== null
  );
}

function parseInventoryEnrichmentFailureMessage(value: unknown): string {
  if (value === undefined || value === null) {
    return "Inventory enrichment processing failed.";
  }

  if (typeof value !== "string") {
    throw new Error("Inventory enrichment failure message must be a string.");
  }

  return cleanString(value) ?? "Inventory enrichment processing failed.";
}

function parseInventoryEnrichmentFailureRetryable(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }

  if (typeof value !== "boolean") {
    throw new Error(
      "Inventory enrichment failure retryable must be a boolean.",
    );
  }

  return value;
}

function buildInventoryEnrichmentFailureDetail(
  job: InventoryEnrichmentJobRecord,
  message: string,
  retryable: boolean,
  now: Date,
): InventoryEnrichmentFailureDetail {
  if (!job.claimedAt) {
    throw new Error("Inventory enrichment job does not have an active lease.");
  }

  return {
    attempt: job.attempts,
    failedAt: now.toISOString(),
    leaseClaimedAt: job.claimedAt.toISOString(),
    message,
    retryable,
  };
}

function assertActiveInventoryEnrichmentLease(
  job: InventoryEnrichmentJobRecord,
  leaseClaimedAt: Date | null | undefined,
  now: Date,
): void {
  if (!leaseClaimedAt) {
    throw new Error("Inventory enrichment job lease is required.");
  }

  if (
    job.status !== "CLAIMED" ||
    job.claimedAt === null ||
    job.leaseExpiresAt === null
  ) {
    throw new Error("Inventory enrichment job does not have an active lease.");
  }

  if (
    job.claimedAt.getTime() !== leaseClaimedAt.getTime() ||
    job.leaseExpiresAt.getTime() <= now.getTime()
  ) {
    throw new Error("Inventory enrichment job lease is no longer active.");
  }
}

async function requireInventoryEnrichmentJob(
  repository: InventoryEnrichmentRepository,
  jobId: string,
): Promise<InventoryEnrichmentJobRecord> {
  const job = await repository.getInventoryEnrichmentJob(jobId);

  if (!job) {
    throw new Error("Inventory enrichment job not found.");
  }

  return job;
}
