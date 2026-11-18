import { expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPublicPosting, postingText, postingUrl, readPublicPostingHosts, samePublicPosting } from './public-posting';

test('public posting URLs cannot resolve private or credentialed endpoints', () => {
  expect(postingUrl('https://jobs.ashbyhq.com/example/123').hostname).toBe('jobs.ashbyhq.com');
  for (const url of ['http://127.0.0.1:3000', 'https://localhost/', 'https://jobs.ashbyhq.com.attacker.example/', 'https://user:secret@jobs.ashbyhq.com/123', 'https://jobs.ashbyhq.com:9443/123']) expect(() => postingUrl(url)).toThrow();
});
test('public redirects preserve posting identity and meaningful query parameters', () => {
  const same = (a: string, b: string) => samePublicPosting(new URL(a), new URL(b));
  expect(same('https://jobs.example.test/job/?gh_jid=123', 'https://www.jobs.example.test/job?gh_jid=123')).toBe(true);
  expect(same('https://boards.greenhouse.io/team/jobs/123?utm_source=board', 'https://job-boards.greenhouse.io/team/jobs/123')).toBe(true);
  expect(same('https://jobs.ashbyhq.com/team/id', 'https://jobs.ashbyhq.com/team')).toBe(false);
  expect(same('https://jobs.example.test/job?gh_jid=123', 'https://www.jobs.example.test/job?gh_jid=456')).toBe(false);
  expect(same('https://jobs.ashbyhq.com/team/id?locationId=one', 'https://jobs.ashbyhq.com/team/id?locationId=two')).toBe(false);
});

test('private allowlist enables exact HTTPS hosts and checks both ends of a redirect', async () => {
  const originalHome = process.env.QUANTSELF_JOBS_HOME;
  const originalFetch = globalThis.fetch;
  const home = await mkdtemp(join(tmpdir(), 'posting-hosts-'));
  process.env.QUANTSELF_JOBS_HOME = home;
  try {
    const config = join(home, 'public-posting-hosts.json');
    const host = 'careers.example.test';
    const source = `https://${host}/jobs/1`;
    const requested: string[] = [];
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.credentials).toBe('omit');
      expect(init?.redirect).toBe('manual');
      requested.push(String(input));
      return requested.length === 1
        ? new Response(null, { status: 302, headers: { location: `https://www.${host}/jobs/1` } })
        : new Response('Public posting. '.repeat(12), { headers: { 'content-type': 'text/html' } });
    }, { preconnect: originalFetch.preconnect });

    expect(readPublicPostingHosts().size).toBe(0);
    expect(await getPublicPosting(source)).toContain('unavailable');
    expect(requested).toEqual([]);
    await writeFile(config, JSON.stringify([host]), { mode: 0o600 });
    expect(await getPublicPosting(source)).toContain('unavailable');
    expect(requested).toEqual([source]);
    requested.length = 0;
    await writeFile(config, JSON.stringify([host, `www.${host}`]));
    expect(await getPublicPosting(source)).toContain('Public posting.');
    expect(requested).toEqual([source, `https://www.${host}/jobs/1`]);
    await chmod(config, 0o644);
    expect(readPublicPostingHosts).toThrow('invalid_public_posting_hosts');
    await chmod(config, 0o600);
    const target = join(home, 'other-hosts.json');
    await writeFile(target, JSON.stringify([host]), { mode: 0o600 });
    await rm(config);
    await symlink(target, config);
    expect(readPublicPostingHosts).toThrow('invalid_public_posting_hosts');
    await rm(config);
    await writeFile(config, JSON.stringify([host]), { mode: 0o600 });

    for (const invalid of ['127.0.0.1', '127.0.0.0x1', 'service.local', 'service.home.arpa', `${host}:443`, `*.${host}`, `https://${host}`]) {
      await writeFile(config, JSON.stringify([host, invalid]));
      expect(readPublicPostingHosts).toThrow('invalid_public_posting_hosts');
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.QUANTSELF_JOBS_HOME;
    else process.env.QUANTSELF_JOBS_HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  }
});
test('public text omits scripts, navigation and contact details and has a fixed size cap', () => {
  const result = postingText('<script>private tracking data</script><nav>navigation</nav><p>Publish web pages. recruiter@example.com +1 (555) 234-5678</p>');
  expect(result).toBe('Publish web pages. [contact omitted] [contact omitted]');
  expect(postingText('A'.repeat(20_000))).toHaveLength(12_000);
});

test('extracts the public JobPosting description from a JavaScript-only portal', () => {
  const page = `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', description: '<p>Build &amp; maintain publishing tools. recruiter@example.com</p>', applicant: 'DO_NOT_INCLUDE' })}</script><p>Enable JavaScript.</p>`;
  expect(postingText(page)).toBe('Build & maintain publishing tools. [contact omitted]');
  expect(postingText(`<script type='application/ld+json'>${JSON.stringify({ '@graph': [{ '@type': ['JobPosting'], description: '<p>Maintain &#39;customer&#39; records.</p>' }] })}</script>`)).toBe("Maintain 'customer' records.");
});

test('does not select an arbitrary job or serialize unrelated structured metadata', () => {
  const entries = [{ '@type': 'JobPosting', description: 'First role' }, { '@type': 'JobPosting', description: 'Second role' }];
  expect(postingText(`<script type="application/ld+json">${JSON.stringify(entries)}</script><main>Actual public page.</main>`)).toBe('Actual public page.');
  expect(postingText('<script type="application/ld+json">invalid</script><script>private state</script><p>Public text.</p>')).toBe('Public text.');
  expect(postingText('<p>&#0; &#xD800; &#999999999999; visible</p>')).toBe('visible');
});
