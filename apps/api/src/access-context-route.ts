import { createRoute, z } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { authorizationErrorSchema } from "./authorization-response";

const accessContextOwnerSchema = z
  .object({
    email: z.email().openapi({ example: "owner@example.com" }),
    id: z.string().min(1).openapi({ example: "user_123" }),
    name: z.string().min(1).openapi({ example: "QuantSelf Owner" }),
  })
  .openapi("AccessContextOwner");

const clientIdentity = {
  id: z.string().min(1).openapi({ example: "key_123" }),
  name: z.string().min(1).openapi({ example: "inventory-bot" }),
};

const accessContextClientSchema = z.union([
  z.object({ ...clientIdentity, kind: z.enum(["api-key", "web"]) }),
  z.object({
    ...clientIdentity,
    kind: z.literal("agent"),
    avatar: z.string().nullable().openapi({ example: "https://example.com/agent.png" }),
  }),
]).openapi("AccessContextClient");

const accessContextResponseSchema = z
  .object({
    owner: accessContextOwnerSchema,
    client: accessContextClientSchema,
    permissions: z
      .array(z.string().min(1))
      .openapi({ example: ["inventory:read", "inventory:write"] }),
  })
  .openapi("AccessContext");

type AccessContextResponse = z.infer<typeof accessContextResponseSchema>;

function toAccessContextResponse(
  accessContext: AccessContext,
): AccessContextResponse {
  return {
    owner: {
      email: accessContext.owner.email,
      id: accessContext.owner.id,
      name: accessContext.owner.name,
    },
    client: accessContext.client.kind === "agent"
      ? { ...accessContext.client }
      : { id: accessContext.client.id, kind: accessContext.client.kind, name: accessContext.client.name },
    permissions: [...accessContext.permissions],
  };
}

const accessContextRoute = createRoute({
  method: "get",
  operationId: "getAccessContext",
  path: "/api/v1/access-context",
  responses: {
    200: {
      content: {
        "application/json": {
          example: {
            owner: {
              email: "owner@example.com",
              id: "user_123",
              name: "QuantSelf Owner",
            },
            client: {
              id: "key_123",
              kind: "api-key",
              name: "inventory-bot",
            },
            permissions: ["inventory:read", "inventory:write"],
          } satisfies AccessContextResponse,
          schema: accessContextResponseSchema,
        },
      },
      description: "Current authenticated access context.",
    },
    401: {
      content: {
        "application/json": {
          example: {
            code: "UNAUTHENTICATED",
            message: "Authentication required.",
          },
          schema: authorizationErrorSchema,
        },
      },
      description: "No valid Owner ingress proof or API Key was provided.",
    },
  },
  security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
  summary: "Get current access context",
  tags: ["Auth"],
  "x-destructive": false,
  "x-required-permissions": [],
  description:
    "Returns the safe owner identity, resolved client, and effective permissions for the current request. Authentication: X-API-Key or trusted Owner ingress. Required permissions: none. Inputs: none. Success response: 200 with owner, client, and effective permissions. Failure responses: 401 when no valid Owner ingress proof or API Key is present. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

export {
  type AccessContextResponse,
  accessContextResponseSchema,
  accessContextRoute,
  toAccessContextResponse,
};
