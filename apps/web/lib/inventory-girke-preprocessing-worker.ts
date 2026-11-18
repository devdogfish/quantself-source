import { z } from "zod";

import {
  InventoryPreprocessingStepError,
  InventoryPreprocessingSystemError,
  buildInventoryTextBundle,
  type InventoryGirkePreprocessingAdapter,
  type InventoryPreprocessingItemSnapshot,
  type InventoryPreprocessingSourceRef,
  type InventoryTextBundle,
  type InventoryTranscriptionPollingRuntime,
} from "../../api/src/inventory-preprocessing-service";
import { INVENTORY_CATEGORY_VALUES } from "../../api/src/inventory-service";

export type InventoryPreprocessingWorkerClaimedJob = {
  claimedAt: string | null;
  id: string;
  item: InventoryPreprocessingItemSnapshot;
  sourceRefs: InventoryPreprocessingSourceRef[];
};

export interface InventoryGirkePreprocessingWorkerApiClient {
  claimJobs(input: {
    leaseSeconds: number;
    limit: number;
    workerId: string;
  }): Promise<InventoryPreprocessingWorkerClaimedJob[]>;
  submitSuccess(input: {
    jobId: string;
    leaseClaimedAt: string | null;
    textBundle: InventoryTextBundle;
  }): Promise<void>;
  submitFailure(input: {
    code?: string;
    jobId: string;
    leaseClaimedAt: string | null;
    message: string;
    retryable: boolean;
  }): Promise<void>;
}

export class InventoryGirkePreprocessingWorkerApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "InventoryGirkePreprocessingWorkerApiError";
    this.status = status;
  }
}

export function createInventoryGirkePreprocessingWorkerApiClient(input: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  secret: string;
}): InventoryGirkePreprocessingWorkerApiClient {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const fetchImpl = input.fetchImpl ?? fetch;

  return {
    async claimJobs(request) {
      const body = await postJson(fetchImpl, {
        baseUrl,
        body: request,
        pathname: "/api/internal/inventory/preprocessing/jobs/claim",
        secret: input.secret,
      });

      return parseClaimJobsResponse(body);
    },
    async submitFailure(request) {
      await postJson(fetchImpl, {
        baseUrl,
        body: {
          code: request.code,
          leaseClaimedAt: request.leaseClaimedAt,
          message: request.message,
          retryable: request.retryable,
        },
        pathname: `/api/internal/inventory/preprocessing/jobs/${request.jobId}/failure`,
        secret: input.secret,
      });
    },
    async submitSuccess(request) {
      await postJson(fetchImpl, {
        baseUrl,
        body: {
          leaseClaimedAt: request.leaseClaimedAt,
          textBundle: request.textBundle,
        },
        pathname: `/api/internal/inventory/preprocessing/jobs/${request.jobId}/success`,
        secret: input.secret,
      });
    },
  };
}

export async function runInventoryGirkePreprocessingWorkerOnce(input: {
  adapter: InventoryGirkePreprocessingAdapter;
  apiClient: InventoryGirkePreprocessingWorkerApiClient;
  leaseSeconds?: number;
  limit?: number;
  pollingRuntime?: InventoryTranscriptionPollingRuntime;
  workerId: string;
}): Promise<{
  claimed: number;
  failed: number;
  processed: number;
  succeeded: number;
}> {
  const leaseSeconds = clampInteger(input.leaseSeconds ?? 300, 1, 60 * 60);
  const jobs = await input.apiClient.claimJobs({
    leaseSeconds,
    limit: clampInteger(input.limit ?? 10, 1, 50),
    workerId: input.workerId,
  });
  const summary = {
    claimed: jobs.length,
    failed: 0,
    processed: 0,
    succeeded: 0,
  };

  for (const job of jobs) {
    summary.processed += 1;

    const outcome = await processClaimedJob({
      adapter: input.adapter,
      apiClient: input.apiClient,
      job,
      pollingRuntime: input.pollingRuntime,
      transcriptionPollTimeoutMs: transcriptionPollTimeoutForLease({
        claimedAt: job.claimedAt,
        leaseSeconds,
        now: input.pollingRuntime?.now() ?? Date.now(),
      }),
    });

    if (outcome === "succeeded") {
      summary.succeeded += 1;
    } else {
      summary.failed += 1;
    }
  }

  return summary;
}

async function processClaimedJob(input: {
  adapter: InventoryGirkePreprocessingAdapter;
  apiClient: InventoryGirkePreprocessingWorkerApiClient;
  job: InventoryPreprocessingWorkerClaimedJob;
  pollingRuntime?: InventoryTranscriptionPollingRuntime;
  transcriptionPollTimeoutMs: number;
}): Promise<"failed" | "succeeded"> {
  try {
    const textBundle = await buildInventoryTextBundle(
      input.job.item,
      input.job.sourceRefs,
      input.adapter,
      {
        transcriptionPolling: {
          runtime: input.pollingRuntime,
          timeoutMs: input.transcriptionPollTimeoutMs,
        },
      },
    );

    await input.apiClient.submitSuccess({
      jobId: input.job.id,
      leaseClaimedAt: input.job.claimedAt,
      textBundle,
    });

    return "succeeded";
  } catch (error) {
    const failure = toWorkerFailure(error);

    await input.apiClient.submitFailure({
      code: failure.code,
      jobId: input.job.id,
      leaseClaimedAt: input.job.claimedAt,
      message: failure.message,
      retryable: failure.retryable,
    });

    return "failed";
  }
}

function toWorkerFailure(error: unknown): {
  code?: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof InventoryPreprocessingSystemError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }

  if (error instanceof InventoryPreprocessingStepError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }

  if (error instanceof InventoryGirkePreprocessingWorkerApiError) {
    return {
      message: error.message,
      retryable:
        error.status === 408 ||
        error.status === 425 ||
        error.status === 429 ||
        error.status >= 500,
    };
  }

  return {
    message:
      error instanceof Error
        ? error.message
        : "Inventory preprocessing worker failed.",
    retryable: true,
  };
}

async function postJson(
  fetchImpl: typeof fetch,
  input: {
    baseUrl: string;
    body: unknown;
    pathname: string;
    secret: string;
  },
): Promise<unknown> {
  const response = await fetchImpl(`${input.baseUrl}${input.pathname}`, {
    body: JSON.stringify(input.body),
    headers: {
      authorization: `Bearer ${input.secret}`,
      "content-type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new InventoryGirkePreprocessingWorkerApiError(
      response.status,
      await readApiErrorMessage(response),
    );
  }

  return response.json();
}

async function readApiErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };

    if (typeof body.error === "string" && body.error.trim()) {
      return body.error;
    }
  } catch {}

  return `Inventory preprocessing worker API request failed with status ${response.status}.`;
}

function parseClaimJobsResponse(value: unknown): InventoryPreprocessingWorkerClaimedJob[] {
  const parsed = z
    .object({
      jobs: z.array(
        z.object({
          claimedAt: z.string().nullable(),
          id: z.string().min(1),
          item: z
            .object({
              assets: z
                .array(
                  z.object({
                    filePath: z.string().min(1),
                    id: z.string().optional(),
                    mimeType: z.string().nullable().optional(),
                    originalName: z.string().nullable().optional(),
                    sizeBytes: z.number().nullable().optional(),
                  }),
                )
                .optional(),
              audioNotes: z
                .array(
                  z.object({
                    filePath: z.string().min(1),
                    id: z.string().optional(),
                    mimeType: z.string().nullable().optional(),
                    originalName: z.string().nullable().optional(),
                    sizeBytes: z.number().nullable().optional(),
                  }),
                )
                .optional(),
              captureText: z.string().nullable().optional(),
              category: z.enum(INVENTORY_CATEGORY_VALUES).nullable(),
              containerLabel: z.string().nullable(),
              id: z.string().min(1),
              images: z.array(
                z.object({
                  caption: z.string().nullable().optional(),
                  filePath: z.string().min(1),
                  height: z.number().nullable().optional(),
                  id: z.string().optional(),
                  mimeType: z.string().nullable().optional(),
                  ocrText: z.string().nullable().optional(),
                  originalName: z.string().nullable().optional(),
                  sizeBytes: z.number().nullable().optional(),
                  width: z.number().nullable().optional(),
                }),
              ),
              importance: z.enum(["HIGH", "MEDIUM", "LOW"]),
              kind: z.enum(["ITEM", "GROUP"]),
              locationName: z.string().nullable(),
              note: z.string().nullable(),
              originLocationName: z.string().nullable(),
              status: z.enum(["KEEP", "DONATE", "TRASH", "UNSURE"]),
              title: z.string().nullable(),
            })
            .strict(),
          sourceRefs: z.array(
            z
              .object({
                id: z.string().min(1),
                kind: z.enum(["item", "image", "audio", "asset"]),
              })
              .strict(),
          ),
        }),
      ),
    })
    .safeParse(value);

  if (!parsed.success) {
    throw new InventoryGirkePreprocessingWorkerApiError(
      500,
      "Inventory preprocessing worker claim response is invalid.",
    );
  }

  return parsed.data.jobs;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }

  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function transcriptionPollTimeoutForLease(input: {
  claimedAt: string | null;
  leaseSeconds: number;
  now: number;
}): number {
  const leaseMilliseconds = input.leaseSeconds * 1000;
  const claimedAt = input.claimedAt ? Date.parse(input.claimedAt) : Number.NaN;
  const elapsedLeaseMilliseconds = Number.isFinite(claimedAt)
    ? Math.max(0, input.now - claimedAt)
    : 0;
  const completionBufferMilliseconds = Math.min(5_000, leaseMilliseconds);

  return Math.max(
    0,
    leaseMilliseconds -
      elapsedLeaseMilliseconds -
      completionBufferMilliseconds,
  );
}
