import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config, proxy } from "./proxy";

describe("dashboard proxy", () => {
  test("PDF library assets bypass Owner checks while Jobs remains protected", () => {
    for (const resource of ["pdf.worker.min.mjs", "cmaps/Adobe-Japan1-UCS2.bcmap", "standard_fonts/FoxitSerif.pfb", "wasm/openjpeg.wasm", "iccs/CGATS001Compat-v2-micro.icc"]) {
      expect(unstable_doesMiddlewareMatch({ config, url: `/pdfjs/6.3.289/${resource}` })).toBe(false);
    }
    for (const url of ["/jobs", "/jobs/context", "/jobs/private", "/pdfjs-private/data", "/inventory/container-visual-catalog-private/data"]) {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
    }
  });

  test("the optimizer and its static image inputs bypass dashboard auth", () => {
    for (const url of ["/_next/image", "/inventory/container-visual-catalog/6l/back.webp", "/_next/static/media/back.webp"]) {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
    }
  });
});

test("trusted dashboard requests forward proof once and fail closed without it", async () => {
  const previousProof = process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
  const oldFetch = globalThis.fetch;
  const proof = "a1".repeat(32);
  const trusted = { "x-quantself-owner-proof": proof };
  const urls: string[] = [];
  let apiStatus = 200;
  process.env.QUANTSELF_OWNER_INGRESS_TOKEN = proof;
  globalThis.fetch = (async (input, init) => {
    urls.push(String(input));
    const forwarded = new Headers(init?.headers);
    expect(forwarded.get("x-quantself-owner-proof")).toBe(proof);
    expect(forwarded.has("tailscale-user-login")).toBe(false);
    expect(forwarded.has("cookie")).toBe(false);
    expect(init?.redirect).toBe("error");
    return Response.json({ owner: { id: "existing-owner" }, client: { id: "quantself-web", kind: "web" } }, { status: apiStatus });
  }) as typeof fetch;

  const request = (path: string, headers: Record<string, string>, method = "GET") =>
    proxy(new NextRequest(`https://qs.girke.dev${path}`, { headers, method }));
  try {
    const deniedHeaders: Record<string, string>[] = [
      { "tailscale-user-login": "owner@example.com", "x-forwarded-for": "100.64.1.2", cookie: "better-auth.session_token=old" },
      { "x-quantself-owner-proof": "b2".repeat(32) },
      { "x-quantself-owner-proof": `${proof}, ${proof}` },
      { ...trusted, origin: "https://foreign.example" },
      { ...trusted, "x-api-key": "explicit-key" },
    ];
    for (const headers of deniedHeaders) {
      expect((await request("/inventory", headers)).status).toBe(403);
    }
    expect((await request("/settings", trusted, "POST")).status).toBe(403);
    expect(urls).toHaveLength(0);
    const ok = await request("/inventory", { ...trusted, "tailscale-user-login": "spoofed", cookie: "better-auth.session_token=old" });
    expect(ok.headers.get("x-middleware-next")).toBe("1");
    expect(urls).toEqual([expect.stringMatching(/\/api\/v1\/access-context$/)]);
    expect((await request("/settings", { ...trusted, origin: "https://qs.girke.dev" }, "POST")).headers.get("x-middleware-next")).toBe("1");
    apiStatus = 401;
    expect((await request("/settings", trusted)).status).toBe(403);
    delete process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
    expect((await request("/settings", trusted)).status).toBe(403);
  } finally {
    globalThis.fetch = oldFetch;
    if (previousProof === undefined) delete process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
    else process.env.QUANTSELF_OWNER_INGRESS_TOKEN = previousProof;
  }
});
