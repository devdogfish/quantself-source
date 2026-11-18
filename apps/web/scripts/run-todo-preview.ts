// Isolated frontend preview. The stub has no database or mutation endpoints.
import { runNextPreview } from "./preview-process";

const previewPort = 3110;
const stub = Bun.serve({
  hostname: "127.0.0.1",
  port: 3111,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") return new Response("Preview: no API writes", { status: 405 });
    if (path === "/mobile") {
      const query = new URL(request.url).searchParams;
      const requestedView = query.get("view");
      const view = requestedView === "week" || requestedView === "month" || requestedView === "year" || requestedView === "list" ? requestedView : "calendar";
      const requestedDate = query.get("date");
      const date = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : "2026-10-25";
      return new Response(`<!doctype html><html><head><title>Quantself · mobile preview</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f5f5f5;display:grid;justify-content:center;padding:18px;font:12px system-ui"><p style="text-align:center;margin:0 0 12px">390 px mobile preview · sample data</p><iframe title="Quantself mobile preview" style="width:390px;height:844px;border:1px solid #ddd;border-radius:12px;background:white" src="http://127.0.0.1:${previewPort}/todo?view=${view}&date=${date}"></iframe></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (path === "/api/v1/access-context") return Response.json({
      owner: { id: "preview-owner", name: "Sample Owner" },
      client: { id: "quantself-web", kind: "web", name: "Preview Web Client" },
      permissions: [],
    });
    return new Response("Preview API: no real data", { status: 404 });
  },
});
process.exitCode = await runNextPreview({
  kind: "todo",
  port: previewPort,
  server: stub,
  env: { ...process.env, QUANTSELF_API_INTERNAL_URL: `http://127.0.0.1:${stub.port}` },
  message: `\nTo-Do frontend preview: http://127.0.0.1:${previewPort}/calendar?view=calendar&date=2026-10-25\nSample data only. No database. Ctrl-C stops the preview.\n`,
});
