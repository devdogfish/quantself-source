import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { api, jobsHome, readLocal, tracks, type JobsApiConfig, type PrivateConfig } from './config';
import { localFiles, localPython } from './local-files';
import { maxResumeMarkdown, parseResumeDocument, replaceDocumentSummary, resumeHeader } from './resume-document';
import { resumeLinkCatalog } from './resume-links';
import { validateResumeTrackingLinks } from './resume-tracking-validation';
import { emailApplicationRoute, readEmailRoutes, type EmailRoutes } from './email-routes';

const maxPdfBytes = 16 * 1024 * 1024;
const selection = z.strictObject({
  applicationId: z.uuid(),
  revision: z.number().int().positive().max(2_147_483_646),
  resumeTrack: z.enum(tracks),
  summary: z.string().min(1).max(2_000).refine(text => Boolean(text.trim())),
});
const snapshot = selection.extend({
  resumeMarkdown: z.string().max(maxResumeMarkdown).optional(),
  company: z.string().min(1).max(200), role: z.string().min(1).max(200), sourceUrl: z.url().max(2_048),
});
const personalKeys = ['firstName', 'lastName', 'email', 'phone', 'city', 'region', 'country', 'postalCode', 'addressLine1', 'linkedin', 'website'] as const;
const personal = z.partialRecord(z.enum(personalKeys), z.string().max(4_000));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const previewRequest = z.strictObject({
  grant: z.string().regex(/^[a-f0-9-]{36}\.[1-9][0-9]{0,9}\.[0-9]{13}\.[a-f0-9]{64}$/),
  resumeMarkdown: z.string().min(1).max(maxResumeMarkdown).optional(),
});
export const resumeSourceRequest = previewRequest.omit({ resumeMarkdown: true });
const authorizedPreview = z.strictObject({ application: snapshot.extend({ summary: z.string().max(2_000) }), personal });
export class InvalidResumeDocument extends Error {}


type Snapshot = z.infer<typeof snapshot>;
type Selection = z.infer<typeof selection>;
export class PreviewConflict extends Error {}
export class InvalidPreviewGrant extends Error {}
const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

function sameSelection(a: Selection, b: Selection) {
  return a.applicationId === b.applicationId && a.revision === b.revision && a.resumeTrack === b.resumeTrack && a.summary === b.summary;
}

async function localInputs(work: Snapshot, config: PrivateConfig, email: boolean) {
  const source = resolve(config.resumePaths[work.resumeTrack]);
  const renderer = resolve(config.rendererPath || join(dirname(source), 'render_resumes.py'));
  const [markdown, rendererBytes, wrapperBytes] = await Promise.all([
    readFile(source, 'utf8'), readFile(renderer), readFile(new URL('./files.py', import.meta.url)),
  ]);
  return {
    source, renderer, interpreter: config.rendererPython || localPython(),
    templateSha256: sha(markdown.replace(/\r\n?/g, '\n')), rendererSha256: sha(rendererBytes),
    wrapperSha256: sha(wrapperBytes),
    ...(work.resumeMarkdown ? { customWrapperSha256: sha(await readFile(new URL('./resume_document.py', import.meta.url))) } : {}),
    ...(email ? { emailWithoutTracking: true } : {}),
    resumeTrackingLinks: config.resumeTrackingLinks,
    applicationTracking: config.applicationTracking ? {
      url: config.applicationTracking.url,
      registryUrl: config.applicationTracking.registryUrl,
      implementationSha256: sha(await readFile(new URL('../website-analytics/application_links.py', import.meta.url))),
    } : undefined,
    identitySha256: sha(JSON.stringify(personalKeys.map(key => [key, config.personal?.[key] ?? '']))),
  };
}

async function boundedPdf(path: string) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 5 || stat.size > maxPdfBytes) throw new Error('invalid_resume_pdf');
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size || bytes.toString('ascii', 0, 5) !== '%PDF-') throw new Error('invalid_resume_pdf');
    return bytes.subarray(0, offset);
  } finally { await file.close(); }
}

async function readArtifact(directory: string, work: Snapshot, inputs: Awaited<ReturnType<typeof localInputs>>) {
  const path = join(directory, 'resume.pdf');
  const [pdf, rawManifest, rawWork] = await Promise.all([
    boundedPdf(path), readFile(join(directory, 'resume.manifest.json'), 'utf8'), readFile(join(directory, 'resume.work.json'), 'utf8'),
  ]);
  const manifest = JSON.parse(rawManifest);
  const saved = snapshot.parse(JSON.parse(rawWork));
  if (!sameSelection(saved, work) || saved.company !== work.company || saved.role !== work.role || saved.sourceUrl !== work.sourceUrl || saved.resumeMarkdown !== work.resumeMarkdown ||
      manifest?.applicationId !== work.applicationId || manifest?.revision !== work.revision || manifest?.sha256 !== sha(pdf) ||
      manifest?.templateSha256 !== inputs.templateSha256 || manifest?.rendererSha256 !== inputs.rendererSha256) {
    throw new Error('invalid_resume_artifact');
  }
  return { path, pdf };
}

const previewMarker = z.strictObject({
  cacheKey: z.string().regex(/^[a-f0-9]{64}$/),
  artifact: z.string().regex(/^(?:pdf-[a-f0-9]{64}|render-[A-Za-z0-9]+)$/),
});

export async function renderApprovedArtifact(work: Snapshot, {
  purpose = 'submit', previewDigest, render = localFiles, privateConfigPath = join(jobsHome(), 'private.json'), emailRoutes,
}: { purpose?: 'preview' | 'submit' | 'draft'; previewDigest?: string | null; render?: typeof localFiles; privateConfigPath?: string; emailRoutes?: EmailRoutes } = {}) {
  const exact = snapshot.parse(work);
  const email = Boolean(emailApplicationRoute(exact, emailRoutes));
  if (exact.resumeMarkdown) {
    const parsed = parseDocument(exact.resumeMarkdown);
    if (parsed.markdown !== exact.resumeMarkdown || parsed.summary !== exact.summary) throw new InvalidResumeDocument();
  }
  const readConfig = async () => {
    const config = JSON.parse(await readFile(privateConfigPath, 'utf8')) as PrivateConfig;
    return email ? { ...config, resumeTrackingLinks: undefined, applicationTracking: undefined } : config;
  };
  const config = await readConfig();
  const inputs = await localInputs(exact, config, email);
  const revisionFolder = join(jobsHome(), 'applications', exact.applicationId, String(exact.revision));
  const cacheKey = sha(JSON.stringify([2, exact, inputs]));
  async function renderAt(directory: string) {
    const workPath = join(directory, 'input.json');
    await writeFile(workPath, JSON.stringify(exact), { mode: 0o600 });
    const pdfPath = join(directory, 'resume.pdf');
    const renderConfigPath = email ? join(directory, 'private.json') : privateConfigPath;
    if (email) await writeFile(renderConfigPath, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
    try {
      await render(exact.resumeMarkdown ? ['custom-pdf', renderConfigPath, workPath, pdfPath]
        : ['pdf', '--private-config', renderConfigPath, '--work', workPath, '--output', pdfPath]);
    } finally {
      if (email) await rm(renderConfigPath, { force: true });
    }
    return readArtifact(directory, exact, inputs);
  }
  if (purpose === 'draft') {
    const staging = await mkdtemp(join(jobsHome(), 'draft-preview-'));
    try { return { pdf: (await renderAt(staging)).pdf, path: '' }; }
    finally { await rm(staging, { recursive: true, force: true }); }
  }
  const markerPath = (hash: string) => join(revisionFolder, `preview-${cacheKey}-${hash}.json`);

  if (purpose === 'submit' && previewDigest != null) {
    const hash = digest.parse(previewDigest);
    const rawMarker = await readFile(markerPath(hash), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new Error('resume_preview_missing');
      throw error;
    });
    const marker = previewMarker.parse(JSON.parse(rawMarker));
    if (marker.cacheKey !== cacheKey) throw new Error('resume_preview_inputs_changed');
    const artifact = await readArtifact(join(revisionFolder, marker.artifact), exact, inputs);
    if (sha(artifact.pdf) !== hash) throw new Error('resume_preview_changed');
    return artifact;
  }

  async function finish(artifact: Awaited<ReturnType<typeof readArtifact>>) {
    if (purpose === 'preview') {
      const marker = markerPath(sha(artifact.pdf));
      const temporary = `${marker}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ cacheKey, artifact: basename(dirname(artifact.path)) }), { mode: 0o600 });
        // Each marker binds one input snapshot and digest. Replacing its path
        // can repair a damaged artifact without changing the approved bytes.
        await rename(temporary, marker);
      } finally { await rm(temporary, { force: true }); }
    }
    return artifact;
  }

  const directory = join(revisionFolder, `pdf-${cacheKey}`);
  const cached = await readArtifact(directory, exact, inputs).catch(() => null);
  if (cached) return finish(cached);

  await mkdir(revisionFolder, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(revisionFolder, 'render-'));
  let keep = false;
  try {
    const artifact = await renderAt(staging);
    if (JSON.stringify(await localInputs(exact, await readConfig(), email)) !== JSON.stringify(inputs)) throw new Error('resume_inputs_changed');
    try {
      await rename(staging, directory);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const winner = await readArtifact(directory, exact, inputs).catch(() => null);
      if (winner) return await finish(winner);
      // A damaged cache cannot overwrite a fresh verified artifact another process may need.
      const fresh = await finish(artifact);
      keep = true;
      return fresh;
    }
    return await finish({ path: join(directory, 'resume.pdf'), pdf: artifact.pdf });
  } finally { if (!keep) await rm(staging, { recursive: true, force: true }); }
}

function parseDocument(markdown: string) {
  try { return parseResumeDocument(markdown); }
  catch { throw new InvalidResumeDocument(); }
}

export async function authorizedResume(config: JobsApiConfig, grant: string, purpose?: 'source') {
  const response = await api<unknown>(config, '/preview', { grant, ...(purpose ? { purpose } : {}) }).catch(error => {
    if (error.message === 'jobs_api_409' || error.message === 'jobs_api_404') throw new PreviewConflict();
    if (error.message === 'jobs_api_403') throw new InvalidPreviewGrant();
    throw error;
  });
  return authorizedPreview.parse(response);
}

export async function loadResumeSource(config: JobsApiConfig, { grant }: z.infer<typeof resumeSourceRequest>) {
  const { application } = await authorizedResume(config, grant, 'source');
  const local = await readLocal<PrivateConfig>('private.json');
  const sourcePath = local.resumePaths[application.resumeTrack];
  const file = await open(sourcePath, 'r');
  try {
    if ((await file.stat()).size > maxResumeMarkdown * 4) throw new InvalidResumeDocument();
    const source = (await file.readFile('utf8')).replace(/\r\n?/g, '\n');
    const heading = /^## Summary[ \t]*\n/m.exec(source);
    if (!heading) throw new InvalidResumeDocument();
    const linkCatalog = resumeLinkCatalog(source.slice(0, heading.index),
      emailApplicationRoute(application) ? undefined : local.resumeTrackingLinks?.[application.resumeTrack]);
    if (application.resumeMarkdown) return { markdown: parseDocument(application.resumeMarkdown).markdown, linkCatalog };
    const base = parseDocument(resumeHeader + source.slice(heading.index));
    return { markdown: application.summary ? replaceDocumentSummary(base.markdown, application.summary).markdown : base.markdown, linkCatalog };
  } finally { await file.close(); }
}

export async function previewSavedPdf(config: JobsApiConfig, input: z.infer<typeof previewRequest>, render = renderApprovedArtifact) {
  const { application, personal: selected } = await authorizedResume(config, input.grant);
  const edited = input.resumeMarkdown ? parseDocument(input.resumeMarkdown) : undefined;
  if (!edited && !application.summary.trim()) throw new PreviewConflict();
  const work = edited ? { ...application, summary: edited.summary, resumeMarkdown: edited.markdown } : application;
  const emailRoutes = readEmailRoutes();
  const local = await readLocal<PrivateConfig>('private.json');
  if (work.resumeMarkdown && local.applicationTracking && !emailApplicationRoute(work, emailRoutes)) {
    const source = await readFile(local.resumePaths[work.resumeTrack], 'utf8');
    const heading = /^## Summary[ \t]*\n/m.exec(source);
    if (!heading || source.length > maxResumeMarkdown * 4) throw new InvalidResumeDocument();
    await validateResumeTrackingLinks(work.resumeMarkdown, source.slice(0, heading.index));
  }
  const directory = await mkdtemp(join(jobsHome(), 'preview-identity-'));
  const privateConfigPath = join(directory, 'private.json');
  try {
    await writeFile(privateConfigPath, JSON.stringify({
      ...local, personal: selected, answers: undefined,
      ...(edited ? { applicationTracking: undefined } : {}),
    }), { mode: 0o600 });
    return (await render(work, { purpose: edited ? 'draft' : 'preview', privateConfigPath, emailRoutes })).pdf;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
