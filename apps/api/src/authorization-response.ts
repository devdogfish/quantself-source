import { z } from "@hono/zod-openapi";
import {
  authorizationFailureStatus,
  type AuthorizationFailure,
} from "@quantself/auth";
import type { Context } from "hono";

const authorizationErrorSchema = z
  .object({
    code: z
      .enum(["FORBIDDEN", "UNAUTHENTICATED"])
      .openapi({ example: "UNAUTHENTICATED" }),
    message: z
      .string()
      .min(1)
      .openapi({ example: "Authentication required." }),
  })
  .openapi("AuthorizationError");

function authorizationErrorBody(error: AuthorizationFailure) {
  return {
    code: error.code,
    message: error.message,
  };
}

function jsonAuthorizationFailure(
  context: Context,
  error: AuthorizationFailure,
) {
  return context.json(
    authorizationErrorBody(error),
    authorizationFailureStatus(error),
  );
}

function jsonUnauthenticatedFailure(
  context: Context,
  error: AuthorizationFailure,
) {
  return context.json(authorizationErrorBody(error), 401);
}

export {
  authorizationErrorBody,
  authorizationErrorSchema,
  jsonAuthorizationFailure,
  jsonUnauthenticatedFailure,
};
