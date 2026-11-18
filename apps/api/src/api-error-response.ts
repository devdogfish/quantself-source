import { z } from "@hono/zod-openapi";
import type { Context } from "hono";

const apiErrorSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .openapi({ example: "INVALID_IDEMPOTENCY_KEY" }),
    message: z
      .string()
      .min(1)
      .openapi({ example: "Idempotency-Key header is required." }),
  })
  .openapi("ApiError");

function jsonApiError(
  context: Context,
  input: { code: string; message: string; status: 400 | 404 | 409 | 415 },
) {
  return context.json(
    {
      code: input.code,
      message: input.message,
    },
    input.status,
  );
}

export { apiErrorSchema, jsonApiError };
