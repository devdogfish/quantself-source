import { Hono } from "hono";
import { createTaskDrain } from "./task-drain";
import { websiteAnalyticsIngestion } from "./website-analytics-route";

const app = new Hono();
app.route("/api/v1/website-analytics", websiteAnalyticsIngestion());

const requests = createTaskDrain();
const server = Bun.serve({
  hostname: process.env.API_HOSTNAME ?? "127.0.0.1",
  port: Number(process.env.API_PORT ?? "4311"),
  fetch: async (request) => (await requests.run(() => Promise.resolve(app.fetch(request))))
    ?? new Response("Service stopping", { status: 503 }),
});

console.info(`Analytics relay listening on ${server.url.origin}`);

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => {
    console.error("Analytics relay drain timed out");
    process.exit(1);
  }, 120_000);
  void Promise.all([requests.stop(), server.stop(false)]).then(() => {
    clearTimeout(timeout);
    console.info("Analytics relay drain complete");
    process.exit(0);
  }, () => {
    console.error("Analytics relay drain failed");
    process.exit(1);
  });
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
