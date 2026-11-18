import { createHash, timingSafeEqual } from "node:crypto";
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import type { PrismaClient } from "@quantself/db/generated/prisma/client";
import { dispatchJobsPilotScreen } from "./jobs-pilot-anthropic-transport";
import { JobsError } from "./jobs-error";
import { jobsGreenhouseSourceIdentity } from "./jobs-owner-contract";
import type { JobsPilotPostingTarget } from "./jobs-pilot-permit";
import { registerJobsPilotIntakeRoute } from "./jobs-route";

type ApprovedScreen = Parameters<typeof dispatchJobsPilotScreen>[2];
type ScreenTransport = Parameters<typeof dispatchJobsPilotScreen>[3];
const screenInput = z.strictObject({ sourceIdentity: jobsGreenhouseSourceIdentity });
const intakeReceipt = z.object({ applicationId: z.uuid(), revision: z.literal(0) });
const hash = (value: string) => createHash("sha256").update(value).digest();

async function readScreenBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new JobsError(400, "Supply the permitted posting identity.");
  const buffer = new Uint8Array(512);
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (length + next.value.byteLength > buffer.length) {
        await reader.cancel();
        return null;
      }
      buffer.set(next.value, length);
      length += next.value.byteLength;
    }
    return new TextDecoder().decode(buffer.subarray(0, length));
  } finally { reader.releaseLock(); }
}

// Explicit wiring seam. The default API registers no pilot gateway and supplies no transport or policy.
export function createJobsPilotGateway({ db, target, access, key, approved, transport, onImported }: {
  db: PrismaClient;
  target: JobsPilotPostingTarget;
  access: AccessContext;
  key: string;
  approved: ApprovedScreen;
  transport: ScreenTransport;
  onImported?: (receipt: z.output<typeof intakeReceipt>) => void;
}) {
  if (key.length < 32 || access.owner.id !== target.ownerId || access.client.kind !== "api-key" ||
      !access.permissions.includes("jobs:import-tailored")) throw new Error("Invalid Jobs pilot gateway configuration.");
  const keyHash = hash(key);
  const intake = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  intake.use("*", async (c, next) => { c.set("accessContext", access); await next(); });
  registerJobsPilotIntakeRoute(intake, db);

  return async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path !== "/screen" && path !== "/held-import") return new Response(null, { status: 404 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (!timingSafeEqual(hash(request.headers.get("x-jobs-pilot-key") ?? ""), keyHash) ||
        request.headers.get("x-jobs-pilot-permit") !== target.permitId) {
      return Response.json({ message: "The Jobs pilot gateway requires the configured permit and credential." }, { status: 403 });
    }
    if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) {
      return Response.json({ message: "Send a JSON request." }, { status: 400 });
    }
    try {
      if (path === "/held-import") {
        const internal = new Request(`http://localhost/api/v1/jobs/pilot/permits/${target.permitId}/intake`, {
          method: "POST", body: request.body, headers: {
            "content-type": "application/json", "idempotency-key": request.headers.get("idempotency-key") ?? "",
          },
        });
        const response = await intake.fetch(internal);
        if (!response.ok) return response;
        const receipt = intakeReceipt.parse(await response.json());
        onImported?.(receipt);
        return Response.json({ imported: 1, duplicates: 0, ...receipt });
      }
      // The workflow supplies only the selected identity. The gateway owns the approved request bytes and policy.
      const raw = await readScreenBody(request);
      if (raw === null) return Response.json({ message: "The pilot screen request is too large." }, { status: 413 });
      const input = screenInput.parse(JSON.parse(raw));
      if (input.sourceIdentity !== target.sourceIdentity) throw new JobsError(409, "The posting does not match the configured pilot.");
      const result = await dispatchJobsPilotScreen(db, target, approved, transport);
      if (!result) throw new JobsError(409, "Pilot screening is unavailable or requires reconciliation.");
      return Response.json(result.posting ? { outcome: "keep", application: result.posting } : { outcome: "no_import" });
    } catch (error) {
      if (error instanceof JobsError) return Response.json({ message: error.message }, { status: error.status });
      if (error instanceof SyntaxError || error instanceof z.ZodError) return Response.json({ message: "Invalid Jobs pilot request." }, { status: 400 });
      throw error;
    }
  };
}
