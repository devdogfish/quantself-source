import { describe, expect, test } from "bun:test";

import nextConfig from "./next.config";

describe("Next config", () => {
  test("allows local browser testing and multi-photo inventory captures", () => {
    expect(nextConfig.allowedDevOrigins).toContain("127.0.0.1");
    expect(nextConfig.experimental?.serverActions).toMatchObject({
      bodySizeLimit: "50mb",
    });
  });

  test("proxies discovery and Owner Jobs paths to the local API process", async () => {
    const previousOrigin = process.env.QUANTSELF_API_INTERNAL_URL;
    process.env.QUANTSELF_API_INTERNAL_URL = "http://api.internal:3001/";

    try {
      const rewrites = await nextConfig.rewrites?.();
      if (!Array.isArray(rewrites)) {
        throw new Error("Expected array-form Next.js rewrites");
      }

      expect(rewrites).toEqual([
        {
          source: "/api/health",
          destination: "http://api.internal:3001/api/health",
        },
        {
          source: "/api/openapi.json",
          destination: "http://api.internal:3001/api/openapi.json",
        },
        {
          source: "/api/reference",
          destination: "http://api.internal:3001/api/reference",
        },
        {
          source: "/api/reference.md",
          destination: "http://api.internal:3001/api/reference.md",
        },
        {
          source: "/api/reference-assets/:path*",
          destination:
            "http://api.internal:3001/api/reference-assets/:path*",
        },
        {
          source: "/api/v1/:path*",
          destination: "http://api.internal:3001/api/v1/:path*",
        },
        {
          source: "/api/owner/jobs/applications/:id/original-reply",
          destination: "http://api.internal:3001/api/owner/jobs/applications/:id/original-reply",
        },
        {
          source: "/api/owner/jobs/applications/:id/original-reply/confirmation",
          destination: "http://api.internal:3001/api/owner/jobs/applications/:id/original-reply/confirmation",
        },
        {
          source: "/api/owner/jobs/applications/:id/replies/confirmation",
          destination: "http://api.internal:3001/api/owner/jobs/applications/:id/replies/confirmation",
        },
        {
          source: "/api/owner/jobs/applications/:id/replies",
          destination: "http://api.internal:3001/api/owner/jobs/applications/:id/replies",
        },
        {
          source: "/api/owner/jobs/applications/:id/replies/:replyId/original",
          destination: "http://api.internal:3001/api/owner/jobs/applications/:id/replies/:replyId/original",
        },
        {
          source: "/api/todo-webhooks/:path*",
          destination: "http://api.internal:3001/api/todo-webhooks/:path*",
        },
        {
          source: "/llms.txt",
          destination: "http://api.internal:3001/llms.txt",
        },
      ]);
      expect(
        rewrites.some(
          (rewrite) => rewrite.source === "/api/inventory/:path*",
        ),
      ).toBe(false);
    } finally {
      if (previousOrigin === undefined) {
        delete process.env.QUANTSELF_API_INTERNAL_URL;
      } else {
        process.env.QUANTSELF_API_INTERNAL_URL = previousOrigin;
      }
    }
  });
});
