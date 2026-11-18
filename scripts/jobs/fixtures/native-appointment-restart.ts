import { OWNER_INGRESS_HEADER } from "../../../packages/auth/src/owner-ingress";
import { scheduleJobInterviewOutput } from "../../../apps/api/src/jobs-lifecycle-contract";

async function postInFreshJobsApi(database: string, path: string, options: {
  headers: Record<string, string>;
  body?: string;
  ownerProof?: string;
  dropResponse?: boolean;
}) {
  const url = new URL(database);
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || !url.port ||
      !["/native_interview_fixture", "/jobs_worker_integration"].includes(url.pathname)) {
    throw new Error("Use a disposable Jobs fixture database.");
  }
  const ready = Promise.withResolvers<string>();
  const apiStarted = performance.now();
  const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", `
    import { createApp } from "./apps/api/src/app.ts";
    const api = createApp({ emitAccessLog() {} });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const response = await api.fetch(request);
      if (process.env.QUANTSELF_FIXTURE_DROP_RESPONSE !== "1" || !response.ok) return response;
      await response.arrayBuffer();
      return Response.json({ message: "Fixture lost the committed response." }, { status: 503 });
    } });
    process.send(server.url.origin);
  `], {
    env: {
      DATABASE_URL: database,
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
      QUANTSELF_NATIVE_JOB_INTERVIEWS: "1",
      ...(options.ownerProof && {
        QUANTSELF_OWNER_INGRESS_TOKEN: options.ownerProof, QUANTSELF_PUBLIC_ORIGIN: options.headers.origin,
      }),
      ...(options.dropResponse && { QUANTSELF_FIXTURE_DROP_RESPONSE: "1" }),
    },
    ipc(message) {
      if (typeof message === "string") ready.resolve(message);
    },
    stdout: "ignore", stderr: "inherit",
  });
  const timeout = setTimeout(() => ready.reject(new Error("Fixture API did not start.")), 10_000);
  void child.exited.then(code => ready.reject(new Error("Fixture API exited before readiness: " + code)));
  try {
    const apiUrl = await ready.promise;
    const requestStarted = performance.now();
    const response = await fetch(apiUrl + path, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: options.headers, body: options.body,
    });
    const result: unknown = await response.json();
    return { pid: child.pid, result, status: response.status, startupMs: Math.round(requestStarted - apiStarted),
      requestMs: Math.round(performance.now() - requestStarted) };
  } finally {
    clearTimeout(timeout);
    child.kill("SIGKILL");
    await child.exited;
  }
}

export async function scheduleInFreshJobsApi(database: string, secret: string, appointmentKey: string, applicationId: string,
  input: { start: string; end: string; expectedRevision: number }) {
  const attempt = await postInFreshJobsApi(database, `/api/v1/jobs/applications/${applicationId}/interviews/native`, {
    headers: { "x-api-key": secret, "idempotency-key": appointmentKey, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (attempt.status !== 200) throw new Error(`Native Appointment fixture returned HTTP ${attempt.status}: ${JSON.stringify(attempt.result)}`);
  return { ...attempt, result: scheduleJobInterviewOutput.parse(attempt.result) };
}

export function undoInFreshJobsApi(database: string, auditId: string, origin: string, ownerProof: string, dropResponse = false) {
  return postInFreshJobsApi(database, `/api/v1/agent-audit/${auditId}/undo`, {
    headers: { origin, [OWNER_INGRESS_HEADER]: ownerProof }, ownerProof, dropResponse,
  });
}
