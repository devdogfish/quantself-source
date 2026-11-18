import { randomUUID } from "node:crypto";
import { prisma } from "@quantself/db";
import {
  AGENT_CLIENT_METADATA_KEY,
  agentClientFromMetadata,
  hasAgentClientMetadata,
  type AgentClient,
} from "./agent-client";
import { auth } from "./auth-config";
import { flattenApiKeyPermissions } from "./access-context";
import {
  API_KEY_PERMISSION_GROUPS,
  type ApiKeyPreset,
  type ApiKeyStatus,
  type ApiKeySummary,
} from "./api-key-contract";

export {
  API_KEY_PERMISSION_GROUPS,
  type ApiKeyPreset,
  type ApiKeyStatus,
  type ApiKeySummary,
} from "./api-key-contract";

const API_KEY_PREFIX = "qs_key_";
const API_KEY_MIN_EXPIRY_MS = 60_000;
const API_KEY_MAX_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;
const API_KEY_MAX_ROTATION_OVERLAP_MINUTES = 24 * 60;
const PRESET_ACTIONS = {
  editor: ["read", "write"],
  maintainer: ["delete", "read", "write"],
  reader: ["read"],
} as const;

type ApiKeyDomain = (typeof API_KEY_PERMISSION_GROUPS)[number]["domain"];
type ApiKeyAction = (typeof API_KEY_PERMISSION_GROUPS)[number]["actions"][number];
type ApiKeyPermissions = Record<string, ApiKeyAction[]>;
const apiKeyActions = new Set<string>(API_KEY_PERMISSION_GROUPS.flatMap(({ actions }) => [...actions]));

type ApiKeyMetadata = Record<string, unknown> & {
  preset?: ApiKeyPreset;
  replacementCredentialId?: string;
  rotatedFromCredentialId?: string;
  rotationOverlapEndsAt?: string;
  revokedAt?: string;
  revokedReason?: "manual" | "rotation";
};

type ApiKeyRecord = {
  createdAt: Date;
  enabled: boolean | null;
  expiresAt: Date | null;
  id: string;
  lastRequest: Date | null;
  metadata: Record<string, unknown> | null;
  name: string | null;
  permissions: Record<string, string[]> | null;
  prefix: string | null;
  start: string | null;
  updatedAt: Date;
};

type CreatedApiKeyRecord = ApiKeyRecord & {
  key: string;
};

type CreateApiKeyDependencies = {
  createApiKey: (input: {
    expiresIn?: number;
    metadata: ApiKeyMetadata;
    name: string;
    permissions: ApiKeyPermissions;
    prefix: string;
    userId: string;
  }) => Promise<CreatedApiKeyRecord>;
  findStoredApiKeyById: (id: string) => Promise<{
    id: string;
    key: string;
  } | null>;
};

type ListApiKeyDependencies = {
  listApiKeys: (input: { userId: string }) => Promise<{ apiKeys: ApiKeyRecord[] }>;
};

type UpdateApiKeyDependencies = CreateApiKeyDependencies & {
  findOwnedApiKey: (id: string, userId: string) => Promise<ApiKeyRecord | null>;
  updateApiKey: (input: {
    enabled?: boolean;
    expiresIn?: number | null;
    keyId: string;
    metadata?: ApiKeyMetadata;
    userId: string;
  }) => Promise<ApiKeyRecord>;
};

type ApiKeyClock = {
  now: () => Date;
};

const defaultClock: ApiKeyClock = {
  now: () => new Date(),
};

const defaultCreateDependencies: CreateApiKeyDependencies = {
  createApiKey: (input) =>
    auth.api.createApiKey({
      body: input,
    }),
  findStoredApiKeyById: (id) =>
    prisma.apikey.findUnique({
      select: {
        id: true,
        key: true,
      },
      where: {
        id,
      },
    }),
};

const apiKeySummaryFields = {
  createdAt: true, enabled: true, expiresAt: true, id: true, lastRequest: true,
  metadata: true, name: true, permissions: true, prefix: true, start: true, updatedAt: true,
} as const;

function parseApiKeyRecord(row: Omit<ApiKeyRecord, "metadata" | "permissions"> & {
  metadata: string | null; permissions: string | null;
}): ApiKeyRecord {
  const parse = (value: string | null) => {
    try {
      const parsed: unknown = value === null ? null : JSON.parse(value);
      return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
    } catch {
      return null;
    }
  };
  return { ...row, metadata: parse(row.metadata), permissions: parse(row.permissions) };
}

const defaultListDependencies: ListApiKeyDependencies = {
  listApiKeys: async ({ userId }) => ({
    apiKeys: (await prisma.apikey.findMany({
      where: { referenceId: userId },
      select: apiKeySummaryFields,
      orderBy: { createdAt: "desc" },
    })).map(parseApiKeyRecord),
  }),
};

const defaultUpdateDependencies: UpdateApiKeyDependencies = {
  ...defaultCreateDependencies,
  findOwnedApiKey: async (id, userId) => {
    const row = await prisma.apikey.findUnique({
      where: { id, referenceId: userId },
      select: apiKeySummaryFields,
    });
    return row ? parseApiKeyRecord(row) : null;
  },
  updateApiKey: (body) => auth.api.updateApiKey({ body }),
};

export type CreateApiKeyInput = {
  expiresAt?: Date | null;
  name: string;
  preset: ApiKeyPreset;
  permissionIds?: string[];
  userId: string;
};

export type CreateApiKeyResult = {
  credential: ApiKeySummary;
  secret: string;
};

export type RevokeApiKeyInput = {
  credentialId: string;
  userId: string;
};

export type RotateApiKeyInput = {
  credentialId: string;
  overlapMinutes: number;
  userId: string;
};

export type RotateApiKeyResult = {
  credential: ApiKeySummary;
  revokedCredential: ApiKeySummary;
  secret: string;
};

export function resolveApiKeyPermissions(input: {
  preset: ApiKeyPreset;
  permissionIds?: string[];
}): ApiKeyPermissions {
  const preset = input.preset;

  if (preset !== "custom") {
    return Object.fromEntries(
      // Specialized permissions require explicit grants.
      API_KEY_PERMISSION_GROUPS.filter(({ domain }) =>
        domain === "health" || domain === "inventory" || domain === "notes",
      ).map(
        ({ domain }) => [domain, [...PRESET_ACTIONS[preset]]],
      ),
    );
  }

  const permissions = new Map<ApiKeyDomain, Set<ApiKeyAction>>();

  for (const permissionId of input.permissionIds ?? []) {
    const parsed = parsePermissionId(permissionId);

    if (!parsed) {
      continue;
    }

    if (!permissions.has(parsed.domain)) {
      permissions.set(parsed.domain, new Set());
    }

    permissions.get(parsed.domain)!.add(parsed.action);
  }

  if (permissions.size === 0) {
    throw new Error("Select at least one custom permission.");
  }

  return Object.fromEntries(
    [...permissions.entries()].map(([domain, actions]) => [
      domain,
      [...actions].sort(),
    ]),
  );
}

export function createApiKey(
  input: CreateApiKeyInput,
  dependencies: CreateApiKeyDependencies = defaultCreateDependencies,
  clock: ApiKeyClock = defaultClock,
): Promise<CreateApiKeyResult> {
  return issueApiKey(input, { preset: input.preset }, dependencies, clock);
}

export async function createAgentApiKey(
  input: Omit<CreateApiKeyInput, "permissionIds" | "preset"> & { avatar?: string; permissionIds: string[] },
  dependencies: CreateApiKeyDependencies = defaultCreateDependencies,
  clock: ApiKeyClock = defaultClock,
): Promise<CreateApiKeyResult & { client: AgentClient }> {
  for (const permissionId of input.permissionIds) {
    if (!parsePermissionId(permissionId)) throw new Error(`Unknown Agent permission: ${permissionId}`);
  }
  const name = normalizeApiKeyName(input.name);
  if (name.length > 32) throw new Error("Agent name must be 32 characters or fewer.");
  const avatar = input.avatar ?? null;
  if (avatar !== null) {
    const url = URL.parse(avatar);
    if (!url || url.protocol !== "https:" || url.username || url.password) {
      throw new Error("Agent avatar must be an HTTPS URL without credentials.");
    }
  }
  const agent = { id: randomUUID(), name, avatar };
  const issued = await issueApiKey(
    { ...input, name, preset: "custom" },
    { preset: "custom", [AGENT_CLIENT_METADATA_KEY]: agent },
    dependencies,
    clock,
  );
  return { ...issued, client: { ...agent, kind: "agent" } };
}

async function issueApiKey(
  input: CreateApiKeyInput,
  metadata: ApiKeyMetadata,
  dependencies: CreateApiKeyDependencies = defaultCreateDependencies,
  clock: ApiKeyClock = defaultClock,
): Promise<CreateApiKeyResult> {
  const name = normalizeApiKeyName(input.name);
  const permissions = resolveApiKeyPermissions({
    preset: input.preset,
    permissionIds: input.permissionIds,
  });
  const created = await dependencies.createApiKey({
    expiresIn: expiresInSecondsFromDate(input.expiresAt, clock.now()),
    metadata,
    name,
    permissions,
    prefix: API_KEY_PREFIX,
    userId: input.userId,
  });
  const stored = await dependencies.findStoredApiKeyById(created.id);

  if (!stored || stored.key === created.key) {
    throw new Error("API key storage must stay hashed.");
  }

  return {
    credential: summarizeApiKey(created, clock.now()),
    secret: created.key,
  };
}

export async function listApiKeys(
  input: { userId: string },
  dependencies: ListApiKeyDependencies = defaultListDependencies,
  clock: ApiKeyClock = defaultClock,
): Promise<ApiKeySummary[]> {
  const response = await dependencies.listApiKeys({
    userId: input.userId,
  });

  return response.apiKeys.map((apiKey) => summarizeApiKey(apiKey, clock.now()));
}

export async function revokeApiKey(
  input: RevokeApiKeyInput,
  dependencies: UpdateApiKeyDependencies = defaultUpdateDependencies,
  clock: ApiKeyClock = defaultClock,
): Promise<ApiKeySummary> {
  const current = await dependencies.findOwnedApiKey(input.credentialId, input.userId);
  if (!current) throw new Error("API key not found.");
  const now = clock.now();
  const summary = summarizeApiKey(current, now);

  if (summary.status === "revoked") {
    return summary;
  }

  const metadata = metadataFromRecord(current);
  const updated = await dependencies.updateApiKey({
    enabled: false,
    userId: input.userId,
    keyId: current.id,
    metadata: {
      ...metadata,
      preset: summary.preset,
      revokedAt: now.toISOString(),
      revokedReason: "manual",
      rotationOverlapEndsAt: undefined,
    },
  });

  return summarizeApiKey(updated, now);
}

export async function rotateApiKey(
  input: RotateApiKeyInput,
  dependencies: UpdateApiKeyDependencies = defaultUpdateDependencies,
  clock: ApiKeyClock = defaultClock,
): Promise<RotateApiKeyResult> {
  const current = await dependencies.findOwnedApiKey(input.credentialId, input.userId);
  if (!current) throw new Error("API key not found.");
  const now = clock.now();
  const summary = summarizeApiKey(current, now);

  if (summary.status !== "active") {
    throw new Error("Only active credentials can be rotated.");
  }

  const metadata = metadataFromRecord(current);
  const agent = agentClientFromMetadata(metadata);
  if (hasAgentClientMetadata(metadata) && !agent) {
    throw new Error("Agent identity is invalid.");
  }
  const overlapMinutes = normalizeRotationOverlapMinutes(input.overlapMinutes);
  const overlapEndsAt = new Date(now.getTime() + overlapMinutes * 60_000);
  const replacementProvisionalExpiresAt =
    current.expiresAt && current.expiresAt.getTime() <= overlapEndsAt.getTime()
      ? current.expiresAt
      : overlapEndsAt;
  const replacement = await dependencies.createApiKey({
    // Keep an undisclosed replacement bounded if any later rotation step fails.
    expiresIn: expiresInSecondsFromDate(replacementProvisionalExpiresAt, now),
    metadata: {
      ...(agent && { [AGENT_CLIENT_METADATA_KEY]: metadata[AGENT_CLIENT_METADATA_KEY] }),
      preset: summary.preset,
      rotatedFromCredentialId: current.id,
    },
    name: normalizeApiKeyName(current.name ?? current.id),
    permissions: resolveRotationPermissions(current, summary),
    prefix: API_KEY_PREFIX,
    userId: input.userId,
  });
  const stored = await dependencies.findStoredApiKeyById(replacement.id);

  if (!stored || stored.key === replacement.key) {
    throw new Error("API key storage must stay hashed.");
  }

  const expiresIn = rotationExpiresInSeconds(
    current.expiresAt,
    overlapEndsAt,
    now,
  );
  const updated = await dependencies.updateApiKey({
    expiresIn,
    userId: input.userId,
    keyId: current.id,
    metadata: {
      ...metadata,
      preset: summary.preset,
      replacementCredentialId: replacement.id,
      revokedReason: "rotation",
      rotationOverlapEndsAt: overlapEndsAt.toISOString(),
    },
  });
  const finalizedReplacement =
    current.expiresAt && current.expiresAt.getTime() <= overlapEndsAt.getTime()
      ? replacement
      : await dependencies.updateApiKey({
          expiresIn: current.expiresAt
            ? expiresInSecondsFromDate(current.expiresAt, now)
            : null,
          userId: input.userId,
          keyId: replacement.id,
        });

  return {
    credential: summarizeApiKey(finalizedReplacement, now),
    revokedCredential: summarizeApiKey(updated, now),
    secret: replacement.key,
  };
}

function normalizeApiKeyName(name: string) {
  const normalized = name.trim();

  if (!normalized) {
    throw new Error("Credential name required.");
  }

  return normalized;
}

function normalizeRotationOverlapMinutes(value: number) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Rotation overlap must be at least 1 minute.");
  }

  if (value > API_KEY_MAX_ROTATION_OVERLAP_MINUTES) {
    throw new Error("Rotation overlap must be 24 hours or less.");
  }

  return value;
}

function expiresInSecondsFromDate(
  expiresAt: Date | null | undefined,
  now: Date,
) {
  if (expiresAt == null) {
    return undefined;
  }

  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error("Expiry must be a valid date.");
  }

  const diffMs = expiresAt.getTime() - now.getTime();
  if (diffMs < API_KEY_MIN_EXPIRY_MS) {
    throw new Error("Expiry must be at least 1 minute in the future.");
  }

  if (diffMs > API_KEY_MAX_EXPIRY_MS) {
    throw new Error("Expiry must be within 365 days.");
  }

  return Math.ceil(diffMs / 1000);
}

function rotationExpiresInSeconds(
  currentExpiresAt: Date | null,
  overlapEndsAt: Date,
  now: Date,
) {
  if (
    currentExpiresAt &&
    currentExpiresAt.getTime() <= overlapEndsAt.getTime()
  ) {
    return undefined;
  }

  return expiresInSecondsFromDate(overlapEndsAt, now);
}

function resolveRotationPermissions(
  apiKey: ApiKeyRecord,
  summary: ApiKeySummary,
) {
  if (apiKey.permissions && Object.keys(apiKey.permissions).length > 0) {
    return Object.fromEntries(
      Object.entries(apiKey.permissions).map(([domain, actions]) => [
        domain,
        actions.filter(isApiKeyAction),
      ]),
    );
  }

  if (hasAgentClientMetadata(apiKey.metadata)) {
    throw new Error("Agent credentials require explicit permissions.");
  }

  return resolveApiKeyPermissions({
    preset: summary.preset,
    permissionIds: summary.permissions,
  });
}

function isApiKeyAction(action: string): action is ApiKeyAction {
  return apiKeyActions.has(action);
}

function parsePermissionId(permissionId: string): {
  action: ApiKeyAction;
  domain: ApiKeyDomain;
} | null {
  const [domain, action, ...rest] = permissionId.split(":");

  if (rest.length > 0 || !domain || !action) {
    return null;
  }

  const group = API_KEY_PERMISSION_GROUPS.find((entry) => entry.domain === domain);
  const allowedAction = group?.actions.find((allowed) => allowed === action);
  if (!group || !allowedAction) {
    return null;
  }

  return {
    action: allowedAction,
    domain: group.domain,
  };
}

function summarizeApiKey(apiKey: ApiKeyRecord, now: Date): ApiKeySummary {
  const metadata = metadataFromRecord(apiKey);
  const rotationOverlapEndsAt = dateFromMetadataValue(
    metadata.rotationOverlapEndsAt,
  );

  const agentClient = agentClientFromMetadata(metadata);
  return {
    ...(agentClient && { agentClient }),
    createdAt: apiKey.createdAt,
    expiresAt: apiKey.expiresAt,
    id: apiKey.id,
    lastRequestAt: apiKey.lastRequest,
    maskedKey: maskApiKey(apiKey.start, apiKey.id),
    name: apiKey.name?.trim() || apiKey.id,
    preset: apiKeyPresetFromMetadata(metadata),
    replacementCredentialId: textFromMetadataValue(
      metadata.replacementCredentialId,
    ),
    revokedAt: dateFromMetadataValue(metadata.revokedAt),
    rotatedFromCredentialId: textFromMetadataValue(
      metadata.rotatedFromCredentialId,
    ),
    rotationOverlapEndsAt,
    permissions: flattenApiKeyPermissions(
      apiKey.permissions ? JSON.stringify(apiKey.permissions) : null,
    ),
    status: apiKeyStatus(apiKey, metadata, rotationOverlapEndsAt, now),
  };
}

function metadataFromRecord(
  apiKey: Pick<ApiKeyRecord, "metadata">,
): ApiKeyMetadata {
  const metadata = apiKey.metadata;

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  return {
    ...metadata,
    preset: apiKeyPresetFromMetadata(metadata),
    replacementCredentialId:
      textFromMetadataValue(metadata.replacementCredentialId) ?? undefined,
    revokedAt: dateTextFromMetadataValue(metadata.revokedAt) ?? undefined,
    revokedReason:
      metadata.revokedReason === "manual" ||
      metadata.revokedReason === "rotation"
        ? metadata.revokedReason
        : undefined,
    rotatedFromCredentialId:
      textFromMetadataValue(metadata.rotatedFromCredentialId) ?? undefined,
    rotationOverlapEndsAt:
      dateTextFromMetadataValue(metadata.rotationOverlapEndsAt) ?? undefined,
  };
}

function apiKeyPresetFromMetadata(
  metadata: Record<string, unknown> | ApiKeyMetadata | null,
): ApiKeyPreset {
  const preset = metadata?.preset;

  return preset === "reader" ||
    preset === "editor" ||
    preset === "maintainer" ||
    preset === "custom"
    ? preset
    : "custom";
}

function apiKeyStatus(
  apiKey: {
    enabled: boolean | null;
    expiresAt: Date | null;
  },
  metadata: ApiKeyMetadata,
  rotationOverlapEndsAt: Date | null,
  now: Date,
): ApiKeyStatus {
  const revokedAt = dateFromMetadataValue(metadata.revokedAt);
  if (revokedAt && revokedAt.getTime() <= now.getTime()) {
    return "revoked";
  }

  if (apiKey.enabled === false) {
    return metadata.revokedReason ? "revoked" : "disabled";
  }

  if (rotationOverlapEndsAt && metadata.replacementCredentialId) {
    if (
      apiKey.expiresAt &&
      apiKey.expiresAt.getTime() < rotationOverlapEndsAt.getTime() &&
      apiKey.expiresAt.getTime() <= now.getTime()
    ) {
      return "expired";
    }

    if (rotationOverlapEndsAt.getTime() <= now.getTime()) {
      return "revoked";
    }

    return "rotating";
  }

  if (apiKey.expiresAt && apiKey.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }

  return "active";
}

function textFromMetadataValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function dateFromMetadataValue(value: unknown) {
  const text = dateTextFromMetadataValue(value);

  if (!text) {
    return null;
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateTextFromMetadataValue(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  return textFromMetadataValue(value);
}

function maskApiKey(start: string | null, id: string) {
  if (start?.trim()) {
    return `${start}...`;
  }

  return `${id.slice(0, 12)}...`;
}
