import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './cli';
import { writeLocal } from './config';
import { importJobBatch, loadIntakeConfig, parseDirectJob } from './intake';

const required = ['--company', 'Example Studio', '--role', 'Web Engineer', '--track', 'web'];
const listing = 'https://jobs.example.com/web-engineer';

test('direct intake rejects invalid, local, credentialed and non-web URLs', () => {
  for (const url of [
    '/jobs/42', 'https:jobs.example.com', 'https://user:secret@jobs.example.com/post', 'file:///jobs/42', 'javascript:alert(1)',
    'http://localhost:3000/jobs/42', 'http://careers.local/jobs/42', 'http://127.0.0.1/jobs/42', 'http://0x7f.1/jobs/42', 'http://[::1]/jobs/42',
    'https://..',
  ]) {
    expect(() => parseDirectJob([...required, '--url', url])).toThrow('Use a public HTTP or HTTPS posting URL');
  }
});

test('direct intake validates required, duplicate and bounded optional flags', () => {
  expect(parseDirectJob(['--help'])).toBeNull();
  expect(() => parseDirectJob(['--url', listing])).toThrow('Supply URL, company, role and a valid track');
  expect(() => parseDirectJob([...required, '--url', listing, '--track', 'admin'])).toThrow('Use each flag once');
  expect(() => parseDirectJob([...required, '--url', listing, '--unknown', 'value'])).toThrow('Use the documented flags');
  expect(() => parseDirectJob([...required, '--url', listing, '--description', 'x'.repeat(12_001)])).toThrow('Check the optional field lengths');
  expect(parseDirectJob([...required, '--url', listing, '--location', ' Remote ', '--salary', 'CAD $100,000', '--description', ' Build public APIs. ', '--source-label', ' Company site '])).toEqual({
    company: 'Example Studio', role: 'Web Engineer', sourceUrl: listing, track: 'web', location: 'Remote', salary: 'CAD $100,000',
    postingText: 'Build public APIs.', source: 'Company site',
  });
});

test('retries the same import body and key and reports server duplicate counts', async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ body: string; key: string | null }> = [];
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe('https://quantself.example/api/v1/jobs/applications/import');
    expect(init?.method).toBe('POST');
    requests.push({ body: String(init?.body), key: new Headers(init?.headers).get('Idempotency-Key') });
    return requests.length === 1 ? new Response('{}', { status: 503 }) : Response.json({ imported: 0, duplicates: 1 });
  }) as typeof fetch;
  const config = { apiBaseUrl: 'https://quantself.example', apiKey: 'fixture-key' };
  try {
    const first = parseDirectJob([...required, '--url', listing])!;
    await expect(importJobBatch(config, [first])).rejects.toThrow('jobs_api_503');
    const retry = parseDirectJob(['--url', ' HTTPS://JOBS.EXAMPLE.COM/web-engineer ', ...required])!;
    expect(await importJobBatch(config, [retry])).toEqual({ imported: 0, duplicates: 1 });
    expect(requests[1]).toEqual(requests[0]);
    expect(JSON.parse(requests[0].body)).toEqual({
      applications: [{ company: 'Example Studio', role: 'Web Engineer', sourceUrl: listing, track: 'web', postingText: 'Web Engineer at Example Studio.', source: 'Added directly' }],
    });
    expect(requests[0].key).toBe(`jobs-import-${createHash('sha256').update(requests[0].body).digest('hex')}`);
  } finally { globalThis.fetch = previousFetch; }
});

test('intake uses a scoped key, with explicit configuration taking precedence over the historical intake key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qs-jobs-intake-'));
  const previous = process.env.QUANTSELF_JOBS_HOME;
  process.env.QUANTSELF_JOBS_HOME = directory;
  try {
    await expect(loadIntakeConfig()).rejects.toThrow('jobs_intake_configuration_required');
    await writeLocal('draft.json', { apiBaseUrl: 'https://fallback.example.test', apiKey: 'synthetic-older', extra: 'ignored' });
    expect(await loadIntakeConfig()).toEqual({ apiBaseUrl: 'https://fallback.example.test', apiKey: 'synthetic-older' });
    await writeLocal('intake.json', { apiBaseUrl: 'https://intake.example.test', apiKey: 'synthetic-new' });
    expect(await loadIntakeConfig()).toEqual({ apiBaseUrl: 'https://intake.example.test', apiKey: 'synthetic-new' });
    await writeLocal('intake.json', { apiBaseUrl: 'http://intake.example.test', apiKey: 'synthetic-new' });
    await expect(loadIntakeConfig()).rejects.toThrow('invalid_api_origin');
    await expect(main(['setup'])).rejects.toThrow('jobs_intake_usage');
    await expect(main(['run', '--submit'])).rejects.toThrow('jobs_intake_usage');
  } finally {
    if (previous === undefined) delete process.env.QUANTSELF_JOBS_HOME;
    else process.env.QUANTSELF_JOBS_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
