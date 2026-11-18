import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import sharp from "sharp";
import {
  InventoryPreprocessingStepError,
  InventoryPreprocessingSystemError,
  type InventoryGirkeMediaInput,
  type InventoryGirkeOcrMetadata,
  type InventoryGirkeOcrResult,
  type InventoryGirkePreprocessingAdapter,
  type InventoryGirkeTranscriptionJob,
  type InventoryGirkeTranscriptionJobAccepted,
  type InventoryGirkeTranscriptionJobResult,
  type InventoryGirkeTranscriptionMetadata,
  type InventoryGirkeTranscriptionSyncResult,
} from "../../api/src/inventory-preprocessing-service";

const OCR_MAX_IMAGE_DIMENSION = 1000;

export function resolveInventoryGirkeBaseUrl(
  value: string | null | undefined,
): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new InventoryPreprocessingSystemError({
      code: "girke_credentials_missing",
      message: "Girke API base URL is not configured.",
      retryable: false,
    });
  }

  return normalized.replace(/\/+$/, "");
}

export function createInventoryGirkePreprocessingAdapter(input: {
  apiToken?: string | null;
  baseUrl?: string | null;
  fetch?: typeof globalThis.fetch;
} = {}): InventoryGirkePreprocessingAdapter {
  const apiToken = input.apiToken?.trim() || process.env.GIRKE_API_TOKEN?.trim();

  if (!apiToken) {
    throw new InventoryPreprocessingSystemError({
      code: "girke_credentials_missing",
      message: "Girke API token is not configured.",
      retryable: false,
    });
  }

  const baseUrl = resolveInventoryGirkeBaseUrl(
    input.baseUrl ?? process.env.GIRKE_API_BASE_URL,
  );
  const fetchImplementation = input.fetch ?? globalThis.fetch;

  return {
    async createTranscriptionJob(mediaInput) {
      const formData = await createTranscriptionFormData(mediaInput);
      const response = await fetchImplementation(
        `${baseUrl}/api/v1/transcription/jobs`,
        {
          body: formData,
          headers: bearerHeaders(apiToken),
          method: "POST",
        },
      );
      const body = await parseJsonBody(response);

      if (response.status !== 202) {
        throwTranscriptionStepError(response.status, body);
      }

      return {
        createdAt: stringValue(body?.created_at),
        detectedLanguage: optionalStringValue(body?.detected_language),
        jobId: stringValue(body?.job_id),
        language: stringValue(body?.language),
        level: stringValue(body?.level),
        status: "queued",
      } satisfies InventoryGirkeTranscriptionJobAccepted;
    },

    async getOcrMetadata() {
      const response = await fetchImplementation(`${baseUrl}/api/v1/ocr`, {
        headers: bearerHeaders(apiToken),
      });
      const body = await parseJsonBody(response);

      if (!response.ok) {
        throwOcrStepError(response.status, body);
      }

      return {
        acceptedImageFormats: stringArrayValue(body?.accepted_image_formats),
        maxUploadBytes: numberValue(body?.max_upload_bytes),
        model: stringValue(body?.model),
        timeoutSeconds: numberValue(body?.timeout_seconds),
      } satisfies InventoryGirkeOcrMetadata;
    },

    async getTranscriptionJob(jobId) {
      const response = await fetchImplementation(
        `${baseUrl}/api/v1/transcription/jobs/${encodeURIComponent(jobId)}`,
        {
          headers: bearerHeaders(apiToken),
        },
      );
      const body = await parseJsonBody(response);

      if (!response.ok) {
        throwTranscriptionStepError(response.status, body);
      }

      return {
        error: errorObjectValue(body?.error),
        jobId: stringValue(body?.job_id),
        status: stringValue(body?.status) as InventoryGirkeTranscriptionJob["status"],
      };
    },

    async getTranscriptionJobResult(jobId) {
      const response = await fetchImplementation(
        `${baseUrl}/api/v1/transcription/jobs/${encodeURIComponent(jobId)}/result`,
        {
          headers: bearerHeaders(apiToken),
        },
      );
      const body = await parseJsonBody(response);

      if (!response.ok) {
        throwTranscriptionStepError(response.status, body);
      }

      return {
        detectedLanguage: optionalStringValue(body?.detected_language),
        durationSeconds: numberValue(body?.duration_seconds),
        jobId: stringValue(body?.job_id),
        language: stringValue(body?.language),
        level: stringValue(body?.level),
        model: stringValue(body?.model),
        processingSeconds: numberValue(body?.processing_seconds),
        segments: arrayValue(body?.segments).map((segment) => {
          const segmentRecord = objectRecord(segment);

          return {
            chunkIndex: optionalNumberValue(segmentRecord?.chunk_index),
            end: numberValue(segmentRecord?.end),
            start: numberValue(segmentRecord?.start),
            text: stringValue(segmentRecord?.text),
          };
        }),
        status: "completed",
        text: stringValue(body?.text),
      } satisfies InventoryGirkeTranscriptionJobResult;
    },

    async getTranscriptionMetadata() {
      const response = await fetchImplementation(
        `${baseUrl}/api/v1/transcription`,
        {
          headers: bearerHeaders(apiToken),
        },
      );
      const body = await parseJsonBody(response);

      if (!response.ok) {
        throwTranscriptionStepError(response.status, body);
      }

      const acceptedMedia = objectRecord(body?.accepted_media);

      return {
        acceptedAudioFormats: stringArrayValue(acceptedMedia?.audio),
        acceptedVideoFormats: stringArrayValue(acceptedMedia?.video),
        defaultLevel: stringValue(body?.default_level),
        languageOptional: Boolean(body?.language_optional),
        languages: arrayValue(body?.languages).map((language) =>
          stringValue(objectRecord(language)?.code),
        ),
        levels: stringArrayValue(body?.levels),
      } satisfies InventoryGirkeTranscriptionMetadata;
    },

    async recognizeOcr(mediaInput) {
      const response = await fetchImplementation(`${baseUrl}/api/v1/ocr`, {
        body: await createOcrFormData(mediaInput),
        headers: bearerHeaders(apiToken),
        method: "POST",
      });
      const body = await parseJsonBody(response);

      if (!response.ok) {
        throwOcrStepError(response.status, body);
      }

      return {
        lines: stringArrayValue(body?.lines),
        model: stringValue(body?.model),
        processingSeconds: numberValue(body?.processing_seconds),
        text: stringValue(body?.text),
      } satisfies InventoryGirkeOcrResult;
    },

    async transcribeSynchronously(mediaInput) {
      const response = await fetchImplementation(
        `${baseUrl}/api/v1/transcription/transcribe`,
        {
          body: await createTranscriptionFormData(mediaInput),
          headers: bearerHeaders(apiToken),
          method: "POST",
        },
      );
      const body = await parseJsonBody(response);

      if (!response.ok) {
        throwTranscriptionStepError(response.status, body);
      }

      return {
        detectedLanguage: optionalStringValue(body?.detected_language),
        durationSeconds: numberValue(body?.duration_seconds),
        language: stringValue(body?.language),
        level: stringValue(body?.level),
        model: stringValue(body?.model),
        processingSeconds: numberValue(body?.processing_seconds),
        segments: arrayValue(body?.segments).map((segment) => {
          const segmentRecord = objectRecord(segment);

          return {
            end: numberValue(segmentRecord?.end),
            start: numberValue(segmentRecord?.start),
            text: stringValue(segmentRecord?.text),
          };
        }),
        text: stringValue(body?.text),
      } satisfies InventoryGirkeTranscriptionSyncResult;
    },
  };
}

async function createFileFormData(
  mediaInput: InventoryGirkeMediaInput,
): Promise<FormData> {
  const formData = new FormData();
  formData.set("file", await toFile(mediaInput));

  return formData;
}

async function createOcrFormData(
  mediaInput: InventoryGirkeMediaInput,
): Promise<FormData> {
  const bytes = await sharp(await readMediaBytes(mediaInput.filePath))
    .rotate()
    .resize({
      fit: "inside",
      height: OCR_MAX_IMAGE_DIMENSION,
      width: OCR_MAX_IMAGE_DIMENSION,
      withoutEnlargement: true,
    })
    .toBuffer();
  const formData = new FormData();
  const fileBytes = Uint8Array.from(bytes);
  formData.set(
    "file",
    new File([fileBytes], mediaFilename(mediaInput), {
      type: mediaInput.mimeType ?? undefined,
    }),
  );

  return formData;
}

async function createTranscriptionFormData(
  mediaInput: InventoryGirkeMediaInput & { level?: string; language?: string },
): Promise<FormData> {
  const formData = await createFileFormData(mediaInput);

  if (mediaInput.level) {
    formData.set("level", mediaInput.level);
  }

  if (mediaInput.language) {
    formData.set("language", mediaInput.language);
  }

  return formData;
}

async function toFile(mediaInput: InventoryGirkeMediaInput): Promise<File> {
  const bytes = await readMediaBytes(mediaInput.filePath);

  return new File([new Uint8Array(bytes)], mediaFilename(mediaInput), {
    type: mediaInput.mimeType ?? undefined,
  });
}

function mediaFilename(mediaInput: InventoryGirkeMediaInput): string {
  return mediaInput.originalName?.trim() || basename(mediaInput.filePath);
}

function bearerHeaders(apiToken: string): HeadersInit {
  return {
    authorization: `Bearer ${apiToken}`,
  };
}

type JsonObject = Record<string, unknown>;

async function parseJsonBody(response: Response): Promise<JsonObject | null> {
  try {
    return (await response.json()) as JsonObject;
  } catch {
    return null;
  }
}

function throwOcrStepError(status: number, body: JsonObject | null): never {
  throw new InventoryPreprocessingStepError({
    code: parseErrorCode(body),
    message: parseErrorMessage(body, `Girke OCR request failed with status ${status}.`),
    retryable: isRetryableGirkeStatus(status),
    step: "ocr",
  });
}

function throwTranscriptionStepError(
  status: number,
  body: JsonObject | null,
): never {
  throw new InventoryPreprocessingStepError({
    code: parseErrorCode(body),
    message: parseErrorMessage(
      body,
      `Girke transcription request failed with status ${status}.`,
    ),
    retryable: isRetryableGirkeStatus(status),
    step: "transcription",
  });
}

function isRetryableGirkeStatus(status: number): boolean {
  return status === 401 || status === 403 || status >= 500;
}

function parseErrorCode(body: JsonObject | null): string | undefined {
  const error = body?.error;

  if (typeof error === "string") {
    return error;
  }

  const errorRecord = objectRecord(error);

  if (typeof errorRecord?.code === "string") {
    return errorRecord.code;
  }

  return undefined;
}

function parseErrorMessage(
  body: JsonObject | null,
  fallbackMessage: string,
): string {
  const error = body?.error;

  if (typeof error === "string") {
    return error;
  }

  const errorRecord = objectRecord(error);

  if (typeof errorRecord?.message === "string") {
    return errorRecord.message;
  }

  return fallbackMessage;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Expected Girke response string.");
  }

  return value;
}

function optionalStringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Expected Girke response number.");
  }

  return value;
}

function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return arrayValue(value).map((entry) => stringValue(entry));
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objectRecord(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function errorObjectValue(
  value: unknown,
): { code?: string; message: string } | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const errorValue = value as Record<string, unknown>;
  const message =
    typeof errorValue.message === "string" ? errorValue.message : null;

  if (!message) {
    return undefined;
  }

  return {
    code: typeof errorValue.code === "string" ? errorValue.code : undefined,
    message,
  };
}

// Preprocessing workers use the existing scoped Quantself API credential, never Vault credentials.
async function readMediaBytes(filePath: string): Promise<Buffer> {
  if (!filePath.startsWith("original:")) return readFile(filePath);
  const base = process.env.INVENTORY_PREPROCESSING_WORKER_BASE_URL;
  const secret = process.env.INVENTORY_PREPROCESSING_WORKER_SECRET;
  if (!base || !secret) throw new Error("Inventory worker API configuration missing.");
  const response = await fetch(`${base.replace(/\/+$/, "")}/api/internal/inventory/preprocessing/originals/${encodeURIComponent(filePath)}`, {
    headers: { Authorization: `Bearer ${secret}` }, redirect: "error", signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Inventory original unavailable (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}
