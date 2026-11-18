// Isolated Jobs preview: the web app against an in-memory stub of the Jobs API contract (app/jobs/jobs-client.ts).
// Sample data only; no database. In development the Owner's local résumé Markdown and rendered PDFs are read, never copied.
import { runNextPreview } from "./preview-process";
import type { ApplicationsQuery, Decision, Resolution } from "../app/jobs/jobs-client";
import * as fixtures from "./jobs-preview-fixtures";

const previewPort = 3130;

const query = (url: URL): ApplicationsQuery => ({
  tab: (url.searchParams.get("tab") ?? undefined) as ApplicationsQuery["tab"],
  q: url.searchParams.get("q") ?? undefined,
  track: (url.searchParams.get("track") ?? "") as ApplicationsQuery["track"],
  status: (url.searchParams.get("status") ?? "") as ApplicationsQuery["status"],
  due: (url.searchParams.get("due") ?? "") as ApplicationsQuery["due"],
  verdict: (url.searchParams.get("verdict") ?? "") as ApplicationsQuery["verdict"],
  sort: (url.searchParams.get("sort") ?? undefined) as ApplicationsQuery["sort"],
  page: Number(url.searchParams.get("page") ?? 1),
  pageSize: url.searchParams.get("pageSize") ? Number(url.searchParams.get("pageSize")) : undefined,
});
const notFound = () => Response.json({ message: "Not found" }, { status: 404 });
const conflict = () => Response.json({ message: "This application changed. Reload to see the latest version." }, { status: 409 });

const stub = Bun.serve({
  hostname: "127.0.0.1",
  port: 3131,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    if (path === "/api/v1/access-context") return Response.json({
      owner: { id: "preview-owner", name: "Sample Owner" },
      client: { id: "quantself-web", kind: "web", name: "Preview Web Client" },
      permissions: [],
    });
    if (path === "/api/v1/jobs/candidate-context") {
      if (method === "GET") return Response.json(fixtures.candidateContext());
      const saved = fixtures.saveCandidateContext(await request.json() as { markdown: string; expectedVersion: number });
      return saved ? Response.json(saved) : Response.json({ message: "Changed elsewhere", ...fixtures.candidateContext() }, { status: 409 });
    }
    if (path === "/api/v1/jobs/private-fields/values" && method === "POST") {
      const body = await request.json() as { applicationId?: string };
      return Response.json(fixtures.privateValues(body.applicationId));
    }
    if (path === "/api/v1/jobs/private-fields" && method === "GET") return Response.json(fixtures.privateMetadata(url.searchParams.get("applicationId") ?? undefined));
    if (path === "/api/v1/jobs/private-fields" && method === "PATCH") {
      const saved = fixtures.savePrivateFields(await request.json() as never);
      return saved ? Response.json(saved) : Response.json({ message: "Changed elsewhere" }, { status: 409 });
    }
    if (method === "GET" && path === "/api/v1/jobs/overview") return Response.json(fixtures.overview());
    if (method === "GET" && path === "/api/v1/jobs/applications") return Response.json(fixtures.applications(query(url)));
    if (method === "GET" && path === "/api/v1/jobs/applications/reviewable") return Response.json(fixtures.reviewableIds(query(url)));
    if (method === "GET" && path === "/api/v1/jobs/review-session") {
      return Response.json(await fixtures.reviewSession((url.searchParams.get("ids") ?? "").split(",").filter(Boolean)));
    }
    if (method === "GET" && path === "/api/v1/jobs/submissions") return Response.json(fixtures.submissions());
    if (method === "PATCH" && path === "/api/v1/jobs/runner") {
      const body = await request.json() as { paused: boolean };
      return Response.json(fixtures.setPaused(body.paused));
    }
    const pdf = path.match(/^\/api\/v1\/jobs\/applications\/([^/]+)\/resume\.pdf$/);
    if (method === "GET" && pdf) {
      const bytes = await fixtures.localPdf(url.searchParams.get("track"));
      return bytes ? new Response(new Uint8Array(bytes), { headers: { "content-type": "application/pdf" } }) : notFound();
    }
    const lifecycle = path.match(/^\/api\/v1\/jobs\/applications\/([^/]+)\/lifecycle$/);
    if (method === "GET" && lifecycle) {
      const item = fixtures.applicationLifecycle(lifecycle[1]);
      return item ? Response.json(item) : notFound();
    }
    const application = path.match(/^\/api\/v1\/jobs\/applications\/([^/]+)$/);
    if (method === "GET" && application && application[1] !== "reviewable") {
      const item = (await fixtures.reviewSession([application[1]])).items[0];
      return item ? Response.json({ application: { ...item, privatePauseFieldKeys: fixtures.pausedFieldKeys(item.id) } }) : notFound();
    }
    if (method === "PATCH" && application) {
      const result = await fixtures.saveResume(application[1], await request.json() as never);
      return result === "conflict" ? conflict() : result ? Response.json({ application: result }) : notFound();
    }
    const decision = path.match(/^\/api\/v1\/jobs\/applications\/([^/]+)\/decision$/);
    if (method === "POST" && decision) {
      await Bun.sleep(400); // Show optimistic UI against a slow response.
      const result = fixtures.decide(decision[1], await request.json() as { expectedRevision: number } & Decision);
      return result === "conflict" ? conflict() : result ? Response.json({ application: result }) : notFound();
    }
    const resolution = path.match(/^\/api\/v1\/jobs\/submissions\/([^/]+)\/resolve$/);
    if (method === "POST" && resolution) {
      const result = fixtures.resolve(resolution[1], await request.json() as Resolution);
      return result ? Response.json(result) : notFound();
    }
    return new Response("Preview API: no real data", { status: 404 });
  },
});
process.exitCode = await runNextPreview({
  kind: "jobs",
  port: previewPort,
  server: stub,
  env: { ...process.env, QUANTSELF_API_INTERNAL_URL: `http://127.0.0.1:${stub.port}` },
  message: `\nJobs preview: http://127.0.0.1:${previewPort}/jobs/overview\nSample data only. No database. Ctrl-C stops the preview.\n`,
});
