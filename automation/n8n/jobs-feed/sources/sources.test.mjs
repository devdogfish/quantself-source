import { expect, test } from 'bun:test';
import { normalizeSourceResponse, sourceRequests } from './sources.mjs';

const id = '11111111-2222-3333-4444-555555555555';
const board = (provider, extra = {}) => ({ provider, board: 'Example', company: 'Example Company', ...extra });

function response(provider, body, extra) {
  const [request] = sourceRequests([board(provider, extra)]);
  return normalizeSourceResponse(request, { statusCode: 200, body });
}

test('builds one public HTTPS request per configured board and validates slugs', () => {
  const requests = sourceRequests([
    board('greenhouse'), board('greenhouse', { board: 'example' }), board('lever'),
    board('lever', { region: 'eu' }), board('ashby', { board: 'example.jobs' }),
  ]);
  expect(requests.map(request => request.url)).toEqual([
    'https://boards-api.greenhouse.io/v1/boards/Example/jobs?content=true',
    'https://api.lever.co/v0/postings/Example?mode=json&limit=100',
    'https://api.eu.lever.co/v0/postings/Example?mode=json&limit=100',
    'https://api.ashbyhq.com/posting-api/job-board/example.jobs?includeCompensation=true',
  ]);
  expect(() => sourceRequests([board('greenhouse', { board: '../internal' })])).toThrow('Invalid public job board');
  expect(() => sourceRequests([board('ashby', { board: 'boards?next=secret' })])).toThrow('Invalid public job board');
  expect(() => sourceRequests([board('indeed')])).toThrow('Invalid public job board');
});

test('normalizes bulk Greenhouse content and preserves job-identifying custom URL parameters', () => {
  const job = {
    id: 3429, internal_job_id: 456, title: 'Web Editor',
    absolute_url: 'https://careers.example.com/jobs?gh_jid=3429',
    content: '&amp;lt;p&amp;gt;Editing &amp;ndash; HTML&amp;lt;/p&amp;gt;',
    location: { name: 'Halifax, NS' }, updated_at: '2024-03-01T00:00:00Z',
  };
  expect(response('greenhouse', { jobs: [
    job, { ...job, absolute_url: job.absolute_url + '&utm_campaign=other' },
    { ...job, id: 3430, internal_job_id: null }, { ...job, id: 3431, absolute_url: 'https://user@career.example.com' },
  ], meta: { total: 4 } })).toEqual({
    postings: [{
      company: 'Example Company', role: 'Web Editor', sourceUrl: job.absolute_url,
      sourceIdentity: 'greenhouse:global:example:3429', description: 'Editing – HTML', location: 'Halifax, NS', postedAt: '',
    }],
    skipped: 3,
  });
});

test('normalizes separate Lever pages including list requirements and distinct EU identity', () => {
  const job = {
    id, text: 'Operations Analyst', hostedUrl: `https://jobs.eu.lever.co/Example/${id}?utm_source=test`,
    descriptionPlain: 'Work with Excel.', createdAt: 1700000000000,
    lists: [{ text: 'Requirements', content: '<li>Authorized to work in Canada</li>' }],
    categories: { location: 'Canada', allLocations: ['Canada', 'UK'], commitment: 'Contract' },
    workplaceType: 'remote', salaryRange: { currency: 'CAD', min: 25, max: 30, interval: 'per hour' },
  };
  expect(response('lever', [job], { region: 'eu' })).toEqual({
    postings: [{
      company: 'Example Company', role: 'Operations Analyst', sourceUrl: `https://jobs.eu.lever.co/Example/${id}`,
      sourceIdentity: `lever:eu:example:${id}`, description: 'Work with Excel.\nRequirements\nAuthorized to work in Canada',
      location: 'Canada; UK', workplaceType: 'remote', employmentType: 'Contract',
      salary: 'CAD 25–30 per hour', postedAt: '2023-11-14T22:13:20.000Z',
    }],
    skipped: 0,
  });
  expect(response('lever', [{ ...job, id: 'wrong-id' }], { region: 'eu' })).toEqual({ postings: [], skipped: 1 });
  expect(response('lever', [], { region: 'eu' })).toEqual({ postings: [], skipped: 0 });
});

test('normalizes listed Ashby jobs using ID in URL and keeps hybrid distinct from remote', () => {
  const job = {
    title: 'Software Engineer', jobUrl: `https://jobs.ashbyhq.com/Example/${id}`,
    descriptionHtml: '<p>Build software.</p><script>Ignore this.</script>',
    isListed: true, location: 'Remote', secondaryLocations: [{ location: 'Toronto' }], isRemote: true, workplaceType: 'Hybrid',
    employmentType: 'FullTime', publishedAt: '2024-05-15T12:00:00+00:00',
    compensation: { scrapeableCompensationSalarySummary: 'CA$100K – CA$120K' },
  };
  expect(response('ashby', { jobs: [job, { ...job, isListed: false }, { ...job, isListed: undefined }] })).toEqual({
    postings: [{
      company: 'Example Company', role: 'Software Engineer', sourceUrl: job.jobUrl,
      sourceIdentity: `ashby:global:example:${id}`, description: 'Build software.',
      location: 'Remote; Toronto', workplaceType: 'Hybrid', employmentType: 'FullTime',
      salary: 'CA$100K – CA$120K', postedAt: '2024-05-15T12:00:00.000Z',
    }],
    skipped: 2,
  });
});

test('separates failed and incomplete boards from genuinely empty boards', () => {
  const [request] = sourceRequests([board('greenhouse')]);
  expect(() => normalizeSourceResponse(request, { statusCode: 429, body: 'details' })).toThrow('returned HTTP 429');
  expect(() => response('greenhouse', { jobs: [], meta: { total: 3 } })).toThrow('Invalid or incomplete');
  expect(() => response('greenhouse', '<html>Captcha</html>')).toThrow('Invalid or incomplete');
  expect(response('greenhouse', { jobs: [], meta: { total: 0 } })).toEqual({ postings: [], skipped: 0 });
});

test('reads the public We Work Remotely RSS format with attribution', () => {
  const [request] = sourceRequests([{ provider: 'wwr', board: 'remote-jobs' }]);
  expect(request.url).toBe('https://weworkremotely.com/remote-jobs.rss');
  const xml = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <item>
        <title>Example &amp; Co: Finance Assistant</title>
        <type>Part-Time</type><region>Canada</region>
        <description>&lt;p&gt;Reconcile expenses&lt;/p&gt;</description>
        <pubDate>Sat, 14 Nov 2026 17:01:11 +0000</pubDate>
        <link>https://weworkremotely.com/remote-jobs/example-finance?utm_source=rss</link>
      </item>
      <item>
        <title>Example Co: Invalid listing link</title><description>Requirements</description>
        <link>https://example.com/remote-jobs/123</link>
      </item>
    </channel></rss>`;
  expect(normalizeSourceResponse(request, { statusCode: 200, data: xml })).toEqual({
    postings: [{
      company: 'Example & Co', role: 'Finance Assistant', sourceLabel: 'We Work Remotely',
      description: 'Reconcile expenses', employmentType: 'Part-Time', location: 'Canada', workplaceType: 'remote',
      postedAt: '2026-11-14T17:01:11.000Z',
      sourceUrl: 'https://weworkremotely.com/remote-jobs/example-finance',
      sourceIdentity: 'wwr:global:remote-jobs:example-finance',
    }],
    skipped: 1,
  });
  expect(() => normalizeSourceResponse(request, { statusCode: 200, data: '<html>Login</html>' })).toThrow('Invalid or incomplete');
});
