import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { api, apiOrigin, readLocal, tracks, type JobsApiConfig } from './config';

export const addJobHelp = `Usage: bun run jobs:add --url URL --company COMPANY --role ROLE --track engineering|web|admin

Optional flags: --location LOCATION --salary SALARY --description DESCRIPTION --source-label LABEL
Use public posting information. To queue enrichment, use Add listing in Jobs.`;

export class DirectJobArgumentsError extends Error {}

const label = (max: number) => z.string().trim().min(1).max(max);
const fields = z.object({
  url: label(2048),
  company: label(200),
  role: label(200),
  track: z.enum(tracks),
  location: label(200).optional(),
  salary: label(200).optional(),
  description: label(12_000).optional(),
  'source-label': label(120).default('Added directly'),
});

function publicPostingUrl(raw: string) {
  const url = URL.parse(raw);
  if (!url || !/^https?:\/\//i.test(raw) || url.username || url.password) return null;
  const host = url.hostname.replace(/\.$/, '');
  const dnsName = host.includes('.') && host.split('.').every(part => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(part));
  if (!dnsName || isIP(host) || /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/.test(host)) return null;
  return url.href.length <= 2048 ? url.href : null;
}

export function parseDirectJob(args: string[]) {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args, tokens: true, allowPositionals: false,
      options: {
        url: { type: 'string' }, company: { type: 'string' }, role: { type: 'string' }, track: { type: 'string' },
        location: { type: 'string' }, salary: { type: 'string' }, description: { type: 'string' }, 'source-label': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch { throw new DirectJobArgumentsError('Use the documented flags and give each flag a value.'); }
  if (parsed.values.help) return null;
  const options = parsed.tokens?.flatMap(token => token.kind === 'option' ? [token.name] : []) ?? [];
  if (new Set(options).size !== options.length) throw new DirectJobArgumentsError('Use each flag once.');
  const input = fields.safeParse(parsed.values);
  if (!input.success) throw new DirectJobArgumentsError('Supply URL, company, role and a valid track. Check the optional field lengths.');
  const values = input.data;
  const sourceUrl = publicPostingUrl(values.url);
  if (!sourceUrl) throw new DirectJobArgumentsError('Use a public HTTP or HTTPS posting URL without credentials.');
  return {
    company: values.company, role: values.role, sourceUrl, track: values.track,
    location: values.location, salary: values.salary, postingText: values.description ?? `${values.role} at ${values.company}.`, source: values['source-label'],
  };
}

export async function loadIntakeConfig(): Promise<JobsApiConfig> {
  const read = (name: string) => readLocal<unknown>(name);
  const raw = await read('intake.json').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return read('draft.json').catch((fallback: NodeJS.ErrnoException) => {
      if (fallback.code === 'ENOENT') throw new Error('jobs_intake_configuration_required');
      throw fallback;
    });
  });
  const config = z.object({ apiBaseUrl: z.string().min(1), apiKey: z.string().trim().min(1) }).safeParse(raw);
  if (!config.success) throw new Error('jobs_intake_configuration_required');
  return { ...config.data, apiBaseUrl: apiOrigin(config.data.apiBaseUrl) };
}

export async function importJobBatch(config: JobsApiConfig, applications: readonly object[]) {
  const body = { applications: applications.map(normalizeInput) };
  const idempotency = `jobs-import-${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
  return api<{ imported: number; duplicates: number }>(config, '/applications/import', body, idempotency);
}

const workbookRow = z.object({
  company: label(200), role: label(200), sourceUrl: label(2048), resumeTrack: z.enum(tracks),
  location: z.string().nullable().optional(), salary: z.string().nullable().optional(),
  description: z.string().nullable().optional(), sourceLabel: z.string().nullable().optional(), sourceStatus: z.string().optional(),
});
const historicalStatus = z.enum(['applied', 'disqualified', 'rejected', 'saved_for_later', 'skipped']);

function normalizeInput(input: object) {
  if ('track' in input) return input;
  const row = workbookRow.parse(input);
  return {
    company: row.company, role: row.role, sourceUrl: row.sourceUrl, track: row.resumeTrack, source: row.sourceLabel || undefined,
    location: row.location, salary: row.salary, postingText: row.description?.trim() || `${row.role} at ${row.company}.`,
    recordedStatus: historicalStatus.safeParse(row.sourceStatus?.toLowerCase()).data,
  };
}
