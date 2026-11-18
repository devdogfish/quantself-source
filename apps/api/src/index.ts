import { startOriginalFilesWorker } from "./original-files-worker";
import { startWebsiteVisitorRetention } from "./website-visitor-retention";
import { startHabitWorker } from "./habits-service";
import { createNotificationWorker } from "./notifications";
import { createNativeAppointmentReminderReader } from "./notifications-appointment-reader";
import { startPrivateDocumentWorker } from "./private-document-worker";
import { productionMeetingEmail } from "./meetings-runtime";
import { app, productionTodoFreshness, productionPhoneRuntime, productionShutdown } from "./app";

import { prisma } from "@quantself/db";
import { createShutdown } from "./shutdown";
import { createTaskDrain } from "./task-drain";

const mode = process.env.QUANTSELF_API_MODE ?? "combined";
if (mode !== "combined" && mode !== "serve" && mode !== "workers") {
  throw new Error("Invalid QUANTSELF_API_MODE");
}

const requests = createTaskDrain();
const server = Bun.serve({
  hostname: mode === "workers" ? "127.0.0.1" : (process.env.API_HOSTNAME ?? "0.0.0.0"),
  port: Number.parseInt(process.env.API_PORT ?? "3001", 10),
  idleTimeout: 120,
  fetch: async (request) => productionShutdown.signal.aborted
    ? new Response("Service stopping", { status: 503, headers: { "Retry-After": "60" } })
    : mode === "workers" ? new Response("Not found", { status: 404 })
    : (await requests.run(async () => app.fetch(request))) ?? new Response("Service stopping", { status: 503 }),
});

const stopWorkers: Array<() => Promise<unknown> | void> = [() => productionMeetingEmail?.stop()];
if (mode !== "serve") {
  productionTodoFreshness.start();
  stopWorkers.push(
    startHabitWorker(),
    createNotificationWorker(productionTodoFreshness.reader, {
      appointments: createNativeAppointmentReminderReader(prisma),
    }).start(),
    startPrivateDocumentWorker(),
    startOriginalFilesWorker(),
    startWebsiteVisitorRetention(),
    () => productionPhoneRuntime?.stop(),
  );
  productionMeetingEmail?.start();
  productionPhoneRuntime?.start();
}
const shutdown = createShutdown({
  controller: productionShutdown,
  stopServer: () => server.stop(false),
  stopWorkers: [...stopWorkers, () => requests.stop()],
  stopFreshness: () => productionTodoFreshness.stop(),
  disconnect: () => prisma.$disconnect(),
});
const stop = () => { void shutdown().then(
  () => { console.info("API drain complete"); process.exit(0); },
  () => { console.error("API drain failed; backup must not proceed"); process.exit(1); },
); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
