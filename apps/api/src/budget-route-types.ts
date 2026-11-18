import type { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AccessContext } from "@quantself/auth";
type Env = { Variables: { accessContext: AccessContext | null } };
export type BudgetRoute = <Output extends z.ZodType, Input extends z.ZodType, Query extends z.ZodObject>(
  method: "get" | "post" | "put" | "delete", path: string, operationId: string, summary: string,
  output: Output, example: unknown,
  handler: (c: Context<Env>, ownerId: string, input: z.output<Input>, query: z.output<Query>) => Promise<z.input<Output> | Response>,
  options?: { input?: Input; query?: Query; params?: z.ZodObject; inputExample?: unknown; multipart?: boolean; image?: boolean; ownerOnly?: boolean; retry?: string },
) => void;
