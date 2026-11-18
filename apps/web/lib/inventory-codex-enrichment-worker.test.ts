import { describe, expect, test } from "bun:test";
import {
  InventoryCodexEnrichmentWorkerApiError,
  runInventoryCodexEnrichmentWorkerOnce,
  type InventoryCodexEnrichmentClient,
  type InventoryCodexEnrichmentWorkerApiClient,
  type InventoryEnrichmentWorkerClaimedJob,
} from "./inventory-codex-enrichment-worker";
import type { InventoryTextBundle } from "../../api/src/inventory-preprocessing-service";

class FakeWorkerApiClient implements InventoryCodexEnrichmentWorkerApiClient {
  readonly claimInputs: Array<{
    leaseSeconds: number;
    limit: number;
    workerId: string;
  }> = [];
  readonly successes: Array<{
    jobId: string;
    leaseClaimedAt: string | null;
    result: unknown;
    resultId: string;
  }> = [];
  readonly failures: Array<{
    jobId: string;
    leaseClaimedAt: string | null;
    message: string;
    retryable: boolean;
  }> = [];

  constructor(
    private readonly jobs: InventoryEnrichmentWorkerClaimedJob[],
    private readonly submitSuccessError?: Error,
  ) {}

  async claimJobs(input: {
    leaseSeconds: number;
    limit: number;
    workerId: string;
  }): Promise<InventoryEnrichmentWorkerClaimedJob[]> {
    this.claimInputs.push(input);

    return this.jobs.slice(0, input.limit);
  }

  async submitSuccess(input: {
    jobId: string;
    leaseClaimedAt: string | null;
    result: unknown;
    resultId: string;
  }): Promise<void> {
    this.successes.push(input);

    if (this.submitSuccessError) {
      throw this.submitSuccessError;
    }
  }

  async submitFailure(input: {
    jobId: string;
    leaseClaimedAt: string | null;
    message: string;
    retryable: boolean;
  }): Promise<void> {
    this.failures.push(input);
  }
}

class FakeCodexClient implements InventoryCodexEnrichmentClient {
  readonly requests: Array<{ outputSchema: unknown; prompt: string }> = [];

  constructor(
    private readonly finalResponse: string,
    private readonly resultId = "codex-thread-1",
  ) {}

  async runInventoryEnrichment(input: {
    outputSchema: unknown;
    prompt: string;
  }): Promise<{ finalResponse: string; resultId: string }> {
    this.requests.push(input);

    return {
      finalResponse: this.finalResponse,
      resultId: this.resultId,
    };
  }
}

describe("inventory codex enrichment worker", () => {
  test("uses a strict-required schema while preserving nullable proposal fields", async () => {
    const apiClient = new FakeWorkerApiClient([buildClaimedBundleJob()]);
    const codexClient = new FakeCodexClient(
      JSON.stringify({
        aliases: null,
        acquisitionSource: null,
        category: null,
        confidence: 0.7,
        costCents: null,
        importance: null,
        note: null,
        rationale: "Only the required proposal metadata is supported.",
        status: null,
        tags: null,
        title: null,
      }),
    );

    const summary = await runInventoryCodexEnrichmentWorkerOnce({
      apiClient,
      codexClient,
      workerId: "inventory-codex-test",
    });

    expect(summary).toEqual({
      claimed: 1,
      failed: 0,
      processed: 1,
      succeeded: 1,
    });
    expect(apiClient.successes[0]?.result).toMatchObject({
      aliases: [],
      acquisitionSource: null,
      category: null,
      costCents: null,
      importance: null,
      note: null,
      status: null,
      tags: [],
      title: null,
    });

    const outputSchema = codexClient.requests[0]?.outputSchema as {
      properties: Record<string, { type?: unknown }>;
      required: string[];
    };

    expect([...outputSchema.required].sort()).toEqual(
      Object.keys(outputSchema.properties).sort(),
    );
    expect(outputSchema.properties.aliases?.type).toEqual(["array", "null"]);
    expect(outputSchema.properties.title?.type).toEqual(["string", "null"]);
  });

  test("claims bundle jobs, sends OCR/transcript/source refs only, and submits normalized proposal results", async () => {
    const apiClient = new FakeWorkerApiClient([buildClaimedBundleJob()]);
    const codexClient = new FakeCodexClient(
      JSON.stringify({
        aliases: ["travel document pouch"],
        acquisitionSource: "gift",
        category: "documents",
        confidence: 0.94,
        costCents: 1250,
        importance: "HIGH",
        note: "Passport and charging kit stored together.",
        rationale: "OCR and transcript mention passport and charger.",
        status: "KEEP",
        tags: ["travel", "documents"],
        title: "Passport and charger pouch",
      }),
    );

    const summary = await runInventoryCodexEnrichmentWorkerOnce({
      apiClient,
      codexClient,
      leaseSeconds: 300,
      limit: 1,
      workerId: "inventory-codex-test",
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
        workerId: "inventory-codex-test",
      },
    ]);
    expect(apiClient.successes).toEqual([
      {
        jobId: "job-1",
        leaseClaimedAt: "2026-07-13T04:00:00.000Z",
        result: {
          aliases: ["travel document pouch"],
          acquisitionSource: "gift",
          category: "documents",
          costCents: 1250,
          importance: "HIGH",
          metadata: {
            confidence: 0.94,
            rationale: "OCR and transcript mention passport and charger.",
          },
          note: "Passport and charging kit stored together.",
          searchTextAdditions: [],
          status: "KEEP",
          tags: ["documents", "travel"],
          title: "Passport and charger pouch",
        },
        resultId: "codex-thread-1",
      },
    ]);
    expect(apiClient.failures).toEqual([]);
    expect(codexClient.requests).toHaveLength(1);
    expect(codexClient.requests[0]?.prompt).toContain("PASSPORT USB-C CHARGER");
    expect(codexClient.requests[0]?.prompt).toContain(
      "Spoken note mentions the passport and charger.",
    );
    expect(codexClient.requests[0]?.prompt).toContain(
      "Allowed acquisition source values",
    );
    expect(codexClient.requests[0]?.prompt).toContain("costCents");
    expect(codexClient.requests[0]?.prompt).toContain('"sourceRefs"');
    expect(codexClient.requests[0]?.prompt).not.toContain(
      "storage/inventory-images",
    );
    expect(codexClient.requests[0]?.prompt).not.toContain(
      "Bearer girke-secret",
    );
    expect(codexClient.requests[0]?.prompt).not.toContain(
      "https://api.example.com",
    );
    expect(codexClient.requests[0]?.prompt).not.toContain(
      "https://www.canadiantire.ca/example",
    );
    expect(codexClient.requests[0]?.prompt).toContain("[redacted url]");
    expect(codexClient.requests[0]?.prompt).not.toContain("sourceMetadata");
    expect(codexClient.requests[0]?.prompt).not.toContain("providerJobId");
    expect(codexClient.requests[0]?.outputSchema).toMatchObject({
      additionalProperties: false,
      type: "object",
    });
  });

  test("records invalid JSON as a non-retryable worker failure", async () => {
    const apiClient = new FakeWorkerApiClient([buildClaimedBundleJob()]);
    const codexClient = new FakeCodexClient("not-json");

    const summary = await runInventoryCodexEnrichmentWorkerOnce({
      apiClient,
      codexClient,
      workerId: "inventory-codex-test",
    });

    expect(summary).toEqual({
      claimed: 1,
      failed: 1,
      processed: 1,
      succeeded: 0,
    });
    expect(apiClient.successes).toEqual([]);
    expect(apiClient.failures).toEqual([
      {
        jobId: "job-1",
        leaseClaimedAt: "2026-07-13T04:00:00.000Z",
        message: "Codex enrichment output must be strict JSON.",
        retryable: false,
      },
    ]);
  });

  test("records unsupported Codex fields as a non-retryable worker failure", async () => {
    const apiClient = new FakeWorkerApiClient([buildClaimedBundleJob()]);
    const codexClient = new FakeCodexClient(
      JSON.stringify({
        confidence: 0.91,
        imageCaption: "not allowed",
        rationale: "This should fail validation.",
      }),
    );

    await runInventoryCodexEnrichmentWorkerOnce({
      apiClient,
      codexClient,
      workerId: "inventory-codex-test",
    });

    expect(apiClient.successes).toEqual([]);
    expect(apiClient.failures).toEqual([
      {
        jobId: "job-1",
        leaseClaimedAt: "2026-07-13T04:00:00.000Z",
        message: "Codex enrichment output field is not allowed: imageCaption",
        retryable: false,
      },
    ]);
  });

  test("records stale success submission errors through the failure endpoint", async () => {
    const apiClient = new FakeWorkerApiClient(
      [buildClaimedBundleJob()],
      new InventoryCodexEnrichmentWorkerApiError(
        409,
        "Inventory enrichment result is stale for current inventory input.",
      ),
    );
    const codexClient = new FakeCodexClient(
      JSON.stringify({
        confidence: 0.88,
        rationale: "Passport OCR text is present.",
        title: "Passport pouch",
      }),
    );

    const summary = await runInventoryCodexEnrichmentWorkerOnce({
      apiClient,
      codexClient,
      workerId: "inventory-codex-test",
    });

    expect(summary).toEqual({
      claimed: 1,
      failed: 1,
      processed: 1,
      succeeded: 0,
    });
    expect(apiClient.failures).toEqual([
      {
        jobId: "job-1",
        leaseClaimedAt: "2026-07-13T04:00:00.000Z",
        message:
          "Inventory enrichment result is stale for current inventory input.",
        retryable: false,
      },
    ]);
  });

  test("fails legacy or image jobs without sending raw snapshot material to Codex", async () => {
    const apiClient = new FakeWorkerApiClient([
      {
        claimedAt: "2026-07-13T04:00:00.000Z",
        id: "job-legacy-1",
        inputSnapshot: {
          deterministicMetadata: {
            aliases: [],
            category: null,
            metadata: {},
            searchText: "travel pouch",
            tags: [],
          },
          images: [
            {
              id: "image-1",
              mediaUrl: "/api/internal/inventory/enrichment/images/image-1",
              mimeType: "image/jpeg",
              ocrText: null,
              originalName: "travel-pouch.jpg",
              sizeBytes: 1200,
            },
          ],
          item: {
            capturedAt: "2026-07-13T03:00:00.000Z",
            containerLabel: null,
            id: "item-1",
            importance: "MEDIUM",
            kind: "GROUP",
            locationName: null,
            note: null,
            originLocationName: null,
            status: "UNSURE",
            title: "Travel pouch",
          },
          schemaVersion: 1,
          sourceFingerprint: "legacy-fingerprint",
          target: {
            imageId: null,
            itemId: "item-1",
            kind: "ITEM",
          },
        },
        kind: "INVENTORY_ITEM_ENRICHMENT",
      },
    ]);
    const codexClient = new FakeCodexClient(
      JSON.stringify({
        confidence: 0.88,
        rationale: "Should never be called.",
      }),
    );

    await runInventoryCodexEnrichmentWorkerOnce({
      apiClient,
      codexClient,
      workerId: "inventory-codex-test",
    });

    expect(codexClient.requests).toEqual([]);
    expect(apiClient.failures).toEqual([
      {
        jobId: "job-legacy-1",
        leaseClaimedAt: "2026-07-13T04:00:00.000Z",
        message:
          "Inventory enrichment worker only supports bundle-only item jobs.",
        retryable: false,
      },
    ]);
  });
});

function buildClaimedBundleJob(): InventoryEnrichmentWorkerClaimedJob {
  return {
    claimedAt: "2026-07-13T04:00:00.000Z",
    id: "job-1",
    inputSnapshot: {
      schemaVersion: 1,
      sourceFingerprint: "bundle-fingerprint-1",
      target: {
        imageId: null,
        itemId: "item-1",
        kind: "ITEM",
      },
      textBundle: buildTextBundle(),
    },
    kind: "INVENTORY_ITEM_ENRICHMENT",
  };
}

function buildTextBundle(): InventoryTextBundle {
  return {
    captureText:
      "Black pouch with passport, charger, and handwritten travel checklist.",
    failedSteps: [
      {
        mediaId: "audio-1",
        message: "One transcript segment timed out.",
        retryable: true,
        step: "transcription",
      },
    ],
    item: {
      containerLabel: "Top drawer",
      containerLocation: "Closet shelf",
      id: "item-1",
      importance: "MEDIUM",
      kind: "GROUP",
      note:
        "Needs better label. Product reference: https://www.canadiantire.ca/example",
      status: "UNSURE",
      title: "Black pouch",
    },
    mediaTexts: [
      {
        mediaId: "image-1",
        ocrLines: ["PASSPORT", "USB-C CHARGER"],
        ocrText: "PASSPORT USB-C CHARGER",
        provider: "girke",
        providerJobId: "girke-job-1",
        providerModel: "tesseract-latin-psm11-gray",
        sourceMetadata: {
          girkeResponse: {
            authorization: "Bearer girke-secret",
            url: "https://api.example.com/api/v1/ocr/result/1",
          },
        },
        type: "image",
      },
      {
        mediaId: "audio-1",
        provider: "girke",
        providerJobId: "girke-job-2",
        transcript:
          "Spoken note mentions the passport and charger. storage/inventory-images/raw.wav should stay private.",
        transcriptSegments: [
          {
            end: 2.5,
            start: 0,
            text: "Passport and charger are together.",
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
}
