import { join } from 'node:path';
import { indexWwrPostings, wwrPostingDescription } from '../../automation/n8n/jobs-feed/sources/sources.mjs';
import { jobsHome } from './config';
import { readPrivatePostingFile } from './private-posting-file';

// Cookie-free public posting fetch. Never forward API credentials or local profile data.
const publicHosts = new Set(['jobs.lever.co', 'jobs.eu.lever.co', 'jobs.ashbyhq.com',
  'job-boards.greenhouse.io', 'boards.greenhouse.io', 'job-boards.eu.greenhouse.io', 'jobs.smartrecruiters.com', 'apply.workable.com', 'www.careerbeacon.com',
  'www.careers-page.com', 'djinni.co', 'www.onlinejobs.ph', 'www.saskjobs.ca']);

export function readPublicPostingHosts() {
  const value = readPrivatePostingFile(join(jobsHome(), 'public-posting-hosts.json'), {
    maxBytes: 64 * 1024, missing: 'allow', errorCode: 'invalid_public_posting_hosts',
  });
  if (value === undefined) return new Set<string>();
  if (!Array.isArray(value) || !value.every(host => typeof host === 'string' && host.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/u.test(host) &&
    URL.parse(`https://${host}`)?.hostname === host &&
    !/\.(?:localhost|local|internal|lan|home\.arpa)$/u.test(host)) || new Set(value).size !== value.length) {
    throw new Error('invalid_public_posting_hosts');
  }
  return new Set<string>(value);
}

export function postingUrl(raw: string, configuredHosts?: ReadonlySet<string>) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    !(publicHosts.has(url.hostname) || configuredHosts?.has(url.hostname))) throw new Error('unsupported_public_source');
  return url;
}

export function samePublicPosting(source: URL, target: URL) {
  const host = (url: URL) => url.hostname.replace(/^www\./, '').replace(/^boards\./, 'job-boards.');
  const query = (url: URL) => [...url.searchParams].filter(([key]) => !/^(?:utm_|gh_src$|lever-source$)/i.test(key))
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  return host(source) === host(target) && source.pathname.replace(/\/$/, '') === target.pathname.replace(/\/$/, '') &&
    JSON.stringify(query(source)) === JSON.stringify(query(target));
}

function plainText(html: string) {
  // Public recruiter contact information is irrelevant to summary tailoring.
  return sanitizePublicPostingText(html.replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
      const named: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
      if (entity[1] !== '#') return named[entity.toLowerCase()] || ' ';
      const code = parseInt(entity.slice(entity[2].toLowerCase() === 'x' ? 3 : 2, -1), entity[2].toLowerCase() === 'x' ? 16 : 10);
      return code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
    }));
}

export function sanitizePublicPostingText(text: string) {
  return text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[contact omitted]')
    .replace(/(?:\+?\d[\s().-]*){10,}/g, '[contact omitted]')
    .replace(/\s+/g, ' ').trim().slice(0, 12_000);
}

export function postingText(html: string) {
  // Ashby and other portals publish the complete public job in schema.org/JobPosting
  // while their visible initial HTML contains only a JavaScript loading message.
  // Parse data only; never evaluate scripts or include unrelated serialized state.
  const descriptions: string[] = [];
  let visited = 0;
  function visit(value: unknown, depth = 0) {
    if (++visited > 150 || depth > 4 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 50)) visit(item, depth + 1); return; }
    const entry = value as Record<string, unknown>;
    const types = Array.isArray(entry['@type']) ? entry['@type'] : [entry['@type']];
    if (types.some(type => type === 'JobPosting' || type === 'https://schema.org/JobPosting') && typeof entry.description === 'string') {
      const description = plainText(entry.description);
      if (description) descriptions.push(description);
    }
    if (entry['@graph']) visit(entry['@graph'], depth + 1);
    if (entry.mainEntity) visit(entry.mainEntity, depth + 1);
  }
  let scripts = 0;
  for (const match of html.matchAll(/<script\b[^>]*\btype\s*=\s*(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    if (++scripts > 20) break;
    try { visit(JSON.parse(match[2])); } catch { /* Malformed public metadata is not executable code. */ }
  }
  const unique = [...new Set(descriptions)];
  return unique.length === 1 ? unique[0] : plainText(html);
}

async function boundedResponseText(response: Response, maxBytes: number) {
  if (Number(response.headers.get('content-length') || 0) > maxBytes) {
    await response.body?.cancel();
    throw new Error('posting_too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '', size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return text + decoder.decode();
    size += chunk.value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error('posting_too_large'); }
    text += decoder.decode(chunk.value, { stream: true });
  }
}

export const publicPostingUnavailable = 'Public posting text unavailable. Use only the supplied role title and approved candidate facts. Make no employer-specific claims.';

const wwrFreshnessMs = 120_000;
let wwrSnapshot: { descriptions: ReadonlyMap<string, string>; expiresAt: number } | undefined;
let wwrRequest: Promise<ReadonlyMap<string, string> | undefined> | undefined;

async function fetchWwrSnapshot() {
  const response = await fetch('https://weworkremotely.com/remote-jobs.rss', {
    redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(12_000),
    headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
  });
  const mime = response.headers.get('content-type')?.split(';', 1)[0].trim();
  if (!response.ok || !['application/rss+xml', 'application/xml', 'text/xml'].includes(mime ?? '')) {
    await response.body?.cancel();
    return;
  }
  const descriptions = indexWwrPostings(await boundedResponseText(response, 4_000_000));
  if (descriptions) wwrSnapshot = { descriptions, expiresAt: Date.now() + wwrFreshnessMs };
  return descriptions;
}

async function getWwrPosting(url: URL) {
  if (url.origin !== 'https://weworkremotely.com' || url.username || url.password ||
      !/^\/remote-jobs\/[a-z\d-]+$/i.test(url.pathname) || url.search || url.hash) return publicPostingUnavailable;
  let descriptions = wwrSnapshot?.descriptions;
  if (!wwrSnapshot || Date.now() >= wwrSnapshot.expiresAt) {
    wwrSnapshot = undefined;
    wwrRequest ??= fetchWwrSnapshot().finally(() => { wwrRequest = undefined; });
    descriptions = await wwrRequest;
  }
  const text = sanitizePublicPostingText(wwrPostingDescription(descriptions?.get(url.href)));
  return text.length > 100 ? text : publicPostingUnavailable;
}

export async function getPublicPosting(raw: string) {
  try {
    const target = new URL(raw);
    if (target.hostname === 'weworkremotely.com') return await getWwrPosting(target);
    // The same allowlist snapshot applies to the original URL and redirects.
    const configuredHosts = readPublicPostingHosts();
    let url = postingUrl(raw, configuredHosts);
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(url, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(12_000), headers: { Accept: 'text/html' } });
      if (response.status >= 300 && response.status < 400) {
        const target = response.headers.get('location');
        await response.body?.cancel();
        if (!target) break;
        const redirected = postingUrl(new URL(target, url).href, configuredHosts);
        // A closed posting can redirect to a board or another job. Its text is
        // not evidence for the original application, even on an allowed host.
        if (!samePublicPosting(url, redirected)) break;
        url = redirected; continue;
      }
      if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) break;
      const text = postingText(await boundedResponseText(response, 2_000_000));
      if (text.length > 100) return text;
      break;
    }
  } catch { /* No raw remote response or request diagnostics enter the model. */ }
  return publicPostingUnavailable;
}
