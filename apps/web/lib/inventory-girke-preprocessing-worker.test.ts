import { describe, expect, test } from "bun:test";
import {
  runInventoryGirkePreprocessingWorkerOnce,
  type InventoryGirkePreprocessingWorkerApiClient,
  type InventoryPreprocessingWorkerClaimedJob,
} from "./inventory-girke-preprocessing-worker";
import { InventoryPreprocessingStepError } from "../../api/src/inventory-preprocessing-service";
import type {
  InventoryGirkeOcrMetadata,
  InventoryGirkeOcrResult,
  InventoryGirkePreprocessingAdapter,
  InventoryGirkeTranscriptionJob,
  InventoryGirkeTranscriptionJobAccepted,
  InventoryGirkeTranscriptionJobResult,
  InventoryGirkeTranscriptionMetadata,
  InventoryGirkeTranscriptionSyncResult,
} from "../../api/src/inventory-preprocessing-service";

class FakeWorkerApiClient implements InventoryGirkePreprocessingWorkerApiClient {
  readonly claimInputs: Array<{
    leaseSeconds: number;
    limit: number;
    workerId: string;
  }> = [];
  readonly failures: Array<{
    code?: string;
    jobId: string;
    leaseClaimedAt: string | null;
    message: string;
    retryable: boolean;
  }> = [];
  readonly successes: Array<{
    jobId: string;
    leaseClaimedAt: string | null;
    textBundle: unknown;
  }> = [];

  constructor(
    private readonly jobs: InventoryPreprocessingWorkerClaimedJob[],
  ) {}

  async claimJobs(input: {
    leaseSeconds: number;
    limit: number;
    workerId: string;
  }): Promise<InventoryPreprocessingWorkerClaimedJob[]> {
    this.claimInputs.push(input);

    return this.jobs.slice(0, input.limit);
  }

  async submitSuccess(input: {
    jobId: string;
    leaseClaimedAt: string | null;
    textBundle: unknown;
  }): Promise<void> {
    this.successes.push(input);
  }

  async submitFailure(input: {
    code?: string;
    jobId: string;
    leaseClaimedAt: string | null;
    message: string;
    retryable: boolean;
  }): Promise<void> {
    this.failures.push(input);
  }
}

class FakeGirkeAdapter implements InventoryGirkePreprocessingAdapter {
  async getOcrMetadata(): Promise<InventoryGirkeOcrMetadata> {
    return {
      acceptedImageFormats: ["jpg", "jpeg", "png", "webp"],
      maxUploadBytes: 26214400,
      model: "tesseract-latin-psm11-gray",
      timeoutSeconds: 20,
    };
  }

  async recognizeOcr(): Promise<InventoryGirkeOcrResult> {
    return {
      lines: ["PASSPORT USB-C CHARGER"],
      model: "tesseract-latin-psm11-gray",
      processingSeconds: 1.2,
      text: "PASSPORT USB-C CHARGER",
    };
  }

  async getTranscriptionMetadata(): Promise<InventoryGirkeTranscriptionMetadata> {
    return {
      acceptedAudioFormats: ["m4a", "mp3", "wav", "webm"],
      acceptedVideoFormats: ["mp4", "mov", "webm"],
      defaultLevel: "medium",
      languageOptional: true,
      languages: ["en", "de"],
      levels: ["low", "medium", "high"],
    };
  }

  async transcribeSynchronously(): Promise<InventoryGirkeTranscriptionSyncResult> {
    return {
      detectedLanguage: "en",
      durationSeconds: 4.5,
      language: "en",
      level: "medium",
      model: "distil-small.en",
      processingSeconds: 0.7,
      segments: [
        {
          end: 4.5,
          start: 0,
          text: "Spoken note says passport and charger stay together.",
        },
      ],
      text: "Spoken note says passport and charger stay together.",
    };
  }

  async createTranscriptionJob(): Promise<InventoryGirkeTranscriptionJobAccepted> {
    throw new Error("Async transcription should not be used in this test.");
  }

  async getTranscriptionJob(
    jobId: string,
  ): Promise<InventoryGirkeTranscriptionJob> {
    void jobId;
    throw new Error("Async transcription should not be used in this test.");
  }

  async getTranscriptionJobResult(
    jobId: string,
  ): Promise<InventoryGirkeTranscriptionJobResult> {
    void jobId;
    throw new Error("Async transcription should not be used in this test.");
  }
}

class DelayedAsyncGirkeAdapter extends FakeGirkeAdapter {
  pollCount = 0;

  constructor(private readonly completeAfterPolls = 11) {
    super();
  }

  override async transcribeSynchronously(): Promise<InventoryGirkeTranscriptionSyncResult> {
    throw new InventoryPreprocessingStepError({
      code: "sync_media_too_long",
      message: "Use async transcription for this media length.",
      retryable: false,
      step: "transcription",
    });
  }

  override async createTranscriptionJob(): Promise<InventoryGirkeTranscriptionJobAccepted> {
    return {
      createdAt: "2026-07-13T12:10:00.000Z",
      detectedLanguage: null,
      jobId: "transcription-job-1",
      language: "auto",
      level: "medium",
      status: "queued",
    };
  }

  override async getTranscriptionJob(
    jobId: string,
  ): Promise<InventoryGirkeTranscriptionJob> {
    this.pollCount += 1;

    return {
      jobId,
      status:
        this.pollCount >= this.completeAfterPolls
          ? "completed"
          : "processing",
    };
  }

  override async getTranscriptionJobResult(
    jobId: string,
  ): Promise<InventoryGirkeTranscriptionJobResult> {
    return {
      detectedLanguage: "en",
      durationSeconds: 107.6,
      jobId,
      language: "auto",
      level: "medium",
      model: "large-v3-turbo",
      processingSeconds: 37.5,
      segments: [
        {
          end: 5,
          start: 0,
          text: "Black USB-C to USB-A cables.",
        },
      ],
      status: "completed",
      text: "Black USB-C to USB-A cables.",
    };
  }
}

describe("inventory Girke preprocessing worker", () => {
  test("claims preprocessing work, builds a text bundle, and submits success", async () => {
    const apiClient = new FakeWorkerApiClient([buildClaimedJob()]);
    const adapter = new FakeGirkeAdapter();

    const summary = await runInventoryGirkePreprocessingWorkerOnce({
      adapter,
      apiClient,
      leaseSeconds: 300,
      limit: 1,
      workerId: "inventory-preprocessing-test",
    });

    expect(summary).toEqual({
      claimed: 1,
      failed: 0,
      processed: 1,
      succeeded: 1,
    });
    expect(apiClient.claimInputs).toEqual([
      {
        leaseSeconds: 300,
        limit: 1,
        workerId: "inventory-preprocessing-test",
      },
    ]);
    expect(apiClient.failures).toEqual([]);
    expect(apiClient.successes).toEqual([
      {
        jobId: "preprocessing-job-1",
        leaseClaimedAt: "2026-07-13T12:10:00.000Z",
        textBundle: {
          captureText: "Passport and charger live in this pouch.",
          failedSteps: [],
          item: {
            containerLabel: "Travel pouch",
            containerLocation: "Closet shelf",
            id: "item-1",
            importance: "MEDIUM",
            kind: "GROUP",
            note: null,
            status: "UNSURE",
            title: "Small black pouch",
          },
          mediaTexts: [
            {
              mediaId: "image-1",
              ocrLines: ["PASSPORT USB-C CHARGER"],
              ocrText: "PASSPORT USB-C CHARGER",
              provider: "girke",
              providerModel: "tesseract-latin-psm11-gray",
              sourceMetadata: {
                ocr: {
                  model: "tesseract-latin-psm11-gray",
                  processingSeconds: 1.2,
                },
              },
              type: "image",
            },
            {
              mediaId: "audio-1",
              provider: "girke",
              providerModel: "distil-small.en",
              sourceMetadata: {
                transcription: {
                  detectedLanguage: "en",
                  durationSeconds: 4.5,
                  language: "en",
                  level: "medium",
                  model: "distil-small.en",
                  processingSeconds: 0.7,
                },
              },
              transcript: "Spoken note says passport and charger stay together.",
              transcriptSegments: [
                {
                  end: 4.5,
                  start: 0,
                  text: "Spoken note says passport and charger stay together.",
                },
              ],
              type: "audio",
            },
          ],
          schemaVersion: 1,
          sourceRefs: [
            { id: "item-1", kind: "item" },
            { id: "image-1", kind: "image" },
            { id: "audio-1", kind: "audio" },
          ],
        },
      },
    ]);
  });

  test("waits with backoff for async transcription until elapsed timeout", async () => {
    const apiClient = new FakeWorkerApiClient([buildClaimedJob()]);
    const adapter = new DelayedAsyncGirkeAdapter();
    const sleepDurations: number[] = [];
    let currentTime = Date.parse("2026-07-13T12:10:00.000Z");

    const summary = await runInventoryGirkePreprocessingWorkerOnce({
      adapter,
      apiClient,
      leaseSeconds: 300,
      limit: 1,
      pollingRuntime: {
        now: () => currentTime,
        sleep: async (milliseconds) => {
          sleepDurations.push(milliseconds);
          currentTime += milliseconds;
        },
      },
      workerId: "inventory-preprocessing-test",
    });

    expect(summary).toEqual({
      claimed: 1,
      failed: 0,
      processed: 1,
      succeeded: 1,
    });
    expect(adapter.pollCount).toBe(11);
    expect(sleepDurations).toEqual([
      500, 1000, 2000, 4000, 5000, 5000, 5000, 5000, 5000, 5000,
    ]);
    expect(apiClient.failures).toEqual([]);
    expect(apiClient.successes[0]?.textBundle).toMatchObject({
      failedSteps: [],
      mediaTexts: expect.arrayContaining([
        expect.objectContaining({
          mediaId: "audio-1",
          transcript: "Black USB-C to USB-A cables.",
        }),
      ]),
    });
  });

  test("stops polling before its lease expires using elapsed timeout", async () => {
    const apiClient = new FakeWorkerApiClient([buildClaimedJob()]);
    const adapter = new DelayedAsyncGirkeAdapter(
      Number.POSITIVE_INFINITY,
    );
    const sleepDurations: number[] = [];
    const claimedAt = Date.parse("2026-07-13T12:10:00.000Z");
    let currentTime = claimedAt;

    await runInventoryGirkePreprocessingWorkerOnce({
      adapter,
      apiClient,
      leaseSeconds: 10,
      limit: 1,
      pollingRuntime: {
        now: () => currentTime,
        sleep: async (milliseconds) => {
          sleepDurations.push(milliseconds);
          currentTime += milliseconds;
        },
      },
      workerId: "inventory-preprocessing-test",
    });

    expect(currentTime - claimedAt).toBe(5_000);
    expect(sleepDurations).toEqual([500, 1000, 2000, 1500]);
    expect(apiClient.successes[0]?.textBundle).toMatchObject({
      failedSteps: [
        expect.objectContaining({
          code: "transcription_job_poll_timeout",
          mediaId: "audio-1",
          retryable: true,
          step: "transcription",
        }),
      ],
    });
  });
});

function buildClaimedJob(): InventoryPreprocessingWorkerClaimedJob {
  return {
    claimedAt: "2026-07-13T12:10:00.000Z",
    id: "preprocessing-job-1",
    item: {
      audioNotes: [
        {
          filePath: "storage/inventory-audio/passport-note.m4a",
          id: "audio-1",
          mimeType: "audio/mp4",
          originalName: "passport-note.m4a",
          sizeBytes: 2048,
        },
      ],
      captureText: "Passport and charger live in this pouch.",
      category: null,
      containerLabel: "Travel pouch",
      id: "item-1",
      images: [
        {
          filePath: "storage/inventory-images/passport-pouch.jpg",
          id: "image-1",
          mimeType: "image/jpeg",
          originalName: "passport-pouch.jpg",
          sizeBytes: 1024,
        },
      ],
      importance: "MEDIUM",
      kind: "GROUP",
      locationName: "Closet shelf",
      note: null,
      originLocationName: "Hallway",
      status: "UNSURE",
      title: "Small black pouch",
    },
    sourceRefs: [
      { id: "item-1", kind: "item" },
      { id: "image-1", kind: "image" },
      { id: "audio-1", kind: "audio" },
    ],
  };
}
