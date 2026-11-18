import { prisma } from "@quantself/db";
import {
  agentClientFromMetadata,
  hasAgentClientMetadata,
  type AgentClient,
} from "./agent-client";
import { auth } from "./auth-config";
import { hasOwnerIngressProof } from "./owner-ingress";
import { OWNER_RECORD_ID } from "./owner-record";

export type AccessContextOwner = {
  email: string;
  id: string;
  name: string;
};

export type AccessContext = {
  owner: AccessContextOwner;
  client: AgentClient | {
    id: string;
    kind: "api-key" | "web";
    name: string;
  };
  permissions: string[];
};

export type AuthorizationFailure = {
  code: "FORBIDDEN" | "UNAUTHENTICATED";
  message: string;
};

export type AuthorizationPermission =
  | string
  | AuthorizationPermission[]
  | {
      action: string;
      domain: string;
    };

export type AuthorizationResult =
  | {
      accessContext: AccessContext;
      ok: true;
    }
  | {
      error: AuthorizationFailure;
      ok: false;
    };

type ApiKeyRecord = {
  id: string;
  metadata?: unknown;
  name: string | null;
  permissions: Record<string, string[]> | string | null;
  referenceId: string;
};

type OwnerRecord = {
  user: AccessContextOwner;
  userId: string;
};

export type AccessContextDependencies = {
  findOwnerByUserId: (userId: string) => Promise<OwnerRecord | null>;
  findExistingOwner: () => Promise<OwnerRecord | null>;
  verifyApiKey: (key: string) => Promise<ApiKeyRecord | null>;
};

function findOwner(where: { id: string } | { userId: string }) {
  return prisma.authOwner.findUnique({
    where,
    select: { userId: true, user: { select: { email: true, id: true, name: true } } },
  });
}

const defaultDependencies: AccessContextDependencies = {
  findOwnerByUserId: (userId) => findOwner({ userId }),
  findExistingOwner: () => findOwner({ id: OWNER_RECORD_ID }),
  verifyApiKey: async (key) => {
    const result = await auth.api.verifyApiKey({
      body: { key },
    });

    if (!result.valid || !result.key) {
      return null;
    }

    return {
      id: result.key.id,
      metadata: result.key.metadata,
      name: result.key.name,
      permissions: result.key.permissions ?? null,
      referenceId: result.key.referenceId,
    };
  },
};

const unauthenticatedError = {
  code: "UNAUTHENTICATED",
  message: "Authentication required.",
} satisfies AuthorizationFailure;

const forbiddenError = {
  code: "FORBIDDEN",
  message: "Missing required permission.",
} satisfies AuthorizationFailure;

const ownerPermissions = [
  "jobs:read",
  "jobs:write",
  "budgeting:read",
  "budgeting:write",
  "budgeting:delete",
  "habits:read",
  "habits:write",
  "habits:delete",
  "todos:read",
  "todos:write",
  "todos:approve",
  "todos:delete",
  "health:delete",
  "health:read",
  "health:write",
  "inventory:delete",
  "inventory:read",
  "inventory:write",
  "meetings:read",
  "meetings:write",
] as const;

function stringifyPermission(
  permission: AuthorizationPermission,
): string | string[] {
  if (Array.isArray(permission)) {
    return permission.flatMap((entry) => stringifyPermission(entry));
  }

  return typeof permission === "string"
    ? permission
    : `${permission.domain}:${permission.action}`;
}

function failure(
  error: AuthorizationFailure,
): Extract<AuthorizationResult, { ok: false }> {
  return {
    error,
    ok: false,
  };
}

export function flattenApiKeyPermissions(
  permissions: Record<string, string[]> | string | null,
) {
  if (!permissions) {
    return [];
  }

  let parsed: unknown = permissions;
  if (typeof permissions === "string") {
    try {
      parsed = JSON.parse(permissions);
    } catch {
      return [];
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return [];
  }

  return Object.entries(parsed)
    .flatMap(([domain, actions]) =>
      Array.isArray(actions)
        ? actions
            .filter(
              (action): action is string =>
                typeof action === "string" && action.length > 0,
            )
            .map((action) => `${domain}:${action}`)
        : [],
    )
    .filter(
      (permission, index, permissions) =>
        permissions.indexOf(permission) === index,
    )
    .sort((left, right) => left.localeCompare(right));
}

export function authenticateAccessContext(
  accessContext: AccessContext | null,
): AuthorizationResult {
  return accessContext
    ? {
        accessContext,
        ok: true,
      }
    : failure(unauthenticatedError);
}

export function authorizeAccessContext(
  accessContext: AccessContext | null,
  requiredPermission: AuthorizationPermission,
): AuthorizationResult {
  const authenticated = authenticateAccessContext(accessContext);
  if (!authenticated.ok) {
    return authenticated;
  }

  const permissions = stringifyPermission(requiredPermission);
  const requiredPermissions = Array.isArray(permissions)
    ? permissions
    : [permissions];

  if (
    requiredPermissions.every((permission) =>
      authenticated.accessContext.permissions.includes(permission),
    )
  ) {
    return authenticated;
  }

  return failure(forbiddenError);
}

export function authorizationFailureStatus(error: AuthorizationFailure) {
  return error.code === "UNAUTHENTICATED" ? 401 : 403;
}

export async function resolveAccessContext(
  headers: Headers,
  dependencies: AccessContextDependencies = defaultDependencies,
): Promise<AccessContext | null> {
  const presentedApiKey = headers.get("x-api-key");
  if (presentedApiKey !== null) {
    if (!presentedApiKey.trim()) {
      return null;
    }

    const apiKey = await dependencies.verifyApiKey(presentedApiKey);
    if (!apiKey) {
      return null;
    }

    const agentClient = agentClientFromMetadata(apiKey.metadata);
    if (hasAgentClientMetadata(apiKey.metadata) && !agentClient) {
      return null;
    }

    const ownerRecord = await dependencies.findOwnerByUserId(
      apiKey.referenceId,
    );
    if (!ownerRecord) {
      return null;
    }

    return {
      owner: ownerRecord.user,
      client: agentClient ?? {
        id: apiKey.id,
        kind: "api-key",
        name: apiKey.name ?? apiKey.id,
      },
      permissions: flattenApiKeyPermissions(apiKey.permissions),
    };
  }

  const ownerRecord = await resolveOwnerRecord(headers, dependencies);
  if (!ownerRecord) {
    return null;
  }

  return {
    owner: ownerRecord.user,
    client: {
      id: "quantself-web",
      kind: "web",
      name: "Quantself Web Client",
    },
    permissions: [...ownerPermissions],
  };
}

export { forbiddenError, unauthenticatedError };

async function resolveOwnerRecord(headers: Headers, dependencies: AccessContextDependencies) {
  return !headers.has("x-api-key") && hasOwnerIngressProof(headers)
    ? dependencies.findExistingOwner()
    : null;
}

export async function resolveBrowserOwner(headers: Headers): Promise<AccessContextOwner | null> {
  return (await resolveOwnerRecord(headers, defaultDependencies))?.user ?? null;
}
