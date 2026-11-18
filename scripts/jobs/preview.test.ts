import { emailRoutes } from './email-routes.fixture';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeLocal } from './config';
import { withResolvedClaimPrivateConfig } from './private-fields';
import { InvalidPreviewGrant, loadResumeSource, previewSavedPdf, PreviewConflict, renderApprovedArtifact } from './preview';

const work = {
  applicationId: 'f817402d-e00e-45c2-81db-6de8f3ee59bb', revision: 4, resumeTrack: 'web',
  summary: 'Public test summary.', company: 'Example Studio', role: 'Engineer', sourceUrl: 'https://example.com/jobs/42',
} as const;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const previousHome = process.env.QUANTSELF_JOBS_HOME;
let directory: string;
let source: string;
let renderer: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'jobs-preview-test-'));
  process.env.QUANTSELF_JOBS_HOME = directory;
  await writeLocal('email-routes.json', emailRoutes);
  source = join(directory, 'test.md');
  renderer = join(directory, 'render_resumes.py');
  await writeFile(source, '# Synthetic template\n');
  await writeFile(renderer, '# Synthetic renderer\n');
  await writeLocal('private.json', { resumePaths: { engineering: source, web: source, admin: source }, rendererPath: renderer });
});
afterAll(async () => {
  if (previousHome === undefined) delete process.env.QUANTSELF_JOBS_HOME; else process.env.QUANTSELF_JOBS_HOME = previousHome;
  await rm(directory, { recursive: true, force: true });
});

test('submission reuses the exact preview bytes and refuses changed contact details, source, renderer, or PDF', async () => {
  let renders = 0;
  const render = async (args: string[]) => {
    renders++;
    const input = JSON.parse(await readFile(args[args.indexOf('--work') + 1], 'utf8'));
    const output = args[args.indexOf('--output') + 1];
    const stem = output.slice(0, -4);
    const pdf = `%PDF-synthetic-${input.revision}-${input.summary}-${sha(await readFile(source))}-${sha(await readFile(renderer))}`;
    await Promise.all([
      writeFile(output, pdf),
      writeFile(`${stem}.work.json`, JSON.stringify(input)),
      writeFile(`${stem}.manifest.json`, JSON.stringify({
        sha256: sha(pdf), templateSha256: sha(await readFile(source)), rendererSha256: sha(await readFile(renderer)),
        applicationId: input.applicationId, revision: input.revision,
      })),
    ]);
    return '';
  };
  const privateConfig = JSON.parse(await readFile(join(directory, 'private.json'), 'utf8'));
  const personal = { email: 'category@example.test', phone: '+1 555 012 3000' };
  await writeLocal('private.json', { ...privateConfig, personal });
  const preview = await renderApprovedArtifact(work, { purpose: 'preview', render });
  const isolatedConfig = join(directory, 'work-private.json');
  await writeFile(isolatedConfig, JSON.stringify({ ...privateConfig,
    personal: { phone: personal.phone, email: personal.email, fullName: 'Synthetic Derived Name' } }));
  const previewDigest = sha(preview.pdf);
  const submitted = await renderApprovedArtifact(work, { render, privateConfigPath: isolatedConfig, previewDigest });
  expect(submitted.path).toBe(preview.path);
  expect(submitted.pdf.equals(preview.pdf)).toBe(true);
  expect(renders).toBe(1);

  for (const changed of [{ ...personal, email: 'other@example.test' }, { ...personal, phone: '+1 555 012 4000' }, { email: personal.email }]) {
    await writeFile(isolatedConfig, JSON.stringify({ ...privateConfig, personal: changed }));
    await expect(renderApprovedArtifact(work, { render, privateConfigPath: isolatedConfig, previewDigest })).rejects.toThrow('resume_preview_missing');
  }

  const trackingConfig = {
    ...privateConfig, personal, resumeTrackingLinks: { web: { 'https://portfolio.example/': 'https://tracking.example/' } },
  };
  await writeFile(isolatedConfig, JSON.stringify(trackingConfig));
  await expect(renderApprovedArtifact(work, { render, privateConfigPath: isolatedConfig, previewDigest })).rejects.toThrow('resume_preview_missing');

  await writeFile(source, '# Changed synthetic template\n');
  await expect(renderApprovedArtifact(work, { render, previewDigest })).rejects.toThrow('resume_preview_missing');
  expect(renders).toBe(1);
  const newer = await renderApprovedArtifact(work, { purpose: 'preview', render });
  const newerDigest = sha(newer.pdf);
  expect(newerDigest).not.toBe(previewDigest);
  await expect(renderApprovedArtifact(work, { render, previewDigest })).rejects.toThrow('resume_preview_missing');
  await writeFile(source, '# Synthetic template\n');
  expect((await renderApprovedArtifact(work, { render, previewDigest })).pdf).toEqual(preview.pdf);

  const revisionFolder = join(directory, 'applications', work.applicationId, String(work.revision));
  const oldMarker = (await readdir(revisionFolder)).find(name => name.endsWith(`-${previewDigest}.json`))!;
  await rm(join(revisionFolder, oldMarker));
  await expect(renderApprovedArtifact(work, { render, previewDigest })).rejects.toThrow('resume_preview_missing');
  expect(renders).toBe(2);

  await writeFile(source, '# Changed synthetic template\n');
  await writeFile(renderer, '# Changed synthetic renderer\n');
  await expect(renderApprovedArtifact(work, { render, previewDigest: newerDigest })).rejects.toThrow('resume_preview_missing');

  const newest = await renderApprovedArtifact(work, { purpose: 'preview', render });
  const newestDigest = sha(newest.pdf);
  await writeFile(newest.path, '%PDF-invalid artifact');
  await expect(renderApprovedArtifact(work, { render, previewDigest: newestDigest })).rejects.toThrow('invalid_resume_artifact');
  expect(renders).toBe(3);
  const repaired = await renderApprovedArtifact(work, { purpose: 'preview', render });
  expect(sha(repaired.pdf)).toBe(newestDigest);
  expect((await renderApprovedArtifact(work, { render, previewDigest: newestDigest })).pdf).toEqual(newest.pdf);
  const different = await renderApprovedArtifact({ ...work, revision: 5, summary: 'Different approved summary.' }, { render });
  expect(different.path).not.toBe(newest.path);
  expect(renders).toBe(5);
});

test('email résumé previews and submissions share an exact PDF without generated tracking links', async () => {
  const posting = { ...work, revision: 10, company: 'Example Services', role: 'Accounts Payable Clerk',
    sourceUrl: 'https://listings.example.test/jobs?posting_id=1234' };
  const privateConfigPath = join(directory, 'email-private.json');
  await writeFile(privateConfigPath, JSON.stringify({
    resumePaths: { web: source }, rendererPath: renderer,
    resumeTrackingLinks: { web: { 'https://portfolio.example/': 'https://tracking.example/' } },
    applicationTracking: { url: 'https://portfolio.example/', registryUrl: 'https://quantself.example/api/v1/tracked-links/applications', token: 'test' },
  }));
  const render = async (args: string[]) => {
    const config = JSON.parse(await readFile(args[args.indexOf('--private-config') + 1], 'utf8'));
    const input = await readFile(args[args.indexOf('--work') + 1], 'utf8');
    const output = args[args.indexOf('--output') + 1];
    const stem = output.slice(0, -4);
    const pdf = config.resumeTrackingLinks || config.applicationTracking ? '%PDF-tracked' : '%PDF-untracked';
    await Promise.all([
      writeFile(output, pdf),
      writeFile(`${stem}.work.json`, input),
      writeFile(`${stem}.manifest.json`, JSON.stringify({
        sha256: sha(pdf), templateSha256: sha(await readFile(source)), rendererSha256: sha(await readFile(renderer)),
        applicationId: posting.applicationId, revision: posting.revision,
      })),
    ]);
    return '';
  };

  const preview = await renderApprovedArtifact(posting, { purpose: 'preview', privateConfigPath, render });
  expect(preview.pdf.toString()).toBe('%PDF-untracked');
  await expect(renderApprovedArtifact(posting, { privateConfigPath, render, previewDigest: sha('%PDF-tracked') }))
    .rejects.toThrow('resume_preview_missing');
  const submitted = await renderApprovedArtifact(posting, { privateConfigPath, render, previewDigest: sha(preview.pdf) });
  expect(submitted.pdf).toEqual(preview.pdf);
});

test('loopback renders only the authorized application and identity returned by the API', async () => {
  const previousFetch = globalThis.fetch;
  const grant = `${work.applicationId}.${work.revision}.1794276000000.${'a'.repeat(64)}`;
  let status = 403;
  let rendered = 0;
  globalThis.fetch = (async (url, options) => {
    expect(String(url)).toBe('https://quantself.example/api/v1/jobs/preview');
    expect(options?.method).toBe('POST');
    expect(options?.body).toBe(JSON.stringify({ grant }));
    expect(new Headers(options?.headers).get('X-API-Key')).toBe('test-only');
    return status === 200 ? Response.json({ application: work, personal: { email: 'selected@example.test' } })
      : Response.json({}, { status });
  }) as typeof fetch;
  const config = { apiBaseUrl: 'https://quantself.example', apiKey: 'test-only' };
  const render: typeof renderApprovedArtifact = async (exact, options) => {
    expect(options?.purpose).toBe('preview');
    expect(exact).toEqual(work);
    const privateConfig = JSON.parse(await readFile(options!.privateConfigPath!, 'utf8'));
    expect(privateConfig.personal).toEqual({ email: 'selected@example.test' });
    expect(privateConfig.answers).toBeUndefined();
    rendered++;
    return { path: '/never-exposed', pdf: Buffer.from('%PDF-test') };
  };
  try {
    await expect(previewSavedPdf(config, { grant }, render)).rejects.toBeInstanceOf(InvalidPreviewGrant);
    status = 409;
    await expect(previewSavedPdf(config, { grant }, render)).rejects.toBeInstanceOf(PreviewConflict);
    expect(rendered).toBe(0);
    status = 200;
    await expect(previewSavedPdf(config, { grant }, render)).resolves.toBeInstanceOf(Buffer);
    expect(rendered).toBe(1);
  } finally { globalThis.fetch = previousFetch; }
});

test('owner-authorized editor source removes the complete original contact block', async () => {
  const previousFetch = globalThis.fetch;
  const grant = `${work.applicationId}.${work.revision}.1794276000000.${'a'.repeat(64)}`;
  const sourceMarkdown = '# Synthetic Contact Name\n\nprivate@example.test | +1 902 555 0123 | 123 Private Street\n\n## Summary\n\nOld summary.\n\n## Education\n\nA course.\n';
  await writeFile(source, sourceMarkdown);
  globalThis.fetch = (async (_url, options) => {
    expect(options?.body).toBe(JSON.stringify({ grant, purpose: 'source' }));
    return Response.json({ application: work, personal: {} });
  }) as typeof fetch;
  try {
    const config = { apiBaseUrl: 'https://quantself.example', apiKey: 'test-only' };
    const source = await loadResumeSource(config, { grant });
    expect(source.markdown).toBe('# {{fullName}}\n\n{{contact}}\n\n## Summary\n\nPublic test summary.\n\n## Education\n\nA course.\n');
  } finally { globalThis.fetch = previousFetch; }
});

test('unsaved previews render the edited document without registering application tracking', async () => {
  const previousFetch = globalThis.fetch;
  const local = JSON.parse(await readFile(join(directory, 'private.json'), 'utf8'));
  const applicationTracking = { url: 'https://girke.dev/api/links', registryUrl: 'https://quantself.example/api/v1/tracked-links/applications', token: 'synthetic-test-token' };
  const markdown = '# {{fullName}}\n\n{{contact}}\n\n## Projects\n\nA project.\n\n## Summary\n\nNew local draft.\n';
  const grant = `${work.applicationId}.${work.revision}.1794276000000.${'a'.repeat(64)}`;
  await writeLocal('private.json', { ...local, applicationTracking });
  globalThis.fetch = (async (url, options) => {
    if (String(url) === 'https://girke.dev/api/links') return Response.json({
      destinations: [{ sourceUrls: ['https://example.test/project'] }],
    });
    expect(options?.body).toBe(JSON.stringify({ grant }));
    return Response.json({ application: work, personal: {} });
  }) as typeof fetch;
  try {
    const config = { apiBaseUrl: 'https://quantself.example', apiKey: 'test-only' };
    await previewSavedPdf(config, { grant, resumeMarkdown: markdown }, async (exact, options) => {
      expect(exact.summary).toBe('New local draft.');
      expect(exact.resumeMarkdown).toBe(markdown);
      expect(options?.purpose).toBe('draft');
      const privateConfig = JSON.parse(await readFile(options!.privateConfigPath!, 'utf8'));
      expect(privateConfig.applicationTracking).toBeUndefined();
      return { path: '', pdf: Buffer.from('%PDF-test') };
    });
  } finally {
    globalThis.fetch = previousFetch;
    await writeLocal('private.json', local);
  }
});

test('application tracking preview and submission share the same exact cached PDF', async () => {
  const previousFetch = globalThis.fetch;
  const privatePath = join(directory, 'private.json');
  const previousConfig = await readFile(privatePath, 'utf8');
  const application = { ...work, revision: 20 };
  const applicationTracking = {
    url: 'https://girke.dev/api/links',
    registryUrl: 'https://quantself.example/api/v1/tracked-links/applications',
    token: 'synthetic-private-registry-credential',
  };
  const personal = { email: 'selected@example.test', phone: '+1 902 555 0123' };
  const config = { apiBaseUrl: 'https://quantself.example', apiKey: 'test-only' };
  let renders = 0;
  const render = async (args: string[]) => {
    renders++;
    const privateConfig = JSON.parse(await readFile(args[args.indexOf('--private-config') + 1], 'utf8'));
    expect(privateConfig.applicationTracking).toEqual(applicationTracking);
    const input = JSON.parse(await readFile(args[args.indexOf('--work') + 1], 'utf8'));
    const output = args[args.indexOf('--output') + 1];
    const stem = output.slice(0, -4);
    const pdf = '%PDF-synthetic-per-application-tracking';
    await Promise.all([
      writeFile(output, pdf),
      writeFile(stem + '.work.json', JSON.stringify(input)),
      writeFile(stem + '.manifest.json', JSON.stringify({
        sha256: sha(pdf), templateSha256: sha(await readFile(source)), rendererSha256: sha(await readFile(renderer)),
        applicationId: input.applicationId, revision: input.revision,
      })),
    ]);
    return '';
  };
  globalThis.fetch = (async url => {
    expect(String(url)).toBe(config.apiBaseUrl + '/api/v1/jobs/preview');
    return Response.json({ application, personal });
  }) as typeof fetch;
  const resolveFields = async () => ({ candidateContext: { markdown: '', version: 0 }, fields: [
    { key: 'email', label: 'Application email', type: 'email', scope: { kind: 'track', track: 'web' }, value: personal.email },
    { key: 'phone', label: 'Phone', type: 'phone', scope: { kind: 'global' }, value: personal.phone },
  ] });
  try {
    await writeLocal('private.json', {
      personal, resumePaths: { engineering: source, web: source, admin: source }, rendererPath: renderer, applicationTracking,
    });
    const grant = application.applicationId + '.' + application.revision + '.1794276000000.' + 'a'.repeat(64);
    const preview = await previewSavedPdf(config, { grant }, (exact, options) => renderApprovedArtifact(exact, { ...options, render }));
    await withResolvedClaimPrivateConfig(application, resolveFields, async privateConfigPath => {
      const submitted = await renderApprovedArtifact(application, { render, privateConfigPath, previewDigest: sha(preview) });
      expect(submitted.pdf).toEqual(preview);
    });
    expect(renders).toBe(1);
    applicationTracking.registryUrl = 'https://replacement.example/api/v1/tracked-links/applications';
    await writeLocal('private.json', { ...JSON.parse(await readFile(privatePath, 'utf8')), applicationTracking });
    await previewSavedPdf(config, { grant }, (exact, options) => renderApprovedArtifact(exact, { ...options, render }));
    expect(renders).toBe(2);
  } finally {
    globalThis.fetch = previousFetch;
    await writeFile(privatePath, previousConfig);
  }
});

test('draft and saved custom previews reject unsupported project links before rendering', async () => {
  const { UntrackedResumeLink } = await import('./resume-tracking-validation');
  const previousFetch = globalThis.fetch;
  const local = JSON.parse(await readFile(join(directory, 'private.json'), 'utf8'));
  const markdown = '# {{fullName}}\n\n{{contact}}\n\n## Summary\n\nNew local draft.\n\n## Projects\n\n[New project](https://unsupported.example/project)\n';
  const grant = `${work.applicationId}.${work.revision}.1794276000000.${'a'.repeat(64)}`;
  await writeLocal('private.json', { ...local, applicationTracking: {
    url: 'https://girke.dev/api/links', registryUrl: 'https://quantself.example/api/v1/tracked-links/applications', token: 'synthetic-test-token',
  } });
  globalThis.fetch = (async (url, options) => {
    if (String(url) === 'https://girke.dev/api/links') return Response.json({
      destinations: [{ sourceUrls: ['https://example.test/project'] }],
    });
    expect(options?.body).toBe(JSON.stringify({ grant }));
    return Response.json({ application: { ...work, resumeMarkdown: markdown, summary: 'New local draft.' }, personal: {} });
  }) as typeof fetch;
  let renders = 0;
  const render: typeof renderApprovedArtifact = async () => { renders++; return { path: '', pdf: Buffer.from('%PDF-test') }; };
  try {
    const config = { apiBaseUrl: 'https://quantself.example', apiKey: 'test-only' };
    await expect(previewSavedPdf(config, { grant, resumeMarkdown: markdown }, render)).rejects.toBeInstanceOf(UntrackedResumeLink);
    await expect(previewSavedPdf(config, { grant }, render)).rejects.toBeInstanceOf(UntrackedResumeLink);
    expect(renders).toBe(0);
  } finally {
    globalThis.fetch = previousFetch;
    await writeLocal('private.json', local);
  }
});
