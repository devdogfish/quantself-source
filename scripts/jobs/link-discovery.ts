import { z } from "zod";
import { readLocal, type PrivateConfig } from "./config";

const defaultEndpoint = "https://girke.dev/api/links";
const maxResponseBytes = 262_144;
type PublicFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch>;

const choice = z.object({
  key: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2_000),
});
const choices = z.array(choice).max(1_000).refine(rows => new Set(rows.map(row => row.key)).size === rows.length);
const availableLinks = z.object({
  project: choices,
  profile: choices,
  variant: choices,
});
export type AvailableApplicationLinks = z.infer<typeof availableLinks>;

export class LinkDiscoveryUnavailable extends Error {
  constructor() { super("Application link discovery is unavailable."); }
}

export async function discoverApplicationLinks(
  endpoint = defaultEndpoint,
  request: PublicFetch = (input, init) => fetch(input, init),
): Promise<AvailableApplicationLinks> {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/api/links" || url.search || url.hash) {
      throw new LinkDiscoveryUnavailable();
    }
    // Discovery is public. Registration credentials never enter this request.
    const response = await request(url.href, { method: "GET", redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok || !response.body ||
        response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      throw new LinkDiscoveryUnavailable();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxResponseBytes) throw new LinkDiscoveryUnavailable();
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    // Project/profile keys come entirely from the endpoint; select only public metadata.
    return availableLinks.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new LinkDiscoveryUnavailable();
  }
}

export async function discoverConfiguredApplicationLinks() {
  const local = await readLocal<Pick<PrivateConfig, "applicationTracking">>("private.json");
  return discoverApplicationLinks(local.applicationTracking?.url ?? defaultEndpoint);
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await discoverConfiguredApplicationLinks(), null, 2));
  } catch {
    console.error("Application link discovery is unavailable. Check the configured portfolio endpoint.");
    process.exitCode = 1;
  }
}
