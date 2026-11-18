// Isolated frontend preview of /website-analytics with a stub API serving fictional sample reports in the contract
// shape. No database, no Umami. Run: bun run preview:website-analytics → http://127.0.0.1:3132/website-analytics (PREVIEW_PORT overrides)
import { randomBytes } from "node:crypto";
import { trackedShareInput } from "../../api/src/tracked-links-contract";
import { runNextPreview } from "./preview-process";
import { jobSearchReport, websiteReport } from "./website-analytics-preview-data";

const port = Number(process.env.PREVIEW_PORT ?? 3132);
const origin = `http://127.0.0.1:${port}`;

const report = jobSearchReport();
const sharesPath = "/api/v1/website-analytics/shares";
const created = new Map<string, (typeof report.shares)[number]>();
const stub = Bun.serve({
  hostname: "127.0.0.1",
  port: port + 1,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === sharesPath) {
      const key = request.headers.get("idempotency-key");
      const input = trackedShareInput.safeParse(await request.json().catch(() => null));
      if (!key || !input.success) return Response.json({ message: "Invalid share." }, { status: 400 });
      const { title, track = null } = input.data;
      const existing = created.get(key);
      if (existing && (existing.title !== title || existing.track !== track)) return Response.json({ message: "Key already used." }, { status: 409 });
      if (existing) return Response.json(existing, { status: 201 });
      const share = { code: randomBytes(6).toString("hex").slice(0, 8), title, track, archived: false, opens: 0, visits: 0 };
      created.set(key, share);
      report.shares.push(share);
      return Response.json(share, { status: 201 });
    }
    if (request.method === "DELETE" && url.pathname.startsWith(sharesPath + "/")) {
      const share = report.shares.find(row => row.code === url.pathname.slice(sharesPath.length + 1));
      if (share) share.archived = true;
      return new Response(null, { status: 204 });
    }
    if (request.method !== "GET") return Response.json({ message: "Preview: no API writes." }, { status: 405 });
    if (url.pathname === "/api/v1/access-context") return Response.json({
      owner: { id: "preview-owner", name: "Sample Owner" },
      client: { id: "quantself-web", kind: "web", name: "Preview Web Client" },
      permissions: [],
    });
    if (url.pathname === "/api/v1/website-analytics/website") return Response.json(websiteReport(url.searchParams));
    if (url.pathname === "/api/v1/website-analytics/job-search") return Response.json(report);
    return Response.json({ message: "Preview API: no data here." }, { status: 404 });
  },
});

process.exitCode = await runNextPreview({
  kind: "website-analytics",
  port: port,
  server: stub,
  env: { ...process.env, QUANTSELF_API_KEY: undefined, QUANTSELF_API_INTERNAL_URL: `http://127.0.0.1:${stub.port}` },
  message: `\nWebsite analytics preview: ${origin}/website-analytics  (sample data, no database). Ctrl-C stops.\n`,
});
