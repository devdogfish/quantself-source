import { describe, expect, test } from "bun:test";
import {
  handleInventoryEnrichmentClaim,
  handleInventoryEnrichmentFailure,
  handleInventoryEnrichmentSuccess,
} from "../../api/src/inventory-enrichment-route-handlers";
import {
  queueInventoryEnrichmentCapture,
  type InventoryEnrichmentJobRecord,
  type InventoryEnrichmentNewJobRecord,
  type InventoryEnrichmentRepository,
  type InventoryEnrichmentSettingsRecord,
} from "../../api/src/inventory-enrichment-service";
import type { InventoryItemRecord } from "../../api/src/inventory-service";

class RouteEnrichmentRepository implements InventoryEnrichmentRepository {
  readonly items: InventoryItemRecord[] = [
    {
      aliases: [],
      acquisitionSource: null,
      captureSessionId: null,
      capturedAt: new Date("2026-06-27T11:00:00.000Z"),
      category: null,
      containerLabel: "Black pouch",
      costCents: null,
      costCurrency: "CAD",
      id: "item-1",
      images: [],
      importance: "MEDIUM",
      kind: "GROUP",
      locationId: null,
      locationName: "Storage shelf",
      metadata: {},
      note: null,
      originLocationId: null,
      originLocationName: "Office",
      searchText: "black pouch storage shelf office",
      status: "UNSURE",
      tags: [],
      title: "Small black pouch",
    },
  ];
  readonly jobs: InventoryEnrichmentJobRecord[] = [];
  private jobCount = 0;
  settings: InventoryEnrichmentSettingsRecord = {
    approvalsRequired: true,
    updatedAt: new Date("2026-06-27T09:00:00.000Z"),
  };

  async enqueueInventoryEnrichmentJobs(
    jobs: InventoryEnrichmentNewJobRecord[],
  ): Promise<InventoryEnrichmentJobRecord[]> {
    const now = new Date("2026-06-27T11:30:00.000Z");
    const createdJobs = jobs.map((job) => ({
      ...job,
      attempts: 0,
      createdAt: now,
      id: `job-${++this.jobCount}`,
      status: "QUEUED" as const,
      updatedAt: now,
    }));

    this.jobs.push(...createdJobs);

    return createdJobs;
  }

  async listClaimableInventoryEnrichmentJobs(input: {
    limit: number;
    now: Date;
  }): Promise<InventoryEnrichmentJobRecord[]> {
    return this.jobs
      .filter(
        (job) =>
          job.status === "QUEUED" ||
          (job.status === "CLAIMED" &&
            job.leaseExpiresAt !== null &&
            job.leaseExpiresAt <= input.now),
      )
      .slice(0, input.limit);
  }

  async listInventoryEnrichmentJobs(input?: {
    status?: InventoryEnrichmentJobRecord["status"];
    limit?: number;
    targetItemId?: string;
  }): Promise<InventoryEnrichmentJobRecord[]> {
    return this.jobs
      .filter(
        (job) =>
          (!input?.status || job.status === input.status) &&
          (!input?.targetItemId || job.targetItemId === input.targetItemId),
      )
      .slice(0, input?.limit ?? this.jobs.length);
  }

  async updateInventoryEnrichmentJob(
    job: InventoryEnrichmentJobRecord,
  ): Promise<InventoryEnrichmentJobRecord> {
    const index = this.jobs.findIndex(
      (existingJob) => existingJob.id === job.id,
    );
    this.jobs[index] = job;

    return job;
  }

  async getInventoryEnrichmentJob(
    id: string,
  ): Promise<InventoryEnrichmentJobRecord | null> {
    return this.jobs.find((job) => job.id === id) ?? null;
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

  async applyInventoryItemEnrichment(input: {
    itemId: string;
    title: string | null;
    note: string | null;
    status: InventoryItemRecord["status"];
    importance: InventoryItemRecord["importance"];
    acquisitionSource: string | null;
    category: string | null;
    costCents: number | null;
    tags: string[];
    aliases: string[];
    searchText: string;
    metadata: Record<string, unknown>;
  }): Promise<InventoryItemRecord> {
    const item = this.items.find((candidate) => candidate.id === input.itemId);

    if (!item) {
      throw new Error("Inventory item not found.");
    }

    Object.assign(item, {
      acquisitionSource: input.acquisitionSource,
      importance: input.importance,
      aliases: input.aliases,
      category: input.category,
      costCents: input.costCents,
      metadata: input.metadata,
      note: input.note,
      searchText: input.searchText,
      status: input.status,
      tags: input.tags,
      title: input.title,
    });

    return item;
  }

  async applyInventoryImageEnrichment(): Promise<void> {}
}

describe("inventory enrichment route handlers", () => {
  test("requires the configured inventory enrichment secret before claiming jobs", async () => {
    const repository = new RouteEnrichmentRepository();
    await queueInventoryEnrichmentCapture(repository, repository.items[0]!);

    const response = await handleInventoryEnrichmentClaim(
      jsonRequest("/api/internal/inventory/enrichment/jobs/claim", {}),
      repository,
      "secret",
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Unauthorized inventory enrichment worker request.",
    });
  });

  test("claims work and rejects malformed success payloads", async () => {
    const repository = new RouteEnrichmentRepository();
    await queueInventoryEnrichmentCapture(repository, repository.items[0]!);
    const claimResponse = await handleInventoryEnrichmentClaim(
      jsonRequest(
        "/api/internal/inventory/enrichment/jobs/claim",
        { leaseSeconds: 45, limit: 1, workerId: "enrichment-route-test" },
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
        leaseExpiresAt: string | null;
        status: InventoryEnrichmentJobRecord["status"];
      }>;
    };

    expect(claimResponse.status).toBe(200);
    expect(claimBody.jobs).toHaveLength(1);
    expect(claimBody.jobs[0]?.status).toBe("CLAIMED");
    expect(claimBody.jobs[0]?.claimedBy).toBe("enrichment-route-test");
    expect(claimBody.jobs[0]?.leaseExpiresAt).not.toBeNull();

    const successResponse = await handleInventoryEnrichmentSuccess(
      jsonRequest(
        `/api/internal/inventory/enrichment/jobs/${claimBody.jobs[0]?.id}/success`,
        {
          leaseClaimedAt: claimBody.jobs[0]?.claimedAt,
          result: { confidence: 0.91 },
          resultId: "bad-result-1",
        },
        "secret",
      ),
      repository,
      claimBody.jobs[0]?.id ?? "",
      "secret",
    );

    expect(successResponse.status).toBe(400);
    expect(await successResponse.json()).toEqual({
      error: "Inventory enrichment result field is not allowed: confidence",
    });
  });

  test("rejects stale lease submits after the job is recovered", async () => {
    const repository = new RouteEnrichmentRepository();
    await queueInventoryEnrichmentCapture(repository, repository.items[0]!);
    const claimResponse = await handleInventoryEnrichmentClaim(
      jsonRequest(
        "/api/internal/inventory/enrichment/jobs/claim",
        { leaseSeconds: 45, limit: 1, workerId: "enrichment-route-test" },
        "secret",
      ),
      repository,
      "secret",
    );
    const claimBody = (await claimResponse.json()) as {
      jobs: Array<{ claimedAt: string | null; id: string }>;
    };
    const claimedJob = repository.jobs.find(
      (job) => job.id === claimBody.jobs[0]?.id,
    );

    if (!claimedJob) {
      throw new Error("Expected claimed inventory enrichment job.");
    }

    await repository.updateInventoryEnrichmentJob({
      ...claimedJob,
      attempts: claimedJob.attempts + 1,
      claimedAt: new Date("2026-06-27T12:02:00.000Z"),
      claimedBy: "enrichment-recovered",
      leaseExpiresAt: new Date("2026-06-27T12:03:00.000Z"),
      status: "CLAIMED",
      updatedAt: new Date("2026-06-27T12:02:00.000Z"),
    });

    const successResponse = await handleInventoryEnrichmentSuccess(
      jsonRequest(
        `/api/internal/inventory/enrichment/jobs/${claimBody.jobs[0]?.id}/success`,
        {
          leaseClaimedAt: claimBody.jobs[0]?.claimedAt,
          result: { aliases: ["passport pouch"] },
          resultId: "stale-lease-result-1",
        },
        "secret",
      ),
      repository,
      claimBody.jobs[0]?.id ?? "",
      "secret",
    );

    expect(successResponse.status).toBe(409);
    expect(await successResponse.json()).toEqual({
      error: "Inventory enrichment job lease is no longer active.",
    });
  });

  test("keeps pending success submits idempotent through the private route", async () => {
    const repository = new RouteEnrichmentRepository();
    await queueInventoryEnrichmentCapture(repository, repository.items[0]!);
    const claimResponse = await handleInventoryEnrichmentClaim(
      jsonRequest(
        "/api/internal/inventory/enrichment/jobs/claim",
        { leaseSeconds: 45, limit: 1, workerId: "enrichment-route-test" },
        "secret",
      ),
      repository,
      "secret",
    );
    const claimBody = (await claimResponse.json()) as {
      jobs: Array<{ claimedAt: string | null; id: string }>;
    };
    const requestBody = {
      leaseClaimedAt: claimBody.jobs[0]?.claimedAt,
      result: { aliases: ["passport pouch"] },
      resultId: "pending-route-result-1",
    };
    const firstResponse = await handleInventoryEnrichmentSuccess(
      jsonRequest(
        `/api/internal/inventory/enrichment/jobs/${claimBody.jobs[0]?.id}/success`,
        requestBody,
        "secret",
      ),
      repository,
      claimBody.jobs[0]?.id ?? "",
      "secret",
    );
    const secondResponse = await handleInventoryEnrichmentSuccess(
      jsonRequest(
        `/api/internal/inventory/enrichment/jobs/${claimBody.jobs[0]?.id}/success`,
        requestBody,
        "secret",
      ),
      repository,
      claimBody.jobs[0]?.id ?? "",
      "secret",
    );
    const firstBody = (await firstResponse.json()) as {
      job: InventoryEnrichmentJobRecord;
    };
    const secondBody = (await secondResponse.json()) as {
      job: InventoryEnrichmentJobRecord;
    };

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(firstBody.job.status).toBe("PENDING_APPROVAL");
    expect(secondBody.job.id).toBe(firstBody.job.id);
    expect(secondBody.job.status).toBe("PENDING_APPROVAL");
  });

  test("records retryable failure details through the private route", async () => {
    const repository = new RouteEnrichmentRepository();
    await queueInventoryEnrichmentCapture(repository, repository.items[0]!);
    const claimResponse = await handleInventoryEnrichmentClaim(
      jsonRequest(
        "/api/internal/inventory/enrichment/jobs/claim",
        { leaseSeconds: 45, limit: 1, workerId: "enrichment-route-test" },
        "secret",
      ),
      repository,
      "secret",
    );
    const claimBody = (await claimResponse.json()) as {
      jobs: Array<{ claimedAt: string | null; id: string }>;
    };
    const job = repository.jobs.find(
      (candidate) => candidate.id === claimBody.jobs[0]?.id,
    );

    if (!job) {
      throw new Error("Expected inventory enrichment job.");
    }

    const failureResponse = await handleInventoryEnrichmentFailure(
      jsonRequest(
        `/api/internal/inventory/enrichment/jobs/${job.id}/failure`,
        {
          leaseClaimedAt: claimBody.jobs[0]?.claimedAt,
          message: "model timeout",
          retryable: true,
        },
        "secret",
      ),
      repository,
      job.id,
      "secret",
    );
    const failureBody = (await failureResponse.json()) as {
      job: InventoryEnrichmentJobRecord;
    };

    expect(failureResponse.status).toBe(200);
    expect(failureBody.job.status).toBe("QUEUED");
    expect(failureBody.job.failureDetail).toMatchObject({
      attempt: 1,
      leaseClaimedAt: job.claimedAt?.toISOString(),
      message: "model timeout",
      retryable: true,
    });
    expect(
      Number.isNaN(
        Date.parse(failureBody.job.failureDetail?.failedAt ?? "not-a-date"),
      ),
    ).toBe(false);
  });

  test("rejects malformed failure payloads through the private route", async () => {
    const repository = new RouteEnrichmentRepository();
    await queueInventoryEnrichmentCapture(repository, repository.items[0]!);
    const claimResponse = await handleInventoryEnrichmentClaim(
      jsonRequest(
        "/api/internal/inventory/enrichment/jobs/claim",
        { leaseSeconds: 45, limit: 1, workerId: "enrichment-route-test" },
        "secret",
      ),
      repository,
      "secret",
    );
    const claimBody = (await claimResponse.json()) as {
      jobs: Array<{ claimedAt: string | null; id: string }>;
    };
    const failureResponse = await handleInventoryEnrichmentFailure(
      jsonRequest(
        `/api/internal/inventory/enrichment/jobs/${claimBody.jobs[0]?.id}/failure`,
        {
          leaseClaimedAt: claimBody.jobs[0]?.claimedAt,
          message: "model timeout",
          retryable: "yes",
        },
        "secret",
      ),
      repository,
      claimBody.jobs[0]?.id ?? "",
      "secret",
    );

    expect(failureResponse.status).toBe(400);
    expect(await failureResponse.json()).toEqual({
      error: "Inventory enrichment failure retryable must be a boolean.",
    });
  });
});

function jsonRequest(
  pathname: string,
  body: unknown,
  secret?: string,
): Request {
  return new Request(`http://quantself.test${pathname}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    method: "POST",
  });
}
