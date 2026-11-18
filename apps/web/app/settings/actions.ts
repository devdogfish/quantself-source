"use server";

import { revalidatePath } from "next/cache";
import type { ApiKeyPreset } from "@quantself/auth";
import { assertOwnerActionSession } from "@/lib/owner-session-server";
import {
  createOwnerApiKey,
  revokeOwnerApiKey,
  rotateOwnerApiKey,
} from "@/lib/owner-api-keys-server";

export type ApiKeyActionState = {
  credential:
    | Awaited<ReturnType<typeof createOwnerApiKey>>["credential"]
    | null;
  message: string;
  secret: string | null;
  status: "idle" | "success" | "error";
};

export type ApiKeyMutationActionState = {
  credential: Awaited<ReturnType<typeof revokeOwnerApiKey>> | null;
  message: string;
  status: "idle" | "success" | "error";
};

export type ApiKeyRotationActionState = {
  credential:
    | Awaited<ReturnType<typeof rotateOwnerApiKey>>["credential"]
    | null;
  message: string;
  revokedCredential:
    | Awaited<ReturnType<typeof rotateOwnerApiKey>>["revokedCredential"]
    | null;
  secret: string | null;
  status: "idle" | "success" | "error";
};

export async function createApiKeyAction(
  formData: FormData,
): Promise<Awaited<ReturnType<typeof createOwnerApiKey>>> {
  const session = await assertOwnerActionSession();
  const preset = formPreset(formData, "preset");

  const created = await createOwnerApiKey({
    expiresAt: formExpiresAt(formData, "expiresInHours"),
    name: formString(formData, "name") ?? "",
    preset,
    permissionIds: formStrings(formData, "permissionId"),
    userId: session.user.id,
  });

  revalidatePath("/settings");

  return created;
}

export async function createApiKeyWithStateAction(
  _state: ApiKeyActionState,
  formData: FormData,
): Promise<ApiKeyActionState> {
  try {
    const created = await createApiKeyAction(formData);

    return {
      credential: created.credential,
      message: "API key created.",
      secret: created.secret,
      status: "success",
    };
  } catch (error) {
    return {
      credential: null,
      message:
        error instanceof Error && error.message.trim()
          ? error.message
          : "Could not create API key.",
      secret: null,
      status: "error",
    };
  }
}

export async function revokeApiKeyAction(
  formData: FormData,
): Promise<Awaited<ReturnType<typeof revokeOwnerApiKey>>> {
  const session = await assertOwnerActionSession();

  const credentialId = requiredFormString(formData, "credentialId");
  const credential = await revokeOwnerApiKey({ credentialId, userId: session.user.id });
  revalidatePath("/settings");

  return credential;
}

export async function revokeApiKeyWithStateAction(
  _state: ApiKeyMutationActionState,
  formData: FormData,
): Promise<ApiKeyMutationActionState> {
  try {
    const credential = await revokeApiKeyAction(formData);

    return {
      credential,
      message: "API key revoked.",
      status: "success",
    };
  } catch (error) {
    return {
      credential: null,
      message:
        error instanceof Error && error.message.trim()
          ? error.message
          : "Could not revoke API key.",
      status: "error",
    };
  }
}

export async function rotateApiKeyAction(
  formData: FormData,
): Promise<Awaited<ReturnType<typeof rotateOwnerApiKey>>> {
  const session = await assertOwnerActionSession();

  const rotated = await rotateOwnerApiKey({
    credentialId: requiredFormString(formData, "credentialId"),
    overlapMinutes: formPositiveInteger(formData, "overlapMinutes"),
    userId: session.user.id,
  });
  revalidatePath("/settings");

  return rotated;
}

export async function rotateApiKeyWithStateAction(
  _state: ApiKeyRotationActionState,
  formData: FormData,
): Promise<ApiKeyRotationActionState> {
  try {
    const rotated = await rotateApiKeyAction(formData);

    return {
      credential: rotated.credential,
      message: "API key rotated.",
      revokedCredential: rotated.revokedCredential,
      secret: rotated.secret,
      status: "success",
    };
  } catch (error) {
    return {
      credential: null,
      message:
        error instanceof Error && error.message.trim()
          ? error.message
          : "Could not rotate API key.",
      revokedCredential: null,
      secret: null,
      status: "error",
    };
  }
}

function formString(formData: FormData, key: string): string | null {
  const value = formData.get(key);

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formStrings(formData: FormData, key: string): string[] {
  return formData
    .getAll(key)
    .flatMap((value) =>
      typeof value === "string" && value.trim() ? [value.trim()] : [],
    );
}

function requiredFormString(formData: FormData, key: string) {
  const value = formString(formData, key);

  if (!value) {
    throw new Error("API key not found.");
  }

  return value;
}

function formPositiveInteger(formData: FormData, key: string) {
  const value = formString(formData, key);

  if (!value) {
    throw new Error("Choose a valid overlap.");
  }

  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("Choose a valid overlap.");
  }

  return Number.parseInt(value, 10);
}

function formExpiresAt(formData: FormData, key: string) {
  const value = formString(formData, key);

  if (!value) {
    return null;
  }

  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("Expiry must be a whole number of hours.");
  }

  const parsed = Number.parseInt(value, 10);
  return new Date(Date.now() + parsed * 60 * 60 * 1000);
}

function formPreset(formData: FormData, key: string): ApiKeyPreset {
  const value = formString(formData, key);

  if (
    value === "reader" ||
    value === "editor" ||
    value === "maintainer" ||
    value === "custom"
  ) {
    return value;
  }

  throw new Error("Select a valid permission preset.");
}
