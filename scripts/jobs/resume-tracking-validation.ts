import { z } from "zod";
import { extractMarkdownLinks } from "./resume-links";

export const portfolioCatalogUrl = "https://girke.dev/api/links";
type CatalogFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch>;
const maxCatalogBytes = 262_144;
const successLifetimeMs = 30_000;
const failureLifetimeMs = 2_000;

export class UntrackedResumeLink extends Error {
  constructor(readonly count: number) { super("resume_link_not_tracked"); }
}

const publicSource = z.url().max(2_048).refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
});
const catalogSchema = z.object({ destinations: z.array(z.object({ sourceUrls: z.array(publicSource).min(1).max(100) })).min(1).max(256) });

async function readPublicCatalog(request: CatalogFetch) {
  const response = await request(portfolioCatalogUrl, { redirect: "error", signal: AbortSignal.timeout(4_000) });
  if (!response.ok || !response.body) throw new Error("resume_tracking_catalog_unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxCatalogBytes) throw new Error("resume_tracking_catalog_unavailable");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const catalog = catalogSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  return new Set(catalog.destinations.flatMap(destination => destination.sourceUrls));
}

export function createResumeTrackingValidator(
  request: CatalogFetch = (input, init) => fetch(input, init),
  now = Date.now,
) {
  let cached: { expires: number; sources?: Set<string> } | undefined;
  let pending: Promise<Set<string>> | undefined;
  async function sources() {
    if (cached && cached.expires > now()) {
      if (cached.sources) return cached.sources;
      throw new Error("resume_tracking_catalog_unavailable");
    }
    if (pending) return pending;
    pending = readPublicCatalog(request).then(value => {
      cached = { expires: now() + successLifetimeMs, sources: value };
      return value;
    }, () => {
      cached = { expires: now() + failureLifetimeMs };
      throw new Error("resume_tracking_catalog_unavailable");
    }).finally(() => { pending = undefined; });
    return pending;
  }
  return async (markdown: string, protectedHeader = "", catalogUrl = portfolioCatalogUrl) => {
    if (catalogUrl !== portfolioCatalogUrl) throw new Error("resume_tracking_catalog_unavailable");
    const allowed = await sources();
    const anchors = extractMarkdownLinks(protectedHeader + "\n" + markdown);
    const unsupported = new Set<string>();
    for (const { url: value } of anchors) {
      if (/^(?:mailto|tel):/i.test(value) || value.startsWith("#")) continue;
      let url: URL;
      try { url = new URL(value); } catch { unsupported.add(value); continue; }
      if (url.protocol !== "https:" || url.username || url.password || !allowed.has(value)) unsupported.add(value);
    }
    if (unsupported.size) throw new UntrackedResumeLink(unsupported.size);
  };
}

export const validateResumeTrackingLinks = createResumeTrackingValidator();
