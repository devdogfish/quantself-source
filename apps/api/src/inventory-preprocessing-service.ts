import {
  buildInventoryEnrichmentTextBundleJobInput,
  type InventoryEnrichmentJobRecord,
  type InventoryEnrichmentNewJobRecord,
  type InventoryEnrichmentQueueRepository,
} from "./inventory-enrichment-service";
import type {
  InventoryItemAssetRecord,
  InventoryItemAudioRecord,
  InventoryItemImageRecord,
  InventoryItemRecord,
} from "./inventory-service";

export const INVENTORY_PREPROCESSING_STATUSES = [
  "QUEUED",
  "PROCESSING",
  "READY_FOR_ENRICHMENT",
  "PARTIAL",
  "NEEDS_REVIEW",
  "FAILED",
] as const;

export type InventoryPreprocessingStatus =
  (typeof INVENTORY_PREPROCESSING_STATUSES)[number];

export type InventoryPreprocessingSourceRef = {
  kind: "item" | "image" | "audio" | "asset";
  id: string;
};

export type InventoryPreprocessingFailedStep = {
  mediaId?: string;
  step: "ocr" | "transcription";
  code?: string;
  message: string;
  retryable: boolean;
};

export type InventoryTextBundle = {
  schemaVersion: 1;
  item: {
    id: string;
    title: string | null;
    note: string | null;
    kind: InventoryItemRecord["kind"];
    status: InventoryItemRecord["status"];
    importance: InventoryItemRecord["importance"];
    containerLabel: string | null;
    containerLocation: string | null;
  };
  captureText: string | null;
  mediaTexts: InventoryTextBundleMediaText[];
  failedSteps: InventoryPreprocessingFailedStep[];
  sourceRefs: InventoryPreprocessingSourceRef[];
};

export type InventoryTextBundleMediaText = {
  mediaId: string;
  type: "image" | "audio" | "video";
  ocrText?: string;
  ocrLines?: string[];
  transcript?: string;
  transcriptSegments?: Array<{ start: number; end: number; text: string }>;
  provider?: "girke";
  providerModel?: string;
  providerJobId?: string;
  sourceMetadata?: Record<string, unknown>;
};

export type InventoryPreprocessingItemSnapshot = Pick<
  InventoryItemRecord,
  | "assets"
  | "audioNotes"
  | "captureText"
  | "category"
  | "containerLabel"
  | "id"
  | "images"
  | "importance"
  | "kind"
  | "locationName"
  | "note"
  | "originLocationName"
  | "status"
  | "title"
>;

export type InventoryPreprocessingFailureDetail = {
  attempt: number;
  code?: string;
  failedAt: string;
  leaseClaimedAt: string | null;
  message: string;
  retryable: boolean;
};

export interface InventoryPreprocessingJobRecord {
  id: string;
  targetItemId: string;
  status: InventoryPreprocessingStatus;
  attempts: number;
  maxAttempts: number;
  claimedBy: string | null;
  claimedAt: Date | null;
  leaseExpiresAt: Date | null;
  sourceRefs: InventoryPreprocessingSourceRef[];
  textBundle: InventoryTextBundle | null;
  failureDetail: InventoryPreprocessingFailureDetail | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type InventoryPreprocessingNewJobRecord = Omit<
  InventoryPreprocessingJobRecord,
  | "attempts"
  | "completedAt"
  | "createdAt"
  | "failureDetail"
  | "id"
  | "status"
  | "textBundle"
  | "updatedAt"
>;

export type InventoryGirkeMediaInput = {
  mediaId: string;
  filePath: string;
  originalName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
};

export type InventoryGirkeOcrMetadata = {
  model: string;
  timeoutSeconds: number;
  maxUploadBytes: number;
  acceptedImageFormats: string[];
};

export type InventoryGirkeOcrResult = {
  text: string;
  lines: string[];
  processingSeconds: number;
  model: string;
};

export type InventoryGirkeTranscriptionMetadata = {
  levels: string[];
  languages: string[];
  defaultLevel: string;
  languageOptional: boolean;
  acceptedAudioFormats: string[];
  acceptedVideoFormats: string[];
};

export type InventoryGirkeTranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

export type InventoryGirkeTranscriptionSyncResult = {
  text: string;
  segments: InventoryGirkeTranscriptSegment[];
  durationSeconds: number;
  processingSeconds: number;
  level: string;
  language: string;
  detectedLanguage: string | null;
  model: string;
};

export type InventoryGirkeTranscriptionJob = {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  error?: {
    code?: string;
    message: string;
  };
};

export type InventoryGirkeTranscriptionJobAccepted = {
  jobId: string;
  status: "queued";
  level: string;
  language: string;
  detectedLanguage: string | null;
  createdAt: string;
};

export type InventoryGirkeTranscriptionJobResult = {
  jobId: string;
  status: "completed";
  text: string;
  segments: Array<
    InventoryGirkeTranscriptSegment & {
      chunkIndex?: number;
    }
  >;
  durationSeconds: number;
  processingSeconds: number;
  level: string;
  language: string;
  detectedLanguage: string | null;
  model: string;
};

export interface InventoryGirkePreprocessingAdapter {
  getOcrMetadata(): Promise<InventoryGirkeOcrMetadata>;
  recognizeOcr(input: InventoryGirkeMediaInput): Promise<InventoryGirkeOcrResult>;
  getTranscriptionMetadata(): Promise<InventoryGirkeTranscriptionMetadata>;
  transcribeSynchronously(
    input: InventoryGirkeMediaInput & {
      level?: string;
      language?: string;
    },
  ): Promise<InventoryGirkeTranscriptionSyncResult>;
  createTranscriptionJob(
    input: InventoryGirkeMediaInput & {
      level?: string;
      language?: string;
    },
  ): Promise<InventoryGirkeTranscriptionJobAccepted>;
  getTranscriptionJob(jobId: string): Promise<InventoryGirkeTranscriptionJob>;
  getTranscriptionJobResult(
    jobId: string,
  ): Promise<InventoryGirkeTranscriptionJobResult>;
}

export type InventoryTranscriptionPollingRuntime = {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
};

type InventoryTranscriptionPollingOptions = {
  runtime?: InventoryTranscriptionPollingRuntime;
  timeoutMs?: number;
};

export class InventoryPreprocessingStepError extends Error {
  readonly code?: string;
  readonly retryable: boolean;
  readonly step: InventoryPreprocessingFailedStep["step"];

  constructor(input: {
    step: InventoryPreprocessingFailedStep["step"];
    message: string;
    code?: string;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = "InventoryPreprocessingStepError";
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    this.step = input.step;
  }
}

export class InventoryPreprocessingSystemError extends Error {
  readonly code?: string;
  readonly retryable: boolean;

  constructor(input: { message: string; code?: string; retryable?: boolean }) {
    super(input.message);
    this.name = "InventoryPreprocessingSystemError";
    this.code = input.code;
    this.retryable = input.retryable ?? true;
  }
}

export interface InventoryPreprocessingRepository {
  enqueueInventoryPreprocessingJobs(
    jobs: InventoryPreprocessingNewJobRecord[],
  ): Promise<InventoryPreprocessingJobRecord[]>;
  listClaimableInventoryPreprocessingJobs(input: {
    limit: number;
    now: Date;
  }): Promise<InventoryPreprocessingJobRecord[]>;
  listInventoryPreprocessingJobs(input?: {
    limit?: number;
    status?: InventoryPreprocessingStatus;
    targetItemId?: string;
  }): Promise<InventoryPreprocessingJobRecord[]>;
  updateInventoryPreprocessingJob(
    job: InventoryPreprocessingJobRecord,
  ): Promise<InventoryPreprocessingJobRecord>;
  getInventoryPreprocessingJob(
    id: string,
  ): Promise<InventoryPreprocessingJobRecord | null>;
}

export interface InventoryPreprocessingRuntimeRepository
  extends InventoryPreprocessingRepository,
    InventoryEnrichmentQueueRepository {
  completeInventoryPreprocessingJob(input: {
    enrichmentJob: InventoryEnrichmentNewJobRecord | null;
    job: InventoryPreprocessingJobRecord;
  }): Promise<InventoryPreprocessingJobRecord>;
  getInventoryItem(id: string): Promise<InventoryItemRecord | null>;
  listInventoryEnrichmentJobs(input?: {
    limit?: number;
    status?: InventoryEnrichmentJobRecord["status"];
    targetItemId?: string;
  }): Promise<InventoryEnrichmentJobRecord[]>;
}

export interface InventoryPreprocessingRetryRepository
  extends Pick<
    InventoryPreprocessingRepository,
    "enqueueInventoryPreprocessingJobs" | "listInventoryPreprocessingJobs"
  > {
  getInventoryItem(id: string): Promise<InventoryItemRecord | null>;
}

export class InventoryPreprocessingRetryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryPreprocessingRetryConflictError";
  }
}

export class InventoryPreprocessingRetryNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryPreprocessingRetryNotAllowedError";
  }
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TRANSCRIPTION_POLL_TIMEOUT_MS = 120_000;
const INITIAL_TRANSCRIPTION_POLL_DELAY_MS = 500;
const MAX_TRANSCRIPTION_POLL_DELAY_MS = 5_000;

export function isInventoryPreprocessingRepository(
  repository: unknown,
): repository is InventoryPreprocessingRepository {
  return (
    repository !== null &&
    typeof repository === "object" &&
    "enqueueInventoryPreprocessingJobs" in repository &&
    "listClaimableInventoryPreprocessingJobs" in repository &&
    "updateInventoryPreprocessingJob" in repository
  );
}

export async function queueInventoryPreprocessingCapture(
  repository: InventoryPreprocessingRepository,
  item: InventoryItemRecord,
): Promise<InventoryPreprocessingJobRecord> {
  const [job] = await repository.enqueueInventoryPreprocessingJobs([
    buildInventoryPreprocessingJobInput(item),
  ]);

  if (!job) {
    throw new Error("Inventory preprocessing job was not created.");
  }

  return job;
}

export async function retryInventoryPreprocessing(
  repository: InventoryPreprocessingRetryRepository,
  input: { targetItemId: string },
): Promise<InventoryPreprocessingJobRecord> {
  const [item, jobs] = await Promise.all([
    repository.getInventoryItem(input.targetItemId),
    repository.listInventoryPreprocessingJobs({
      limit: 50,
      targetItemId: input.targetItemId,
    }),
  ]);

  if (!item) {
    throw new Error("Inventory item not found.");
  }

  const retryInput = buildInventoryPreprocessingJobInput(item);
  const equivalentActiveJob = jobs.find(
    (job) =>
      (job.status === "QUEUED" || job.status === "PROCESSING") &&
      sameInventoryPreprocessingSourceRefs(job.sourceRefs, retryInput.sourceRefs),
  );

  if (equivalentActiveJob) {
    throw new InventoryPreprocessingRetryConflictError(
      "Equivalent Inventory preprocessing is already queued or processing.",
    );
  }

  const latestJob = jobs[0];

  if (!latestJob || !isRetryableInventoryPreprocessingFailure(latestJob)) {
    throw new InventoryPreprocessingRetryNotAllowedError(
      "Latest Inventory preprocessing failure is not retryable.",
    );
  }

  const [job] = await repository.enqueueInventoryPreprocessingJobs([retryInput]);

  if (!job) {
    throw new Error("Inventory preprocessing retry job was not created.");
  }

  return job;
}

export async function claimInventoryPreprocessingJobs(
  repository: InventoryPreprocessingRepository,
  input: {
    limit: number;
    leaseSeconds: number;
    now?: Date;
    workerId?: string | null;
  },
): Promise<InventoryPreprocessingJobRecord[]> {
  const now = input.now ?? new Date();
  const jobs = await repository.listClaimableInventoryPreprocessingJobs({
    limit: clampInteger(input.limit, 1, 50),
    now,
  });
  const leaseSeconds = clampInteger(input.leaseSeconds, 1, 60 * 60);

  return Promise.all(
    jobs.map((job) =>
      repository.updateInventoryPreprocessingJob({
        ...job,
        attempts: job.attempts + 1,
        claimedAt: now,
        claimedBy: cleanString(input.workerId),
        leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000),
        status: "PROCESSING",
        updatedAt: now,
      }),
    ),
  );
}

export async function repairInventoryPreprocessingHandoffs(
  repository: InventoryPreprocessingRuntimeRepository,
  input: { limit?: number } = {},
): Promise<number> {
  const limit = clampInteger(input.limit ?? 100, 1, 500);
  const completedJobs = (
    await Promise.all(
      (["READY_FOR_ENRICHMENT", "PARTIAL"] as const).map((status) =>
        repository.listInventoryPreprocessingJobs({ limit, status }),
      ),
    )
  )
    .flat()
    .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime())
    .slice(0, limit);
  let repaired = 0;

  for (const preprocessingJob of completedJobs) {
    if (!preprocessingJob.textBundle) {
      continue;
    }

    const item = await repository.getInventoryItem(preprocessingJob.targetItemId);

    if (!item) {
      continue;
    }

    const enrichmentJob = buildInventoryEnrichmentTextBundleJobInput(
      item,
      preprocessingJob.textBundle,
    );
    const existingJobs = await repository.listInventoryEnrichmentJobs({
      limit: 100,
      targetItemId: preprocessingJob.targetItemId,
    });
    const handoffExists = existingJobs.some(
      (existingJob) =>
        existingJob.kind === enrichmentJob.kind &&
        existingJob.inputFingerprint === enrichmentJob.inputFingerprint,
    );

    if (handoffExists) {
      continue;
    }

    await repository.enqueueInventoryEnrichmentJobs([enrichmentJob]);
    repaired += 1;
  }

  return repaired;
}

export async function runInventoryPreprocessingJob(
  repository: InventoryPreprocessingRuntimeRepository,
  input: {
    adapter: InventoryGirkePreprocessingAdapter;
    jobId: string;
    leaseClaimedAt?: Date | null;
    now?: Date;
  },
): Promise<InventoryPreprocessingJobRecord> {
  const now = input.now ?? new Date();
  const job = await requireInventoryPreprocessingJob(repository, input.jobId);

  if (isCompletedInventoryPreprocessingStatus(job.status)) {
    return job;
  }

  assertActiveInventoryPreprocessingLease(job, input.leaseClaimedAt, now);

  try {
    const item = await repository.getInventoryItem(job.targetItemId);

    if (!item) {
      throw new InventoryPreprocessingSystemError({
        code: "item_not_found",
        message: "Inventory item not found for preprocessing.",
        retryable: false,
      });
    }

    const textBundle = await buildInventoryTextBundle(item, job.sourceRefs, input.adapter);

    return await submitCompletedInventoryPreprocessingJob(repository, {
      item,
      job,
      now,
      textBundle,
    });
  } catch (error) {
    return submitFailedInventoryPreprocessingJob(repository, {
      error,
      job,
      leaseClaimedAt: input.leaseClaimedAt ?? job.claimedAt,
      now,
    });
  }
}

export async function submitInventoryPreprocessingSuccess(
  repository: InventoryPreprocessingRuntimeRepository,
  input: {
    jobId: string;
    leaseClaimedAt?: Date | null;
    now?: Date;
    textBundle: InventoryTextBundle;
  },
): Promise<InventoryPreprocessingJobRecord> {
  const now = input.now ?? new Date();
  const job = await requireInventoryPreprocessingJob(repository, input.jobId);

  if (isMatchingInventoryPreprocessingSuccess(job, input.textBundle)) {
    return job;
  }

  if (isCompletedInventoryPreprocessingStatus(job.status)) {
    throw new Error("Inventory preprocessing job is already completed.");
  }

  assertActiveInventoryPreprocessingLease(job, input.leaseClaimedAt, now);
  const item = await repository.getInventoryItem(job.targetItemId);

  if (!item) {
    throw new Error("Inventory item not found for preprocessing.");
  }

  return submitCompletedInventoryPreprocessingJob(repository, {
    item,
    job,
    now,
    textBundle: input.textBundle,
  });
}

export async function submitInventoryPreprocessingFailure(
  repository: InventoryPreprocessingRepository,
  input: {
    code?: unknown;
    jobId: string;
    leaseClaimedAt?: Date | null;
    message?: unknown;
    now?: Date;
    retryable?: unknown;
  },
): Promise<InventoryPreprocessingJobRecord> {
  const now = input.now ?? new Date();
  const job = await requireInventoryPreprocessingJob(repository, input.jobId);

  if (shouldIgnoreInventoryPreprocessingFailure(job)) {
    return job;
  }

  const message = parseInventoryPreprocessingFailureMessage(input.message);
  const retryable = parseInventoryPreprocessingFailureRetryable(input.retryable);
  const code = parseInventoryPreprocessingFailureCode(input.code);

  if (
    isMatchingInventoryPreprocessingFailure(
      job,
      input.leaseClaimedAt,
      message,
      retryable,
      code,
    )
  ) {
    return job;
  }

  assertActiveInventoryPreprocessingLease(job, input.leaseClaimedAt, now);

  return repository.updateInventoryPreprocessingJob({
    ...job,
    claimedAt: null,
    claimedBy: null,
    completedAt: now,
    failureDetail: buildInventoryPreprocessingFailureDetailFromMessage(
      job,
      code,
      message,
      retryable,
      input.leaseClaimedAt ?? job.claimedAt,
      now,
    ),
    leaseExpiresAt: null,
    status: "FAILED",
    textBundle: null,
    updatedAt: now,
  });
}

function buildInventoryPreprocessingJobInput(
  item: InventoryItemRecord,
): InventoryPreprocessingNewJobRecord {
  return {
    claimedAt: null,
    claimedBy: null,
    leaseExpiresAt: null,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    sourceRefs: buildInventoryPreprocessingSourceRefs(item),
    targetItemId: item.id,
  };
}

function buildInventoryPreprocessingSourceRefs(
  item: InventoryItemRecord,
): InventoryPreprocessingSourceRef[] {
  return [
    { id: item.id, kind: "item" },
    ...item.images
      .filter((image): image is typeof image & { id: string } => Boolean(image.id))
      .map((image) => ({
        id: image.id,
        kind: "image" as const,
      })),
    ...(item.audioNotes ?? [])
      .filter(
        (audioNote): audioNote is typeof audioNote & { id: string } =>
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
  ];
}

function sameInventoryPreprocessingSourceRefs(
  left: InventoryPreprocessingSourceRef[],
  right: InventoryPreprocessingSourceRef[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRetryableInventoryPreprocessingFailure(
  job: InventoryPreprocessingJobRecord,
): boolean {
  if (job.status === "FAILED") {
    return job.failureDetail?.retryable === true;
  }

  if (job.status !== "PARTIAL" && job.status !== "NEEDS_REVIEW") {
    return false;
  }

  return (
    job.failureDetail?.retryable === true ||
    job.textBundle?.failedSteps.some(
      (step) => step.retryable || step.code === "unauthorized",
    ) === true
  );
}

export async function buildInventoryTextBundle(
  item: InventoryPreprocessingItemSnapshot,
  sourceRefs: InventoryPreprocessingSourceRef[],
  adapter: InventoryGirkePreprocessingAdapter,
  options?: {
    transcriptionPolling?: InventoryTranscriptionPollingOptions;
  },
): Promise<InventoryTextBundle> {
  const textBundle: InventoryTextBundle = {
    captureText: item.captureText ?? null,
    failedSteps: [],
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
    mediaTexts: [],
    schemaVersion: 1,
    sourceRefs: [...sourceRefs],
  };

  if (item.images.length > 0 && item.category !== "clothing") {
    try {
      const ocrMetadata = await adapter.getOcrMetadata();

      for (const image of item.images) {
        if (!image.id) {
          continue;
        }

        await appendImageTextBundleMedia(
          textBundle,
          image as InventoryItemImageRecord & { id: string },
          adapter,
          ocrMetadata,
        );
      }
    } catch (error) {
      for (const image of item.images) {
        if (!image.id) {
          continue;
        }

        textBundle.failedSteps.push(
          toInventoryPreprocessingFailedStep(error, "ocr", image.id),
        );
      }
    }
  }

  const audioNotes = item.audioNotes ?? [];

  if (audioNotes.length > 0) {
    try {
      const transcriptionMetadata = await adapter.getTranscriptionMetadata();

      for (const audioNote of audioNotes) {
        if (!audioNote.id) {
          continue;
        }

        await appendAudioTextBundleMedia(
          textBundle,
          audioNote as InventoryItemAudioRecord & { id: string },
          adapter,
          transcriptionMetadata,
          options?.transcriptionPolling,
        );
      }
    } catch (error) {
      for (const audioNote of audioNotes) {
        if (!audioNote.id) {
          continue;
        }

        textBundle.failedSteps.push(
          toInventoryPreprocessingFailedStep(error, "transcription", audioNote.id),
        );
      }
    }
  }

  const processableAssets = (item.assets ?? []).filter(
    (asset): asset is InventoryItemAssetRecord & { id: string } => {
      const mediaType = inventoryAssetMediaType(asset);

      return (
        Boolean(asset.id) &&
        mediaType !== null &&
        !(item.category === "clothing" && mediaType === "image")
      );
    },
  );

  if (processableAssets.length > 0) {
    await appendAssetTextBundleMedia(
      textBundle,
      processableAssets,
      adapter,
      options?.transcriptionPolling,
    );
  }

  return textBundle;
}

async function appendImageTextBundleMedia(
  textBundle: InventoryTextBundle,
  image: InventoryItemImageRecord & { id: string },
  adapter: InventoryGirkePreprocessingAdapter,
  metadata: InventoryGirkeOcrMetadata,
): Promise<void> {
  try {
    assertAcceptedExtension(
      metadata.acceptedImageFormats,
      image.originalName ?? image.filePath,
      "ocr",
      "unsupported_image_format",
      "Girke OCR does not accept this image format.",
    );
    const result = await adapter.recognizeOcr(toMediaInput(image));

    textBundle.mediaTexts.push({
      mediaId: image.id,
      ocrLines: result.lines,
      ocrText: result.text,
      provider: "girke",
      providerModel: result.model,
      sourceMetadata: {
        ocr: {
          model: result.model,
          processingSeconds: result.processingSeconds,
        },
      },
      type: "image",
    });
  } catch (error) {
    textBundle.failedSteps.push(toInventoryPreprocessingFailedStep(error, "ocr", image.id));
  }
}

async function appendAudioTextBundleMedia(
  textBundle: InventoryTextBundle,
  audioNote: InventoryItemAudioRecord & { id: string },
  adapter: InventoryGirkePreprocessingAdapter,
  metadata: InventoryGirkeTranscriptionMetadata,
  transcriptionPolling?: InventoryTranscriptionPollingOptions,
): Promise<void> {
  try {
    assertAcceptedExtension(
      metadata.acceptedAudioFormats,
      audioNote.originalName ?? audioNote.filePath,
      "transcription",
      "unsupported_media_format",
      "Girke transcription does not accept this audio format.",
    );
    const mediaInput = toMediaInput(audioNote);
    const result = await transcribeAudioWithGirke(
      adapter,
      mediaInput,
      metadata.defaultLevel,
      transcriptionPolling,
    );

    textBundle.mediaTexts.push({
      mediaId: audioNote.id,
      provider: "girke",
      providerJobId: result.jobId ?? undefined,
      providerModel: result.model,
      sourceMetadata: {
        transcription: {
          detectedLanguage: result.detectedLanguage,
          durationSeconds: result.durationSeconds,
          language: result.language,
          level: result.level,
          model: result.model,
          processingSeconds: result.processingSeconds,
        },
      },
      transcript: result.text,
      transcriptSegments: result.segments.map((segment) => ({
        end: segment.end,
        start: segment.start,
        text: segment.text,
      })),
      type: "audio",
    });
  } catch (error) {
    textBundle.failedSteps.push(
      toInventoryPreprocessingFailedStep(error, "transcription", audioNote.id),
    );
  }
}

async function appendAssetTextBundleMedia(
  textBundle: InventoryTextBundle,
  assets: Array<InventoryItemAssetRecord & { id: string }>,
  adapter: InventoryGirkePreprocessingAdapter,
  transcriptionPolling?: InventoryTranscriptionPollingOptions,
): Promise<void> {
  const imageAssets = assets.filter(
    (asset) => inventoryAssetMediaType(asset) === "image",
  );
  const transcribableAssets = assets.filter((asset) => {
    const mediaType = inventoryAssetMediaType(asset);

    return mediaType === "audio" || mediaType === "video";
  });

  if (imageAssets.length > 0) {
    try {
      const metadata = await adapter.getOcrMetadata();

      for (const asset of imageAssets) {
        await appendImageTextBundleMedia(textBundle, asset, adapter, metadata);
      }
    } catch (error) {
      for (const asset of imageAssets) {
        textBundle.failedSteps.push(
          toInventoryPreprocessingFailedStep(error, "ocr", asset.id),
        );
      }
    }
  }

  if (transcribableAssets.length === 0) {
    return;
  }

  try {
    const metadata = await adapter.getTranscriptionMetadata();

    for (const asset of transcribableAssets) {
      await appendTranscribableAssetTextBundleMedia(
        textBundle,
        asset,
        adapter,
        metadata,
        transcriptionPolling,
      );
    }
  } catch (error) {
    for (const asset of transcribableAssets) {
      textBundle.failedSteps.push(
        toInventoryPreprocessingFailedStep(
          error,
          "transcription",
          asset.id,
        ),
      );
    }
  }
}

async function appendTranscribableAssetTextBundleMedia(
  textBundle: InventoryTextBundle,
  asset: InventoryItemAssetRecord & { id: string },
  adapter: InventoryGirkePreprocessingAdapter,
  metadata: InventoryGirkeTranscriptionMetadata,
  transcriptionPolling?: InventoryTranscriptionPollingOptions,
): Promise<void> {
  const mediaType = inventoryAssetMediaType(asset);

  if (mediaType !== "audio" && mediaType !== "video") {
    return;
  }

  try {
    assertAcceptedExtension(
      mediaType === "video"
        ? metadata.acceptedVideoFormats
        : metadata.acceptedAudioFormats,
      asset.originalName ?? asset.filePath,
      "transcription",
      "unsupported_media_format",
      "Girke transcription does not accept this media format.",
    );
    const result = await transcribeAudioWithGirke(
      adapter,
      toMediaInput(asset),
      metadata.defaultLevel,
      transcriptionPolling,
    );

    textBundle.mediaTexts.push({
      mediaId: asset.id,
      provider: "girke",
      providerJobId: result.jobId ?? undefined,
      providerModel: result.model,
      sourceMetadata: {
        transcription: {
          detectedLanguage: result.detectedLanguage,
          durationSeconds: result.durationSeconds,
          language: result.language,
          level: result.level,
          model: result.model,
          processingSeconds: result.processingSeconds,
        },
      },
      transcript: result.text,
      transcriptSegments: result.segments.map((segment) => ({
        end: segment.end,
        start: segment.start,
        text: segment.text,
      })),
      type: mediaType,
    });
  } catch (error) {
    textBundle.failedSteps.push(
      toInventoryPreprocessingFailedStep(error, "transcription", asset.id),
    );
  }
}

async function transcribeAudioWithGirke(
  adapter: InventoryGirkePreprocessingAdapter,
  mediaInput: InventoryGirkeMediaInput,
  defaultLevel: string,
  transcriptionPolling?: InventoryTranscriptionPollingOptions,
): Promise<
  InventoryGirkeTranscriptionSyncResult & {
    jobId?: string;
  }
> {
  try {
    return await adapter.transcribeSynchronously({
      ...mediaInput,
      level: defaultLevel,
    });
  } catch (error) {
    if (!shouldUseAsyncTranscriptionFallback(error)) {
      throw error;
    }

    const job = await adapter.createTranscriptionJob({
      ...mediaInput,
      level: defaultLevel,
    });
    const result = await pollGirkeTranscriptionJob(
      adapter,
      job.jobId,
      transcriptionPolling,
    );

    return {
      ...result,
      jobId: job.jobId,
    };
  }
}

async function pollGirkeTranscriptionJob(
  adapter: InventoryGirkePreprocessingAdapter,
  jobId: string,
  options?: InventoryTranscriptionPollingOptions,
): Promise<InventoryGirkeTranscriptionJobResult> {
  const runtime = options?.runtime ?? {
    now: Date.now,
    sleep: sleepForPolling,
  };
  const timeoutMs = normalizeTranscriptionPollTimeout(options?.timeoutMs);
  const startedAt = runtime.now();
  let delayMs = INITIAL_TRANSCRIPTION_POLL_DELAY_MS;

  while (runtime.now() - startedAt < timeoutMs) {
    const status = await adapter.getTranscriptionJob(jobId);

    if (status.status === "completed") {
      return adapter.getTranscriptionJobResult(jobId);
    }

    if (status.status === "failed") {
      throw new InventoryPreprocessingStepError({
        code: status.error?.code ?? "transcription_job_failed",
        message: status.error?.message ?? "Girke transcription job failed.",
        retryable: false,
        step: "transcription",
      });
    }

    if (status.status === "cancelled") {
      throw new InventoryPreprocessingStepError({
        code: status.error?.code ?? "job_cancelled",
        message: status.error?.message ?? "Girke transcription job was cancelled.",
        retryable: false,
        step: "transcription",
      });
    }

    const elapsedMs = Math.max(0, runtime.now() - startedAt);
    const remainingMs = timeoutMs - elapsedMs;

    if (remainingMs <= 0) {
      break;
    }

    await runtime.sleep(Math.min(delayMs, remainingMs));
    delayMs = Math.min(delayMs * 2, MAX_TRANSCRIPTION_POLL_DELAY_MS);
  }

  throw new InventoryPreprocessingStepError({
    code: "transcription_job_poll_timeout",
    message: "Girke transcription job did not complete before polling timed out.",
    retryable: true,
    step: "transcription",
  });
}

function normalizeTranscriptionPollTimeout(value?: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_TRANSCRIPTION_POLL_TIMEOUT_MS;
  }

  return Math.max(
    0,
    Math.min(DEFAULT_TRANSCRIPTION_POLL_TIMEOUT_MS, Math.trunc(value)),
  );
}

function sleepForPolling(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shouldUseAsyncTranscriptionFallback(error: unknown): boolean {
  return (
    error instanceof InventoryPreprocessingStepError &&
    error.step === "transcription" &&
    (error.code === "sync_upload_too_large" ||
      error.code === "sync_media_too_long")
  );
}

function determineInventoryPreprocessingStatus(
  textBundle: InventoryTextBundle,
): InventoryPreprocessingStatus {
  if (!hasUsableText(textBundle)) {
    return "NEEDS_REVIEW";
  }

  return textBundle.failedSteps.length > 0 ? "PARTIAL" : "READY_FOR_ENRICHMENT";
}

function hasUsableText(textBundle: InventoryTextBundle): boolean {
  return [
    textBundle.item.title,
    textBundle.item.note,
    textBundle.captureText,
    ...textBundle.mediaTexts.flatMap((mediaText) => [
      mediaText.ocrText,
      mediaText.transcript,
    ]),
  ].some((value) => Boolean(cleanString(value)));
}

function toInventoryPreprocessingFailedStep(
  error: unknown,
  step: InventoryPreprocessingFailedStep["step"],
  mediaId: string,
): InventoryPreprocessingFailedStep {
  if (error instanceof InventoryPreprocessingStepError) {
    return {
      code: error.code,
      mediaId,
      message: error.message,
      retryable: error.retryable,
      step,
    };
  }

  throw error;
}

function buildInventoryPreprocessingFailureDetail(
  job: InventoryPreprocessingJobRecord,
  error: unknown,
  leaseClaimedAt: Date | null | undefined,
  now: Date,
): InventoryPreprocessingFailureDetail {
  return {
    attempt: job.attempts,
    code:
      error instanceof InventoryPreprocessingSystemError ? error.code : undefined,
    failedAt: now.toISOString(),
    leaseClaimedAt: leaseClaimedAt?.toISOString() ?? null,
    message:
      error instanceof Error
        ? error.message
        : "Inventory preprocessing worker request failed.",
    retryable:
      error instanceof InventoryPreprocessingSystemError ? error.retryable : true,
  };
}

async function submitCompletedInventoryPreprocessingJob(
  repository: InventoryPreprocessingRuntimeRepository,
  input: {
    item: InventoryItemRecord;
    job: InventoryPreprocessingJobRecord;
    now: Date;
    textBundle: InventoryTextBundle;
  },
): Promise<InventoryPreprocessingJobRecord> {
  const nextStatus = determineInventoryPreprocessingStatus(input.textBundle);
  const completedJob = {
    ...input.job,
    claimedAt: null,
    claimedBy: null,
    completedAt: input.now,
    failureDetail: null,
    leaseExpiresAt: null,
    status: nextStatus,
    textBundle: input.textBundle,
    updatedAt: input.now,
  };
  const enrichmentJob =
    nextStatus === "READY_FOR_ENRICHMENT" || nextStatus === "PARTIAL"
      ? buildInventoryEnrichmentTextBundleJobInput(input.item, input.textBundle)
      : null;

  return repository.completeInventoryPreprocessingJob({
    enrichmentJob,
    job: completedJob,
  });
}

async function submitFailedInventoryPreprocessingJob(
  repository: InventoryPreprocessingRepository,
  input: {
    error: unknown;
    job: InventoryPreprocessingJobRecord;
    leaseClaimedAt: Date | null | undefined;
    now: Date;
  },
): Promise<InventoryPreprocessingJobRecord> {
  return repository.updateInventoryPreprocessingJob({
    ...input.job,
    claimedAt: null,
    claimedBy: null,
    completedAt: input.now,
    failureDetail: buildInventoryPreprocessingFailureDetail(
      input.job,
      input.error,
      input.leaseClaimedAt,
      input.now,
    ),
    leaseExpiresAt: null,
    status: "FAILED",
    textBundle: null,
    updatedAt: input.now,
  });
}

function buildInventoryPreprocessingFailureDetailFromMessage(
  job: InventoryPreprocessingJobRecord,
  code: string | undefined,
  message: string,
  retryable: boolean,
  leaseClaimedAt: Date | null | undefined,
  now: Date,
): InventoryPreprocessingFailureDetail {
  return {
    attempt: job.attempts,
    code,
    failedAt: now.toISOString(),
    leaseClaimedAt: leaseClaimedAt?.toISOString() ?? null,
    message,
    retryable,
  };
}

async function requireInventoryPreprocessingJob(
  repository: InventoryPreprocessingRepository,
  jobId: string,
): Promise<InventoryPreprocessingJobRecord> {
  const job = await repository.getInventoryPreprocessingJob(jobId);

  if (!job) {
    throw new Error("Inventory preprocessing job not found.");
  }

  return job;
}

function assertActiveInventoryPreprocessingLease(
  job: InventoryPreprocessingJobRecord,
  leaseClaimedAt: Date | null | undefined,
  now: Date,
): void {
  if (job.status !== "PROCESSING") {
    throw new Error("Inventory preprocessing job does not have an active lease.");
  }

  if (!job.claimedAt || !job.leaseExpiresAt) {
    throw new Error("Inventory preprocessing job does not have an active lease.");
  }

  if (job.leaseExpiresAt <= now) {
    throw new Error("Inventory preprocessing job lease is no longer active.");
  }

  if (
    leaseClaimedAt &&
    job.claimedAt.getTime() !== leaseClaimedAt.getTime()
  ) {
    throw new Error("Inventory preprocessing job lease is stale for this worker.");
  }
}

function isMatchingInventoryPreprocessingSuccess(
  job: InventoryPreprocessingJobRecord,
  textBundle: InventoryTextBundle,
): boolean {
  return (
    job.textBundle !== null &&
    stableFingerprint(job.textBundle) === stableFingerprint(textBundle)
  );
}

function isMatchingInventoryPreprocessingFailure(
  job: InventoryPreprocessingJobRecord,
  leaseClaimedAt: Date | null | undefined,
  message: string,
  retryable: boolean,
  code: string | undefined,
): boolean {
  if (!job.failureDetail || !leaseClaimedAt || job.status === "PROCESSING") {
    return false;
  }

  return (
    job.failureDetail.code === code &&
    job.failureDetail.leaseClaimedAt === leaseClaimedAt.toISOString() &&
    job.failureDetail.message === message &&
    job.failureDetail.retryable === retryable
  );
}

function shouldIgnoreInventoryPreprocessingFailure(
  job: InventoryPreprocessingJobRecord,
): boolean {
  return (
    (job.status === "READY_FOR_ENRICHMENT" ||
      job.status === "PARTIAL" ||
      job.status === "NEEDS_REVIEW") &&
    job.textBundle !== null
  );
}

function assertAcceptedExtension(
  acceptedExtensions: string[],
  filename: string,
  step: InventoryPreprocessingFailedStep["step"],
  code: string,
  message: string,
): void {
  const extension = filename.split(".").at(-1)?.trim().toLowerCase() ?? "";

  if (!extension || !acceptedExtensions.includes(extension)) {
    throw new InventoryPreprocessingStepError({
      code,
      message,
      retryable: false,
      step,
    });
  }
}

function toMediaInput(
  media: (
    | InventoryItemAssetRecord
    | InventoryItemImageRecord
    | InventoryItemAudioRecord
  ) & { id: string },
): InventoryGirkeMediaInput {
  return {
    filePath: media.filePath,
    mediaId: media.id,
    mimeType: media.mimeType ?? null,
    originalName: media.originalName ?? null,
    sizeBytes: media.sizeBytes ?? null,
  };
}

function inventoryAssetMediaType(
  asset: InventoryItemAssetRecord,
): "audio" | "image" | "video" | null {
  const mimeType = asset.mimeType?.toLowerCase() ?? "";

  if (mimeType.startsWith("image/")) {
    return "image";
  }

  if (mimeType.startsWith("audio/")) {
    return "audio";
  }

  if (mimeType.startsWith("video/")) {
    return "video";
  }

  const filename = asset.originalName ?? asset.filePath;

  if (/\.(?:gif|heic|jpe?g|png|webp)$/iu.test(filename)) {
    return "image";
  }

  if (/\.(?:aac|flac|m4a|mp3|ogg|opus|wav)$/iu.test(filename)) {
    return "audio";
  }

  if (/\.(?:avi|mkv|mov|mp4|mpeg|mpg|webm)$/iu.test(filename)) {
    return "video";
  }

  return null;
}

function isCompletedInventoryPreprocessingStatus(
  status: InventoryPreprocessingStatus,
): boolean {
  return (
    status === "READY_FOR_ENRICHMENT" ||
    status === "PARTIAL" ||
    status === "NEEDS_REVIEW" ||
    status === "FAILED"
  );
}

function parseInventoryPreprocessingFailureMessage(value: unknown): string {
  if (value === undefined || value === null) {
    return "Inventory preprocessing worker failed.";
  }

  if (typeof value !== "string") {
    throw new Error("Inventory preprocessing failure message must be a string.");
  }

  return cleanString(value) ?? "Inventory preprocessing worker failed.";
}

function parseInventoryPreprocessingFailureRetryable(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }

  if (typeof value !== "boolean") {
    throw new Error("Inventory preprocessing failure retryable must be a boolean.");
  }

  return value;
}

function parseInventoryPreprocessingFailureCode(
  value: unknown,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error("Inventory preprocessing failure code must be a string.");
  }

  return cleanString(value) ?? undefined;
}

function stableFingerprint(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJsonValue(child)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }

  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function cleanString(value: string | null | undefined): string | null {
  const normalized = value?.trim();

  return normalized ? normalized : null;
}
