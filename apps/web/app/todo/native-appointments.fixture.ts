// Run the actual Next routes against a disposable loopback API.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPreviewOwnerIngress } from "../../scripts/preview-process";
import type { ApplicationRow, JobLifecycle } from "../jobs/jobs-client";
import type { AppointmentRequest } from "./native-appointment-client";
import type { LiveTodo } from "./todo-live";
import type { NativeAppointment } from "./native-appointments";

export const fixtureDay = "2026-11-16";
const applicationId = "ee52c955-88d8-4c66-a87f-09a8ae238064";
export const fixtureAppointment: NativeAppointment = {
  source: "native", id: "c6d5c397-809a-48be-ac36-7e9f242c0539", applicationId,
  title: "Native interview · Fixture Studio", start: "2026-11-16T13:30:00.000Z", end: "2026-11-16T14:30:00.000Z",
  beforeMinutes: 15, afterMinutes: 10, fixed: true, allDay: false, category: "Job search", alertMinutes: 10,
  revision: 1, cancelledAt: null,
};
export const fixtureLegacyAppointment: LiveTodo = {
  id: "fixture-issue-42", databaseId: 42, repository: "fixture/tasks", number: 42,
  title: "GitHub interview · Fixture Studio", body: "", state: "open", closureReason: null,
  url: "https://example.test/tasks/issues/42", updatedAt: "2026-11-15T12:00:00Z", labels: [],
  fields: { Category: "Job search", Commitment: "Active" }, fieldValues: [], scheduleError: null,
  start: "2026-11-16T13:45:00.000Z", end: "2026-11-16T14:15:00.000Z", fixed: true, allDay: false,
};

const application: ApplicationRow = {
  id: applicationId, role: "Fixture Editor", company: "Fixture Studio", track: "web", status: "interviewing",
  issue: null, verdict: "strong", dueAt: null, source: "Fixture", sourceUrl: "https://example.test/job",
  updatedAt: "2026-11-15T12:00:00Z", appliedAt: "2026-11-14T12:00:00Z",
};
const lifecycle: JobLifecycle = {
  application, revision: 1, changedAt: "2026-11-15T12:00:00Z", transitions: [], sourceReplyLinked: false, sourceReplyUrl: null,
  appointments: [
    fixtureAppointment,
    { source: "github", id: "a6cad512-3f7d-4a41-b130-13d472426a17", todoNumber: fixtureLegacyAppointment.number,
      start: fixtureLegacyAppointment.start!, end: fixtureLegacyAppointment.end! },
  ],
};
const endpoint = "/api/v1/jobs/interview-appointments";

if (import.meta.main) {
  const port = Number(process.env.PREVIEW_PORT ?? 3862);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Use a disposable loopback preview port.");
  const root = fileURLToPath(new URL("../../../..", import.meta.url));
  let current = fixtureAppointment;
  let hold: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const receipts = new Map<string, { body: string; appointment: NativeAppointment }>();
  const detailPath = `${endpoint}/${fixtureAppointment.id}`;
  const stub = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const { pathname, searchParams } = new URL(request.url);
    if (request.method === "POST" && pathname === "/_fixture/hold") {
      if (hold) return new Response(null, { status: 409 });
      hold = Promise.withResolvers<void>();
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && pathname === "/_fixture/release") {
      hold?.resolve();
      hold = undefined;
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && pathname === "/_fixture/external-change") {
      current = { ...current, revision: current.revision + 1, alertMinutes: 45 };
      return new Response(null, { status: 204 });
    }
    if (request.method === "PATCH" && pathname === detailPath) {
      const key = request.headers.get("Idempotency-Key");
      if (!key) return Response.json({ message: "Missing idempotency key." }, { status: 400 });
      const body = await request.text();
      const receipt = receipts.get(key);
      if (receipt) return receipt.body === body ? Response.json(receipt.appointment) :
        Response.json({ message: "Idempotency key reused." }, { status: 409 });
      const { action, expectedRevision, ...fields } = JSON.parse(body) as AppointmentRequest;
      if (expectedRevision !== current.revision || current.cancelledAt) {
        console.info("fixture request: appointment conflict");
        return Response.json({ message: "Appointment changed." }, { status: 409 });
      }
      const appointment = action === "cancel"
        ? { ...current, cancelledAt: new Date().toISOString(), revision: current.revision + 1 }
        : { ...current, ...fields, revision: current.revision + 1 };
      current = appointment;
      receipts.set(key, { body, appointment });
      console.info(`fixture request: appointment ${action} revision ${appointment.revision}${hold ? " held" : ""}`);
      if (hold) await Promise.race([hold.promise, Bun.sleep(12000)]);
      return Response.json(appointment);
    }
    if (request.method !== "GET") return new Response(null, { status: 405 });
    if (pathname === "/api/v1/access-context") return Response.json({
      owner: { id: "synthetic-owner", name: "Synthetic Owner" },
      client: { id: "quantself-web", kind: "web", name: "Synthetic Web Client" },
      permissions: ["jobs:read", "jobs:write", "todos:read", "todos:write"],
    });
    if (pathname === "/api/v1/todos/live") return new Response(null, { status: 204 });
    if (pathname === "/api/v1/todos") return Response.json({ todos: [fixtureLegacyAppointment], readAt: fixtureLegacyAppointment.updatedAt });
    if (pathname === "/api/v1/todos/42") {
      console.info("fixture request: GitHub issue detail");
      return Response.json({ todo: fixtureLegacyAppointment });
    }
    if (pathname === "/api/v1/todo-categories") return Response.json({ categories: [], revision: "fixture" });
    if (pathname === "/api/v1/jobs/applications") return Response.json({
      rows: [application], total: 1, pageSize: 15, tabCounts: { all: 1, review: 0, progress: 0, attention: 0, applied: 1, closed: 0 },
    });
    if (pathname === `/api/v1/jobs/applications/${applicationId}/lifecycle`) {
      return Response.json({ ...lifecycle, appointments: [current, ...lifecycle.appointments.slice(1)] });
    }
    if (pathname === endpoint) {
      const from = Date.parse(searchParams.get("from") ?? ""), to = Date.parse(searchParams.get("to") ?? "");
      console.info("fixture request: native range");
      if (!(from < to)) return Response.json({ message: "Invalid range." }, { status: 400 });
      const intersects = Date.parse(current.start) - current.beforeMinutes * 60_000 < to &&
        Date.parse(current.end) + current.afterMinutes * 60_000 > from;
      return Response.json({ appointments: intersects && !current.cancelledAt ? [current] : [], nextCursor: null });
    }
    if (pathname === detailPath) {
      console.info("fixture request: native UUID detail");
      await Bun.sleep(450);
      return Response.json(current);
    }
    return Response.json({ message: "Fixture record unavailable." }, { status: 404 });
  } });
  const ownerIngress = createPreviewOwnerIngress(port);
  const web = spawn("bun", ["--no-env-file", "run", "--cwd", "apps/web", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root, env: {
      ...process.env,
      ...ownerIngress.env,
      QUANTSELF_API_INTERNAL_URL: `http://127.0.0.1:${stub.port}`,
    }, detached: true, stdio: "inherit",
  });
  console.info(`fixture PID ${process.pid}, web group ${web.pid}, API port ${stub.port}`);
  console.info(ownerIngress.browserInstructions);
  function signalGroup(signal: NodeJS.Signals | 0) {
    if (!web.pid) return false;
    try {
      return process.kill(-web.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }
  let stopping: Promise<void> | undefined;
  function stop() {
    return stopping ??= (async () => {
      hold?.resolve();
      stub.stop(true);
      signalGroup("SIGTERM");
      const deadline = Date.now() + 2000;
      while (signalGroup(0) && Date.now() < deadline) await Bun.sleep(50);
      signalGroup("SIGKILL");
    })();
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      web.once("error", reject);
      web.once("exit", code => resolve(code ?? (stopping ? 0 : 1)));
    });
  } finally {
    await stop();
  }
}
