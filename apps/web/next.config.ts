import type { NextConfig } from "next";
import { nextDevCacheConfig } from "./preview-cache";

const devCache = nextDevCacheConfig(process.env);

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: process.env.QUANTSELF_SKIP_NEXT_TYPECHECK === "1" },
  distDir: devCache.distDir,
  allowedDevOrigins: ["127.0.0.1"],
  // Next's optimizer cache is shared and its internal fetch has no Owner proof.
  images: {
    localPatterns: [
      { pathname: "/inventory/container-visual-catalog/**", search: "" },
      { pathname: "/_next/static/media/**", search: "" },
    ],
  },
  async rewrites() {
    const apiOrigin = (
      process.env.QUANTSELF_API_INTERNAL_URL ?? "http://api:3001"
    ).replace(/\/$/, "");

    const apiRewrites = [
      "/api/health",
      "/api/openapi.json",
      "/api/reference",
      "/api/reference.md",
      "/api/reference-assets/:path*",
      "/api/v1/:path*",
      "/api/owner/jobs/applications/:id/original-reply",
      "/api/owner/jobs/applications/:id/original-reply/confirmation",
      "/api/owner/jobs/applications/:id/replies/confirmation",
      "/api/owner/jobs/applications/:id/replies",
      "/api/owner/jobs/applications/:id/replies/:replyId/original",
      "/api/todo-webhooks/:path*",
    ].map((source) => ({
      source,
      destination: `${apiOrigin}${source}`,
    }));

    return [
      ...apiRewrites,
      {
        source: "/llms.txt",
        destination: `${apiOrigin}/llms.txt`,
      },
    ];
  },
  experimental: {
    turbopackFileSystemCacheForDev: devCache.turbopackFileSystemCacheForDev,
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
  typedRoutes: true,
};

export default nextConfig;
