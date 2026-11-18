import {
  claimInventoryEnrichmentJobs,
  submitInventoryEnrichmentFailure,
  submitInventoryEnrichmentSuccess,
  type InventoryEnrichmentRepository,
} from "./inventory-enrichment-service";

type EnrichmentClaimRequestBody = {
  leaseSeconds?: unknown;
  limit?: unknown;
  workerId?: unknown;
};

type EnrichmentSuccessRequestBody = {
  leaseClaimedAt?: unknown;
  result?: unknown;
  resultId?: unknown;
};

type EnrichmentFailureRequestBody = {
  leaseClaimedAt?: unknown;
  message?: unknown;
  retryable?: unknown;
};

type AuthenticatedJsonBody<T> =
  | { ok: true; value: T }
  | { ok: false; response: Response };

export async function handleInventoryEnrichmentClaim(
  request: Request,
  repository: InventoryEnrichmentRepository,
  secret = process.env.INVENTORY_ENRICHMENT_WORKER_SECRET,
): Promise<Response> {
  const body = await readAuthenticatedJsonBody<EnrichmentClaimRequestBody>(
    request,
    secret,
  );

  if (!body.ok) {
    return body.response;
  }

  const jobs = await claimInventoryEnrichmentJobs(repository, {
    leaseSeconds: numberInput(body.value.leaseSeconds, 300),
    limit: numberInput(body.value.limit, 10),
    workerId: stringInput(body.value.workerId),
  });

  return Response.json({ jobs });
}

export async function handleInventoryEnrichmentSuccess(
  request: Request,
  repository: InventoryEnrichmentRepository,
  jobId: string,
  secret = process.env.INVENTORY_ENRICHMENT_WORKER_SECRET,
): Promise<Response> {
  const body = await readAuthenticatedJsonBody<EnrichmentSuccessRequestBody>(
    request,
    secret,
  );

  if (!body.ok) {
    return body.response;
  }

  try {
    const job = await submitInventoryEnrichmentSuccess(repository, {
      jobId,
      leaseClaimedAt: dateInput(body.value.leaseClaimedAt),
      result: body.value.result,
      resultId: stringInput(body.value.resultId),
    });

    return Response.json({ job });
  } catch (error) {
    return jsonError(errorMessage(error), enrichmentMutationErrorStatus(error));
  }
}

export async function handleInventoryEnrichmentFailure(
  request: Request,
  repository: InventoryEnrichmentRepository,
  jobId: string,
  secret = process.env.INVENTORY_ENRICHMENT_WORKER_SECRET,
): Promise<Response> {
  const body = await readAuthenticatedJsonBody<EnrichmentFailureRequestBody>(
    request,
    secret,
  );

  if (!body.ok) {
    return body.response;
  }

  try {
    const job = await submitInventoryEnrichmentFailure(repository, {
      jobId,
      leaseClaimedAt: dateInput(body.value.leaseClaimedAt),
      message: body.value.message,
      retryable: body.value.retryable,
    });

    return Response.json({ job });
  } catch (error) {
    return jsonError(errorMessage(error), enrichmentMutationErrorStatus(error));
  }
}

export function authenticateInventoryEnrichmentRequest(
  request: Request,
  secret = process.env.INVENTORY_ENRICHMENT_WORKER_SECRET,
): Response | null {
  if (!secret) {
    return jsonError("Inventory enrichment worker secret is not configured.", 503);
  }

  const authorization = request.headers.get("authorization");
  const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  const headerToken = request.headers.get("x-inventory-enrichment-secret");
  const token = bearerToken ?? headerToken;

  if (!token || !constantTimeEqual(token, secret)) {
    return jsonError("Unauthorized inventory enrichment worker request.", 401);
  }

  return null;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

async function readAuthenticatedJsonBody<T>(
  request: Request,
  secret: string | undefined,
): Promise<AuthenticatedJsonBody<T>> {
  const authResponse = authenticateInventoryEnrichmentRequest(request, secret);

  if (authResponse) {
    return { ok: false, response: authResponse };
  }

  const body = await readJsonBody<T>(request);

  if (!body.ok) {
    return { ok: false, response: jsonError(body.message, 400) };
  }

  return { ok: true, value: body.value };
}

async function readJsonBody<T>(
  request: Request,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: (await request.json()) as T };
  } catch {
    return { ok: false, message: "Request body must be JSON." };
  }
}

function numberInput(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringInput(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function dateInput(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Inventory enrichment worker request failed.";
}

function enrichmentMutationErrorStatus(error: unknown): number {
  if (
    error instanceof Error &&
    (error.message.includes("stale") ||
      error.message.includes("does not have an active lease") ||
      error.message.includes("lease is no longer active"))
  ) {
    return 409;
  }

  return 400;
}

function constantTimeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let index = 0; index < maxLength; index++) {
    diff |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return diff === 0;
}
