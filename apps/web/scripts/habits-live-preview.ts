// Local preview transport. Credentials stay in this process; production owns authorization.
const productionOrigin = "https://dashboard.girke.dev";
const readablePaths = new Set([
  "/api/v1/habits/overview",
  "/api/v1/habits/summary",
  "/api/v1/habits/asks",
  "/api/v1/habits/definitions/history",
  "/api/v1/habits/definitions",
  "/api/v1/habits/system",
  "/api/v1/habits/day",
  "/api/v1/habits/calendar",
  "/api/v1/habits/document",
  "/api/v1/habits/reviews",
  "/api/v1/habits/context",
  "/api/v1/habits/slips",
]);
type Transport = (url: string, init: RequestInit) => Promise<Response>;

export type HabitPreviewSnapshot = {
  capturedAt: string;
  responses: Record<string, unknown>;
};

export function createHabitSnapshotPreview(snapshot: HabitPreviewSnapshot, previewOrigin: string) {
  if (!Number.isFinite(Date.parse(snapshot.capturedAt)) || !snapshot.responses?.["/api/v1/habits/overview?weeks=13"])
    throw Error("A dated production habit overview is required for a snapshot preview.");
  return (request: Request): Response => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || (origin && origin !== previewOrigin) || request.headers.get("sec-fetch-site") === "cross-site")
      return Response.json({ message: "This preview is available only on this computer." }, { status: 403 });
    if (request.method !== "GET") return Response.json({ message: "This is a read-only snapshot. No changes were sent." }, { status: 405 });
    if (url.pathname === "/api/v1/habits/reviews" && url.searchParams.get("offset") === "0") url.searchParams.delete("offset");
    const key = `${url.pathname}${url.search}`;
    if (Object.hasOwn(snapshot.responses, key)) return Response.json(snapshot.responses[key], { headers: { "Cache-Control": "no-store" } });
    return Response.json({ message: "This view is not included in the read-only snapshot. Open Quantself for current records." }, { status: 404 });
  };
}

const writablePaths = new Set(["/api/v1/habits/ask", "/api/v1/habits/commands", "/api/v1/habits/review"]);
const setupPath = "/api/v1/habits/preview-setup";
const setupPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Connect habits preview</title></head><body><main><h1>Connect habits preview</h1><p>Enter a production API key with habits read and write permissions. It stays in this preview process until it stops.</p><form id="setup"><label>API key <input name="key" type="password" autocomplete="off" required></label><button>Connect</button></form><p id="message" role="status"></p></main><script>document.querySelector('#setup').addEventListener('submit', async (event) => { event.preventDefault(); const input = event.currentTarget.elements.key; const message = document.querySelector('#message'); message.textContent = 'Checking access…'; try { const response = await fetch(location.pathname, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:input.value})}); input.value = ''; if (response.ok) location.replace('/habits'); else message.textContent = (await response.json()).message; } catch { input.value = ''; message.textContent = 'Could not connect. Try again.'; } });</script></body></html>`;

export async function createLiveHabitPreview({
  apiKey,
  previewOrigin,
  writable = false,
  transport = fetch,
}: {
  apiKey: string | undefined;
  previewOrigin: string;
  writable?: boolean;
  transport?: Transport;
}) {
  type Context = { owner: { id: string; name?: string }; permissions: string[] };
  let credential: string | undefined;
  let context: Context | undefined;
  let setupPending = false;
  const previewPort = new URL(previewOrigin).port;
  // Next normalizes 127.0.0.1 to localhost for the web shell's own auth fetch.
  const localHosts = new Set([`127.0.0.1:${previewPort}`, `localhost:${previewPort}`]);
  const validate = async (candidate: string) => {
    const auth = await transport(`${productionOrigin}/api/v1/access-context`, {
      method: "GET", headers: { "X-API-Key": candidate, Accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    if (!auth.ok) throw Error(`Production authentication failed (${auth.status}). Check the configured Quantself API key.`);
    const value = await auth.json() as { owner?: { id?: string; name?: string }; permissions?: string[] };
    if (!value.owner?.id || !Array.isArray(value.permissions)) throw Error("Production returned an invalid access context.");
    if (writable && (!value.permissions.includes("habits:read") || !value.permissions.includes("habits:write")))
      throw Error("Production key requires habits:read and habits:write permissions.");
    credential = candidate;
    context = { owner: { ...value.owner, id: value.owner.id }, permissions: value.permissions.filter((permission) => permission === "habits:read" || (writable && permission === "habits:write")) };
  };
  if (apiKey) {
    try { await validate(apiKey); } catch (error) { if (!writable) throw error; }
  } else if (!writable) throw Error("Configure QUANTSELF_API_KEY before starting the live habits preview.");

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    // Next's external rewrite sets this header from the original Host, replacing
    // any incoming value. Validate it before using the loopback proxy URL.
    const forwardedHost = request.headers.get("x-forwarded-host");
    if (!["127.0.0.1", "localhost"].includes(url.hostname)
      || (forwardedHost !== null && !localHosts.has(forwardedHost))
      || (origin && origin !== previewOrigin)
      || request.headers.get("sec-fetch-site") === "cross-site") {
      return Response.json({ message: "This preview is available only on this computer." }, { status: 403 });
    }
    if (writable && request.method === "POST" && (origin !== previewOrigin || !/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")))
      return Response.json({ message: "An exact preview origin and JSON content type are required." }, { status: 403 });
    if (writable && url.pathname === setupPath) {
      if (request.method === "GET" && !credential) return new Response(setupPage, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" } });
      if (request.method === "POST" && !credential && !setupPending) {
        setupPending = true;
        try {
          const body = await request.json() as { apiKey?: unknown };
          if (typeof body.apiKey !== "string" || !body.apiKey.trim() || body.apiKey.length > 4096) return Response.json({ message: "Enter a valid API key." }, { status: 400 });
          await validate(body.apiKey.trim());
          return Response.json({ connected: true }, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          return Response.json({ message: error instanceof Error && error.message.startsWith("Production ") ? error.message : "Could not verify production access." }, { status: 400 });
        } finally {
          setupPending = false;
        }
      }
      return Response.json({ message: "Setup is closed." }, { status: 403 });
    }
    if (request.method !== "GET" && !(writable && request.method === "POST" && !url.search && writablePaths.has(url.pathname)))
      return Response.json({ message: writable ? "This operation is unavailable in the preview." : "Production preview is read-only. No changes were sent." }, { status: 405 });
    if (!credential || !context) return Response.json({ message: "Connect the live habits preview at /api/v1/habits/preview-setup." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    if (url.pathname === "/api/v1/access-context" && request.method === "GET") {
      return Response.json({ owner: context.owner, client: { id: "quantself-web", kind: "web", name: writable ? "Local habits preview" : "Read-only local habits preview" }, permissions: context.permissions }, { headers: { "Cache-Control": "no-store" } });
    }
    if (request.method === "GET" && !readablePaths.has(url.pathname)) return Response.json({ message: "Only habit reads are available in this preview." }, { status: 404 });
    try {
      const response = await transport(`${productionOrigin}${url.pathname}${url.search}`, {
        method: request.method,
        headers: { "X-API-Key": credential, Accept: "application/json", ...(request.method === "POST" ? { "Content-Type": "application/json", ...(url.pathname === "/api/v1/habits/ask" && request.headers.has("idempotency-key") ? { "Idempotency-Key": request.headers.get("idempotency-key")! } : {}) } : {}) },
        ...(request.method === "POST" ? { body: await request.text() } : {}),
        redirect: "error", signal: AbortSignal.timeout(url.pathname === "/api/v1/habits/ask" ? 25_000 : 20_000),
      });
      return new Response(response.body, {
        status: response.status,
        headers: { "Content-Type": response.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" },
      });
    } catch {
      return Response.json({ message: "Production habits unavailable. Retry when the connection recovers." }, { status: 502 });
    }
  };
}
