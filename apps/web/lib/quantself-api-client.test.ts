import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const requests: Request[] = [];
const originalFetch = globalThis.fetch;

mock.module("next/headers", () => ({
  headers: async () =>
    new Headers({
      origin: "https://qs.girke.dev",
      "x-quantself-owner-proof": "a".repeat(64),
      cookie: "quantself.session=test-session",
    }),
}));

beforeEach(() => {
  requests.length = 0;
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const request = new Request(input, init);
      requests.push(request);

      if (request.url.includes("/api/v1/inventory-locations")) {
        const location = {
          containerCount: 1,
          id: "location-pantry",
          kind: "STORAGE",
          name: "Pantry",
          note: null,
          placementCount: 4,
        };

        return Response.json(
          request.method === "GET" ? { locations: [location] } : { location },
          { status: request.method === "POST" ? 201 : 200 },
        );
      }

      if (
        request.url.includes("/api/v1/inventory-items?") ||
        request.url.endsWith("/api/v1/inventory-items")
      ) {
        return Response.json({
          items: [
            {
              acquisitionSource: null,
              aliases: [],
              archivedAt: null,
              captureText: null,
              capturedAt: "2026-07-28T09:00:00.000Z",
              category: "food",
              clothingProfile: null,
              remedyProfile: null,
              containerId: null,
              containerLabel: null,
              costCents: null,
              costCurrency: "CAD",
              id: "item-food-1",
              importance: "MEDIUM",
              imageId: null,
              kind: "GROUP",
              note: null,
              placementSummary: "Total 2 · Pantry 2",
              placements: [
                {
                  containerId: null,
                  label: "Pantry",
                  locationId: "location-pantry",
                  locationName: "Pantry",
                  note: null,
                  quantity: 2,
                },
              ],
              processing: {
                currentStep: "Wait for background processing",
                enrichment: {
                  attempts: 0,
                  failedAt: null,
                  failureMessage: null,
                  maxAttempts: 3,
                  rationale: "Inventory Enrichment has not started.",
                  retryable: false,
                  status: "NOT_STARTED",
                  summary: "Inventory Enrichment has not started.",
                  updatedAt: "2026-07-28T09:00:00.000Z",
                },
                evidence: [],
                nextAction: "Wait for background processing",
                preprocessing: {
                  attempts: 0,
                  failedAt: null,
                  failedSteps: [],
                  failureMessage: null,
                  maxAttempts: 3,
                  mediaTexts: [],
                  status: "CAPTURED",
                  summary: "Saved evidence is waiting for preprocessing pickup.",
                  textBundleAvailable: false,
                  retryable: false,
                  updatedAt: "2026-07-28T09:00:00.000Z",
                },
                proposal: {
                  status: "NONE",
                  summary: "No pending Inventory Proposal.",
                  updatedAt: "2026-07-28T09:00:00.000Z",
                },
                sourceLabel: "Inventory capture",
              },
              status: "UNSURE",
              tags: [],
              title: "Kale chips",
              totalQuantity: 2,
              where: "Pantry × 2",
            },
          ],
        });
      }

      if (request.url.includes("/api/v1/inventory-items/item-1/clothing-profile")) {
        return Response.json(
          request.method === "GET"
            ? {
                clothingProfile: {
                  itemId: "item-1",
                  isDirty: false,
                  attributes: {
                    version: 1,
                    kind: "shirt",
                    colors: ["blue", "white"],
                  },
                  createdAt: "2026-08-03T09:00:00.000Z",
                  updatedAt: "2026-08-03T09:00:00.000Z",
                },
              }
            : {
                clothingProfile: {
                  itemId: "item-1",
                  isDirty: true,
                  attributes: {
                    version: 1,
                    kind: "shirt",
                    colors: ["blue", "white"],
                  },
                  createdAt: "2026-08-03T09:00:00.000Z",
                  updatedAt: "2026-08-03T10:00:00.000Z",
                },
                item: {
                  acquisitionSource: null,
                  aliases: [],
                  archivedAt: null,
                  captureText: null,
                  capturedAt: "2026-08-03T09:00:00.000Z",
                  category: "clothing",
                  clothingProfile: {
                    itemId: "item-1",
                    isDirty: true,
                    attributes: {
                      version: 1,
                      kind: "shirt",
                      colors: ["blue", "white"],
                    },
                    createdAt: "2026-08-03T09:00:00.000Z",
                    updatedAt: "2026-08-03T10:00:00.000Z",
                  },
                  remedyProfile: null,
                  containerId: null,
                  containerLabel: null,
                  costCents: null,
                  costCurrency: "CAD",
                  id: "item-1",
                  importance: "MEDIUM",
                  imageId: null,
                  kind: "GROUP",
                  note: null,
                  placementSummary: "Total 2 · BIN-0004 2",
                  placements: [{ label: "Blue bin 4 (BIN-0004)", quantity: 2 }],
                  processing: {
                    currentStep: "Wait for background processing",
                    enrichment: {
                      attempts: 0,
                      failedAt: null,
                      failureMessage: null,
                      maxAttempts: 3,
                      rationale: "Inventory Enrichment has not started.",
                      retryable: false,
                      status: "NOT_STARTED",
                      summary: "Inventory Enrichment has not started.",
                      updatedAt: "2026-08-03T09:00:00.000Z",
                    },
                    evidence: [],
                    nextAction: "Wait for background processing",
                    preprocessing: {
                      attempts: 0,
                      failedAt: null,
                      failedSteps: [],
                      failureMessage: null,
                      maxAttempts: 3,
                      mediaTexts: [],
                      status: "CAPTURED",
                      summary: "Saved evidence is waiting for preprocessing pickup.",
                      textBundleAvailable: false,
                      retryable: false,
                      updatedAt: "2026-08-03T09:00:00.000Z",
                    },
                    proposal: {
                      status: "NONE",
                      summary: "No pending Inventory Proposal.",
                      updatedAt: "2026-08-03T09:00:00.000Z",
                    },
                    sourceLabel: "Inventory capture",
                  },
                  status: "UNSURE",
                  tags: [],
                  title: "Travel pouch",
                  totalQuantity: 2,
                  where: "Blue bin 4 (BIN-0004) × 2",
                },
              },
        );
      }

      if (request.url.includes("/api/v1/inventory-items/item-1/worn")) {
        return Response.json({
          item: {
            acquisitionSource: null,
            aliases: [],
            archivedAt: null,
            captureText: null,
            capturedAt: "2026-08-03T09:00:00.000Z",
            category: "clothing",
            clothingProfile: {
              itemId: "item-1",
              isDirty: true,
              attributes: {
                version: 1,
                kind: "shirt",
                colors: ["blue", "white"],
              },
              createdAt: "2026-08-03T09:00:00.000Z",
              updatedAt: "2026-08-03T10:30:00.000Z",
            },
            remedyProfile: null,
            containerId: null,
            containerLabel: null,
            costCents: null,
            costCurrency: "CAD",
            id: "item-1",
            importance: "MEDIUM",
            imageId: null,
            kind: "GROUP",
            note: null,
            placementSummary: "Total 2 · BIN-0004 2",
            placements: [{ label: "Blue bin 4 (BIN-0004)", quantity: 2 }],
            processing: {
              currentStep: "Wait for background processing",
              enrichment: {
                attempts: 0,
                failedAt: null,
                failureMessage: null,
                maxAttempts: 3,
                rationale: "Inventory Enrichment has not started.",
                retryable: false,
                status: "NOT_STARTED",
                summary: "Inventory Enrichment has not started.",
                updatedAt: "2026-08-03T09:00:00.000Z",
              },
              evidence: [],
              nextAction: "Wait for background processing",
              preprocessing: {
                attempts: 0,
                failedAt: null,
                failedSteps: [],
                failureMessage: null,
                maxAttempts: 3,
                mediaTexts: [],
                status: "CAPTURED",
                summary: "Saved evidence is waiting for preprocessing pickup.",
                textBundleAvailable: false,
                retryable: false,
                updatedAt: "2026-08-03T09:00:00.000Z",
              },
              proposal: {
                status: "NONE",
                summary: "No pending Inventory Proposal.",
                updatedAt: "2026-08-03T09:00:00.000Z",
              },
              sourceLabel: "Inventory capture",
            },
            status: "UNSURE",
            tags: [],
            title: "Travel pouch",
            totalQuantity: 2,
            where: "Blue bin 4 (BIN-0004) × 2",
          },
          wearConfirmation: {
            createdAt: "2026-08-03T10:30:00.000Z",
            id: "wear-1",
            itemIds: ["item-1"],
            undoneAt: null,
          },
        });
      }

      if (request.url.includes("/api/v1/inventory-clothing/wear-confirmations/wear-1/undo")) {
        return Response.json({
          items: [
            {
              acquisitionSource: null,
              aliases: [],
              archivedAt: null,
              captureText: null,
              capturedAt: "2026-08-03T09:00:00.000Z",
              category: "clothing",
              clothingProfile: {
                itemId: "item-1",
                isDirty: false,
                attributes: {
                  version: 1,
                  kind: "shirt",
                  colors: ["blue", "white"],
                },
                createdAt: "2026-08-03T09:00:00.000Z",
                updatedAt: "2026-08-03T10:35:00.000Z",
              },
              remedyProfile: null,
              containerId: null,
              containerLabel: null,
              costCents: null,
              costCurrency: "CAD",
              id: "item-1",
              importance: "MEDIUM",
              imageId: null,
              kind: "GROUP",
              note: null,
              placementSummary: "Total 2 · BIN-0004 2",
              placements: [{ label: "Blue bin 4 (BIN-0004)", quantity: 2 }],
              processing: {
                currentStep: "Wait for background processing",
                enrichment: {
                  attempts: 0,
                  failedAt: null,
                  failureMessage: null,
                  maxAttempts: 3,
                  rationale: "Inventory Enrichment has not started.",
                  retryable: false,
                  status: "NOT_STARTED",
                  summary: "Inventory Enrichment has not started.",
                  updatedAt: "2026-08-03T09:00:00.000Z",
                },
                evidence: [],
                nextAction: "Wait for background processing",
                preprocessing: {
                  attempts: 0,
                  failedAt: null,
                  failedSteps: [],
                  failureMessage: null,
                  maxAttempts: 3,
                  mediaTexts: [],
                  status: "CAPTURED",
                  summary: "Saved evidence is waiting for preprocessing pickup.",
                  textBundleAvailable: false,
                  retryable: false,
                  updatedAt: "2026-08-03T09:00:00.000Z",
                },
                proposal: {
                  status: "NONE",
                  summary: "No pending Inventory Proposal.",
                  updatedAt: "2026-08-03T09:00:00.000Z",
                },
                sourceLabel: "Inventory capture",
              },
              status: "UNSURE",
              tags: [],
              title: "Travel pouch",
              totalQuantity: 2,
              where: "Blue bin 4 (BIN-0004) × 2",
            },
          ],
          wearConfirmation: {
            createdAt: "2026-08-03T10:30:00.000Z",
            id: "wear-1",
            itemIds: ["item-1"],
            undoneAt: "2026-08-03T10:35:00.000Z",
          },
        });
      }

      if (request.url.includes("/api/v1/inventory-clothing/laundry-completed")) {
        return Response.json({
          cleanedCount: 1,
          items: [
            {
              acquisitionSource: null,
              aliases: [],
              archivedAt: null,
              captureText: null,
              capturedAt: "2026-08-03T09:00:00.000Z",
              category: "clothing",
              clothingProfile: {
                itemId: "item-1",
                isDirty: false,
                attributes: {
                  version: 1,
                  kind: "shirt",
                  colors: ["blue", "white"],
                },
                createdAt: "2026-08-03T09:00:00.000Z",
                updatedAt: "2026-08-03T10:45:00.000Z",
              },
              remedyProfile: null,
              containerId: null,
              containerLabel: null,
              costCents: null,
              costCurrency: "CAD",
              id: "item-1",
              importance: "MEDIUM",
              imageId: null,
              kind: "GROUP",
              note: null,
              placementSummary: "Total 2 · BIN-0004 2",
              placements: [{ label: "Blue bin 4 (BIN-0004)", quantity: 2 }],
              processing: {
                currentStep: "Wait for background processing",
                enrichment: {
                  attempts: 0,
                  failedAt: null,
                  failureMessage: null,
                  maxAttempts: 3,
                  rationale: "Inventory Enrichment has not started.",
                  retryable: false,
                  status: "NOT_STARTED",
                  summary: "Inventory Enrichment has not started.",
                  updatedAt: "2026-08-03T09:00:00.000Z",
                },
                evidence: [],
                nextAction: "Wait for background processing",
                preprocessing: {
                  attempts: 0,
                  failedAt: null,
                  failedSteps: [],
                  failureMessage: null,
                  maxAttempts: 3,
                  mediaTexts: [],
                  status: "CAPTURED",
                  summary: "Saved evidence is waiting for preprocessing pickup.",
                  textBundleAvailable: false,
                  retryable: false,
                  updatedAt: "2026-08-03T09:00:00.000Z",
                },
                proposal: {
                  status: "NONE",
                  summary: "No pending Inventory Proposal.",
                  updatedAt: "2026-08-03T09:00:00.000Z",
                },
                sourceLabel: "Inventory capture",
              },
              status: "UNSURE",
              tags: [],
              title: "Travel pouch",
              totalQuantity: 2,
              where: "Blue bin 4 (BIN-0004) × 2",
            },
          ],
        });
      }

      if (request.url.includes("/api/v1/inventory-items/item-remedy/remedy-profile")) {
        return Response.json(
          request.method === "GET"
            ? {
                remedyProfile: {
                  createdAt: "2026-08-03T09:00:00.000Z",
                  externalReferences: [
                    {
                      referenceId: "arn",
                      source: "oorep",
                      url: "https://www.oorep.com/remedy/arn",
                    },
                  ],
                  potencies: ["30C", "200C"],
                  itemId: "item-remedy",
                  registeredByClientId: "research-client",
                  selectionSummary: "Bruising after overexertion.",
                  substanceId: "substance-remedy",
                  updatedAt: "2026-08-03T09:00:00.000Z",
                },
              }
            : {
                item: {
                  acquisitionSource: null,
                  aliases: [],
                  archivedAt: null,
                  captureText: null,
                  capturedAt: "2026-08-03T09:00:00.000Z",
                  category: "homeopathy",
                  clothingProfile: null,
                  remedyProfile: {
                    createdAt: "2026-08-03T09:00:00.000Z",
                    externalReferences: [
                      {
                        referenceId: "arn",
                        source: "oorep",
                        url: "https://www.oorep.com/remedy/arn",
                      },
                    ],
                    potencies: ["30C", "1M"],
                    itemId: "item-remedy",
                    registeredByClientId: "research-client",
                    selectionSummary: "Bruising after overexertion.",
                    substanceId: "substance-remedy",
                    updatedAt: "2026-08-03T10:00:00.000Z",
                  },
                  containerId: null,
                  containerLabel: null,
                  costCents: null,
                  costCurrency: "CAD",
                  id: "item-remedy",
                  importance: "MEDIUM",
                  imageId: null,
                  kind: "GROUP",
                  note: null,
                  placementSummary: "Total 2 · Pantry 2",
                  placements: [{ label: "Pantry", quantity: 2 }],
                  processing: {
                    currentStep: "Wait for background processing",
                    enrichment: {
                      attempts: 0,
                      failedAt: null,
                      failureMessage: null,
                      maxAttempts: 3,
                      rationale: "Inventory Enrichment has not started.",
                      retryable: false,
                      status: "NOT_STARTED",
                      summary: "Inventory Enrichment has not started.",
                      updatedAt: "2026-08-03T09:00:00.000Z",
                    },
                    evidence: [],
                    nextAction: "Wait for background processing",
                    preprocessing: {
                      attempts: 0,
                      failedAt: null,
                      failedSteps: [],
                      failureMessage: null,
                      maxAttempts: 3,
                      mediaTexts: [],
                      status: "CAPTURED",
                      summary: "Saved evidence is waiting for preprocessing pickup.",
                      textBundleAvailable: false,
                      retryable: false,
                      updatedAt: "2026-08-03T09:00:00.000Z",
                    },
                    proposal: {
                      status: "NONE",
                      summary: "No pending Inventory Proposal.",
                      updatedAt: "2026-08-03T09:00:00.000Z",
                    },
                    sourceLabel: "Inventory capture",
                  },
                  status: "UNSURE",
                  tags: [],
                  title: "Arnica montana",
                  totalQuantity: 2,
                  where: "Pantry × 2",
                },
                remedyProfile: {
                  createdAt: "2026-08-03T09:00:00.000Z",
                  externalReferences: [
                    {
                      referenceId: "arn",
                      source: "oorep",
                      url: "https://www.oorep.com/remedy/arn",
                    },
                  ],
                  potencies: ["30C", "1M"],
                  itemId: "item-remedy",
                  registeredByClientId: "research-client",
                  selectionSummary: "Bruising after overexertion.",
                  substanceId: "substance-remedy",
                  updatedAt: "2026-08-03T10:00:00.000Z",
                },
              },
        );
      }

      if (request.url.includes("/api/v1/inventory-remedies")) {
        return Response.json(
          {
            item: {
              acquisitionSource: null,
              aliases: ["arnica"],
              archivedAt: null,
              captureText: null,
              capturedAt: "2026-08-03T09:00:00.000Z",
              category: "homeopathy",
              clothingProfile: null,
              remedyProfile: {
                createdAt: "2026-08-03T09:00:00.000Z",
                externalReferences: [
                  {
                    referenceId: "arn",
                    source: "oorep",
                    url: "https://www.oorep.com/remedy/arn",
                  },
                ],
                potencies: ["30C", "200C"],
                itemId: "item-remedy",
                registeredByClientId: "research-client",
                selectionSummary: "Bruising after overexertion.",
                substanceId: "substance-remedy",
                updatedAt: "2026-08-03T09:00:00.000Z",
              },
              containerId: null,
              containerLabel: null,
              costCents: null,
              costCurrency: "CAD",
              id: "item-remedy",
              importance: "MEDIUM",
              imageId: null,
              kind: "ITEM",
              note: null,
              placementSummary: "Total 1 · Pantry 1",
              placements: [{ label: "Pantry", quantity: 1 }],
              processing: {
                currentStep: "Wait for background processing",
                enrichment: {
                  attempts: 0,
                  failedAt: null,
                  failureMessage: null,
                  maxAttempts: 3,
                  rationale: "Inventory Enrichment has not started.",
                  retryable: false,
                  status: "NOT_STARTED",
                  summary: "Inventory Enrichment has not started.",
                  updatedAt: "2026-08-03T09:00:00.000Z",
                },
                evidence: [],
                nextAction: "Wait for background processing",
                preprocessing: {
                  attempts: 0,
                  failedAt: null,
                  failedSteps: [],
                  failureMessage: null,
                  maxAttempts: 3,
                  mediaTexts: [],
                  status: "CAPTURED",
                  summary: "Saved evidence is waiting for preprocessing pickup.",
                  textBundleAvailable: false,
                  retryable: false,
                  updatedAt: "2026-08-03T09:00:00.000Z",
                },
                proposal: {
                  status: "NONE",
                  summary: "No pending Inventory Proposal.",
                  updatedAt: "2026-08-03T09:00:00.000Z",
                },
                sourceLabel: "Inventory capture",
              },
              status: "KEEP",
              tags: [],
              title: "Arnica montana",
              totalQuantity: 1,
              where: "Pantry × 1",
            },
            remedyProfile: {
              createdAt: "2026-08-03T09:00:00.000Z",
              externalReferences: [
                {
                  referenceId: "arn",
                  source: "oorep",
                  url: "https://www.oorep.com/remedy/arn",
                },
              ],
              potencies: ["30C", "200C"],
              itemId: "item-remedy",
              registeredByClientId: "research-client",
              selectionSummary: "Bruising after overexertion.",
              substanceId: "substance-remedy",
              updatedAt: "2026-08-03T09:00:00.000Z",
            },
          },
          { status: 201 },
        );
      }

      if (request.url.includes("/api/v1/remedy-intakes/intake-1")) {
        return Response.json({
          deletedIntakeId: "intake-1",
        });
      }

      if (request.url.includes("/api/v1/remedy-intakes/summary")) {
        return Response.json({
          range: "30d",
          remedies: [
            {
              archivedAt: null,
              colorKey: "remedy-3",
              firstIntakeAt: "2026-08-03T22:15:00.000Z",
              lastIntakeAt: "2026-08-03T22:15:00.000Z",
              potencyTotals: [{ potency: "200C", total: 1 }],
              itemId: "item-remedy",
              itemTitle: "Arnica montana",
              total: 1,
            },
          ],
          totalIntakes: 1,
        });
      }

      if (request.url.includes("/api/v1/remedy-intakes")) {
        return Response.json(
          request.method === "POST"
            ? {
                intake: {
                  id: "intake-1",
                  note: "Before bed.",
                  occurredAt: "2026-08-03T22:15:00.000Z",
                  potency: "200C",
                  itemArchivedAt: null,
                  itemId: "item-remedy",
                  itemTitle: "Arnica montana",
                },
              }
            : {
                intakes: [
                  {
                    bucketDate: "2026-08-03",
                    colorKey: "remedy-3",
                    id: "intake-1",
                    note: "Before bed.",
                    occurredAt: "2026-08-03T22:15:00.000Z",
                    potency: "200C",
                    itemArchivedAt: null,
                    itemId: "item-remedy",
                    itemTitle: "Arnica montana",
                  },
                ],
                pageInfo: { nextCursor: null },
                range: "30d",
              },
          { status: request.method === "POST" ? 201 : 200 },
        );
      }

      if (request.url.includes("/api/v1/inventory-items/")) {
        return Response.json({
          item: {
            acquisitionSource: null,
            aliases: [],
            archivedAt: null,
            captureText: null,
            capturedAt: "2026-07-28T09:00:00.000Z",
            category: null,
            clothingProfile: null,
            remedyProfile: null,
            containerId: null,
            containerLabel: null,
            costCents: null,
            costCurrency: "CAD",
            id: "item-1",
            importance: "MEDIUM",
            imageId: null,
            kind: "GROUP",
            note: null,
            placementSummary: "Total 2 · BIN-0004 2",
            placements: [{ label: "Blue bin 4 (BIN-0004)", quantity: 2 }],
            processing: {
              currentStep: "Wait for background processing",
              enrichment: {
                attempts: 0,
                failedAt: null,
                failureMessage: null,
                maxAttempts: 3,
                rationale: "Inventory Enrichment has not started.",
                retryable: false,
                status: "NOT_STARTED",
                summary: "Inventory Enrichment has not started.",
                updatedAt: "2026-07-28T09:00:00.000Z",
              },
              evidence: [],
              nextAction: "Wait for background processing",
              preprocessing: {
                attempts: 0,
                failedAt: null,
                failedSteps: [],
                failureMessage: null,
                maxAttempts: 3,
                mediaTexts: [],
                status: "CAPTURED",
                summary: "Saved evidence is waiting for preprocessing pickup.",
                textBundleAvailable: false,
                retryable: false,
                updatedAt: "2026-07-28T09:00:00.000Z",
              },
              proposal: {
                status: "NONE",
                summary: "No pending Inventory Proposal.",
                updatedAt: "2026-07-28T09:00:00.000Z",
              },
              sourceLabel: "Inventory capture",
            },
            status: "UNSURE",
            tags: [],
            title: "Travel pouch",
            totalQuantity: 2,
            where: "Blue bin 4 (BIN-0004) × 2",
          },
        });
      }

      if (request.url.includes("/api/v1/inventory-enrichment-settings")) {
        return Response.json({
          settings: {
            approvalsRequired: true,
            updatedAt: "2026-07-28T09:00:00.000Z",
          },
        });
      }

      if (request.url.includes("/api/v1/inventory-proposals/")) {
        return Response.json({
          proposal: {
            decidedAt: "2026-07-28T09:05:00.000Z",
            id: "job-1",
            itemId: "item-1",
            status: request.url.endsWith("/approve") ? "APPLIED" : "REJECTED",
          },
        });
      }

      if (request.url.includes("/api/v1/inventory-proposals")) {
        return Response.json({
          proposals: [
            {
              captureText: "Passport and charger.",
              capturedAt: "2026-07-28T08:50:00.000Z",
              confidence: 0.94,
              diff: [
                {
                  current: "Black pouch",
                  field: "title",
                  label: "Title",
                  proposed: "Passport pouch",
                },
              ],
              failedSteps: [],
              id: "job-1",
              ocrEvidence: [],
              itemId: "item-1",
              itemTitle: "Black pouch",
              rationale: "OCR mentions passport.",
              sourceRefsSummary: "1 item, 1 image, 0 audio, 0 file",
              transcriptEvidence: [],
              updatedAt: "2026-07-28T09:00:00.000Z",
            },
          ],
        });
      }

      if (
        request.url.includes(
          "/api/v1/inventory-clothing/outfit-recommendations/recommendation-1/worn",
        )
      ) {
        return Response.json({
          recommendation: {
            createdAt: "2026-08-03T09:00:00.000Z",
            event: null,
            id: "recommendation-1",
            kind: "DAILY",
            options: [
              {
                id: "option-primary",
                items: [
                  {
                    archiveState: "ACTIVE",
                    availability: "UNAVAILABLE",
                    clothingState: "dirty",
                    id: "item-shirt",
                    imageId: null,
                    title: "Blue oxford shirt",
                    where: "Hall closet / Rail A × 1",
                  },
                ],
                reason: "Breathable layers for a warm meeting day.",
                slot: "PRIMARY",
              },
            ],
            publishedAt: "2026-08-03T09:00:00.000Z",
            publishedBy: {
              clientId: "client-writer-1",
              clientKind: "api-key",
              clientName: "Outfit Writer",
            },
            reason: "Client picked a concise outfit for Monday, August 3, 2026.",
            status: "WORN",
            supersededByRecommendationId: null,
            targetDate: "2026-08-03",
          },
          wearConfirmation: {
            createdAt: "2026-08-03T10:30:00.000Z",
            id: "wear-1",
            itemIds: ["item-shirt"],
            undoneAt: null,
          },
        });
      }

      if (
        request.url.includes(
          "/api/v1/inventory-clothing/outfit-recommendations/recommendation-1/decline",
        )
      ) {
        return Response.json({
          recommendation: {
            createdAt: "2026-08-03T09:00:00.000Z",
            event: null,
            id: "recommendation-1",
            kind: "DAILY",
            options: [
              {
                id: "option-primary",
                items: [
                  {
                    archiveState: "ACTIVE",
                    availability: "AVAILABLE",
                    clothingState: "clean",
                    id: "item-shirt",
                    imageId: null,
                    title: "Blue oxford shirt",
                    where: "Hall closet / Rail A × 1",
                  },
                ],
                reason: "Breathable layers for a warm meeting day.",
                slot: "PRIMARY",
              },
            ],
            publishedAt: "2026-08-03T09:00:00.000Z",
            publishedBy: {
              clientId: "client-writer-1",
              clientKind: "api-key",
              clientName: "Outfit Writer",
            },
            reason: "Client picked a concise outfit for Monday, August 3, 2026.",
            status: "DECLINED",
            supersededByRecommendationId: null,
            targetDate: "2026-08-03",
          },
        });
      }

      if (
        request.url.includes("/api/v1/inventory-clothing/outfit-recommendations/")
      ) {
        return Response.json({
          recommendation: {
            createdAt: "2026-08-03T09:00:00.000Z",
            event: null,
            id: "recommendation-1",
            kind: "DAILY",
            options: [
              {
                id: "option-primary",
                items: [
                  {
                    archiveState: "ACTIVE",
                    availability: "AVAILABLE",
                    clothingState: "clean",
                    id: "item-shirt",
                    imageId: null,
                    title: "Blue oxford shirt",
                    where: "Hall closet / Rail A × 1",
                  },
                ],
                reason: "Breathable layers for a warm meeting day.",
                slot: "PRIMARY",
              },
            ],
            publishedAt: "2026-08-03T09:00:00.000Z",
            publishedBy: {
              clientId: "client-writer-1",
              clientKind: "api-key",
              clientName: "Outfit Writer",
            },
            reason: "Client picked a concise outfit for Monday, August 3, 2026.",
            status: "PUBLISHED",
            supersededByRecommendationId: null,
            targetDate: "2026-08-03",
          },
        });
      }

      if (
        request.url.includes("/api/v1/inventory-clothing/outfit-recommendations")
      ) {
        return Response.json(
          request.method === "POST"
            ? {
                recommendation: {
                  createdAt: "2026-08-03T09:00:00.000Z",
                  event: {
                    label: "Board dinner",
                    startsAt: "2026-08-04T19:00:00.000Z",
                  },
                  id: "recommendation-event-1",
                  kind: "EVENT",
                  options: [
                    {
                      id: "option-primary",
                      items: [
                        {
                          archiveState: "ACTIVE",
                          availability: "AVAILABLE",
                          clothingState: "clean",
                          id: "item-shirt",
                          imageId: null,
                          title: "Blue oxford shirt",
                          where: "Hall closet / Rail A × 1",
                        },
                      ],
                      reason: "Breathable layers for a warm meeting day.",
                      slot: "PRIMARY",
                    },
                  ],
                  publishedAt: "2026-08-03T09:00:00.000Z",
                  publishedBy: {
                    clientId: "client-writer-1",
                    clientKind: "api-key",
                    clientName: "Outfit Writer",
                  },
                  reason: "Client picked a concise outfit for the board dinner.",
                  status: "PUBLISHED",
                  supersededByRecommendationId: null,
                  targetDate: "2026-08-04",
                },
              }
            : {
                recommendations: [
                  {
                    createdAt: "2026-08-03T09:00:00.000Z",
                    event: {
                      label: "Board dinner",
                      startsAt: "2026-08-04T19:00:00.000Z",
                    },
                    id: "recommendation-event-1",
                    kind: "EVENT",
                    options: [
                      {
                        id: "option-primary",
                        items: [
                          {
                            archiveState: "ACTIVE",
                            availability: "AVAILABLE",
                            clothingState: "clean",
                            id: "item-shirt",
                            imageId: null,
                            title: "Blue oxford shirt",
                            where: "Hall closet / Rail A × 1",
                          },
                        ],
                        reason: "Breathable layers for a warm meeting day.",
                        slot: "PRIMARY",
                      },
                    ],
                    publishedAt: "2026-08-03T09:00:00.000Z",
                    publishedBy: {
                      clientId: "client-writer-1",
                      clientKind: "api-key",
                      clientName: "Outfit Writer",
                    },
                    reason: "Client picked a concise outfit for the board dinner.",
                    status: "WORN",
                    supersededByRecommendationId: null,
                    targetDate: "2026-08-04",
                  },
                ],
              },
          { status: request.method === "POST" ? 201 : 200 },
        );
      }

      return Response.json({
        container: {
          createdAt: "2026-07-28T09:00:00.000Z",
          id: "container-1",
          location: null,
          locationId: null,
          metadata: {},
          name: "Blue bin",
          normalizedName: "blue bin",
          referenceId: "BIN-0001",
          sizeLiters: 39,
          updatedAt: "2026-07-28T09:00:00.000Z",
          visualPreset: {
            backImageUrl: "/inventory/container-visual-catalog/39l/back.webp",
            bounds: [
              { x: 0.1, y: 0.1 },
              { x: 0.9, y: 0.1 },
              { x: 0.9, y: 0.8 },
              { x: 0.1, y: 0.8 },
            ],
            emptyImageUrl:
              "/inventory/container-visual-catalog/39l/empty.webp",
            frontImageUrl:
              "/inventory/container-visual-catalog/39l/front.webp",
            height: 857,
            hoverBounds: [
              { x: 0.1, y: 0.1 },
              { x: 0.9, y: 0.1 },
              { x: 0.9, y: 0.8 },
              { x: 0.1, y: 0.8 },
            ],
            id: "39L",
            isDefault: false,
            name: "39L",
            shadowImageUrl:
              "/inventory/container-visual-catalog/39l/shadow.webp",
            width: 1456,
          },
          visualPresetKey: "39L",
        },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("Quantself generated API Client adapter", () => {
  test("uses generated Inventory Location list and mutation contracts", async () => {
    const {
      createInventoryLocation,
      listInventoryLocations,
      updateInventoryLocation,
    } = await import("./quantself-api-client");

    const locations = await listInventoryLocations({
      kind: "STORAGE",
      query: " pantry ",
    });
    await createInventoryLocation(
      { name: "Pantry", note: null },
      { idempotencyKey: "create-location-1" },
    );
    await updateInventoryLocation(
      "location-pantry",
      { note: "Dry goods" },
      { idempotencyKey: "update-location-1" },
    );

    expect(locations[0]).toEqual(
      expect.objectContaining({
        containerCount: 1,
        id: "location-pantry",
        placementCount: 4,
      }),
    );
    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "POST",
      "PUT",
    ]);
    expect(requests[0]?.url).toContain("kind=STORAGE");
    expect(requests[0]?.url).toContain("q=pantry");
    expect(requests[1]?.headers.get("idempotency-key")).toBe(
      "create-location-1",
    );
    expect(requests[2]?.headers.get("idempotency-key")).toBe(
      "update-location-1",
    );
  });

  test("accepts a stable Idempotency-Key for safe command retries", async () => {
    const { createInventoryContainer } = await import("./quantself-api-client");

    await createInventoryContainer(
      {
        locationName: null,
        name: "Blue bin",
        sizeLiters: 39,
        visualPresetKey: "39L",
      },
      { idempotencyKey: " retry-key " },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("idempotency-key")).toBe("retry-key");
    expect(requests[0]?.headers.get("x-quantself-owner-proof")).toBe("a".repeat(64));
    expect(requests[0]?.headers.get("origin")).toBe("https://qs.girke.dev");
    expect(requests[0]?.headers.get("cookie")).toBeNull();
  });

  test("passes stable idempotency keys to item fact and placement commands", async () => {
    const {
      addInventoryItemUnits,
      moveInventoryItemUnits,
      removeInventoryItemUnits,
      retryInventoryEnrichment,
      retryInventoryPreprocessing,
      updateInventoryItem,
    } = await import("./quantself-api-client");

    await updateInventoryItem(
      "item-1",
      {
        title: "Travel pouch",
      },
      { idempotencyKey: " update-item-1 " },
    );
    await addInventoryItemUnits(
      "item-1",
      {
        quantity: 2,
      },
      { idempotencyKey: " add-units-1 " },
    );
    await moveInventoryItemUnits(
      "item-1",
      {
        destinationContainerId: "container-b",
        quantity: 1,
        sourceContainerId: "container-a",
      },
      { idempotencyKey: " move-units-1 " },
    );
    await removeInventoryItemUnits(
      "item-1",
      {
        containerId: "container-b",
        quantity: 1,
      },
      { idempotencyKey: " remove-units-1 " },
    );
    await retryInventoryPreprocessing("item-1", {
      idempotencyKey: " retry-preprocessing-1 ",
    });
    await retryInventoryEnrichment("item-1", {
      idempotencyKey: " retry-enrichment-1 ",
    });

    expect(requests).toHaveLength(6);
    expect(requests[0]?.headers.get("idempotency-key")).toBe("update-item-1");
    expect(requests[1]?.headers.get("idempotency-key")).toBe("add-units-1");
    expect(requests[2]?.headers.get("idempotency-key")).toBe("move-units-1");
    expect(requests[3]?.headers.get("idempotency-key")).toBe("remove-units-1");
    expect(requests[4]?.headers.get("idempotency-key")).toBe(
      "retry-preprocessing-1",
    );
    expect(requests[4]?.url).toContain("/retry-preprocessing");
    expect(requests[5]?.headers.get("idempotency-key")).toBe(
      "retry-enrichment-1",
    );
    expect(requests[5]?.url).toContain("/retry-enrichment");
  });

  test("passes category and query filters to inventory item listing", async () => {
    const { listInventoryItems } = await import("./quantself-api-client");

    const items = await listInventoryItems({
      category: "food",
      query: "kale chips",
    });

    expect(items).toEqual([
      expect.objectContaining({
        category: "food",
        id: "item-food-1",
        where: "Pantry × 2",
      }),
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("category=food");
    expect(requests[0]?.url).toContain("limit=all");
    expect(requests[0]?.url).toContain("q=kale%20chips");
  });

  test("passes Clothing state filters and profile mutations through generated contracts", async () => {
    const {
      completeInventoryClothingLaundry,
      getInventoryClothingProfile,
      listInventoryItems,
      markInventoryClothingItemWorn,
      undoInventoryClothingWearConfirmation,
      updateInventoryClothingProfile,
    } = await import("./quantself-api-client");

    const items = await listInventoryItems({
      category: "clothing",
      clothingState: "dirty",
      query: "oxford",
    });
    const clothingProfile = await getInventoryClothingProfile("item-1");
    const updated = await updateInventoryClothingProfile(
      "item-1",
      {
        attributes: {
          version: 1,
          colors: ["blue", "white"],
          kind: "shirt",
        },
        isDirty: true,
      },
      { idempotencyKey: " clothing-profile-1 " },
    );
    const worn = await markInventoryClothingItemWorn(
      "item-1",
      { idempotencyKey: " wear-item-1 " },
    );
    const undone = await undoInventoryClothingWearConfirmation(
      "wear-1",
      { idempotencyKey: " undo-wear-1 " },
    );
    const laundry = await completeInventoryClothingLaundry(
      {
        mode: "selected",
        itemIds: ["item-1"],
      },
      { idempotencyKey: " laundry-1 " },
    );

    expect(items[0]).toEqual(
      expect.objectContaining({
        category: "food",
      }),
    );
    expect(clothingProfile).toEqual(
      expect.objectContaining({
        attributes: expect.objectContaining({ kind: "shirt", version: 1 }),
        isDirty: false,
        itemId: "item-1",
      }),
    );
    expect(updated).toEqual(
      expect.objectContaining({
        clothingProfile: expect.objectContaining({ isDirty: true }),
        item: expect.objectContaining({ category: "clothing", id: "item-1" }),
      }),
    );
    expect(worn).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({
          clothingProfile: expect.objectContaining({ isDirty: true }),
          id: "item-1",
        }),
        wearConfirmation: expect.objectContaining({
          id: "wear-1",
          itemIds: ["item-1"],
        }),
      }),
    );
    expect(undone).toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            clothingProfile: expect.objectContaining({ isDirty: false }),
            id: "item-1",
          }),
        ],
        wearConfirmation: expect.objectContaining({
          id: "wear-1",
          undoneAt: "2026-08-03T10:35:00.000Z",
        }),
      }),
    );
    expect(laundry).toEqual(
      expect.objectContaining({
        cleanedCount: 1,
        items: [
          expect.objectContaining({
            clothingProfile: expect.objectContaining({ isDirty: false }),
            id: "item-1",
          }),
        ],
      }),
    );
    expect(requests[0]?.url).toContain("category=clothing");
    expect(requests[0]?.url).toContain("clothingState=dirty");
    expect(requests[0]?.url).toContain("q=oxford");
    expect(requests[2]?.headers.get("idempotency-key")).toBe(
      "clothing-profile-1",
    );
    expect(requests[3]?.url).toContain("/api/v1/inventory-items/item-1/worn");
    expect(requests[3]?.headers.get("idempotency-key")).toBe("wear-item-1");
    expect(requests[4]?.url).toContain(
      "/api/v1/inventory-clothing/wear-confirmations/wear-1/undo",
    );
    expect(requests[4]?.headers.get("idempotency-key")).toBe("undo-wear-1");
    expect(requests[5]?.url).toContain(
      "/api/v1/inventory-clothing/laundry-completed",
    );
    expect(requests[5]?.headers.get("idempotency-key")).toBe("laundry-1");
  });

  test("publishes and reads event Clothing recommendations through generated contracts", async () => {
    const {
      declineInventoryClothingRecommendation,
      getInventoryClothingRecommendation,
      listInventoryClothingRecommendations,
      markInventoryClothingRecommendationWorn,
      publishInventoryClothingRecommendation,
    } = await import("./quantself-api-client");

    const recommendations = await listInventoryClothingRecommendations({
      from: "2026-08-03",
      kind: "EVENT",
      limit: 5,
      status: "WORN",
      timeZone: "America/Halifax",
      to: "2026-08-10",
    });
    const published = await publishInventoryClothingRecommendation(
      {
        event: {
          label: "Board dinner",
          startsAt: "2026-08-04T19:00:00.000Z",
        },
        kind: "EVENT",
        primary: {
          itemIds: ["item-shirt"],
          reason: "Breathable layers for a warm meeting day.",
        },
        reason: "Client picked a concise outfit for the board dinner.",
        targetDate: "2026-08-04",
      },
      { idempotencyKey: " publish-recommendation-1 " },
    );
    const recommendation = await getInventoryClothingRecommendation(
      "recommendation-1",
    );
    const worn = await markInventoryClothingRecommendationWorn(
      "recommendation-1",
      { optionId: "option-primary" },
      { idempotencyKey: " wear-recommendation-1 " },
    );
    const declined = await declineInventoryClothingRecommendation(
      "recommendation-1",
      { idempotencyKey: " decline-recommendation-1 " },
    );

    expect(recommendations).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          label: "Board dinner",
        }),
        id: "recommendation-event-1",
        kind: "EVENT",
      }),
    ]);
    expect(published).toEqual(
      expect.objectContaining({
        recommendation: expect.objectContaining({
          event: expect.objectContaining({
            label: "Board dinner",
          }),
          id: "recommendation-event-1",
          targetDate: "2026-08-04",
        }),
      }),
    );
    expect(recommendation).toEqual(
      expect.objectContaining({
        id: "recommendation-1",
        publishedBy: expect.objectContaining({
          clientId: "client-writer-1",
        }),
      }),
    );
    expect(worn).toEqual(
      expect.objectContaining({
        recommendation: expect.objectContaining({
          id: "recommendation-1",
          status: "WORN",
        }),
        wearConfirmation: expect.objectContaining({
          id: "wear-1",
          itemIds: ["item-shirt"],
        }),
      }),
    );
    expect(declined).toEqual(
      expect.objectContaining({
        recommendation: expect.objectContaining({
          id: "recommendation-1",
          status: "DECLINED",
        }),
      }),
    );
    expect(requests[0]?.url).toContain("from=2026-08-03");
    expect(requests[0]?.url).toContain("kind=event");
    expect(requests[0]?.url).toContain("limit=5");
    expect(requests[0]?.url).toContain("status=worn");
    expect(requests[0]?.url).toContain("timeZone=America%2FHalifax");
    expect(requests[0]?.url).toContain("to=2026-08-10");
    expect(requests[1]?.headers.get("idempotency-key")).toBe(
      "publish-recommendation-1",
    );
    expect(requests[2]?.url).toContain(
      "/api/v1/inventory-clothing/outfit-recommendations/recommendation-1",
    );
    expect(requests[3]?.url).toContain(
      "/api/v1/inventory-clothing/outfit-recommendations/recommendation-1/worn",
    );
    expect(requests[3]?.headers.get("idempotency-key")).toBe(
      "wear-recommendation-1",
    );
    expect(requests[4]?.url).toContain(
      "/api/v1/inventory-clothing/outfit-recommendations/recommendation-1/decline",
    );
    expect(requests[4]?.headers.get("idempotency-key")).toBe(
      "decline-recommendation-1",
    );
  });

  test("passes owned remedy registration and profile mutations through generated contracts", async () => {
    const {
      getInventoryRemedyProfile,
      registerInventoryRemedy,
      updateInventoryRemedyProfile,
    } = await import("./quantself-api-client");

    const registered = await registerInventoryRemedy(
      {
        externalReferences: [
          {
            referenceId: "arn",
            source: "oorep",
            url: "https://www.oorep.com/remedy/arn",
          },
        ],
        potencies: ["30C", "200C"],
        quantity: 1,
        selectionSummary: "Bruising after overexertion.",
        title: "Arnica montana",
      },
      { idempotencyKey: " register-remedy-1 " },
    );
    const remedyProfile = await getInventoryRemedyProfile("item-remedy");
    const updated = await updateInventoryRemedyProfile(
      "item-remedy",
      {
        potencies: ["30C", "1M"],
      },
      { idempotencyKey: " update-remedy-1 " },
    );

    expect(registered).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({
          category: "homeopathy",
          id: "item-remedy",
        }),
        remedyProfile: expect.objectContaining({
          potencies: ["30C", "200C"],
        }),
      }),
    );
    expect(remedyProfile).toEqual(
      expect.objectContaining({
        itemId: "item-remedy",
        selectionSummary: "Bruising after overexertion.",
      }),
    );
    expect(updated).toEqual(
      expect.objectContaining({
        remedyProfile: expect.objectContaining({
          potencies: ["30C", "1M"],
        }),
      }),
    );
    expect(requests[0]?.url).toContain("/api/v1/inventory-remedies");
    expect(requests[0]?.headers.get("idempotency-key")).toBe(
      "register-remedy-1",
    );
    expect(requests[1]?.url).toContain(
      "/api/v1/inventory-items/item-remedy/remedy-profile",
    );
    expect(requests[2]?.headers.get("idempotency-key")).toBe(
      "update-remedy-1",
    );
  });

  test("passes remedy intake queries and mutations through generated contracts", async () => {
    const {
      createRemedyIntake,
      deleteRemedyIntake,
      listRemedyIntakes,
      summarizeRemedyIntakes,
    } = await import("./quantself-api-client");

    const listed = await listRemedyIntakes({
      itemId: "item-remedy",
      range: "30d",
      timeZone: "America/Toronto",
    });
    const summary = await summarizeRemedyIntakes({
      itemId: "item-remedy",
      range: "30d",
      timeZone: "America/Toronto",
    });
    const created = await createRemedyIntake(
      {
        note: "Before bed.",
        occurredAt: "2026-08-03T22:15:00.000Z",
        potency: "200C",
        itemId: "item-remedy",
      },
      { idempotencyKey: " create-remedy-intake-1 " },
    );
    const deleted = await deleteRemedyIntake("intake-1", {
      idempotencyKey: " delete-remedy-intake-1 ",
    });

    expect(listed).toEqual(
      expect.objectContaining({
        intakes: [
          expect.objectContaining({
            bucketDate: "2026-08-03",
            id: "intake-1",
            potency: "200C",
            itemId: "item-remedy",
          }),
        ],
        pageInfo: { nextCursor: null },
        range: "30d",
      }),
    );
    expect(summary.totalIntakes).toBe(1);
    expect(created).toEqual(
      expect.objectContaining({
        id: "intake-1",
        note: "Before bed.",
      }),
    );
    expect(deleted).toEqual({
      deletedIntakeId: "intake-1",
    });
    expect(requests[0]?.url).toContain("itemId=item-remedy");
    expect(requests[0]?.url).toContain("range=30d");
    expect(requests[0]?.url).toContain("timeZone=America%2FToronto");
    expect(requests[1]?.url).toContain("/api/v1/remedy-intakes/summary");
    expect(requests[2]?.headers.get("idempotency-key")).toBe(
      "create-remedy-intake-1",
    );
    expect(requests[3]?.url).toContain("/api/v1/remedy-intakes/intake-1");
    expect(requests[3]?.headers.get("idempotency-key")).toBe(
      "delete-remedy-intake-1",
    );
  });

  test("passes stable idempotency keys to inventory proposal and settings commands", async () => {
    const {
      approveInventoryProposal,
      rejectInventoryProposal,
      updateInventoryEnrichmentSettings,
    } = await import("./quantself-api-client");

    await updateInventoryEnrichmentSettings(
      { approvalsRequired: true },
      { idempotencyKey: " enrich-settings-1 " },
    );
    await approveInventoryProposal("job-1", {
      idempotencyKey: " approve-proposal-1 ",
    });
    await rejectInventoryProposal("job-1", {
      idempotencyKey: " reject-proposal-1 ",
    });

    expect(requests).toHaveLength(3);
    expect(requests[0]?.headers.get("idempotency-key")).toBe(
      "enrich-settings-1",
    );
    expect(requests[1]?.headers.get("idempotency-key")).toBe(
      "approve-proposal-1",
    );
    expect(requests[2]?.headers.get("idempotency-key")).toBe(
      "reject-proposal-1",
    );
  });

  test("lists inventory proposals and reads inventory enrichment settings", async () => {
    const {
      getInventoryEnrichmentSettings,
      listInventoryProposals,
    } = await import("./quantself-api-client");

    const settings = await getInventoryEnrichmentSettings();
    const proposals = await listInventoryProposals({
      limit: 20,
      itemId: "item-1",
    });

    expect(settings).toEqual({
      approvalsRequired: true,
      updatedAt: "2026-07-28T09:00:00.000Z",
    });
    expect(proposals).toEqual([
      expect.objectContaining({
        id: "job-1",
        itemId: "item-1",
        itemTitle: "Black pouch",
      }),
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toContain("itemId=item-1");
    expect(requests[1]?.url).toContain("limit=20");
  });

  test("rejects an explicitly blank retry key", async () => {
    const { createInventoryContainer } = await import("./quantself-api-client");

    await expect(
      createInventoryContainer(
        {
          locationName: null,
          name: "Blue bin",
          sizeLiters: 39,
          visualPresetKey: "39L",
        },
        { idempotencyKey: " " },
      ),
    ).rejects.toThrow("Idempotency-Key is required.");
    expect(requests).toHaveLength(0);
  });

  test("passes stable idempotency keys to batch container moves", async () => {
    const { moveInventoryItemsToContainer } = await import(
      "./quantself-api-client"
    );

    await moveInventoryItemsToContainer(
      "container-1",
      {
        itemIds: ["item-1", "item-2"],
      },
      { idempotencyKey: " move-items-1 " },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("idempotency-key")).toBe(
      "move-items-1",
    );
  });
});
