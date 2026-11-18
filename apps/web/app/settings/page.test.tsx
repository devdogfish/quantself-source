import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";

let currentSettings = {
  approvalsRequired: true,
  updatedAt: "2026-06-27T09:00:00.000Z",
};
let currentItems: Array<{
  id: string;
  processing: Record<string, unknown>;
}> = [];
let currentProposals: Array<Record<string, unknown>> = [];
let currentApiKeys = [
  {
    createdAt: new Date("2026-07-28T10:00:00.000Z"),
    expiresAt: null,
    id: "key-1",
    lastRequestAt: new Date("2026-07-28T10:05:00.000Z"),
    maskedKey: "qs_key_abcd12...",
    name: "MCP server",
    preset: "custom" as const,
    replacementCredentialId: null,
    revokedAt: null,
    rotatedFromCredentialId: null,
    rotationOverlapEndsAt: null,
    permissions: ["inventory:read", "inventory:write", "notes:delete"],
    status: "active" as const,
  },
];

async function renderServerPage(node: ReactNode): Promise<string> {
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const stream = await renderToReadableStream(
    <ChakraTestWrapper>{node}</ChakraTestWrapper>,
  );
  await stream.allReady;

  return (await new Response(stream).text()).replaceAll("<!-- -->", "");
}

mock.module("next/navigation", () => ({
  notFound: () => {
    throw new Error("Not found");
  },
  redirect: () => {},
  usePathname: () => "/settings",
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    refresh: () => {},
  }),
  useSearchParams: () => new URLSearchParams(),
}));

mock.module("@/lib/quantself-api-client", () => ({
  addInventoryItemUnits: async () => null,
  approveInventoryProposal: async () => ({
    decidedAt: "2026-06-27T12:00:30.000Z",
    id: "job-1",
    itemId: "item-1",
    status: "APPLIED",
  }),
  archiveInventoryItem: async () => null,
  captureInventoryItem: async () => null,
  createInventoryContainer: async () => null,
  deleteInventoryContainer: async () => null,
  deleteInventoryItem: async () => null,
  getActiveInventoryCaptureSession: async () => null,
  getInventoryEnrichmentSettings: async () => currentSettings,
  getInventoryItem: async () => null,
  inventoryItemMediaContentPath: (itemId: string, mediaId: string) =>
    `/api/v1/inventory-items/${itemId}/media/${mediaId}`,
  isApiAuthenticationError: () => false,
  isApiNotFoundError: () => false,
  listActiveInventoryItems: async () => currentItems,
  listInventoryContainers: async () => [],
  listInventoryContainerVisuals: async () => ({
    editableVisuals: [],
    visualPresets: [],
  }),
  listInventoryItemMedia: async () => [],
  listInventoryItems: async () => currentItems,
  listInventoryProposals: async () => currentProposals,
  moveInventoryItemsToContainer: async () => [],
  moveInventoryItemUnits: async () => null,
  rejectInventoryProposal: async () => ({
    decidedAt: "2026-06-27T12:00:30.000Z",
    id: "job-1",
    itemId: "item-1",
    status: "REJECTED",
  }),
  removeInventoryItemUnits: async () => null,
  resolveInventoryContainerByReference: async () => ({ id: "container-1" }),
  restoreInventoryItem: async () => null,
  saveInventoryCaptureSessionDefaults: async () => null,
  updateInventoryContainer: async () => null,
  updateInventoryEnrichmentSettings: async () => currentSettings,
  updateInventoryItem: async () => null,
}));

mock.module("@/lib/owner-session-server", () => ({
  assertOwnerActionSession: async () => ({
    session: {
      id: "session-1",
    },
    user: {
      email: "owner@quantself.invalid",
      id: "owner",
      name: "Owner",
    },
  }),
  getOwnerSession: async () => ({
    session: {
      id: "session-1",
    },
    user: {
      email: "owner@quantself.invalid",
      id: "owner",
      name: "Owner",
    },
  }),
  requireOwnerPageSession: async () => ({
    session: {
      id: "session-1",
    },
    user: {
      email: "owner@quantself.invalid",
      id: "owner",
      name: "Owner",
    },
  }),
}));

mock.module("@/lib/owner-api-keys-server", () => ({
  createOwnerApiKey: async () => ({
    credential: currentApiKeys[0],
    secret: "qs_key_abcd1234secret",
  }),
  loadOwnerApiKeys: async () => currentApiKeys,
  revokeOwnerApiKey: async () => currentApiKeys[0]!,
  rotateOwnerApiKey: async () => ({
    credential: currentApiKeys[0]!,
    revokedCredential: currentApiKeys[0]!,
    secret: "qs_key_abcd1234secret",
  }),
}));

mock.module("@quantself/db/generated/prisma/enums", () => ({
  InventoryAcquisitionSource: {
    bought: "bought",
    found: "found",
    gifted: "gifted",
  },
  InventoryCategory: {
    documents: "documents",
    technology: "technology",
  },
}));

afterEach(() => {
  currentSettings = {
    approvalsRequired: true,
    updatedAt: "2026-06-27T09:00:00.000Z",
  };
  currentItems = [];
  currentProposals = [];
  currentApiKeys = [
    {
      createdAt: new Date("2026-07-28T10:00:00.000Z"),
      expiresAt: null,
      id: "key-1",
      lastRequestAt: new Date("2026-07-28T10:05:00.000Z"),
      maskedKey: "qs_key_abcd12...",
      name: "MCP server",
      preset: "custom",
      replacementCredentialId: null,
      revokedAt: null,
      rotatedFromCredentialId: null,
      rotationOverlapEndsAt: null,
      permissions: ["inventory:read", "inventory:write", "notes:delete"],
      status: "active",
    },
  ];
});

afterAll(() => {
  mock.restore();
});

describe("settings page", () => {
  test("uses Settings as the page heading and exposes a labelled loading state", async () => {
    const { default: SettingsPage } = await import("./page");
    const html = await renderServerPage(SettingsPage());
    expect(html).toMatch(/<h1[^>]*>Settings<\/h1>/);
    const { default: SettingsLoading } = await import("./loading");
    const loading = await renderServerPage(<SettingsLoading />);
    expect(loading).toContain('aria-label="Loading settings data"');
    expect(loading).toMatch(/<h1[^>]*>Settings<\/h1>/);
  });

  test("puts the Appearance group above the existing settings", async () => {
    const { default: SettingsPage } = await import("./page");
    const html = await renderServerPage(SettingsPage());
    const appearance = html.indexOf("Appearance");
    expect(appearance).toBeGreaterThan(-1);
    for (const heading of ["Theme", "Primary colour", "Navigation layout"])
      expect(html.indexOf(heading)).toBeGreaterThan(appearance);
    expect(html.indexOf("Approval required")).toBeGreaterThan(
      html.indexOf("Navigation layout"),
    );
  });

  test("shows current inventory enrichment approval mode and review-needed state", async () => {
    currentSettings = {
      approvalsRequired: true,
      updatedAt: "2026-06-27T09:10:00.000Z",
    };
    currentItems = [
      buildItem({
        proposalStatus: "PENDING_APPROVAL",
      }),
    ];
    currentProposals = [
      {
        captureText: "Travel pouch",
        capturedAt: "2026-06-27T11:00:00.000Z",
        confidence: 0.94,
        diff: [
          {
            field: "category",
            label: "Category",
            current: "None",
            proposed: "Electronics",
          },
        ],
        failedSteps: [],
        id: "job-1",
        ocrEvidence: [],
        itemId: "item-1",
        itemTitle: "Travel pouch",
        rationale: "Travel wording suggests a document pouch.",
        sourceRefsSummary: "1 item, 0 image, 0 audio, 0 file",
        transcriptEvidence: [],
        updatedAt: "2026-06-27T12:00:30.000Z",
      },
    ];

    const { default: SettingsPage } = await import("./page");
    const html = await renderServerPage(SettingsPage());

    expect(html).toContain("Inventory Enrichment");
    expect(html).toContain("Approval required");
    expect(html).toContain("1 proposal needs review");
    expect(html).toContain("Inventory proposals");
    expect(html).toContain("Travel pouch");
    expect(html).toContain("Current");
    expect(html).toContain("Proposed");
    expect(html).toContain('href="/inventory/items/item-1"');
    expect(html).toContain("Open item");
  });

  test("shows auto-apply mode when inventory enrichment approvals are disabled", async () => {
    currentSettings = {
      approvalsRequired: false,
      updatedAt: "2026-06-27T09:20:00.000Z",
    };
    currentItems = [
      buildItem({
        proposalStatus: "APPROVED",
      }),
    ];

    const { default: SettingsPage } = await import("./page");
    const html = await renderServerPage(SettingsPage());

    expect(html).toContain("Auto-apply enabled");
    expect(html).toContain("0 pending");
    expect(html).toContain("No review needed");
  });

  test("renders least-privilege API key creation and safe listing", async () => {
    const { default: SettingsPage } = await import("./page");
    const html = await renderServerPage(SettingsPage());

    expect(html).toContain("API keys");
    expect(html).toContain("Create credential");
    expect(html).toContain("Optional expiry (hours)");
    expect(html).toContain("Reader");
    expect(html).toContain("Editor");
    expect(html).toContain("Maintainer");
    expect(html).toContain("Custom permissions");
    expect(html).toContain('value="todos:read"');
    expect(html).toContain('value="todos:write"');
    expect(html).toContain('value="todos:approve"');
    expect(html).toContain('value="todos:delete"');
    expect(html).toContain("Approve execution");
    expect(html).not.toContain('value="inventory:approve"');
    expect(html).toContain("MCP server");
    expect(html).toContain("qs_key_abcd12...");
    expect(html).toContain("inventory:read");
    expect(html).toContain("notes:delete");
    expect(html).toContain("Rotate overlap");
    expect(html).toContain("Revoke");
    expect(html).not.toContain("qs_key_abcd1234secret");
  });
});

function buildItem(input?: {
  enrichmentStatus?: string;
  id?: string;
  preprocessingStatus?: string;
  proposalStatus?: string;
}) {
  return {
    id: input?.id ?? "item-1",
    processing: {
      currentStep: "Proposal pending approval",
      enrichment: {
        rationale: "Inventory Enrichment has not started.",
        status: input?.enrichmentStatus ?? "NOT_STARTED",
        summary: "Inventory Enrichment has not started.",
        updatedAt: "2026-06-27T12:00:30.000Z",
      },
      evidence: [],
      nextAction: "Review Inventory Proposal",
      preprocessing: {
        failedSteps: [],
        mediaTexts: [],
        status: input?.preprocessingStatus ?? "CAPTURED",
        summary: "Saved evidence is waiting for preprocessing pickup.",
        textBundleAvailable: false,
        updatedAt: "2026-06-27T11:00:00.000Z",
      },
      proposal: {
        status: input?.proposalStatus ?? "NONE",
        summary: "No pending Inventory Proposal.",
        updatedAt: "2026-06-27T12:00:30.000Z",
      },
      sourceLabel: "Inventory capture",
    },
  };
}
