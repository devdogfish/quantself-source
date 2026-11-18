import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

import { Codex } from "@openai/codex-sdk";
import { z } from "zod";

import {
  INVENTORY_ENRICHMENT_JOB_KINDS,
  type InventoryEnrichmentJobKind,
  type InventoryEnrichmentResultPayload,
} from "../../api/src/inventory-enrichment-service";
import type { InventoryTextBundle } from "../../api/src/inventory-preprocessing-service";
import {
  INVENTORY_ACQUISITION_SOURCE_VALUES,
  INVENTORY_CATEGORY_VALUES,
  INVENTORY_IMPORTANCE_VALUES,
  INVENTORY_ITEM_STATUSES,
  normalizeInventoryAcquisitionSource,
  normalizeInventoryCategory,
} from "../../api/src/inventory-service";

const INVENTORY_CODEX_OUTPUT_SCHEMA = {
  additionalProperties: false,
  properties: {
    aliases: {
      items: { type: "string" },
      type: ["array", "null"],
    },
    acquisitionSource: {
      enum: [...INVENTORY_ACQUISITION_SOURCE_VALUES, null],
      type: ["string", "null"],
    },
    category: {
      enum: [...INVENTORY_CATEGORY_VALUES, null],
      type: ["string", "null"],
    },
    confidence: { type: "number" },
    costCents: {
      minimum: 0,
      type: ["integer", "null"],
    },
    importance: {
      enum: [...INVENTORY_IMPORTANCE_VALUES, null],
      type: ["string", "null"],
    },
    note: { type: ["string", "null"] },
    rationale: { type: "string" },
    status: {
      enum: [...INVENTORY_ITEM_STATUSES, null],
      type: ["string", "null"],
    },
    tags: {
      items: { type: "string" },
      type: ["array", "null"],
    },
    title: { type: ["string", "null"] },
  },
  required: [
    "aliases",
    "acquisitionSource",
    "category",
    "confidence",
    "costCents",
    "importance",
    "note",
    "rationale",
    "status",
    "tags",
    "title",
  ],
  type: "object",
} as const;

const inventoryCodexOutputParser = z
  .object({
    aliases: z.array(z.string()).nullish(),
    acquisitionSource: z.enum(INVENTORY_ACQUISITION_SOURCE_VALUES).nullish(),
    category: z.enum(INVENTORY_CATEGORY_VALUES).nullish(),
    confidence: z.number().finite(),
    costCents: z.number().int().nonnegative().nullish(),
    importance: z.enum(INVENTORY_IMPORTANCE_VALUES).nullish(),
    note: z.string().nullish(),
    rationale: z.string().trim().min(1),
    status: z.enum(INVENTORY_ITEM_STATUSES).nullish(),
    tags: z.array(z.string()).nullish(),
    title: z.string().nullish(),
  })
  .strict();

const EXTERNAL_URL_PATTERN = /\bhttps?:\/\/\S+/gi;
const BEARER_TOKEN_PATTERN = /\bbearer\s+\S+/gi;
const LOCAL_STORAGE_PATH_PATTERN =
  /\bstorage\/inventory-(?:audio|images)\/\S+/gi;
const LOCAL_FILE_URI_PATTERN = /\bfile:\/\/\S+/gi;
const ABSOLUTE_FILE_PATH_PATTERN =
  /(?:^|[\s"'`])(?:\/(?:home|tmp|var|Users)\/\S+|[A-Za-z]:\\\S+)/g;
const CODEX_ENV_ALLOWLIST = new Set([
  "CODEX_HOME",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "NO_PROXY",
  "PATH",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
]);
const DEFAULT_CODEX_WORKING_DIRECTORY = "/tmp/quantself-inventory-codex-worker";

export type InventoryEnrichmentWorkerClaimedJob = {
  id: string;
  kind: InventoryEnrichmentJobKind;
  claimedAt: string | null;
  inputSnapshot: unknown;
};

export type InventoryCodexEnrichmentResult = Omit<
  InventoryEnrichmentResultPayload,
  "imageCaption" | "imageOcrText"
>;

export interface InventoryCodexEnrichmentWorkerApiClient {
  claimJobs(input: {
    leaseSeconds: number;
    limit: number;
    workerId: string;
  }): Promise<InventoryEnrichmentWorkerClaimedJob[]>;
  submitSuccess(input: {
    jobId: string;
    leaseClaimedAt: string | null;
    result: InventoryCodexEnrichmentResult;
    resultId: string;
  }): Promise<void>;
  submitFailure(input: {
    jobId: string;
    leaseClaimedAt: string | null;
    message: string;
    retryable: boolean;
  }): Promise<void>;
}

export interface InventoryCodexEnrichmentClient {
  runInventoryEnrichment(input: {
    outputSchema: unknown;
    prompt: string;
  }): Promise<{ finalResponse: string; resultId: string }>;
}

export class InventoryCodexEnrichmentWorkerError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = "InventoryCodexEnrichmentWorkerError";
    this.retryable = retryable;
  }
}

export class InventoryCodexEnrichmentWorkerApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "InventoryCodexEnrichmentWorkerApiError";
    this.status = status;
  }
}

export function createInventoryCodexEnrichmentWorkerApiClient(input: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  secret: string;
}): InventoryCodexEnrichmentWorkerApiClient {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const fetchImpl = input.fetchImpl ?? fetch;

  return {
    async claimJobs(request) {
      const body = await postJson(fetchImpl, {
        baseUrl,
        body: request,
        pathname: "/api/internal/inventory/enrichment/jobs/claim",
        secret: input.secret,
      });

      return parseClaimJobsResponse(body);
    },
    async submitFailure(request) {
      await postJson(fetchImpl, {
        baseUrl,
        body: {
          leaseClaimedAt: request.leaseClaimedAt,
          message: request.message,
          retryable: request.retryable,
        },
        pathname: `/api/internal/inventory/enrichment/jobs/${request.jobId}/failure`,
        secret: input.secret,
      });
    },
    async submitSuccess(request) {
      await postJson(fetchImpl, {
        baseUrl,
        body: {
          leaseClaimedAt: request.leaseClaimedAt,
          result: request.result,
          resultId: request.resultId,
        },
        pathname: `/api/internal/inventory/enrichment/jobs/${request.jobId}/success`,
        secret: input.secret,
      });
    },
  };
}

export function createCodexSdkInventoryEnrichmentClient(
  input: {
    codex?: Codex;
    environment?: Record<string, string | undefined>;
    model?: string | null;
    workingDirectory?: string;
  } = {},
): InventoryCodexEnrichmentClient {
  const codex =
    input.codex ??
    new Codex({
      env: buildCodexCliEnvironment(input.environment ?? process.env),
    });
  const model = cleanOptionalString(input.model) ?? null;
  const workingDirectory =
    cleanOptionalString(input.workingDirectory) ??
    DEFAULT_CODEX_WORKING_DIRECTORY;

  return {
    async runInventoryEnrichment(request) {
      await mkdir(workingDirectory, { recursive: true });

      const thread = codex.startThread({
        approvalPolicy: "never",
        model: model ?? undefined,
        networkAccessEnabled: false,
        sandboxMode: "read-only",
        skipGitRepoCheck: true,
        webSearchEnabled: false,
        workingDirectory,
      });
      const turn = await thread.run(request.prompt, {
        outputSchema: request.outputSchema,
      });

      return {
        finalResponse: turn.finalResponse,
        resultId: thread.id ?? randomUUID(),
      };
    },
  };
}

export async function runInventoryCodexEnrichmentWorkerOnce(input: {
  apiClient: InventoryCodexEnrichmentWorkerApiClient;
  codexClient: InventoryCodexEnrichmentClient;
  leaseSeconds?: number;
  limit?: number;
  workerId: string;
}): Promise<{
  claimed: number;
  failed: number;
  processed: number;
  succeeded: number;
}> {
  const jobs = await input.apiClient.claimJobs({
    leaseSeconds: clampInteger(input.leaseSeconds ?? 300, 1, 60 * 60),
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
      apiClient: input.apiClient,
      codexClient: input.codexClient,
      job,
    });

    if (outcome === "succeeded") {
      summary.succeeded += 1;
    } else {
      summary.failed += 1;
    }
  }

  return summary;
}

export function buildInventoryCodexEnrichmentPrompt(
  textBundle: InventoryTextBundle,
): string {
  return [
    "You create an inventory proposal from text-only evidence.",
    "Return strict JSON only.",
    "Use only the provided evidence. Use null for proposal fields when evidence is weak.",
    "Allowed fields: title, category, acquisitionSource, costCents, tags, aliases, status, importance, note, confidence, rationale.",
    `Allowed category values: ${INVENTORY_CATEGORY_VALUES.join(", ")}.`,
    `Allowed acquisition source values: ${INVENTORY_ACQUISITION_SOURCE_VALUES.join(", ")}.`,
    "costCents must be a non-negative integer in CAD cents.",
    "Do not include markdown, commentary, or extra keys.",
    "Evidence JSON:",
    JSON.stringify(buildPromptEvidence(textBundle), null, 2),
  ].join("\n");
}

async function processClaimedJob(input: {
  apiClient: InventoryCodexEnrichmentWorkerApiClient;
  codexClient: InventoryCodexEnrichmentClient;
  job: InventoryEnrichmentWorkerClaimedJob;
}): Promise<"failed" | "succeeded"> {
  try {
    const textBundle = requireTextBundleJob(input.job);
    const prompt = buildInventoryCodexEnrichmentPrompt(textBundle);
    const response = await input.codexClient.runInventoryEnrichment({
      outputSchema: INVENTORY_CODEX_OUTPUT_SCHEMA,
      prompt,
    });
    const normalizedResult = normalizeInventoryCodexEnrichmentResult(
      response.finalResponse,
    );

    await input.apiClient.submitSuccess({
      jobId: input.job.id,
      leaseClaimedAt: input.job.claimedAt,
      result: normalizedResult,
      resultId: response.resultId,
    });

    return "succeeded";
  } catch (error) {
    const failure = toWorkerFailure(error);

    await input.apiClient.submitFailure({
      jobId: input.job.id,
      leaseClaimedAt: input.job.claimedAt,
      message: failure.message,
      retryable: failure.retryable,
    });

    return "failed";
  }
}

function requireTextBundleJob(
  job: InventoryEnrichmentWorkerClaimedJob,
): InventoryTextBundle {
  if (job.kind !== "INVENTORY_ITEM_ENRICHMENT") {
    throw new InventoryCodexEnrichmentWorkerError(
      "Inventory enrichment worker only supports bundle-only item jobs.",
    );
  }

  if (
    !job.inputSnapshot ||
    typeof job.inputSnapshot !== "object" ||
    !("textBundle" in job.inputSnapshot)
  ) {
    throw new InventoryCodexEnrichmentWorkerError(
      "Inventory enrichment worker only supports bundle-only item jobs.",
    );
  }

  return (job.inputSnapshot as { textBundle: InventoryTextBundle }).textBundle;
}

function normalizeInventoryCodexEnrichmentResult(
  finalResponse: string,
): InventoryCodexEnrichmentResult {
  const parsed = parseInventoryCodexEnrichmentOutput(finalResponse);

  return {
    aliases: cleanStringArray(parsed.aliases),
    acquisitionSource:
      normalizeInventoryAcquisitionSource(parsed.acquisitionSource) ?? null,
    category: normalizeInventoryCategory(parsed.category),
    costCents: parsed.costCents ?? null,
    importance: parsed.importance ?? null,
    metadata: {
      confidence: parsed.confidence,
      rationale: parsed.rationale.trim(),
    },
    note: cleanOptionalString(parsed.note),
    searchTextAdditions: [],
    status: parsed.status ?? null,
    tags: cleanStringArray(parsed.tags),
    title: cleanOptionalString(parsed.title),
  };
}

function parseInventoryCodexEnrichmentOutput(finalResponse: string) {
  let parsed: unknown;

  try {
    parsed = JSON.parse(finalResponse);
  } catch {
    throw new InventoryCodexEnrichmentWorkerError(
      "Codex enrichment output must be strict JSON.",
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InventoryCodexEnrichmentWorkerError(
      "Codex enrichment output must be a JSON object.",
    );
  }

  const result = inventoryCodexOutputParser.safeParse(parsed);

  if (!result.success) {
    throw new InventoryCodexEnrichmentWorkerError(
      formatCodexOutputValidationError(result.error.issues[0]),
    );
  }

  return result.data;
}

function formatCodexOutputValidationError(
  issue: z.ZodIssue | undefined,
): string {
  if (!issue) {
    return "Codex enrichment output is invalid.";
  }

  if (issue.code === "unrecognized_keys") {
    return `Codex enrichment output field is not allowed: ${issue.keys.join(", ")}`;
  }

  const path = issue.path.join(".");

  if (path) {
    return `Codex enrichment output ${path} is invalid.`;
  }

  return "Codex enrichment output is invalid.";
}

function buildPromptEvidence(textBundle: InventoryTextBundle): unknown {
  return {
    captureText: sanitizePromptString(textBundle.captureText),
    failedSteps: textBundle.failedSteps.map((failedStep) => ({
      ...failedStep,
      message: sanitizePromptString(failedStep.message) ?? "",
    })),
    item: {
      containerLabel: sanitizePromptString(textBundle.item.containerLabel),
      containerLocation: sanitizePromptString(
        textBundle.item.containerLocation,
      ),
      id: textBundle.item.id,
      importance: textBundle.item.importance,
      kind: textBundle.item.kind,
      note: sanitizePromptString(textBundle.item.note),
      status: textBundle.item.status,
      title: sanitizePromptString(textBundle.item.title),
    },
    mediaTexts: textBundle.mediaTexts.map((mediaText) => ({
      mediaId: mediaText.mediaId,
      ocrLines: mediaText.ocrLines?.map(
        (line) => sanitizePromptString(line) ?? "",
      ),
      ocrText: sanitizePromptString(mediaText.ocrText),
      transcript: sanitizePromptString(mediaText.transcript),
      transcriptSegments: mediaText.transcriptSegments?.map((segment) => ({
        end: segment.end,
        start: segment.start,
        text: sanitizePromptString(segment.text) ?? "",
      })),
      type: mediaText.type,
    })),
    schemaVersion: textBundle.schemaVersion,
    sourceRefs: textBundle.sourceRefs,
  };
}

function sanitizePromptString(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const sanitized = value
    .replace(BEARER_TOKEN_PATTERN, "[redacted bearer token]")
    .replace(EXTERNAL_URL_PATTERN, "[redacted url]")
    .replace(LOCAL_STORAGE_PATH_PATTERN, "[redacted storage path]")
    .replace(LOCAL_FILE_URI_PATTERN, "[redacted file uri]")
    .replace(ABSOLUTE_FILE_PATH_PATTERN, " [redacted file path]");

  return cleanOptionalString(sanitized);
}

function cleanOptionalString(value: string | null | undefined): string | null {
  const cleaned = value?.trim();

  return cleaned ? cleaned : null;
}

function cleanStringArray(values: string[] | null | undefined): string[] {
  if (!values) {
    return [];
  }

  const cleaned = new Map<string, string>();

  for (const value of values) {
    const normalized = cleanOptionalString(value);

    if (normalized) {
      cleaned.set(normalized.toLowerCase(), normalized);
    }
  }

  return [...cleaned.values()].sort((left, right) => left.localeCompare(right));
}

function buildCodexCliEnvironment(
  environment: Record<string, string | undefined>,
): Record<string, string> {
  const filtered: Record<string, string> = {};

  for (const [key, value] of Object.entries(environment)) {
    if (!CODEX_ENV_ALLOWLIST.has(key) || !value) {
      continue;
    }

    filtered[key] = value;
  }

  return filtered;
}

function toWorkerFailure(error: unknown): {
  message: string;
  retryable: boolean;
} {
  if (error instanceof InventoryCodexEnrichmentWorkerError) {
    return { message: error.message, retryable: error.retryable };
  }

  if (error instanceof InventoryCodexEnrichmentWorkerApiError) {
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
        : "Inventory Codex enrichment worker failed.",
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
    throw new InventoryCodexEnrichmentWorkerApiError(
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

  return `Inventory enrichment worker API request failed with status ${response.status}.`;
}

function parseClaimJobsResponse(
  value: unknown,
): InventoryEnrichmentWorkerClaimedJob[] {
  const parsed = z
    .object({
      jobs: z.array(
        z.object({
          claimedAt: z.string().nullable(),
          id: z.string().min(1),
          inputSnapshot: z.unknown(),
          kind: z.enum(INVENTORY_ENRICHMENT_JOB_KINDS),
        }),
      ),
    })
    .safeParse(value);

  if (!parsed.success) {
    throw new InventoryCodexEnrichmentWorkerApiError(
      500,
      "Inventory enrichment worker claim response is invalid.",
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
