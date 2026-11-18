import { describe, expect, test } from "bun:test";
import {
  createCaptureSession,
  createInventoryItem,
  type InventoryItemAssetRecord,
  type InventoryItemAudioRecord,
  type InventoryItemImageRecord,
  type InventoryItemRecord,
  type InventoryLocationRecord,
  type InventoryRepository,
  type InventorySearchFilters,
  type InventorySessionRecord,
} from "../../api/src/inventory-service";
import {
  type InventoryEnrichmentJobRecord,
  type InventoryEnrichmentNewJobRecord,
  type InventoryEnrichmentRepository,
  type InventoryEnrichmentSettingsRecord,
} from "../../api/src/inventory-enrichment-service";
import {
  claimInventoryPreprocessingJobs,
  buildInventoryTextBundle,
  InventoryPreprocessingSystemError,
  InventoryPreprocessingStepError,
  repairInventoryPreprocessingHandoffs,
  runInventoryPreprocessingJob,
  type InventoryGirkePreprocessingAdapter,
  type InventoryPreprocessingJobRecord,
  type InventoryPreprocessingNewJobRecord,
  type InventoryPreprocessingRepository,
} from "../../api/src/inventory-preprocessing-service";

class MemoryInventoryPreprocessingRepository
  implements
    InventoryRepository,
    InventoryPreprocessingRepository,
    InventoryEnrichmentRepository
{
  private locationCount = 0;
  private sessionCount = 0;
  private itemCount = 0;
  private imageCount = 0;
  private audioCount = 0;
  private assetCount = 0;
  private preprocessingJobCount = 0;
  private enrichmentJobCount = 0;
  readonly locations: InventoryLocationRecord[] = [];
  readonly sessions: InventorySessionRecord[] = [];
  readonly items: InventoryItemRecord[] = [];
  readonly preprocessingJobs: InventoryPreprocessingJobRecord[] = [];
  readonly enrichmentJobs: InventoryEnrichmentJobRecord[] = [];
  failNextEnrichmentEnqueue = false;
  settings: InventoryEnrichmentSettingsRecord = {
    approvalsRequired: true,
    updatedAt: new Date("2026-06-27T09:00:00.000Z"),
  };

  async upsertLocation(input: {
    name?: string | null;
    kind?: InventoryLocationRecord["kind"];
  }): Promise<InventoryLocationRecord | null> {
    const name = input.name?.trim();

    if (!name) {
      return null;
    }

    const existing = this.locations.find(
      (location) => location.name.toLowerCase() === name.toLowerCase(),
    );

    if (existing) {
      return existing;
    }

    const location: InventoryLocationRecord = {
      id: `location-${++this.locationCount}`,
      name,
      kind: input.kind ?? "OTHER",
    };

    this.locations.push(location);

    return location;
  }

  async upsertCaptureSession(input: {
    id?: string | null;
    label?: string | null;
    defaultOriginLocation: InventoryLocationRecord | null;
    defaultDestinationLocation: InventoryLocationRecord | null;
    defaultContainerLabel?: string | null;
    note?: string | null;
  }): Promise<InventorySessionRecord> {
    const session: InventorySessionRecord = {
      id: input.id || `session-${++this.sessionCount}`,
      label: input.label?.trim() || null,
      defaultOriginLocation: input.defaultOriginLocation,
      defaultDestinationLocation: input.defaultDestinationLocation,
      defaultContainerLabel: input.defaultContainerLabel?.trim() || null,
      note: input.note?.trim() || null,
      startedAt: new Date("2026-06-27T10:00:00.000Z"),
    };
    const existingIndex = this.sessions.findIndex(
      (existingSession) => existingSession.id === session.id,
    );

    if (existingIndex >= 0) {
      this.sessions[existingIndex] = session;
    } else {
      this.sessions.push(session);
    }

    return session;
  }

  async getCaptureSession(id: string): Promise<InventorySessionRecord | null> {
    return this.sessions.find((session) => session.id === id) ?? null;
  }

  async getActiveCaptureSession(): Promise<InventorySessionRecord | null> {
    return this.sessions.at(-1) ?? null;
  }

  async createItem(
    input: Omit<InventoryItemRecord, "id" | "capturedAt">,
  ): Promise<InventoryItemRecord> {
    const item: InventoryItemRecord = {
      ...input,
      audioNotes: (input.audioNotes ?? []).map((audioNote) => ({
        ...audioNote,
        id: audioNote.id ?? `audio-${++this.audioCount}`,
      })),
      assets: (input.assets ?? []).map((asset) => ({
        ...asset,
        id: asset.id ?? `asset-${++this.assetCount}`,
      })),
      captureText: input.captureText ?? null,
      id: `item-${++this.itemCount}`,
      images: input.images.map((image) => ({
        ...image,
        id: image.id ?? `image-${++this.imageCount}`,
      })),
      capturedAt: new Date(`2026-06-27T11:0${this.itemCount}:00.000Z`),
    };

    this.items.push(item);

    return item;
  }

  async listRecentItems(limit: number): Promise<InventoryItemRecord[]> {
    return [...this.items]
      .sort(
        (left, right) => right.capturedAt.getTime() - left.capturedAt.getTime(),
      )
      .slice(0, limit);
  }

  async findInventoryItems(
    filters: InventorySearchFilters,
  ): Promise<InventoryItemRecord[]> {
    void filters;

    return this.items;
  }

  async enqueueInventoryPreprocessingJobs(
    jobs: InventoryPreprocessingNewJobRecord[],
  ): Promise<InventoryPreprocessingJobRecord[]> {
    const now = new Date("2026-06-27T11:30:00.000Z");
    const createdJobs = jobs.map((job) => ({
      ...job,
      attempts: 0,
      completedAt: null,
      createdAt: now,
      failureDetail: null,
      id: `preprocessing-job-${++this.preprocessingJobCount}`,
      status: "QUEUED" as const,
      textBundle: null,
      updatedAt: now,
    }));

    this.preprocessingJobs.push(...createdJobs);

    return createdJobs;
  }

  async listClaimableInventoryPreprocessingJobs(input: {
    limit: number;
    now: Date;
  }): Promise<InventoryPreprocessingJobRecord[]> {
    return this.preprocessingJobs
      .filter(
        (job) =>
          job.status === "QUEUED" ||
          (job.status === "PROCESSING" &&
            job.leaseExpiresAt !== null &&
            job.leaseExpiresAt <= input.now),
      )
      .slice(0, input.limit);
  }

  async listInventoryPreprocessingJobs(input?: {
    limit?: number;
    status?: InventoryPreprocessingJobRecord["status"];
  }): Promise<InventoryPreprocessingJobRecord[]> {
    return this.preprocessingJobs
      .filter((job) => !input?.status || job.status === input.status)
      .slice(0, input?.limit ?? this.preprocessingJobs.length);
  }

  async updateInventoryPreprocessingJob(
    job: InventoryPreprocessingJobRecord,
  ): Promise<InventoryPreprocessingJobRecord> {
    const index = this.preprocessingJobs.findIndex(
      (existingJob) => existingJob.id === job.id,
    );
    this.preprocessingJobs[index] = job;

    return job;
  }

  async completeInventoryPreprocessingJob(input: {
    enrichmentJob: InventoryEnrichmentNewJobRecord | null;
    job: InventoryPreprocessingJobRecord;
  }): Promise<InventoryPreprocessingJobRecord> {
    if (input.enrichmentJob) {
      await this.enqueueInventoryEnrichmentJobs([input.enrichmentJob]);
    }

    return this.updateInventoryPreprocessingJob(input.job);
  }

  async getInventoryPreprocessingJob(
    id: string,
  ): Promise<InventoryPreprocessingJobRecord | null> {
    return this.preprocessingJobs.find((job) => job.id === id) ?? null;
  }

  async enqueueInventoryEnrichmentJobs(
    jobs: InventoryEnrichmentNewJobRecord[],
  ): Promise<InventoryEnrichmentJobRecord[]> {
    if (this.failNextEnrichmentEnqueue) {
      this.failNextEnrichmentEnqueue = false;
      throw new Error("simulated enrichment enqueue failure");
    }

    const now = new Date("2026-06-27T11:30:00.000Z");
    const createdJobs = jobs.map((job) => ({
      ...job,
      attempts: 0,
      createdAt: now,
      id: `enrichment-job-${++this.enrichmentJobCount}`,
      status: "QUEUED" as const,
      updatedAt: now,
    }));

    this.enrichmentJobs.push(...createdJobs);

    return createdJobs;
  }

  async listClaimableInventoryEnrichmentJobs(): Promise<
    InventoryEnrichmentJobRecord[]
  > {
    return [];
  }

  async listInventoryEnrichmentJobs(input?: {
    limit?: number;
    targetItemId?: string;
  }): Promise<InventoryEnrichmentJobRecord[]> {
    return this.enrichmentJobs
      .filter(
        (job) => !input?.targetItemId || job.targetItemId === input.targetItemId,
      )
      .slice(0, input?.limit ?? this.enrichmentJobs.length);
  }

  async updateInventoryEnrichmentJob(
    job: InventoryEnrichmentJobRecord,
  ): Promise<InventoryEnrichmentJobRecord> {
    return job;
  }

  async getInventoryEnrichmentJob(): Promise<InventoryEnrichmentJobRecord | null> {
    return null;
  }

  async getInventoryEnrichmentSettings(): Promise<InventoryEnrichmentSettingsRecord> {
    return this.settings;
  }

  async updateInventoryEnrichmentSettings(
    settings: InventoryEnrichmentSettingsRecord,
  ): Promise<InventoryEnrichmentSettingsRecord> {
    this.settings = settings;

    return settings;
  }

  async getInventoryItem(id: string): Promise<InventoryItemRecord | null> {
    return this.items.find((item) => item.id === id) ?? null;
  }

  async applyInventoryItemEnrichment(): Promise<InventoryItemRecord> {
    throw new Error("not implemented");
  }

  async applyInventoryImageEnrichment(): Promise<void> {}
}

function unusedPreprocessingAdapter(): InventoryGirkePreprocessingAdapter {
  const unused = async (): Promise<never> => {
    throw new Error("media adapter should not run");
  };

  return {
    createTranscriptionJob: unused,
    getOcrMetadata: unused,
    getTranscriptionJob: unused,
    getTranscriptionJobResult: unused,
    getTranscriptionMetadata: unused,
    recognizeOcr: unused,
    transcribeSynchronously: unused,
  };
}

describe("inventory preprocessing service", () => {
  test("capture stores distinct source evidence and queues preprocessing before enrichment", async () => {
    const repository = new MemoryInventoryPreprocessingRepository();
    const session = await createCaptureSession(repository, {
      originRoom: "Office",
      destinationLocation: "Storage shelf",
      defaultContainerLabel: "Travel pouch",
    });
    const audioNote = {
      filePath: "storage/inventory-audio/travel-note.m4a",
      mimeType: "audio/mp4",
      originalName: "travel-note.m4a",
      sizeBytes: 2048,
    } satisfies InventoryItemAudioRecord;
    const image = {
      filePath: "storage/inventory-images/travel-pouch.jpg",
      mimeType: "image/jpeg",
      originalName: "travel-pouch.jpg",
      sizeBytes: 1024,
    } satisfies InventoryItemImageRecord;

    const item = await createInventoryItem(repository, {
      audioNotes: [audioNote],
      captureSessionId: session.id,
      captureText: "Passport and charging brick",
      images: [image],
      note: "Keep travel docs near the zipper pocket.",
      title: "Silver travel pouch",
    });

    expect(item.captureText).toBe("Passport and charging brick");
    expect(item.note).toBe("Keep travel docs near the zipper pocket.");
    expect(item.audioNotes).toEqual([
      expect.objectContaining({
        filePath: audioNote.filePath,
        id: "audio-1",
        mimeType: "audio/mp4",
        originalName: "travel-note.m4a",
        sizeBytes: 2048,
      }),
    ]);
    expect(repository.preprocessingJobs).toHaveLength(1);
    expect(repository.enrichmentJobs).toHaveLength(0);
    expect(repository.preprocessingJobs[0]).toMatchObject({
      sourceRefs: [
        { id: item.id, kind: "item" },
        { id: "image-1", kind: "image" },
        { id: "audio-1", kind: "audio" },
      ],
      status: "QUEUED",
      targetItemId: item.id,
    });

    const claimedJobs = await claimInventoryPreprocessingJobs(repository, {
      leaseSeconds: 90,
      limit: 5,
      now: new Date("2026-06-27T12:00:00.000Z"),
      workerId: "preprocessing-test",
    });

    expect(claimedJobs[0]).toMatchObject({
      attempts: 1,
      claimedBy: "preprocessing-test",
      status: "PROCESSING",
      targetItemId: item.id,
    });
    expect(claimedJobs[0]?.claimedAt?.toISOString()).toBe(
      "2026-06-27T12:00:00.000Z",
    );
    expect(claimedJobs[0]?.leaseExpiresAt?.toISOString()).toBe(
      "2026-06-27T12:01:30.000Z",
    );
  });

  test("does not leave completed preprocessing orphaned when enrichment enqueue fails", async () => {
    const repository = new MemoryInventoryPreprocessingRepository();
    const item = await createInventoryItem(repository, {
      captureText: "Fillet knife",
      title: "Rapala knife",
    });
    const [claimedJob] = await claimInventoryPreprocessingJobs(repository, {
      leaseSeconds: 90,
      limit: 1,
      now: new Date("2026-06-27T12:00:00.000Z"),
      workerId: "preprocessing-test",
    });
    repository.failNextEnrichmentEnqueue = true;

    const completed = await runInventoryPreprocessingJob(repository, {
      adapter: unusedPreprocessingAdapter(),
      jobId: claimedJob?.id ?? "",
      leaseClaimedAt: claimedJob?.claimedAt ?? null,
      now: new Date("2026-06-27T12:00:30.000Z"),
    });

    expect(completed.status).toBe("FAILED");
    expect(completed.failureDetail).toMatchObject({
      message: "simulated enrichment enqueue failure",
      retryable: true,
    });
    expect(repository.enrichmentJobs).toHaveLength(0);
    expect(repository.preprocessingJobs[0]?.targetItemId).toBe(item.id);
  });

  test("repairs a completed preprocessing handoff once without duplicates", async () => {
    const repository = new MemoryInventoryPreprocessingRepository();
    await createInventoryItem(repository, {
      captureText: "Fillet knife",
      title: "Rapala knife",
    });
    const [claimedJob] = await claimInventoryPreprocessingJobs(repository, {
      leaseSeconds: 90,
      limit: 1,
      now: new Date("2026-06-27T12:00:00.000Z"),
      workerId: "preprocessing-test",
    });
    const completed = await runInventoryPreprocessingJob(repository, {
      adapter: unusedPreprocessingAdapter(),
      jobId: claimedJob?.id ?? "",
      leaseClaimedAt: claimedJob?.claimedAt ?? null,
      now: new Date("2026-06-27T12:00:30.000Z"),
    });
    repository.enrichmentJobs.splice(0);

    expect(completed.status).toBe("READY_FOR_ENRICHMENT");
    expect(await repairInventoryPreprocessingHandoffs(repository)).toBe(1);
    expect(await repairInventoryPreprocessingHandoffs(repository)).toBe(0);
    expect(repository.enrichmentJobs).toHaveLength(1);
  });

  test("transcribes video assets and keeps generic assets as source evidence", async () => {
    const video = {
      filePath: "storage/inventory-assets/walkthrough.mp4",
      mimeType: "video/mp4",
      originalName: "walkthrough.mp4",
      sizeBytes: 4096,
      id: "asset-video",
    } satisfies InventoryItemAssetRecord;
    const manual = {
      filePath: "storage/inventory-assets/manual.pdf",
      mimeType: "application/pdf",
      originalName: "manual.pdf",
      sizeBytes: 2048,
      id: "asset-manual",
    } satisfies InventoryItemAssetRecord;
    const item = {
      assets: [video, manual],
      audioNotes: [],
      captureText: null,
      category: null,
      containerLabel: null,
      id: "item-asset",
      images: [],
      importance: "MEDIUM",
      kind: "ITEM",
      locationName: null,
      note: null,
      originLocationName: null,
      status: "KEEP",
      title: "Room walkthrough",
    } satisfies Parameters<typeof buildInventoryTextBundle>[0];
    const adapter: InventoryGirkePreprocessingAdapter = {
      async createTranscriptionJob() {
        throw new Error("async transcription should not run in this test");
      },
      async getOcrMetadata() {
        throw new Error("OCR should not run in this test");
      },
      async getTranscriptionJob() {
        throw new Error("async transcription should not run in this test");
      },
      async getTranscriptionJobResult() {
        throw new Error("async transcription should not run in this test");
      },
      async getTranscriptionMetadata() {
        return {
          acceptedAudioFormats: ["mp3"],
          acceptedVideoFormats: ["mp4", "mov", "webm"],
          defaultLevel: "medium",
          languageOptional: true,
          languages: ["en"],
          levels: ["medium"],
        };
      },
      async recognizeOcr() {
        throw new Error("OCR should not run in this test");
      },
      async transcribeSynchronously(input) {
        expect(input.mediaId).toBe("asset-video");
        expect(input.originalName).toBe("walkthrough.mp4");

        return {
          detectedLanguage: "en",
          durationSeconds: 8,
          language: "auto",
          level: "medium",
          model: "distil-small.en",
          processingSeconds: 0.5,
          segments: [{ end: 8, start: 0, text: "blue tote by the door" }],
          text: "blue tote by the door",
        };
      },
    };
    const sourceRefs = [
      { id: "item-asset", kind: "item" as const },
      { id: "asset-video", kind: "asset" as const },
      { id: "asset-manual", kind: "asset" as const },
    ];

    const textBundle = await buildInventoryTextBundle(
      item,
      sourceRefs,
      adapter,
    );

    expect(textBundle.sourceRefs).toEqual(sourceRefs);
    expect(textBundle.failedSteps).toEqual([]);
    expect(textBundle.mediaTexts).toEqual([
      expect.objectContaining({
        mediaId: "asset-video",
        transcript: "blue tote by the door",
        type: "video",
      }),
    ]);
  });

  test(
    "builds an inventory text bundle from Girke OCR and transcription and hands only text to enrichment",
    async () => {
      const repository = new MemoryInventoryPreprocessingRepository();
      const item = await createInventoryItem(repository, {
        audioNotes: [
          {
            filePath: "storage/inventory-audio/travel-note.m4a",
            mimeType: "audio/mp4",
            originalName: "travel-note.m4a",
            sizeBytes: 2048,
          },
        ],
        captureText: "Passport and charging brick",
        images: [
          {
            filePath: "storage/inventory-images/travel-pouch.jpg",
            mimeType: "image/jpeg",
            originalName: "travel-pouch.jpg",
            sizeBytes: 1024,
          },
        ],
        note: "Keep travel docs near the zipper pocket.",
        title: "Silver travel pouch",
      });
      const [claimedJob] = await claimInventoryPreprocessingJobs(repository, {
        leaseSeconds: 90,
        limit: 5,
        now: new Date("2026-06-27T12:00:00.000Z"),
        workerId: "preprocessing-test",
      });
      const adapter: InventoryGirkePreprocessingAdapter = {
        async createTranscriptionJob() {
          throw new Error("async transcription should not run in this test");
        },
        async getOcrMetadata() {
          return {
            acceptedImageFormats: ["jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp"],
            maxUploadBytes: 26214400,
            model: "tesseract-latin-psm11-gray",
            timeoutSeconds: 20,
          };
        },
        async getTranscriptionJob() {
          throw new Error("async transcription should not run in this test");
        },
        async getTranscriptionJobResult() {
          throw new Error("async transcription should not run in this test");
        },
        async getTranscriptionMetadata() {
          return {
            acceptedAudioFormats: [
              "wav",
              "mp3",
              "m4a",
              "aac",
              "ogg",
              "opus",
              "flac",
              "webm",
            ],
            acceptedVideoFormats: ["mp4", "mov", "mkv", "webm", "avi"],
            defaultLevel: "medium",
            languageOptional: true,
            languages: ["en", "de"],
            levels: ["low", "medium", "high"],
          };
        },
        async recognizeOcr(input) {
          expect(input.mediaId).toBe("image-1");
          expect(input.originalName).toBe("travel-pouch.jpg");

          return {
            lines: ["LOT 1234", "Best before 2027"],
            model: "tesseract-latin-psm11-gray",
            processingSeconds: 2.6,
            text: "LOT 1234\nBest before 2027",
          };
        },
        async transcribeSynchronously(input) {
          expect(input.mediaId).toBe("audio-1");
          expect(input.originalName).toBe("travel-note.m4a");

          return {
            detectedLanguage: "en",
            durationSeconds: 12.4,
            language: "auto",
            level: "medium",
            model: "distil-small.en",
            processingSeconds: 0.9,
            segments: [
              { end: 3.2, start: 0, text: "passport in the front pocket" },
              { end: 6.1, start: 3.2, text: "charger brick near the zipper" },
            ],
            text: "passport in the front pocket charger brick near the zipper",
          };
        },
      };

      const completed = await runInventoryPreprocessingJob(repository, {
        adapter,
        jobId: claimedJob?.id ?? "",
        leaseClaimedAt: claimedJob?.claimedAt ?? null,
        now: new Date("2026-06-27T12:00:30.000Z"),
      });

      expect(completed.status).toBe("READY_FOR_ENRICHMENT");
      expect(completed.textBundle).toMatchObject({
        captureText: "Passport and charging brick",
        failedSteps: [],
        item: {
          containerLabel: null,
          containerLocation: null,
          id: item.id,
          importance: "MEDIUM",
          kind: "GROUP",
          note: "Keep travel docs near the zipper pocket.",
          status: "UNSURE",
          title: "Silver travel pouch",
        },
        mediaTexts: [
          {
            mediaId: "image-1",
            ocrLines: ["LOT 1234", "Best before 2027"],
            ocrText: "LOT 1234\nBest before 2027",
            provider: "girke",
            providerModel: "tesseract-latin-psm11-gray",
            type: "image",
          },
          {
            mediaId: "audio-1",
            provider: "girke",
            providerModel: "distil-small.en",
            transcript:
              "passport in the front pocket charger brick near the zipper",
            transcriptSegments: [
              { end: 3.2, start: 0, text: "passport in the front pocket" },
              { end: 6.1, start: 3.2, text: "charger brick near the zipper" },
            ],
            type: "audio",
          },
        ],
        sourceRefs: [
          { id: item.id, kind: "item" },
          { id: "image-1", kind: "image" },
          { id: "audio-1", kind: "audio" },
        ],
      });
      expect(repository.enrichmentJobs).toHaveLength(1);
      expect(repository.enrichmentJobs[0]?.inputSnapshot).toMatchObject({
        target: {
          imageId: null,
          itemId: item.id,
          kind: "ITEM",
        },
        textBundle: expect.objectContaining({
          captureText: "Passport and charging brick",
          item: expect.objectContaining({
            id: item.id,
            title: "Silver travel pouch",
          }),
        }),
      });
      expect(JSON.stringify(repository.enrichmentJobs[0]?.inputSnapshot)).not.toContain(
        "storage/inventory-",
      );
    },
  );

  test(
    "falls back to async Girke transcription when sync media is too long",
    async () => {
      const repository = new MemoryInventoryPreprocessingRepository();
      await createInventoryItem(repository, {
        audioNotes: [
          {
            filePath: "storage/inventory-audio/garage-note.m4a",
            mimeType: "audio/mp4",
            originalName: "garage-note.m4a",
            sizeBytes: 4096,
          },
        ],
      });
      const [claimedJob] = await claimInventoryPreprocessingJobs(repository, {
        leaseSeconds: 90,
        limit: 5,
        now: new Date("2026-06-27T13:00:00.000Z"),
        workerId: "preprocessing-test",
      });
      const polledStatuses: string[] = [];
      const adapter: InventoryGirkePreprocessingAdapter = {
        async createTranscriptionJob(input) {
          expect(input.mediaId).toBe("audio-1");

          return {
            createdAt: "2026-06-27T13:00:10.000Z",
            detectedLanguage: null,
            jobId: "tr_async_1",
            language: "auto",
            level: "medium",
            status: "queued",
          };
        },
        async getOcrMetadata() {
          return {
            acceptedImageFormats: ["jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp"],
            maxUploadBytes: 26214400,
            model: "tesseract-latin-psm11-gray",
            timeoutSeconds: 20,
          };
        },
        async getTranscriptionJob(jobId) {
          expect(jobId).toBe("tr_async_1");
          const status = polledStatuses.length === 0 ? "processing" : "completed";
          polledStatuses.push(status);

          return { jobId, status };
        },
        async getTranscriptionJobResult(jobId) {
          expect(jobId).toBe("tr_async_1");

          return {
            detectedLanguage: "en",
            durationSeconds: 302.4,
            jobId,
            language: "auto",
            level: "medium",
            model: "large-v3-turbo",
            processingSeconds: 30.2,
            segments: [
              {
                end: 8.1,
                start: 0,
                text: "garage bin has extension cords and bike lights",
              },
            ],
            status: "completed",
            text: "garage bin has extension cords and bike lights",
          };
        },
        async getTranscriptionMetadata() {
          return {
            acceptedAudioFormats: [
              "wav",
              "mp3",
              "m4a",
              "aac",
              "ogg",
              "opus",
              "flac",
              "webm",
            ],
            acceptedVideoFormats: ["mp4", "mov", "mkv", "webm", "avi"],
            defaultLevel: "medium",
            languageOptional: true,
            languages: ["en", "de"],
            levels: ["low", "medium", "high"],
          };
        },
        async recognizeOcr() {
          throw new Error("OCR should not run in this test");
        },
        async transcribeSynchronously() {
          throw new InventoryPreprocessingStepError({
            code: "sync_media_too_long",
            message: "Use async transcription for this media length.",
            retryable: false,
            step: "transcription",
          });
        },
      };

      const completed = await runInventoryPreprocessingJob(repository, {
        adapter,
        jobId: claimedJob?.id ?? "",
        leaseClaimedAt: claimedJob?.claimedAt ?? null,
        now: new Date("2026-06-27T13:01:00.000Z"),
      });

      expect(polledStatuses).toEqual(["processing", "completed"]);
      expect(completed.status).toBe("READY_FOR_ENRICHMENT");
      expect(completed.textBundle?.failedSteps).toEqual([]);
      expect(completed.textBundle?.mediaTexts).toEqual([
        {
          mediaId: "audio-1",
          provider: "girke",
          providerJobId: "tr_async_1",
          providerModel: "large-v3-turbo",
          sourceMetadata: {
            transcription: {
              detectedLanguage: "en",
              durationSeconds: 302.4,
              language: "auto",
              level: "medium",
              model: "large-v3-turbo",
              processingSeconds: 30.2,
            },
          },
          transcript: "garage bin has extension cords and bike lights",
          transcriptSegments: [
            {
              end: 8.1,
              start: 0,
              text: "garage bin has extension cords and bike lights",
            },
          ],
          type: "audio",
        },
      ]);
    },
  );

  test("marks preprocessing partial when capture text survives a failed Girke step", async () => {
    const repository = new MemoryInventoryPreprocessingRepository();
    await createInventoryItem(repository, {
      audioNotes: [
        {
          filePath: "storage/inventory-audio/drawer-note.m4a",
          mimeType: "audio/mp4",
          originalName: "drawer-note.m4a",
          sizeBytes: 2048,
        },
      ],
      captureText: "Desk drawer adapters",
    });
    const [claimedJob] = await claimInventoryPreprocessingJobs(repository, {
      leaseSeconds: 90,
      limit: 5,
      now: new Date("2026-06-27T13:10:00.000Z"),
      workerId: "preprocessing-test",
    });
    const adapter: InventoryGirkePreprocessingAdapter = {
      async createTranscriptionJob() {
        throw new Error("async transcription should not run in this test");
      },
      async getOcrMetadata() {
        return {
          acceptedImageFormats: ["jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp"],
          maxUploadBytes: 26214400,
          model: "tesseract-latin-psm11-gray",
          timeoutSeconds: 20,
        };
      },
      async getTranscriptionJob() {
        throw new Error("async transcription should not run in this test");
      },
      async getTranscriptionJobResult() {
        throw new Error("async transcription should not run in this test");
      },
      async getTranscriptionMetadata() {
        return {
          acceptedAudioFormats: [
            "wav",
            "mp3",
            "m4a",
            "aac",
            "ogg",
            "opus",
            "flac",
            "webm",
          ],
          acceptedVideoFormats: ["mp4", "mov", "mkv", "webm", "avi"],
          defaultLevel: "medium",
          languageOptional: true,
          languages: ["en", "de"],
          levels: ["low", "medium", "high"],
        };
      },
      async recognizeOcr() {
        throw new Error("OCR should not run in this test");
      },
      async transcribeSynchronously() {
        throw new InventoryPreprocessingStepError({
          code: "whisper_failed",
          message: "whisper_failed",
          retryable: true,
          step: "transcription",
        });
      },
    };

    const completed = await runInventoryPreprocessingJob(repository, {
      adapter,
      jobId: claimedJob?.id ?? "",
      leaseClaimedAt: claimedJob?.claimedAt ?? null,
      now: new Date("2026-06-27T13:10:30.000Z"),
    });

    expect(completed.status).toBe("PARTIAL");
    expect(completed.textBundle?.failedSteps).toEqual([
      {
        code: "whisper_failed",
        mediaId: "audio-1",
        message: "whisper_failed",
        retryable: true,
        step: "transcription",
      },
    ]);
    expect(repository.enrichmentJobs).toHaveLength(1);
  });

  test("maps Girke metadata request failures into failed preprocessing steps", async () => {
    const repository = new MemoryInventoryPreprocessingRepository();
    await createInventoryItem(repository, {
      audioNotes: [
        {
          filePath: "storage/inventory-audio/drawer-note.m4a",
          mimeType: "audio/mp4",
          originalName: "drawer-note.m4a",
          sizeBytes: 2048,
        },
      ],
      captureText: "Desk drawer adapters",
    });
    const [claimedJob] = await claimInventoryPreprocessingJobs(repository, {
      leaseSeconds: 90,
      limit: 5,
      now: new Date("2026-06-27T13:15:00.000Z"),
      workerId: "preprocessing-test",
    });
    const adapter: InventoryGirkePreprocessingAdapter = {
      async createTranscriptionJob() {
        throw new Error("async transcription should not run in this test");
      },
      async getOcrMetadata() {
        throw new Error("OCR should not run in this test");
      },
      async getTranscriptionJob() {
        throw new Error("async transcription should not run in this test");
      },
      async getTranscriptionJobResult() {
        throw new Error("async transcription should not run in this test");
      },
      async getTranscriptionMetadata() {
        throw new InventoryPreprocessingStepError({
          code: "unauthorized",
          message: "unauthorized",
          retryable: false,
          step: "transcription",
        });
      },
      async recognizeOcr() {
        throw new Error("OCR should not run in this test");
      },
      async transcribeSynchronously() {
        throw new Error("should not reach sync transcription call");
      },
    };

    const completed = await runInventoryPreprocessingJob(repository, {
      adapter,
      jobId: claimedJob?.id ?? "",
      leaseClaimedAt: claimedJob?.claimedAt ?? null,
      now: new Date("2026-06-27T13:15:30.000Z"),
    });

    expect(completed.status).toBe("PARTIAL");
    expect(completed.textBundle?.failedSteps).toEqual([
      {
        code: "unauthorized",
        mediaId: "audio-1",
        message: "unauthorized",
        retryable: false,
        step: "transcription",
      },
    ]);
    expect(completed.failureDetail).toBeNull();
    expect(repository.enrichmentJobs).toHaveLength(1);
  });

  test("marks preprocessing needs review when Girke returns zero usable text", async () => {
    const repository = new MemoryInventoryPreprocessingRepository();
    await createInventoryItem(repository, {
      images: [
        {
          filePath: "storage/inventory-images/blank-label.jpg",
          mimeType: "image/jpeg",
          originalName: "blank-label.jpg",
          sizeBytes: 1024,
        },
      ],
    });
    const [claimedJob] = await claimInventoryPreprocessingJobs(repository, {
      leaseSeconds: 90,
      limit: 5,
      now: new Date("2026-06-27T13:20:00.000Z"),
      workerId: "preprocessing-test",
    });
    const adapter: InventoryGirkePreprocessingAdapter = {
      async createTranscriptionJob() {
        throw new Error("audio should not run in this test");
      },
      async getOcrMetadata() {
        return {
          acceptedImageFormats: ["jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp"],
          maxUploadBytes: 26214400,
          model: "tesseract-latin-psm11-gray",
          timeoutSeconds: 20,
        };
      },
      async getTranscriptionJob() {
        throw new Error("audio should not run in this test");
      },
      async getTranscriptionJobResult() {
        throw new Error("audio should not run in this test");
      },
      async getTranscriptionMetadata() {
        throw new Error("audio should not run in this test");
      },
      async recognizeOcr() {
        return {
          lines: [],
          model: "tesseract-latin-psm11-gray",
          processingSeconds: 0.3,
          text: "",
        };
      },
      async transcribeSynchronously() {
        throw new Error("audio should not run in this test");
      },
    };

    const completed = await runInventoryPreprocessingJob(repository, {
      adapter,
      jobId: claimedJob?.id ?? "",
      leaseClaimedAt: claimedJob?.claimedAt ?? null,
      now: new Date("2026-06-27T13:20:30.000Z"),
    });

    expect(completed.status).toBe("NEEDS_REVIEW");
    expect(completed.textBundle?.failedSteps).toEqual([]);
    expect(repository.enrichmentJobs).toHaveLength(0);
  });

  test("skips OCR for clothing images", async () => {
    const repository = new MemoryInventoryPreprocessingRepository();
    const item = await createInventoryItem(repository, {
      category: "clothing",
      images: [
        {
          filePath: "storage/inventory-images/shirt.jpg",
          mimeType: "image/jpeg",
          originalName: "shirt.jpg",
          sizeBytes: 1024,
        },
      ],
      title: "Blue shirt",
    });
    let ocrCalls = 0;
    const adapter: InventoryGirkePreprocessingAdapter = {
      async createTranscriptionJob() {
        throw new Error("audio should not run in this test");
      },
      async getOcrMetadata() {
        ocrCalls += 1;
        throw new Error("OCR should not run for clothing");
      },
      async getTranscriptionJob() {
        throw new Error("audio should not run in this test");
      },
      async getTranscriptionJobResult() {
        throw new Error("audio should not run in this test");
      },
      async getTranscriptionMetadata() {
        throw new Error("audio should not run in this test");
      },
      async recognizeOcr() {
        ocrCalls += 1;
        throw new Error("OCR should not run for clothing");
      },
      async transcribeSynchronously() {
        throw new Error("audio should not run in this test");
      },
    };

    const bundle = await buildInventoryTextBundle(
      item,
      [{ id: item.id, kind: "item" }],
      adapter,
    );

    expect(ocrCalls).toBe(0);
    expect(bundle.failedSteps).toEqual([]);
    expect(bundle.mediaTexts).toEqual([]);
  });

  test("records async Girke transcription terminal failures as failed preprocessing steps", async () => {
    const repository = new MemoryInventoryPreprocessingRepository();
    await createInventoryItem(repository, {
      audioNotes: [
        {
          filePath: "storage/inventory-audio/garage-note.m4a",
          mimeType: "audio/mp4",
          originalName: "garage-note.m4a",
          sizeBytes: 4096,
        },
      ],
    });
    const [claimedJob] = await claimInventoryPreprocessingJobs(repository, {
      leaseSeconds: 90,
      limit: 5,
      now: new Date("2026-06-27T13:30:00.000Z"),
      workerId: "preprocessing-test",
    });
    const adapter: InventoryGirkePreprocessingAdapter = {
      async createTranscriptionJob() {
        return {
          createdAt: "2026-06-27T13:30:10.000Z",
          detectedLanguage: null,
          jobId: "tr_async_2",
          language: "auto",
          level: "medium",
          status: "queued",
        };
      },
      async getOcrMetadata() {
        throw new Error("OCR should not run in this test");
      },
      async getTranscriptionJob(jobId) {
        expect(jobId).toBe("tr_async_2");

        return {
          error: {
            code: "TRANSCRIPTION_WORKER_FAILED",
            message: "Transcription job failed",
          },
          jobId,
          status: "failed",
        };
      },
      async getTranscriptionJobResult() {
        throw new Error("result fetch should not run for failed jobs");
      },
      async getTranscriptionMetadata() {
        return {
          acceptedAudioFormats: [
            "wav",
            "mp3",
            "m4a",
            "aac",
            "ogg",
            "opus",
            "flac",
            "webm",
          ],
          acceptedVideoFormats: ["mp4", "mov", "mkv", "webm", "avi"],
          defaultLevel: "medium",
          languageOptional: true,
          languages: ["en", "de"],
          levels: ["low", "medium", "high"],
        };
      },
      async recognizeOcr() {
        throw new Error("OCR should not run in this test");
      },
      async transcribeSynchronously() {
        throw new InventoryPreprocessingStepError({
          code: "sync_upload_too_large",
          message: "Use async transcription for this media size.",
          retryable: false,
          step: "transcription",
        });
      },
    };

    const completed = await runInventoryPreprocessingJob(repository, {
      adapter,
      jobId: claimedJob?.id ?? "",
      leaseClaimedAt: claimedJob?.claimedAt ?? null,
      now: new Date("2026-06-27T13:31:00.000Z"),
    });

    expect(completed.status).toBe("NEEDS_REVIEW");
    expect(completed.textBundle?.failedSteps).toEqual([
      {
        code: "TRANSCRIPTION_WORKER_FAILED",
        mediaId: "audio-1",
        message: "Transcription job failed",
        retryable: false,
        step: "transcription",
      },
    ]);
    expect(repository.enrichmentJobs).toHaveLength(0);
  });

  test("marks preprocessing failed on worker or system errors without inventing a text bundle", async () => {
    const repository = new MemoryInventoryPreprocessingRepository();
    await createInventoryItem(repository, {
      images: [
        {
          filePath: "storage/inventory-images/travel-pouch.jpg",
          mimeType: "image/jpeg",
          originalName: "travel-pouch.jpg",
          sizeBytes: 1024,
        },
      ],
    });
    const [claimedJob] = await claimInventoryPreprocessingJobs(repository, {
      leaseSeconds: 90,
      limit: 5,
      now: new Date("2026-06-27T13:40:00.000Z"),
      workerId: "preprocessing-test",
    });
    const adapter: InventoryGirkePreprocessingAdapter = {
      async createTranscriptionJob() {
        throw new Error("audio should not run in this test");
      },
      async getOcrMetadata() {
        throw new InventoryPreprocessingSystemError({
          code: "girke_unavailable",
          message: "Girke preprocessing worker could not start.",
          retryable: true,
        });
      },
      async getTranscriptionJob() {
        throw new Error("audio should not run in this test");
      },
      async getTranscriptionJobResult() {
        throw new Error("audio should not run in this test");
      },
      async getTranscriptionMetadata() {
        throw new Error("audio should not run in this test");
      },
      async recognizeOcr() {
        throw new Error("should not reach OCR call");
      },
      async transcribeSynchronously() {
        throw new Error("audio should not run in this test");
      },
    };

    const completed = await runInventoryPreprocessingJob(repository, {
      adapter,
      jobId: claimedJob?.id ?? "",
      leaseClaimedAt: claimedJob?.claimedAt ?? null,
      now: new Date("2026-06-27T13:40:30.000Z"),
    });

    expect(completed.status).toBe("FAILED");
    expect(completed.textBundle).toBeNull();
    expect(completed.failureDetail).toEqual({
      attempt: 1,
      code: "girke_unavailable",
      failedAt: "2026-06-27T13:40:30.000Z",
      leaseClaimedAt: "2026-06-27T13:40:00.000Z",
      message: "Girke preprocessing worker could not start.",
      retryable: true,
    });
    expect(repository.enrichmentJobs).toHaveLength(0);
  });
});
