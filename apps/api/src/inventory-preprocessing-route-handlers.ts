import { z } from "zod";

import {
  claimInventoryPreprocessingJobs,
  repairInventoryPreprocessingHandoffs,
  submitInventoryPreprocessingFailure,
  submitInventoryPreprocessingSuccess,
  type InventoryPreprocessingItemSnapshot,
  type InventoryPreprocessingRuntimeRepository,
  type InventoryTextBundle,
} from "./inventory-preprocessing-service";
import {
  INVENTORY_IMPORTANCE_VALUES,
  INVENTORY_ITEM_KINDS,
  INVENTORY_ITEM_STATUSES,
  type InventoryItemRecord,
} from "./inventory-service";

type PreprocessingClaimRequestBody = {
  leaseSeconds?: unknown;
  limit?: unknown;
  workerId?: unknown;
};

type PreprocessingSuccessRequestBody = {
  leaseClaimedAt?: unknown;
  textBundle?: unknown;
};

type PreprocessingFailureRequestBody = {
  code?: unknown;
  leaseClaimedAt?: unknown;
  message?: unknown;
  retryable?: unknown;
};

type AuthenticatedJsonBody<T> =
  | { ok: true; value: T }
  | { ok: false; response: Response };

const handoffRepairPromises = new WeakMap<object, Promise<void>>();

const inventoryTextBundleSchema: z.ZodType<InventoryTextBundle> = z
  .object({
    captureText: z.string().nullable(),
    failedSteps: z.array(
      z
        .object({
          code: z.string().optional(),
          mediaId: z.string().optional(),
          message: z.string(),
          retryable: z.boolean(),
          step: z.enum(["ocr", "transcription"]),
        })
        .strict(),
    ),
    item: z
      .object({
        containerLabel: z.string().nullable(),
        containerLocation: z.string().nullable(),
        id: z.string().min(1),
        importance: z.enum(INVENTORY_IMPORTANCE_VALUES),
        kind: z.enum(INVENTORY_ITEM_KINDS),
        note: z.string().nullable(),
        status: z.enum(INVENTORY_ITEM_STATUSES),
        title: z.string().nullable(),
      })
      .strict(),
    mediaTexts: z.array(
      z
        .object({
          mediaId: z.string().min(1),
          ocrLines: z.array(z.string()).optional(),
          ocrText: z.string().optional(),
          provider: z.literal("girke").optional(),
          providerJobId: z.string().optional(),
          providerModel: z.string().optional(),
          sourceMetadata: z.record(z.string(), z.unknown()).optional(),
          transcript: z.string().optional(),
          transcriptSegments: z
            .array(
              z
                .object({
                  end: z.number().finite(),
                  start: z.number().finite(),
                  text: z.string(),
                })
                .strict(),
            )
            .optional(),
          type: z.enum(["image", "audio", "video"]),
        })
        .strict(),
    ),
    schemaVersion: z.literal(1),
    sourceRefs: z.array(
      z
        .object({
          id: z.string().min(1),
          kind: z.enum(["item", "image", "audio", "asset"]),
        })
        .strict(),
    ),
  })
  .strict();

export async function handleInventoryPreprocessingClaim(
  request: Request,
  repository: InventoryPreprocessingRuntimeRepository,
  secret = process.env.INVENTORY_PREPROCESSING_WORKER_SECRET,
): Promise<Response> {
  const body = await readAuthenticatedJsonBody<PreprocessingClaimRequestBody>(
    request,
    secret,
  );

  if (!body.ok) {
    return body.response;
  }

  await repairInventoryPreprocessingHandoffsOnce(repository);

  const claimedJobs = await claimInventoryPreprocessingJobs(repository, {
    leaseSeconds: numberInput(body.value.leaseSeconds, 300),
    limit: numberInput(body.value.limit, 10),
    workerId: stringInput(body.value.workerId),
  });
  const jobs = [];

  for (const job of claimedJobs) {
    const item = await repository.getInventoryItem(job.targetItemId);

    if (!item) {
      await submitInventoryPreprocessingFailure(repository, {
        code: "item_not_found",
        jobId: job.id,
        leaseClaimedAt: job.claimedAt,
        message: "Inventory item not found for preprocessing.",
        retryable: false,
      });
      continue;
    }

    jobs.push({
      claimedAt: job.claimedAt,
      claimedBy: job.claimedBy,
      id: job.id,
      item: toPreprocessingItemSnapshot(item),
      leaseExpiresAt: job.leaseExpiresAt,
      sourceRefs: job.sourceRefs,
      status: job.status,
    });
  }

  return Response.json({ jobs });
}

async function repairInventoryPreprocessingHandoffsOnce(
  repository: InventoryPreprocessingRuntimeRepository,
): Promise<void> {
  const existing = handoffRepairPromises.get(repository);

  if (existing) {
    return existing;
  }

  const repair = repairInventoryPreprocessingHandoffs(repository)
    .then(() => undefined)
    .catch((error) => {
      handoffRepairPromises.delete(repository);
      throw error;
    });
  handoffRepairPromises.set(repository, repair);

  return repair;
}

export async function handleInventoryPreprocessingSuccess(
  request: Request,
  repository: InventoryPreprocessingRuntimeRepository,
  jobId: string,
  secret = process.env.INVENTORY_PREPROCESSING_WORKER_SECRET,
): Promise<Response> {
  const body = await readAuthenticatedJsonBody<PreprocessingSuccessRequestBody>(
    request,
    secret,
  );

  if (!body.ok) {
    return body.response;
  }

  try {
    const job = await submitInventoryPreprocessingSuccess(repository, {
      jobId,
      leaseClaimedAt: dateInput(body.value.leaseClaimedAt),
      textBundle: parseInventoryTextBundle(body.value.textBundle),
    });

    return Response.json({ job });
  } catch (error) {
    return jsonError(errorMessage(error), preprocessingMutationErrorStatus(error));
  }
}

export async function handleInventoryPreprocessingFailure(
  request: Request,
  repository: InventoryPreprocessingRuntimeRepository,
  jobId: string,
  secret = process.env.INVENTORY_PREPROCESSING_WORKER_SECRET,
): Promise<Response> {
  const body = await readAuthenticatedJsonBody<PreprocessingFailureRequestBody>(
    request,
    secret,
  );

  if (!body.ok) {
    return body.response;
  }

  try {
    const job = await submitInventoryPreprocessingFailure(repository, {
      code: body.value.code,
      jobId,
      leaseClaimedAt: dateInput(body.value.leaseClaimedAt),
      message: body.value.message,
      retryable: body.value.retryable,
    });

    return Response.json({ job });
  } catch (error) {
    return jsonError(errorMessage(error), preprocessingMutationErrorStatus(error));
  }
}

export function authenticateInventoryPreprocessingRequest(
  request: Request,
  secret = process.env.INVENTORY_PREPROCESSING_WORKER_SECRET,
): Response | null {
  if (!secret) {
    return jsonError("Inventory preprocessing worker secret is not configured.", 503);
  }

  const authorization = request.headers.get("authorization");
  const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  const headerToken = request.headers.get("x-inventory-preprocessing-secret");
  const token = bearerToken ?? headerToken;

  if (!token || !constantTimeEqual(token, secret)) {
    return jsonError("Unauthorized inventory preprocessing worker request.", 401);
  }

  return null;
}

function toPreprocessingItemSnapshot(
  item: InventoryItemRecord,
): InventoryPreprocessingItemSnapshot {
  return {
    assets: (item.assets ?? []).map((asset) => ({
      filePath: asset.filePath,
      id: asset.id,
      mimeType: asset.mimeType ?? null,
      originalName: asset.originalName ?? null,
      sizeBytes: asset.sizeBytes ?? null,
    })),
    audioNotes: (item.audioNotes ?? []).map((audioNote) => ({
      filePath: audioNote.filePath,
      id: audioNote.id,
      mimeType: audioNote.mimeType ?? null,
      originalName: audioNote.originalName ?? null,
      sizeBytes: audioNote.sizeBytes ?? null,
    })),
    captureText: item.captureText ?? null,
    category: item.category,
    containerLabel: item.containerLabel,
    id: item.id,
    images: item.images.map((image) => ({
      caption: image.caption ?? null,
      filePath: image.filePath,
      height: image.height ?? null,
      id: image.id,
      mimeType: image.mimeType ?? null,
      ocrText: image.ocrText ?? null,
      originalName: image.originalName ?? null,
      sizeBytes: image.sizeBytes ?? null,
      width: image.width ?? null,
    })),
    importance: item.importance,
    kind: item.kind,
    locationName: item.locationName,
    note: item.note,
    originLocationName: item.originLocationName,
    status: item.status,
    title: item.title,
  };
}

function parseInventoryTextBundle(value: unknown): InventoryTextBundle {
  const parsed = inventoryTextBundleSchema.safeParse(value);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".");

    throw new Error(
      path
        ? `Inventory preprocessing text bundle ${path} is invalid.`
        : "Inventory preprocessing text bundle is invalid.",
    );
  }

  return parsed.data;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

async function readAuthenticatedJsonBody<T>(
  request: Request,
  secret: string | undefined,
): Promise<AuthenticatedJsonBody<T>> {
  const authResponse = authenticateInventoryPreprocessingRequest(request, secret);

  if (authResponse) {
    return { ok: false, response: authResponse };
  }

  const body = await readJsonBody<T>(request);

  if (!body.ok) {
    return { ok: false, response: jsonError(body.message, 400) };
  }

  return { ok: true, value: body.value };
}

async function readJsonBody<T>(
  request: Request,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: (await request.json()) as T };
  } catch {
    return { ok: false, message: "Request body must be JSON." };
  }
}

function numberInput(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringInput(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function dateInput(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Inventory preprocessing worker request failed.";
}

function preprocessingMutationErrorStatus(error: unknown): number {
  if (
    error instanceof Error &&
    (error.message.includes("stale") ||
      error.message.includes("does not have an active lease") ||
      error.message.includes("lease is no longer active"))
  ) {
    return 409;
  }

  if (
    error instanceof Error &&
    (error.message.startsWith("Inventory preprocessing text bundle") ||
      error.message === "Inventory item not found for preprocessing.")
  ) {
    return 400;
  }

  return 500;
}

function constantTimeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return diff === 0;
}
