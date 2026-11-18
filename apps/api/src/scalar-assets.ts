import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const scalarEntryURL =
  typeof import.meta.resolve === "function"
    ? import.meta.resolve("@scalar/api-reference")
    : new URL(require.resolve("@scalar/api-reference"), import.meta.url).href;
const scalarBundleURL = new URL("./browser/standalone.js", scalarEntryURL);

export const SCALAR_BUNDLE_PATH =
  "/api/reference-assets/scalar-1.63.0.js";

export function scalarBundleResponse() {
  return new Response(Bun.file(scalarBundleURL), {
    headers: {
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": "text/javascript; charset=utf-8",
    },
  });
}
