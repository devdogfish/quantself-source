import { describe, expect, test } from "bun:test";
import {
  handleInventoryPreprocessingClaim,
  handleInventoryPreprocessingFailure,
  handleInventoryPreprocessingSuccess,
} from "../../api/src/inventory-preprocessing-route-handlers";
import type {
  InventoryEnrichmentJobRecord,
  InventoryEnrichmentNewJobRecord,
} from "../../api/src/inventory-enrichment-service";
import {
  queueInventoryPreprocessingCapture,
  type InventoryPreprocessingJobRecord,
  type InventoryPreprocessingNewJobRecord,
  type InventoryPreprocessingRuntimeRepository,
  type InventoryTextBundle,
} from "../../api/src/inventory-preprocessing-service";
import type { InventoryItemRecord } from "../../api/src/inventory-service";

class RoutePreprocessingRepository
  implements Pick<InventoryPreprocessingRuntimeRepository, keyof InventoryPreprocessingRuntimeRepository>
{
  readonly items: InventoryItemRecord[] = [
    {
      aliases: [],
      acquisitionSource: null,
      audioNotes: [
        {
          filePath: "storage/inventory-audio/passport-note.m4a",
          id: "audio-1",
          mimeType: "audio/mp4",
          originalName: "passport-note.m4a",
          sizeBytes: 2048,
        },
      ],
      captureSessionId: null,
      captureText: "Passport and charger live in this pouch.",
      capturedAt: new Date("2026-07-13T12:00:00.000Z"),
      category: null,
      containerLabel: "Travel pouch",
      costCents: null,
      costCurrency: "CAD",
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
      locationId: null,
      locationName: "Closet shelf",
      metadata: {},
      note: null,
      originLocationId: null,
      originLocationName: "Hallway",
      searchText: "passport charger travel pouch closet shelf hallway",
      status: "UNSURE",
      tags: [],
      title: "Small black pouch",
    },
  ];
  readonly preprocessingJobs: InventoryPreprocessingJobRecord[] = [];
  readonly enrichmentJobs: InventoryEnrichmentJobRecord[] = [];
  failNextEnrichmentEnqueue = false;
  private enrichmentJobCount = 0;
  private preprocessingJobCount = 0;

  async enqueueInventoryPreprocessingJobs(
    jobs: InventoryPreprocessingNewJobRecord[],
  ): Promise<InventoryPreprocessingJobRecord[]> {
    const now = new Date("2026-07-13T12:05:00.000Z");
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

  async getInventoryItem(id: string): Promise<InventoryItemRecord | null> {
    return this.items.find((item) => item.id === id) ?? null;
  }

  async enqueueInventoryEnrichmentJobs(
    jobs: InventoryEnrichmentNewJobRecord[],
  ): Promise<InventoryEnrichmentJobRecord[]> {
    if (this.failNextEnrichmentEnqueue) {
      this.failNextEnrichmentEnqueue = false;
      throw new Error("simulated database failure");
    }

    const now = new Date("2026-07-13T12:06:00.000Z");
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
}

describe("inventory preprocessing route handlers", () => {
  test("requires the configured inventory preprocessing secret before claiming jobs", async () => {
    const repository = new RoutePreprocessingRepository();
    await queueInventoryPreprocessingCapture(repository, repository.items[0]!);

    const response = await handleInventoryPreprocessingClaim(
      jsonRequest("/api/internal/inventory/preprocessing/jobs/claim", {}),
      repository,
      "secret",
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Unauthorized inventory preprocessing worker request.",
    });
  });

  test("claims work with an item snapshot and completes with a text bundle", async () => {
    const repository = new RoutePreprocessingRepository();
    await queueInventoryPreprocessingCapture(repository, repository.items[0]!);

    const claimResponse = await handleInventoryPreprocessingClaim(
      jsonRequest(
        "/api/internal/inventory/preprocessing/jobs/claim",
        { leaseSeconds: 45, limit: 1, workerId: "preprocessing-route-test" },
        "secret",
      ),
      repository,
      "secret",
    );
    const claimBody = (await claimResponse.json()) as {
      jobs: Array<{
        claimedAt: string | null;
        claimedBy: string | null;
        id: string;
        item: {
          audioNotes: Array<{ filePath: string; id: string }>;
          captureText: string | null;
          id: string;
          images: Array<{ filePath: string; id: string }>;
        };
        leaseExpiresAt: string | null;
        sourceRefs: Array<{ id: string; kind: string }>;
        status: InventoryPreprocessingJobRecord["status"];
      }>;
    };

    expect(claimResponse.status).toBe(200);
    expect(claimBody.jobs).toHaveLength(1);
    expect(claimBody.jobs[0]?.status).toBe("PROCESSING");
    expect(claimBody.jobs[0]?.claimedBy).toBe("preprocessing-route-test");
    expect(claimBody.jobs[0]?.item).toMatchObject({
      audioNotes: [{ filePath: "storage/inventory-audio/passport-note.m4a", id: "audio-1" }],
      captureText: "Passport and charger live in this pouch.",
      id: "item-1",
      images: [{ filePath: "storage/inventory-images/passport-pouch.jpg", id: "image-1" }],
    });
    expect(claimBody.jobs[0]?.sourceRefs).toEqual([
      { id: "item-1", kind: "item" },
      { id: "image-1", kind: "image" },
      { id: "audio-1", kind: "audio" },
    ]);
    expect(claimBody.jobs[0]?.leaseExpiresAt).not.toBeNull();

    const textBundle: InventoryTextBundle = {
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
          type: "image",
        },
        {
          mediaId: "audio-1",
          provider: "girke",
          providerModel: "distil-small.en",
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
    };

    const successResponse = await handleInventoryPreprocessingSuccess(
      jsonRequest(
        `/api/internal/inventory/preprocessing/jobs/${claimBody.jobs[0]?.id}/success`,
        {
          leaseClaimedAt: claimBody.jobs[0]?.claimedAt,
          textBundle,
        },
        "secret",
      ),
      repository,
      claimBody.jobs[0]?.id ?? "",
      "secret",
    );
    const successBody = (await successResponse.json()) as {
      job: InventoryPreprocessingJobRecord;
    };

    expect(successResponse.status).toBe(200);
    expect(successBody.job.status).toBe("READY_FOR_ENRICHMENT");
    expect(successBody.job.textBundle).toEqual(textBundle);
    expect(repository.enrichmentJobs).toHaveLength(1);
    expect(repository.enrichmentJobs[0]?.targetItemId).toBe("item-1");
  });

  test("repairs completed preprocessing without an enrichment handoff on first claim", async () => {
    const repository = new RoutePreprocessingRepository();
    const completedAt = new Date("2026-07-13T12:06:00.000Z");
    repository.preprocessingJobs.push({
      attempts: 1,
      claimedAt: null,
      claimedBy: null,
      completedAt,
      createdAt: new Date("2026-07-13T12:05:00.000Z"),
      failureDetail: null,
      id: "orphaned-preprocessing-job",
      leaseExpiresAt: null,
      maxAttempts: 3,
      sourceRefs: [{ id: "item-1", kind: "item" }],
      status: "READY_FOR_ENRICHMENT",
      targetItemId: "item-1",
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
        mediaTexts: [],
        schemaVersion: 1,
        sourceRefs: [{ id: "item-1", kind: "item" }],
      },
      updatedAt: completedAt,
    });

    const response = await handleInventoryPreprocessingClaim(
      jsonRequest(
        "/api/internal/inventory/preprocessing/jobs/claim",
        { leaseSeconds: 45, limit: 1, workerId: "preprocessing-route-test" },
        "secret",
      ),
      repository,
      "secret",
    );
    const body = (await response.json()) as { jobs: unknown[] };

    expect(response.status).toBe(200);
    expect(body.jobs).toEqual([]);
    expect(repository.enrichmentJobs).toHaveLength(1);
    expect(repository.enrichmentJobs[0]?.targetItemId).toBe("item-1");
  });

  test("reports handoff persistence failures as retryable server errors", async () => {
    const repository = new RoutePreprocessingRepository();
    await queueInventoryPreprocessingCapture(repository, repository.items[0]!);
    const claimResponse = await handleInventoryPreprocessingClaim(
      jsonRequest(
        "/api/internal/inventory/preprocessing/jobs/claim",
        { leaseSeconds: 45, limit: 1, workerId: "preprocessing-route-test" },
        "secret",
      ),
      repository,
      "secret",
    );
    const claimBody = (await claimResponse.json()) as {
      jobs: Array<{ claimedAt: string | null; id: string }>;
    };
    repository.failNextEnrichmentEnqueue = true;

    const response = await handleInventoryPreprocessingSuccess(
      jsonRequest(
        `/api/internal/inventory/preprocessing/jobs/${claimBody.jobs[0]?.id}/success`,
        {
          leaseClaimedAt: claimBody.jobs[0]?.claimedAt,
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
            mediaTexts: [],
            schemaVersion: 1,
            sourceRefs: [{ id: "item-1", kind: "item" }],
          },
        },
        "secret",
      ),
      repository,
      claimBody.jobs[0]?.id ?? "",
      "secret",
    );

    expect(response.status).toBe(500);
    expect(repository.preprocessingJobs[0]?.status).toBe("PROCESSING");
    expect(repository.enrichmentJobs).toHaveLength(0);
  });

  test("records terminal worker failures through the failure endpoint", async () => {
    const repository = new RoutePreprocessingRepository();
    await queueInventoryPreprocessingCapture(repository, repository.items[0]!);
    const claimResponse = await handleInventoryPreprocessingClaim(
      jsonRequest(
        "/api/internal/inventory/preprocessing/jobs/claim",
        { leaseSeconds: 45, limit: 1, workerId: "preprocessing-route-test" },
        "secret",
      ),
      repository,
      "secret",
    );
    const claimBody = (await claimResponse.json()) as {
      jobs: Array<{ claimedAt: string | null; id: string }>;
    };

    const failureResponse = await handleInventoryPreprocessingFailure(
      jsonRequest(
        `/api/internal/inventory/preprocessing/jobs/${claimBody.jobs[0]?.id}/failure`,
        {
          code: "girke_credentials_missing",
          leaseClaimedAt: claimBody.jobs[0]?.claimedAt,
          message: "Girke API token is not configured.",
          retryable: false,
        },
        "secret",
      ),
      repository,
      claimBody.jobs[0]?.id ?? "",
      "secret",
    );
    const failureBody = (await failureResponse.json()) as {
      job: InventoryPreprocessingJobRecord;
    };

    expect(failureResponse.status).toBe(200);
    expect(failureBody.job.status).toBe("FAILED");
    expect(failureBody.job.failureDetail).toEqual({
      attempt: 1,
      code: "girke_credentials_missing",
      failedAt: expect.any(String),
      leaseClaimedAt: claimBody.jobs[0]?.claimedAt,
      message: "Girke API token is not configured.",
      retryable: false,
    });
    expect(repository.enrichmentJobs).toHaveLength(0);
  });
});

function jsonRequest(
  pathname: string,
  body: unknown,
  secret?: string,
): Request {
  const headers = new Headers({ "content-type": "application/json" });

  if (secret) {
    headers.set("authorization", `Bearer ${secret}`);
  }

  return new Request(`http://localhost${pathname}`, {
    body: JSON.stringify(body),
    headers,
    method: "POST",
  });
}
