import { Prisma, type PrismaClient } from "@quantself/db/generated/prisma/client";
import { prisma } from "@quantself/db";
import { fingerprintIdempotentRequest } from "./idempotency-fingerprint";

type JsonRecord = Record<string, unknown>;

type IdempotentCommandConflict = {
  code: "IDEMPOTENCY_CONFLICT";
  kind: "conflict";
  message: string;
  status: 409;
};

type IdempotentCommandSuccess<TResponse extends JsonRecord> = {
  body: TResponse;
  kind: "success";
  status: number;
};

type IdempotentCommandInput<TRequest extends JsonRecord, TResponse extends JsonRecord> = {
  clientId: string;
  timeoutMs?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
  execute: (
    transaction: Prisma.TransactionClient,
  ) => Promise<IdempotentCommandSuccess<TResponse>>;
  idempotencyKey: string;
  operation: string;
  request: TRequest;
};

type IdempotentCommandResult<TResponse extends JsonRecord> =
  | IdempotentCommandConflict
  | IdempotentCommandSuccess<TResponse>;

const idempotencyConflictMessage =
  "Idempotency-Key was already used with different input.";
const maximumTransactionAttempts = 3;

async function runIdempotentCommand<
  TRequest extends JsonRecord,
  TResponse extends JsonRecord,
>(
  input: IdempotentCommandInput<TRequest, TResponse>,
  db: PrismaClient = prisma,
): Promise<IdempotentCommandResult<TResponse>> {
  const requestFingerprint = fingerprintIdempotentRequest(input.request);
  const where = {
    clientId_operation_idempotencyKey: {
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
      operation: input.operation,
    },
  } as const;

  for (let attempt = 1; attempt <= maximumTransactionAttempts; attempt += 1) {
    try {
      return await db.$transaction(
        async (transaction) => {
          const existing = await transaction.apiIdempotencyKey.findUnique({
            where,
          });

          if (existing) {
            return toIdempotentReplay<TResponse>(existing, requestFingerprint);
          }

          await transaction.apiIdempotencyKey.create({
            data: {
              clientId: input.clientId,
              idempotencyKey: input.idempotencyKey,
              operation: input.operation,
              requestFingerprint,
            },
          });

          const response = await input.execute(transaction);

          await transaction.apiIdempotencyKey.update({
            data: {
              responseBody: response.body as Prisma.InputJsonValue,
              responseStatus: response.status,
            },
            where,
          });

          return response;
        },
        {
          isolationLevel: input.isolationLevel ?? Prisma.TransactionIsolationLevel.Serializable,
          ...(input.timeoutMs ? { timeout: input.timeoutMs } : {}),
        },
      );
    } catch (error) {
      if (isPrismaWriteConflict(error) && attempt < maximumTransactionAttempts) {
        continue;
      }
      if (!isPrismaUniqueConstraint(error)) {
        throw error;
      }

      const existing = await db.apiIdempotencyKey.findUnique({
        where,
      });

      if (!existing) {
        throw error;
      }

      return toIdempotentReplay<TResponse>(existing, requestFingerprint);
    }
  }

  throw new Error("Idempotent transaction retry limit exceeded.");
}

function isPrismaUniqueConstraint(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function isPrismaWriteConflict(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  if (error.code !== "P2010") return false;
  const adapterError = error.meta?.driverAdapterError;
  const cause = adapterError instanceof Error ? adapterError.cause : undefined;
  return error.meta?.code === "40001" ||
    (typeof cause === "object" && cause !== null && "originalCode" in cause && cause.originalCode === "40001");
}

function toIdempotentReplay(
  existing: Awaited<ReturnType<PrismaClient["apiIdempotencyKey"]["findUnique"]>>,
  requestFingerprint: string,
): IdempotentCommandResult<JsonRecord>;
function toIdempotentReplay<TResponse extends JsonRecord>(
  existing: Awaited<ReturnType<PrismaClient["apiIdempotencyKey"]["findUnique"]>>,
  requestFingerprint: string,
): IdempotentCommandResult<TResponse>;
function toIdempotentReplay<TResponse extends JsonRecord>(
  existing: Awaited<ReturnType<PrismaClient["apiIdempotencyKey"]["findUnique"]>>,
  requestFingerprint: string,
): IdempotentCommandResult<TResponse> {
  if (!existing || existing.requestFingerprint !== requestFingerprint) {
    return {
      code: "IDEMPOTENCY_CONFLICT",
      kind: "conflict",
      message: idempotencyConflictMessage,
      status: 409,
    };
  }

  if (existing.responseStatus === null || existing.responseBody === null) {
    return {
      code: "IDEMPOTENCY_CONFLICT",
      kind: "conflict",
      message: idempotencyConflictMessage,
      status: 409,
    };
  }

  return {
    body: existing.responseBody as TResponse,
    kind: "success",
    status: existing.responseStatus,
  };
}

export {
  fingerprintIdempotentRequest,
  idempotencyConflictMessage,
  isPrismaWriteConflict,
  runIdempotentCommand,
  type IdempotentCommandConflict,
  type IdempotentCommandResult,
  type IdempotentCommandSuccess,
};
