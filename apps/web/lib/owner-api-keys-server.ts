import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  type CreateApiKeyResult,
  type ApiKeyPreset,
  type ApiKeySummary,
  type RotateApiKeyResult,
} from "@quantself/auth";
export type OwnerApiKeySummary = ApiKeySummary;

export async function loadOwnerApiKeys(userId: string): Promise<OwnerApiKeySummary[]> {
  return listApiKeys({ userId });
}

export async function createOwnerApiKey(input: {
  expiresAt: Date | null;
  name: string;
  preset: ApiKeyPreset;
  permissionIds: string[];
  userId: string;
}): Promise<CreateApiKeyResult> {
  return createApiKey(input);
}

export async function revokeOwnerApiKey(input: {
  credentialId: string;
  userId: string;
}): Promise<ApiKeySummary> {
  return revokeApiKey(input);
}

export async function rotateOwnerApiKey(input: {
  credentialId: string;
  overlapMinutes: number;
  userId: string;
}): Promise<RotateApiKeyResult> {
  return rotateApiKey(input);
}
