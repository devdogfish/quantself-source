import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { privateFieldsOutput } from '../../apps/api/src/jobs-private-fields-contract';
import { jobLifecycleOutput } from '../../apps/api/src/jobs-lifecycle-contract';
import { jobsImportApplicationsOutput } from '../../apps/api/src/jobs-owner-contract';
import { jobsSubmissionsOutput } from '../../apps/api/src/jobs-operations-read';
import { jobsWorkerPath } from '../../apps/api/src/jobs-work-contract';
import { runJobsCodexBatch } from '../../apps/web/lib/jobs-codex-worker';
import { submitApplication } from './browser';
import { scheduleInFreshJobsApi } from './fixtures/native-appointment-restart';
import { rehearseThreadedReply } from './fixtures/threaded-reply-rehearsal';
import { writeLocal } from './config';
import { openSyntheticPortal, sha256, syntheticAnswer, syntheticCandidate, syntheticPdf, syntheticPosting,
  syntheticQuestion, syntheticSourceIdentity } from './fixtures/synthetic-job-application';
import { questionKey } from './private-fields';
import { resumeHeader } from './resume-document';
import { runJobsMacOnce } from './run-jobs-mac-worker';
import { createJobsWorkClient } from './work-client';
import { createJobsWorkOutbox } from './work-outbox';

const codex = randomUUID();
const runner = randomUUID();
const template = `${resumeHeader}## Summary\n\n- Edited sample product pages\n\n## Experience\n\n- Published sample catalog changes\n`;
const generatedSummary = '- Published product pages\n- Maintained catalog listings\n- Edited landing pages';
const ownerSummary = '- Published seasonal product pages\n- Maintained catalog listings\n- Edited landing pages';
const fixtureEnabled = process.env.QUANTSELF_JOBS_INTEGRATION_FIXTURE === '1';
const handoffPath = process.env.QS_JOBS_TEST_N8N_HANDOFF;
const nativeHandoffSchema = z.object({
  onlyLoopback: z.literal(true), sourceIdentity: z.literal('greenhouse:global:synthetic-studio:197'), permitId: z.uuid(),
  allowance: z.object({ ownerId: z.uuid(), id: z.uuid(), heldNanoUsd: z.literal('0'), spentNanoUsd: z.literal('35600000') }),
  application: z.tuple([z.object({ id: z.uuid(), status: z.literal('review'), revision: z.literal(1) })]),
  screen: z.object({ id: z.uuid() }), handoffDumpSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const acceptance = test.skipIf(!fixtureEnabled);
acceptance(handoffPath ? 'Pinned n8n Review, guarded Chrome submit, receipt replay, audited outcome and native Appointment restart'
  : 'Import-only Greenhouse feed, guarded Chrome submit, receipt replay and audited reply outcome',
  () => runAcceptance('replay'), 45_000);
test.skipIf(!fixtureEnabled || !!handoffPath)('Worker crash after a durable start and before receipt requires Owner reconciliation',
  () => runAcceptance('crash'), 45_000);

function killWorkerGroup(pid: number) {
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

async function bounded<T>(operation: Promise<T>, label: string, milliseconds = 12_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function runAcceptance(mode: 'replay' | 'crash') {
  const connection = new URL(process.env.DATABASE_URL ?? '');
  if (connection.protocol !== 'postgresql:' || connection.hostname !== '127.0.0.1' || !connection.port ||
      connection.pathname !== '/jobs_worker_integration') {
    throw new Error('Use a disposable Jobs integration Docker database.');
  }
  const browserUseCommand = process.env.QS_JOBS_TEST_BROWSER_USE ?? '';
  if (!isAbsolute(browserUseCommand)) throw new Error('Set QS_JOBS_TEST_BROWSER_USE to the pinned local executable.');

  const [{ prisma }, { createApp }, { createAgentApiKey, createApiKey }, { registerJobsPilotReviewRoute }] = await Promise.all([
    import('../../packages/db'), import('../../apps/api/src/app'), import('../../packages/auth/src/index'),
    import('../../apps/api/src/jobs-route'),
  ]);
  const handoff = handoffPath ? nativeHandoffSchema.parse(JSON.parse(await readFile(handoffPath, 'utf8'))) : null;
  const ownerId = handoff?.allowance.ownerId ?? 'jobs-worker-integration-owner';
  const owner = { id: ownerId, name: 'Synthetic Owner', email: 'jobs-integration@example.test' };
  const approvalRevision = handoff ? 1 : 2;
  const expectedPdf = syntheticPdf(approvalRevision);
  const digest = sha256(expectedPdf);
  const directory = await mkdtemp(join(tmpdir(), 'qs-jobs-integration-'));
  const previousHome = process.env.QUANTSELF_JOBS_HOME;
  const previousEncryptionKey = process.env.QUANTSELF_JOBS_PRIVATE_FIELDS_KEY;
  const previousTemplates = process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR;
  const templates = join(directory, 'templates');
  process.env.QUANTSELF_JOBS_HOME = directory;
  process.env.QUANTSELF_JOBS_PRIVATE_FIELDS_KEY = Buffer.alloc(32, 7).toString('base64url');
  const gateAccepted = Promise.withResolvers<void>();
  const deliverGate = Promise.withResolvers<void>();
  const portalAccepted = Promise.withResolvers<void>();
  const releasePortal = Promise.withResolvers<void>();
  const stored = new Map<string, Uint8Array>();
  const receiptReports: { body: string; status: number }[] = [];
  const failureReports: { body: unknown; status: number }[] = [];
  const calls: Record<string, Record<string, number>> = {
    import: {}, prepare: {}, 'revocation-probe': {}, submit: {}, restart: {}, reconcile: {}, reply: {}, appointment: {}, 'reply-send': {}, corrupt: {},
  };
  const replyRequests: [route: string, status: number][] = [];
  const timings: Record<string, number> = {};
  let phase = 'import';
  const issuedClientIds: string[] = [];
  const ownerCommandKeys: string[] = [];
  const proof = randomBytes(32).toString("hex");
  const previousProof = process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
  const previousOrigin = process.env.QUANTSELF_PUBLIC_ORIGIN;
  process.env.QUANTSELF_OWNER_INGRESS_TOKEN = proof;
  process.env.QUANTSELF_PUBLIC_ORIGIN = "http://127.0.0.1";
  const app = createApp({
    emitAccessLog: () => {},
    jobsWorkers: {
      db: prisma, secrets: () => ({ codex, runner }), pilotReview: !!handoff,
      pdfStore: {
        async put(key, bytes) { stored.set(key, Buffer.from(bytes)); return key; },
        async open(key) {
          const bytes = stored.get(key);
          return new Response(bytes ? Buffer.from(bytes) : null, {
            status: bytes ? 200 : 404, headers: { 'Content-Type': 'application/pdf' },
          });
        },
      },
    },
  });
  if (handoff) registerJobsPilotReviewRoute(app, prisma);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const route = request.method + ' ' + path.replace(/\/[a-f0-9-]{36}(?=\/|$)/g, '/:id');
    const phaseCalls = calls[phase];
    phaseCalls[route] = (phaseCalls[route] ?? 0) + 1;
    const event = path.endsWith('/events') ? await request.clone().json() : null;
    const receipt = path.endsWith('/complete') && ['submit', 'restart'].includes(phase) ? await request.clone().text() : null;
    const failure = path.endsWith('/fail') && phase === 'restart' ? await request.clone().json() : null;
    const response = await app.fetch(request);
    if (event?.step === 'submit_started' && response.ok) {
      gateAccepted.resolve();
      await deliverGate.promise;
    }
    if (receipt !== null) receiptReports.push({ body: receipt, status: response.status });
    if (failure !== null) failureReports.push({ body: failure, status: response.status });
    if (phase === 'reply') replyRequests.push([route, response.status]);
    return response;
  } });
  const baseUrl = server.url.origin;
  const origin = "http://127.0.0.1";
  function ownerRequest(path: string, method = 'GET', body?: unknown, signal?: AbortSignal, command = randomUUID()) {
    ownerCommandKeys.push(command);
    return fetch(new URL(path, baseUrl), {
      method, headers: { Origin: origin, "x-quantself-owner-proof": proof, 'Content-Type': 'application/json', 'Idempotency-Key': command },
      body: body === undefined ? undefined : JSON.stringify(body), signal,
    });
  }
  async function assertStatus(response: Response, status: number) {
    if (response.status !== status) throw new Error(`Expected HTTP ${status}; got ${response.status} for ${new URL(response.url).pathname}: ${await response.text()}`);
  }
  const outboxDirectory = join(directory, 'worker-v2', 'outbox');
  const browserRuntimeMarker = join(directory, 'browser-runtime');
  let portal: Awaited<ReturnType<typeof openSyntheticPortal>> | undefined;
  let child: ReturnType<typeof startWorker> | undefined;
  function startWorker(cdpUrl: string, dropReceipt = false) {
    return Bun.spawn([process.execPath, '--no-env-file', '--preload',
      fileURLToPath(new URL('./fixtures/submit-receipt-fault.ts', import.meta.url)),
      fileURLToPath(new URL('./run-jobs-mac-worker.ts', import.meta.url)), '--once'], {
      env: {
        HOME: directory, TMPDIR: directory, PATH: join(directory, 'bin') + ':' + process.env.PATH,
        QUANTSELF_JOBS_HOME: directory, JOBS_RUNNER_BASE_URL: baseUrl, JOBS_RUNNER_SECRET: runner,
        JOBS_RUNNER_CDP_URL: cdpUrl, JOBS_RUNNER_ID: 'fixture-mac',
        QS_JOBS_FIXTURE_DROP_RECEIPT: dropReceipt ? '1' : undefined,
      },
      stdout: 'ignore', stderr: 'pipe', detached: true,
    });
  }
  async function closeCrashedBrowserRuntime() {
    const runtime = (await readFile(browserRuntimeMarker, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    })).trim();
    if (!runtime) return;
    if (!/^\/tmp\/qs-jobs-[a-zA-Z0-9]+$/.test(runtime)) throw new Error('Unexpected fixture browser runtime path.');
    const exists = await stat(runtime).then(info => info.isDirectory()).catch(error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (!exists) return;
    const stop = Bun.spawn([browserUseCommand, '--reload'], {
      cwd: runtime, stdout: 'ignore', stderr: 'ignore',
      env: { PATH: process.env.PATH, HOME: runtime, XDG_CONFIG_HOME: runtime, BH_RUNTIME_DIR: runtime,
        BH_TMP_DIR: runtime, ANONYMIZED_TELEMETRY: 'false' },
    });
    try { await bounded(stop.exited, 'detach the crashed worker browser daemon', 3_000); }
    finally {
      if (stop.exitCode === null && stop.signalCode === null) stop.kill('SIGKILL');
      await stop.exited;
      await rm(runtime, { recursive: true, force: true });
    }
  }
  try {
    await mkdir(templates, { mode: 0o700 });
    await mkdir(join(directory, 'bin'), { mode: 0o700 });
    await Promise.all([
      writeFile(join(templates, 'engineering.md'), template.replace('sample product pages', 'engineering projects'), { mode: 0o600 }),
      writeFile(join(templates, 'web.md'), template, { mode: 0o600 }),
      writeFile(join(templates, 'admin.md'), template.replace('sample product pages', 'client records'), { mode: 0o600 }),
      mode === 'crash'
        ? writeFile(join(directory, 'bin', 'browser-use'), [
          '#!/bin/sh',
          `printf '%s\\n' "$BH_RUNTIME_DIR" > ${shellQuote(browserRuntimeMarker)}`,
          `exec ${shellQuote(browserUseCommand)} "$@"`,
          '',
        ].join('\n'), { mode: 0o700 })
        : symlink(browserUseCommand, join(directory, 'bin', 'browser-use')),
    ]);
    process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR = templates;
    const restoredDraft = handoff ? await prisma.jobApplication.findUniqueOrThrow({
      where: { ownerId_id: { ownerId, id: handoff.application[0].id } },
    }) : null;
    if (handoff && restoredDraft) {
      expect(restoredDraft).toMatchObject({ id: handoff.application[0].id, status: 'review', revision: 1,
        pilotHeldAt: expect.any(Date), sourceUrl: 'https://job-boards.greenhouse.io/synthetic-studio/jobs/197' });
      expect(await prisma.jobPilotPermit.findUnique({ where: { ownerId_id: { ownerId, id: handoff.permitId } } }))
        .toMatchObject({ applicationId: restoredDraft.id, allowanceId: handoff.allowance.id, sourceIdentity: handoff.sourceIdentity,
          settledKeepResultId: handoff.screen.id, revision: 0 });
      expect(await prisma.jobPilotAllowance.findUnique({ where: { ownerId_id: { ownerId, id: handoff.allowance.id } } }))
        .toMatchObject({ heldNanoUsd: 0n, spentNanoUsd: 35_600_000n, screenCalls: 1, enrichCalls: 1, tailorCalls: 1 });
      // Restore the short permit window for an archived fixture. The held application stays unchanged.
      await prisma.jobPilotPermit.update({ where: { ownerId_id: { ownerId, id: handoff.permitId } }, data: {
        expiresAt: new Date(Date.now() + 300_000),
      } });
    }
    const fixturePosting = restoredDraft
      ? { sourceUrl: restoredDraft.sourceUrl, company: restoredDraft.company, role: restoredDraft.role } : syntheticPosting;
    const summaryForApproval = restoredDraft?.summary ?? ownerSummary;
    await writeLocal('private.json', { resumePaths: { web: '/synthetic/template.tex' } });
    await writeLocal('public-candidate-form-manifests.json', { forms: [{ ...fixturePosting, listingUrl: fixturePosting.sourceUrl,
      kind: 'discovered', identityCheck: 'verified', fields: [syntheticQuestion] }] });
    await prisma.$transaction(async tx => {
      await tx.user.create({ data: owner });
      await tx.authOwner.create({ data: { id: 'singleton', userId: ownerId } });
    });
    const { credential, secret: feedKey } = await createApiKey({
      userId: ownerId, name: 'Synthetic n8n feed', preset: 'custom', permissionIds: ['jobs:import-tailored'],
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    issuedClientIds.push(credential.id);
    expect(credential.permissions).toEqual(['jobs:import-tailored']);
    const feedRequest = (path: string, method: string, body: unknown, command: string = randomUUID()) => fetch(new URL(path, baseUrl), {
      method, headers: { 'X-API-Key': feedKey, 'Content-Type': 'application/json', 'Idempotency-Key': command },
      body: JSON.stringify(body),
    });
    const row = { ...syntheticPosting, sourceIdentity: syntheticSourceIdentity, track: 'web',
      postingText: 'Fit note: Publish catalog updates remotely from Canada.' };
    async function importDraft(key: string, posting = row) {
      const response = await feedRequest('/api/v1/jobs/applications/import', 'POST', { applications: [posting] }, key);
      await assertStatus(response, 200);
      return jobsImportApplicationsOutput.parse(await response.json());
    }
    const importStarted = performance.now();
    if (!handoff) {
      expect(await importDraft('feed-first')).toEqual({ imported: 1, duplicates: 0 });
      expect(await importDraft('feed-first')).toEqual({ imported: 1, duplicates: 0 });
      expect(await importDraft('feed-next', { ...row, sourceUrl: row.sourceUrl.replace('job-boards.', 'boards.') }))
        .toEqual({ imported: 0, duplicates: 1 });
    }
    timings.import = performance.now() - importStarted;
    const applications = await prisma.jobApplication.findMany({ where: { ownerId } });
    expect(applications).toHaveLength(1);
    const { id: applicationId, applicationAddress } = applications[0];
    expect(applications[0]).toMatchObject({ status: handoff ? 'review' : 'draft', sourceUrl: fixturePosting.sourceUrl });
    if (handoff) expect(applicationId).toBe(handoff.application[0].id);
    expect(await prisma.jobProviderPosting.findMany({ where: { ownerId } }))
      .toEqual([{ ownerId, sourceIdentity: handoff?.sourceIdentity ?? syntheticSourceIdentity, applicationId }]);
    expect(await prisma.jobWorkItem.findMany({ where: { ownerId }, orderBy: { kind: 'asc' }, select: { kind: true, state: true, applicationId: true } }))
      .toEqual(handoff ? [{ kind: 'enrich', state: 'done', applicationId }, { kind: 'tailor', state: 'done', applicationId }]
        : [{ kind: 'enrich', state: 'queued', applicationId }]);
    const applicationPath = `/api/v1/jobs/applications/${applicationId}`;
    phase = 'prepare';
    const prepareStarted = performance.now();
    const names = [
      { key: 'firstName', label: 'First name', value: syntheticCandidate.firstName },
      { key: 'lastName', label: 'Last name', value: syntheticCandidate.lastName },
    ].map(field => ({ ...field, type: 'text', scope: { kind: 'global' }, expectedVersion: null }));
    await assertStatus(await ownerRequest('/api/v1/jobs/private-fields', 'PATCH', { fields: names }), 200);

    const codexApi = createJobsWorkClient({ baseUrl, secret: codex });
    const feedAsWorker = createJobsWorkClient({ baseUrl, secret: feedKey });
    const wrongApi = createJobsWorkClient({ baseUrl, secret: 'wrong-fixture-token' });
    await expect(wrongApi.claim({ workerId: 'wrong-fixture', kinds: ['enrich'] })).rejects.toMatchObject({ status: 401 });
    await assertStatus(await feedRequest(jobsWorkerPath + '/work/claim', 'POST', { workerId: 'fixture-feed', kinds: ['enrich'] }), 401);
    await expect(feedAsWorker.claim({ workerId: 'fixture-feed', kinds: ['enrich'] })).rejects.toMatchObject({ status: 401 });
    await expect(codexApi.claim({ workerId: 'fixture-codex', kinds: ['submit'] })).rejects.toMatchObject({ status: 403 });
    let modelCalls = 0;
    if (!handoff) {
      expect(await runJobsCodexBatch({ api: codexApi, workerId: 'fixture-codex',
        outbox: createJobsWorkOutbox(join(directory, 'codex-outbox'), codexApi),
        async runModel({ prompt }) {
          modelCalls++;
          if (modelCalls === 1) {
            expect(prompt).toContain('Publish catalog updates remotely from Canada.');
            return JSON.stringify({ doing: 'Publish catalog updates.', remote: 'confirmed',
              companySize: { people: null, label: 'Unknown' }, automatable: 'medium',
              humanContact: { level: 'low', note: 'Requests from marketing' }, meetings: { level: 'rare', note: 'Monthly planning' },
              eligible: true, ineligibleReason: null, pay: { min: 41600, max: 62400, currency: 'CAD', period: 'year' },
              verdict: 'strong', dueDate: null });
          }
          expect(prompt).toContain('"hourlyCad":{"min":20,"max":30}');
          expect(prompt).toContain('Edited sample product pages');
          return JSON.stringify({ summaryMarkdown: generatedSummary });
        },
      })).toMatchObject({ claimed: 2, completed: 2, failed: 0 });
      expect(modelCalls).toBe(2);
      const review = await ownerRequest(`/api/v1/jobs/review-session?ids=${applicationId}`);
      await assertStatus(review, 200);
      expect(await review.json()).toMatchObject({ items: [{ id: applicationId, status: 'review', revision: 1, summaryMarkdown: generatedSummary }] });
      const detail = await ownerRequest(applicationPath);
      await assertStatus(detail, 200);
      expect(await detail.json()).toMatchObject({ application: { id: applicationId, track: 'web', summaryMarkdown: generatedSummary } });

      const edit = { expectedRevision: 1, summaryMarkdown: ownerSummary };
      await assertStatus(await feedRequest(applicationPath, 'PATCH', edit), 403);
      const edited = await ownerRequest(applicationPath, 'PATCH', edit);
      await assertStatus(edited, 200);
      expect(await edited.json()).toMatchObject({ application: { revision: 2, approvedRevision: null, summaryMarkdown: ownerSummary } });
      await assertStatus(await ownerRequest(`${applicationPath}/decision`, 'POST', { action: 'approve', expectedRevision: 1 }), 409);
    } else {
      const review = await ownerRequest(`/api/v1/jobs/review-session?ids=${applicationId}`);
      await assertStatus(review, 200);
      expect(await review.json()).toMatchObject({ items: [{ id: applicationId, status: 'review', revision: approvalRevision, summaryMarkdown: summaryForApproval }] });
      await assertStatus(await ownerRequest(`${applicationPath}/decision`, 'POST', { action: 'approve', expectedRevision: 0 }), 409);
    }
    const approval = { action: 'approve', expectedRevision: approvalRevision };
    await assertStatus(await feedRequest(`${applicationPath}/decision`, 'POST', approval), 403);
    const approved = await ownerRequest(`${applicationPath}/decision`, 'POST', approval);
    await assertStatus(approved, 200);
    expect(await approved.json()).toMatchObject({ application: { id: applicationId, status: 'approved' } });
    expect(await prisma.jobApplication.findUnique({ where: { ownerId_id: { ownerId, id: applicationId } } }))
      .toMatchObject({ approvedRevision: approvalRevision, approvedPreviewDigest: null });
    const rawRunner = createJobsWorkClient({ baseUrl, secret: runner });
    expect(await rawRunner.claim({ workerId: 'fixture-mac', kinds: ['submit'] })).toBeNull();
    const pilotReviewPath = (permitId: string) => `/api/v1/jobs/pilot/permits/${permitId}/review`;
    const preview = { action: 'prepare', applicationId, expectedRevision: approvalRevision };
    const release = { ...preview, action: 'release', sha256: digest };
    if (handoff) {
      expect(await rawRunner.claim({ workerId: 'fixture-mac', kinds: ['render', 'submit'] })).toBeNull();
      await assertStatus(await ownerRequest(pilotReviewPath(handoff.permitId), 'POST', release), 409);
      const prepared = await ownerRequest(pilotReviewPath(handoff.permitId), 'POST', preview);
      await assertStatus(prepared, 200);
      expect(await prepared.json()).toMatchObject({ action: 'prepare', applicationId, revision: approvalRevision, sha256: null });
      const closed = createApp({ emitAccessLog: () => {}, jobsWorkers: { db: prisma, secrets: () => ({ codex, runner }) } });
      expect((await closed.request(`${baseUrl}${pilotReviewPath(handoff.permitId)}`, { method: 'POST', headers: {
        Origin: origin, 'x-quantself-owner-proof': proof, 'content-type': 'application/json', 'idempotency-key': randomUUID(),
      }, body: JSON.stringify(preview) })).status).toBe(404);
      const closedClaim = await closed.request(`${baseUrl}/api/internal/jobs/work/claim`, { method: 'POST', headers: {
        Authorization: `Bearer ${runner}`, 'content-type': 'application/json',
      }, body: JSON.stringify({ workerId: 'fixture-mac', kinds: ['render', 'submit'] }) });
      await assertStatus(closedClaim, 200);
      expect(await closedClaim.json()).toEqual({ work: null });
      expect(await prisma.jobApplication.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id: applicationId } } })).toMatchObject({
        pilotHeldAt: expect.any(Date), approvedPreviewDigest: null,
      });
    }

    let allowPortal = false;
    const api = createJobsWorkClient({ baseUrl, secret: runner, fetchImpl: (async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      expect(url.origin).toBe(baseUrl);
      if (init?.method === 'PUT') {
        headers.set('x-content-sha256', '0'.repeat(64));
        await assertStatus(await fetch(url, { ...init, headers }), 400);
        expect(stored.size).toBe(0);
      }
      if (init?.method === 'GET' && url.pathname.endsWith(`/${approvalRevision}/pdf`)) {
        const wrongRevision = new URL(url);
        wrongRevision.pathname = wrongRevision.pathname.replace(`/${approvalRevision}/pdf`, `/${approvalRevision - 1}/pdf`);
        await assertStatus(await fetch(wrongRevision, init), 409);
      }
      return fetch(url, init);
    }) as typeof fetch });
    await api.heartbeat('fixture-mac');
    const outbox = createJobsWorkOutbox(outboxDirectory, api);
    const worker: Parameters<typeof runJobsMacOnce>[0] = {
      api, outbox, workerId: 'fixture-mac', cdpUrl: '', paused: false,
      async render({ revision, summary, resumeMarkdown }) {
        expect(revision).toBe(approvalRevision);
        expect(summary).toBe(summaryForApproval);
        expect(resumeMarkdown).toContain(handoff ? 'Maintained catalogs' : 'Published sample catalog changes');
        return { path: '', pdf: syntheticPdf(revision) };
      },
      submit(work, options) {
        if (!allowPortal) throw new Error('Unexpected browser submit attempt.');
        return submitApplication(work, { ...options, browserUseCommand });
      },
    };
    expect(await runJobsMacOnce(worker)).toBe(true);
    expect(stored.size).toBe(1);
    expect(Buffer.from([...stored.values()][0])).toEqual(expectedPdf);
    expect(await prisma.jobRevision.findUnique({ where: { ownerId_applicationId_revision: { ownerId, applicationId, revision: approvalRevision } } }))
      .toMatchObject({ pdfSha256: digest });
    if (!handoff) expect(await prisma.jobWorkItem.count({ where: {
      applicationId, revision: 1, kind: 'render', state: { in: ['queued', 'claimed', 'done'] },
    } })).toBe(0);

    portal = await openSyntheticPortal(directory, digest, applicationAddress, mode === 'crash' ? async () => {
      portalAccepted.resolve();
      await releasePortal.promise;
      return new Response(null, { status: 503 });
    } : undefined, fixturePosting.sourceUrl);
    allowPortal = true;
    const browserWorker = { ...worker, cdpUrl: portal.cdpUrl };
    if (handoff) {
      const started = performance.now();
      const path = pilotReviewPath(handoff.permitId);
      const pdf = await ownerRequest(`${applicationPath}/resume.pdf?revision=${approvalRevision}`);
      await assertStatus(pdf, 200);
      expect(sha256(new Uint8Array(await pdf.arrayBuffer()))).toBe(release.sha256);
      expect(await rawRunner.claim({ workerId: 'fixture-mac', kinds: ['submit'] })).toBeNull();
      await assertStatus(await feedRequest(path, 'POST', release), 403);

      const wrongOwner = createApp({
        emitAccessLog: () => {}, registerRoutes: api => registerJobsPilotReviewRoute(api, prisma),
        resolveAccessContext: async () => ({ owner: { ...owner, id: randomUUID() }, permissions: ['jobs:write'],
          client: { kind: 'web', id: 'other-fixture-owner', name: 'Other fixture Owner' } }),
      });
      expect((await wrongOwner.request(`${baseUrl}${path}`, { method: 'POST', headers: {
        Origin: origin, 'content-type': 'application/json', 'idempotency-key': randomUUID(),
      }, body: JSON.stringify(release) })).status).toBe(404);

      await assertStatus(await ownerRequest(path, 'POST', { ...release, expectedRevision: approvalRevision - 1 }), 409);
      await assertStatus(await ownerRequest(path, 'POST', { ...release, expectedRevision: approvalRevision + 1 }), 409);
      await assertStatus(await ownerRequest(path, 'POST', { ...release, sha256: '0'.repeat(64) }), 409);
      await assertStatus(await ownerRequest(path, 'POST', { ...release, applicationId: randomUUID() }), 409);
      await assertStatus(await ownerRequest(pilotReviewPath(randomUUID()), 'POST', release), 404);
      const otherPermit = await ownerRequest('/api/v1/jobs/pilot/permits', 'POST', {
        sourceIdentity: 'greenhouse:global:quantself-fixture:123', expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      await assertStatus(otherPermit, 200);
      const otherPermitId = z.object({ id: z.uuid() }).parse(await otherPermit.json()).id;
      await assertStatus(await ownerRequest(pilotReviewPath(otherPermitId), 'POST', release), 409);
      await assertStatus(await ownerRequest(`/api/v1/jobs/pilot/permits/${handoff.permitId}/revoke`, 'POST', {}), 200);
      await assertStatus(await ownerRequest(path, 'POST', release), 409);
      expect(await rawRunner.claim({ workerId: 'fixture-mac', kinds: ['submit'] })).toBeNull();
      // Restore the same disposable permit after testing the real revoke endpoint.
      await prisma.jobPilotPermit.update({ where: { ownerId_id: { ownerId, id: handoff.permitId } }, data: { revokedAt: null } });

      const releaseKey = randomUUID();
      const freshReleaseKey = randomUUID();
      const [firstRelease, sameKeyRelease, freshKeyRelease, workerClaimedDuringRace] = await Promise.all([
        ownerRequest(path, 'POST', release, undefined, releaseKey), ownerRequest(path, 'POST', release, undefined, releaseKey),
        ownerRequest(path, 'POST', release, undefined, freshReleaseKey), runJobsMacOnce(browserWorker),
      ]);
      // Either fresh key can win. The winning key replays and the other key conflicts.
      const winner = firstRelease.status === 200 ? firstRelease : freshKeyRelease;
      const loser = winner === firstRelease ? freshKeyRelease : firstRelease;
      const winningKey = winner === firstRelease ? releaseKey : freshReleaseKey;
      await assertStatus(winner, 200);
      await assertStatus(loser, 409);
      await assertStatus(sameKeyRelease, firstRelease.status);
      const released = await winner.json();
      if (winner === firstRelease) expect(await sameKeyRelease.json()).toEqual(released);
      expect(released).toMatchObject({ applicationId, revision: approvalRevision, sha256: digest, action: 'release' });
      await assertStatus(await ownerRequest(path, 'POST', { ...release, sha256: '0'.repeat(64) }, undefined, winningKey), 409);
      await assertStatus(await ownerRequest(path, 'POST', release), 409);
      if (!workerClaimedDuringRace) expect(await runJobsMacOnce(browserWorker)).toBe(true);
      const replay = await ownerRequest(path, 'POST', release, undefined, winningKey);
      await assertStatus(replay, 200);
      expect(await replay.json()).toEqual(released);
      expect(await prisma.jobEvent.findMany({ where: { ownerId, applicationId, kind: 'pilot_submission_released' }, select: { revision: true, payload: true } }))
        .toEqual([{ revision: approvalRevision, payload: { permitId: handoff.permitId, sha256: digest, workId: released.workId } }]);
      expect(await prisma.jobWorkItem.findMany({ where: { ownerId, applicationId, kind: 'submit' }, select: { id: true, attempts: true } }))
        .toEqual([{ id: released.workId, attempts: 1 }]);
      console.info('Jobs pilot Owner release rehearsal', JSON.stringify({ ...released, permitId: handoff.permitId,
        workerClaimedDuringRace, releaseEvents: 1, submitWorkRows: 1, elapsedMs: Math.round(performance.now() - started) }));
    } else expect(await runJobsMacOnce(browserWorker)).toBe(true);
    expect(portal.clicks()).toBe(0);
    expect(await prisma.jobEvent.count({ where: { ownerId, applicationId, kind: 'submit_started' } })).toBe(0);
    const key = questionKey(syntheticQuestion.label);
    const scope = { kind: 'listing', applicationId };
    const requirementMetadata = { key, label: syntheticQuestion.label, type: 'text', scope };
    expect(await prisma.jobEvent.findFirst({ where: { ownerId, applicationId, kind: 'work_failed' } }))
      .toMatchObject({ payload: { code: 'manual_required', requirements: [requirementMetadata] } });
    const paused = await ownerRequest(applicationPath);
    await assertStatus(paused, 200);
    expect(await paused.json()).toMatchObject({ application: { status: 'needs_attention', issue: 'manual_required',
      revision: approvalRevision, approvedRevision: approvalRevision, privatePauseFieldKeys: [key] } });
    const fields = await ownerRequest(`/api/v1/jobs/private-fields?applicationId=${applicationId}`);
    await assertStatus(fields, 200);
    const requirement = privateFieldsOutput.parse(await fields.json()).fields.find(field => field.key === key);
    if (!requirement) throw new Error('The runner pause did not register its private question.');
    expect(requirement).toMatchObject({ ...requirementMetadata, hasValue: false });
    const answer = await ownerRequest('/api/v1/jobs/private-fields', 'PATCH', { fields: [{
      ...requirementMetadata, expectedVersion: requirement.version, value: syntheticAnswer,
    }] });
    await assertStatus(answer, 200);
    expect(await answer.json()).toMatchObject({ resumedApplicationIds: [applicationId] });
    expect(await prisma.jobApplication.findUnique({ where: { ownerId_id: { ownerId, id: applicationId } } }))
      .toMatchObject({ status: 'queued', revision: approvalRevision, approvedRevision: approvalRevision, approvedPreviewDigest: digest });
    expect(stored.size).toBe(1);

    if (handoff) {
      phase = 'revocation-probe';
      const started = performance.now();
      const claimed = await rawRunner.claim({ workerId: 'fixture-with-revoked-permit', kinds: ['submit'] });
      if (claimed?.kind !== 'submit') throw new Error('Expected the released pilot submit work.');
      expect(claimed).toMatchObject({ applicationId, revision: approvalRevision, input: { sha256: digest } });
      await assertStatus(await ownerRequest(`/api/v1/jobs/pilot/permits/${handoff.permitId}/revoke`, 'POST', {}), 200);
      await expect(rawRunner.submissionEvent(applicationId, { eventId: randomUUID(), workId: claimed.id,
        leaseToken: claimed.leaseToken, step: 'submit_started', state: 'running' })).rejects.toMatchObject({ status: 409 });
      expect(await prisma.jobEvent.count({ where: { ownerId, applicationId, kind: 'submit_started' } })).toBe(0);
      expect(portal.clicks()).toBe(0);
      await rawRunner.report({ id: claimed.id, action: 'fail', body: { resultId: randomUUID(), leaseToken: claimed.leaseToken, code: 'runner_unavailable' } });
      // Undo the synthetic revocation, then use normal Owner resolution to resume the authorized work.
      await prisma.jobPilotPermit.update({ where: { ownerId_id: { ownerId, id: handoff.permitId } }, data: { revokedAt: null } });
      await assertStatus(await ownerRequest(`/api/v1/jobs/submissions/${applicationId}/resolve`, 'POST', { action: 'requeue' }), 200);
      expect(await prisma.jobWorkItem.findMany({ where: { ownerId, applicationId, kind: 'submit' }, select: { id: true, state: true } }))
        .toEqual([{ id: claimed.id, state: 'queued' }]);
      timings['revocation-probe'] = performance.now() - started;
      phase = 'prepare';
    }

    await expect(feedAsWorker.claim({ workerId: 'fixture-feed', kinds: ['submit'] })).rejects.toMatchObject({ status: 401 });
    timings.prepare = performance.now() - prepareStarted;
    phase = 'submit';
    const submitStarted = performance.now();
    const first = child = startWorker(portal.cdpUrl, mode === 'replay');
    const firstError = new Response(first.stderr).text();
    await bounded(Promise.race([gateAccepted.promise, first.exited.then(async code => {
      throw new Error(`Runner exited before submit acknowledgement (${code}): ${await firstError}`);
    })]), 'durable submit_started');
    expect(await prisma.jobEvent.count({ where: { ownerId, applicationId, kind: 'submit_started' } })).toBe(1);
    expect(portal.clicks()).toBe(0);
    expect(await readdir(outboxDirectory)).toHaveLength(1);
    deliverGate.resolve();
    if (mode === 'crash') {
      await bounded(Promise.race([portalAccepted.promise, first.exited.then(async code => {
        throw new Error(`Runner exited before the synthetic POST (${code}): ${await firstError}`);
      })]), 'accepted synthetic POST');
      const starts = await prisma.jobEvent.findMany({ where: { ownerId, applicationId, kind: 'submit_started' } });
      const work = await prisma.jobWorkItem.findUniqueOrThrow({
        where: { ownerId_applicationId_kind_revision: { ownerId, applicationId, kind: 'submit', revision: approvalRevision } },
      });
      expect(starts).toEqual([expect.objectContaining({ revision: approvalRevision,
        payload: { step: 'submit_started', state: 'running', workId: work.id, attempt: work.attempts } })]);
      expect(work.state).toBe('claimed');
      expect(portal.clicks()).toBe(1);
      expect(portal.validSubmissions()).toBe(1);
      expect(receiptReports).toEqual([]);
      const [pending] = await readdir(outboxDirectory);
      const hold = JSON.parse(await readFile(join(outboxDirectory, pending), 'utf8'));
      expect(hold).toMatchObject({ id: work.id, action: 'fail', body: { code: 'submission_uncertain' } });
      expect(first.exitCode).toBeNull();
      expect(first.signalCode).toBeNull();
      killWorkerGroup(first.pid);
      await bounded(first.exited, 'worker SIGKILL');
      expect(first.signalCode).toBe('SIGKILL');
      expect(await readFile(join(directory, 'worker-v2.lock'), 'utf8')).toBe(String(first.pid));
      timings.submit = performance.now() - submitStarted;

      phase = 'restart';
      const restartStarted = performance.now();
      const portalRequests = portal.requests();
      const restarted = child = startWorker(portal.cdpUrl);
      const restartError = new Response(restarted.stderr).text();
      expect(restarted.pid).not.toBe(first.pid);
      expect(await bounded(restarted.exited, 'fresh worker reconciliation')).toBe(0);
      expect(await restartError).toBe('');
      timings.restart = performance.now() - restartStarted;
      expect(calls.restart).toEqual({
        'POST /api/internal/jobs/runner/heartbeat': 1,
        'POST /api/internal/jobs/work/:id/fail': 1,
        'POST /api/internal/jobs/work/claim': 1,
      });
      expect(failureReports).toEqual([{ body: hold.body, status: 200 }]);
      expect(portal.requests()).toBe(portalRequests);
      expect(portal.clicks()).toBe(1);
      expect(await readdir(outboxDirectory)).toEqual([]);
      expect(receiptReports).toEqual([]);

      phase = 'reconcile';
      const reconcileStarted = performance.now();
      const submissions = await ownerRequest('/api/v1/jobs/submissions');
      await assertStatus(submissions, 200);
      const item = jobsSubmissionsOutput.parse(await submissions.json()).items.find(item => item.id === applicationId);
      expect(item).toMatchObject({ status: 'needs_attention', issue: 'submission_uncertain', receipt: null, appliedAt: null });
      expect(item?.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({ label: 'Submitted', state: 'failed' }),
        expect.objectContaining({ label: 'Receipt captured', state: 'pending' }),
      ]));
      expect(await prisma.jobWorkItem.findUnique({ where: { ownerId_id: { ownerId, id: work.id } } }))
        .toMatchObject({ state: 'failed', failureCode: 'submission_uncertain', resultId: hold.body.resultId });
      expect(await prisma.jobApplication.findUnique({ where: { ownerId_id: { ownerId, id: applicationId } } }))
        .toMatchObject({ receipt: null, receiptCode: null, appliedAt: null, sesMessageId: null });
      expect(await prisma.jobEvent.count({ where: { ownerId, applicationId, kind: 'submit_started' } })).toBe(1);
      const receipts = await prisma.jobEvent.count({ where: { ownerId, applicationId, OR: [
        { kind: 'receipt_recorded' },
        { kind: 'submission_step', payload: { path: ['step'], equals: 'receipt_captured' } },
        { kind: 'submission_step', payload: { path: ['step'], equals: 'submitted' } },
      ] } });
      expect(receipts).toBe(0);
      expect(portal.requests()).toBe(portalRequests);
      timings.reconcile = performance.now() - reconcileStarted;
      console.info('Jobs worker crash rehearsal', JSON.stringify({
        applicationId, startEventId: starts[0].id, startAt: starts[0].occurredAt, workId: work.id,
        workerPid: first.pid, restartPid: restarted.pid, signal: first.signalCode, ownerIssue: item?.issue,
        apiCalls: calls, milliseconds: timings, portalRequests, portalReads: portal.pageReads(),
        portalPosts: portal.clicks(), validPortalPosts: portal.validSubmissions(),
        restartPortalRequests: portal.requests() - portalRequests, receiptRequests: receiptReports.length, receiptEvents: receipts,
      }));
      return;
    }
    expect(await bounded(first.exited, 'worker after dropping the committed receipt')).toBe(1);
    expect((await firstError).trim()).toBe('jobs_work_api_unavailable');
    timings.submit = performance.now() - submitStarted;
    expect(portal.clicks()).toBe(1);
    expect(portal.validSubmissions()).toBe(1);
    expect(await readdir(outboxDirectory)).toHaveLength(1);
    expect(receiptReports.map(report => report.status)).toEqual([200]);
    expect(await prisma.jobEvent.count({ where: { ownerId, applicationId, kind: 'receipt_recorded' } })).toBe(1);
    expect(await prisma.jobApplication.findUnique({ where: { ownerId_id: { ownerId, id: applicationId } } }))
      .toMatchObject({ status: 'applied', receiptCode: 'confirmation_page' });
    allowPortal = false;
    phase = 'restart';
    const restartStarted = performance.now();
    const portalRequests = portal.requests();
    const restarted = child = startWorker(portal.cdpUrl);
    const restartError = new Response(restarted.stderr).text();
    expect(restarted.pid).not.toBe(first.pid);
    expect(await bounded(restarted.exited, 'worker receipt replay')).toBe(0);
    expect(await restartError).toBe('');
    timings.restart = performance.now() - restartStarted;
    expect(Object.entries(calls.restart)).toEqual([
      ['POST /api/internal/jobs/runner/heartbeat', 1],
      ['POST /api/internal/jobs/work/:id/complete', 1],
      ['POST /api/internal/jobs/work/claim', 1],
    ]);
    expect(portal.requests()).toBe(portalRequests);
    expect(portal.clicks()).toBe(1);
    expect(await readdir(outboxDirectory)).toEqual([]);
    expect(receiptReports.map(report => report.status)).toEqual([200, 200]);
    expect(receiptReports[1].body).toBe(receiptReports[0].body);
    expect(await prisma.jobEvent.count({ where: { ownerId, applicationId, kind: 'receipt_recorded' } })).toBe(1);
    const submittedKey = { ownerId_id: { ownerId, id: applicationId } };
    const submitted = await prisma.jobApplication.findUniqueOrThrow({ where: submittedKey });
    expect(submitted).toMatchObject({ id: applicationId, applicationAddress,
      approvedRevision: approvalRevision, approvedPreviewDigest: digest, status: 'applied', receiptCode: 'confirmation_page',
      receipt: { code: 'confirmation_page', capturedAt: expect.any(String) }, sesMessageId: null });
    const receiptEvents = () => prisma.jobEvent.findMany({ where: { ownerId, applicationId, kind: 'receipt_recorded' } });
    const originalReceipt = await receiptEvents();

    phase = 'reply';
    const replyStarted = performance.now();
    const replyAgent = await createAgentApiKey({ userId: ownerId, name: 'Synthetic reply Agent', permissionIds: ['jobs:read', 'jobs:write'] });
    issuedClientIds.push(replyAgent.client.id);
    async function cli(command: string, ...args: string[]) {
      const child = Bun.spawn([process.execPath, '--no-env-file', 'packages/cli/src/index.ts', command, ...args], {
        env: { PATH: process.env.PATH, QUANTSELF_API_URL: baseUrl, QUANTSELF_API_KEY: replyAgent.secret },
        stdout: 'pipe', stderr: 'pipe',
      });
      try {
        const [code, output, error] = await bounded(Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]), 'reply CLI ' + command, 6_000);
        return { code, body: JSON.parse(code === 0 ? output : error) };
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await child.exited;
      }
    }
    let matchedId = applicationId;
    let sourceReply = { folder: 'INBOX/Synthetic', uid: 198 };
    let mailboxUidvalidity: number | undefined;
    if (handoff) {
      const mailboxStarted = performance.now();
      const quantself = join(directory, 'bin', 'quantself-mail-fixture');
      await Bun.write(quantself, `#!/bin/sh\nexec ${shellQuote(process.execPath)} --no-env-file packages/cli/src/index.ts "$@"\n`);
      await chmod(quantself, 0o700);
      const mail = Bun.spawn(['python3', '-B', 'agents/sam/jobs-mail/rehearse_match.py', submitted.applicationAddress!, quantself], {
        env: { PATH: process.env.PATH, QUANTSELF_API_URL: baseUrl, QUANTSELF_API_KEY: replyAgent.secret },
        stdout: 'pipe', stderr: 'pipe',
      });
      try {
        const [code, output, error] = await bounded(Promise.all([
          mail.exited, new Response(mail.stdout).text(), new Response(mail.stderr).text(),
        ]), 'synthetic mailbox matching');
        if (code !== 0) throw new Error(`Synthetic mailbox fixture failed: ${error}`);
        const matches = z.array(z.object({ uid: z.number().int().positive(), uidvalidity: z.literal(345),
          match: z.object({ status: z.string(), reason: z.string().optional(), application_id: z.uuid().optional(), source: z.string().optional() }),
          imapCommands: z.array(z.string()).min(5).max(6), elapsedMs: z.number().nonnegative(),
        })).length(3).parse(JSON.parse(output));
        expect(matches.map(({ match }) => match)).toEqual([
          { status: 'needs_review', reason: 'no_verified_match' },
          { status: 'needs_review', reason: 'conflicting_match' },
          { status: 'matched', application_id: applicationId, source: 'smtp_recipient' },
        ]);
        expect(replyRequests).toEqual([['POST /api/v1/jobs/applications/resolve-reply', 200]]);
        expect(await prisma.jobApplication.findUniqueOrThrow({ where: submittedKey })).toEqual(submitted);
        expect(await prisma.agentWriteAudit.count({ where: { ownerId, resourceId: applicationId } })).toBe(0);
        expect(await receiptEvents()).toEqual(originalReceipt);
        matchedId = matches[2].match.application_id!;
        sourceReply = { folder: 'INBOX', uid: matches[2].uid };
        mailboxUidvalidity = matches[2].uidvalidity;
        console.info('Jobs mailbox reply rehearsal', JSON.stringify({ applicationId: matchedId, receiptEventId: originalReceipt[0].id,
          sourceReply, messages: matches, requests: [...replyRequests], elapsedMs: Math.round(performance.now() - mailboxStarted) }));
      } finally {
        if (mail.exitCode === null && mail.signalCode === null) mail.kill('SIGKILL');
        await mail.exited;
      }
    } else {
      const match = await cli('resolveJobApplicationReply', '--body', JSON.stringify({ address: submitted.applicationAddress }));
      expect(match).toEqual({ code: 0, body: { id: applicationId } });
    }
    const applicationArg = JSON.stringify({ id: matchedId });
    const lifecycleStarted = performance.now();
    const readLifecycle = async () => jobLifecycleOutput.parse((await cli('getJobLifecycle', '--path', applicationArg)).body);
    const initial = await readLifecycle();
    expect(initial).toMatchObject({ application: { id: applicationId, status: 'applied' }, revision: 0, sourceReplyLinked: false });
    const outcome = (revision: number, key = randomUUID()) => cli('patchJobApplication', '--path', applicationArg,
      '--body', JSON.stringify({ status: 'interviewing', expectedRevision: revision, sourceReply }), '--idempotency-key', key);
    expect((await outcome(initial.revision)).body).toMatchObject({ status: 409, message: expect.stringContaining('last 3 minutes') });
    const ageOwnerHold = () => prisma.jobApplication.update({ where: submittedKey, data: { lastOwnerEditedAt: new Date(Date.now() - 181_000) } });
    await ageOwnerHold();
    const outcomeKey = randomUUID();
    const recorded = jobLifecycleOutput.parse((await outcome(initial.revision, outcomeKey)).body);
    expect(recorded).toMatchObject({ application: { id: applicationId, status: 'interviewing' }, revision: 1, sourceReplyLinked: true });
    expect(recorded.auditId).toBeString();
    expect(await outcome(initial.revision, outcomeKey)).toEqual({ code: 0, body: recorded });
    expect((await outcome(initial.revision)).body).toMatchObject({ status: 409, message: expect.stringContaining('revision changed') });
    const audits = () => prisma.agentWriteAudit.findMany({ where: { ownerId, resourceId: applicationId }, orderBy: { revisionAfter: 'asc' } });
    expect(await audits()).toEqual([expect.objectContaining({ id: recorded.auditId, clientId: replyAgent.client.id,
      revisionBefore: 0, revisionAfter: 1,
      before: { kind: 'post-application-status', status: 'applied', changedAt: initial.changedAt, sourceReply: null },
      after: { kind: 'post-application-status', status: 'interviewing', changedAt: recorded.changedAt, sourceReply }, undoneAt: null })]);
    expect(await receiptEvents()).toEqual(originalReceipt);

    const undoPath = '/api/v1/agent-audit/' + recorded.auditId + '/undo';
    async function undoOutcome(label: string) {
      return bounded((async () => {
        const response = await ownerRequest(undoPath, 'POST', undefined, AbortSignal.timeout(6_000));
        await assertStatus(response, 200);
        return response.json();
      })(), label, 7_000);
    }
    const undone = await undoOutcome('Owner reply Undo');
    expect(await undoOutcome('Owner reply Undo replay')).toEqual(undone);
    const restored = await readLifecycle();
    expect(restored).toMatchObject({ application: { id: applicationId, status: 'applied' }, revision: 2, sourceReplyLinked: false });
    expect(await receiptEvents()).toEqual(originalReceipt);
    await ageOwnerHold();
    const reapplied = jobLifecycleOutput.parse((await outcome(restored.revision)).body);
    expect(reapplied).toMatchObject({ application: { id: applicationId, status: 'interviewing' }, revision: 3, sourceReplyLinked: true });
    expect(await audits()).toEqual([
      expect.objectContaining({ id: recorded.auditId, undoneAt: expect.any(Date) }),
      expect.objectContaining({ id: reapplied.auditId, revisionBefore: 2, revisionAfter: 3, undoneAt: null }),
    ]);
    expect(await prisma.jobApplication.findUniqueOrThrow({ where: submittedKey })).toMatchObject({
      applicationAddress, sourceReply, revision: approvalRevision, approvedRevision: approvalRevision, approvedPreviewDigest: digest,
      receipt: submitted.receipt, receiptCode: submitted.receiptCode, appliedAt: submitted.appliedAt, sesMessageId: null,
    });
    expect(await receiptEvents()).toEqual(originalReceipt);
    expect(portal.requests()).toBe(portalRequests);
    timings.reply = performance.now() - replyStarted;
    console.info('Chrome draft reply rehearsal', JSON.stringify({
      applicationId, receiptEventId: originalReceipt[0].id, statusAuditId: recorded.auditId, reappliedAuditId: reapplied.auditId,
      states: [initial, recorded, restored, reapplied].map(value => [value.application.status, value.revision]),
      sourceReply, requests: replyRequests, elapsedMs: Math.round(timings.reply), lifecycleMs: Math.round(performance.now() - lifecycleStarted),
      repeatPortalRequests: portal.requests() - portalRequests,
    }));

    if (handoff) {
      phase = 'appointment';
      const appointmentStarted = performance.now();
      const scheduler = await createAgentApiKey({ userId: ownerId, name: 'Synthetic scheduling Agent',
        permissionIds: ['jobs:read', 'jobs:schedule-interview'] });
      issuedClientIds.push(scheduler.client.id);
      const start = new Date(Date.now() + 7 * 86_400_000);
      start.setUTCHours(14, 0, 0, 0);
      const end = new Date(start.getTime() + 1_800_000);
      const nativeTime = { start: start.toISOString(), end: end.toISOString(), expectedRevision: reapplied.revision };
      const equivalent = (date: Date) => new Date(date.getTime() - 14_400_000).toISOString().replace('Z', '-04:00');
      const appointmentKey = randomUUID();
      ownerCommandKeys.push(appointmentKey);
      const firstApi = await scheduleInFreshJobsApi(connection.href, scheduler.secret, appointmentKey, applicationId, nativeTime);
      const restartedApi = await scheduleInFreshJobsApi(connection.href, scheduler.secret, appointmentKey, applicationId, {
        start: equivalent(start), end: equivalent(end), expectedRevision: reapplied.revision,
      });
      expect(restartedApi.pid).not.toBe(firstApi.pid);
      expect(restartedApi.result).toEqual(firstApi.result);
      expect(firstApi.result.appointment).toMatchObject({ source: 'native', revision: 1, cancelledAt: null });
      const interview = { ownerId, applicationId };
      expect(await prisma.jobInterview.count({ where: interview })).toBe(1);
      expect(await prisma.jobInterviewAppointment.findMany({ where: { interview }, select: { id: true } }))
        .toEqual([{ id: firstApi.result.appointment.id }]);
      expect(await prisma.agentWriteAudit.findUnique({ where: { id: firstApi.result.auditId! } })).toMatchObject({
        clientId: scheduler.client.id, resourceType: 'jobInterviewAppointment', resourceId: firstApi.result.appointment.id,
      });
      expect(await receiptEvents()).toEqual(originalReceipt);
      expect(await prisma.jobApplication.findUniqueOrThrow({ where: submittedKey })).toMatchObject({
        id: applicationId, status: 'interviewing', approvedRevision: approvalRevision, approvedPreviewDigest: digest,
        receipt: submitted.receipt, receiptCode: submitted.receiptCode, appliedAt: submitted.appliedAt,
      });
      expect(portal.requests()).toBe(portalRequests);
      timings.appointment = performance.now() - appointmentStarted;
      console.info('Jobs n8n to Appointment rehearsal', JSON.stringify({
        applicationId, approvedRevision: approvalRevision, approvedPdfSha256: digest, receiptEventId: originalReceipt[0].id,
        outcomeAuditId: reapplied.auditId, appointmentId: firstApi.result.appointment.id, appointmentAuditId: firstApi.result.auditId,
        apiCalls: calls, milliseconds: timings, portalRequests, portalReads: portal.pageReads(), portalPosts: portal.clicks(),
        pilotSubmissionAuthorized: true, postsBeforeSubmitAck: 0, receiptReplayIdentical: true, appointmentRows: 1,
        receiptStatuses: receiptReports.map(report => report.status),
        appointmentRequests: [firstApi, restartedApi].map(({ pid, status, startupMs, requestMs }) => ({ pid, status, startupMs, requestMs })),
      }));
      phase = 'reply-send';
      if (!mailboxUidvalidity || !submitted.applicationAddress) throw new Error('The verified mailbox reply is required.');
      // Advance beyond the existing three-minute reply hold in disposable data.
      const beforeSend = await prisma.jobApplication.update({ where: submittedKey, data: { updatedAt: new Date(Date.now() - 181_000) } });
      const send = await rehearseThreadedReply({ directory, address: submitted.applicationAddress, applicationId: matchedId,
        ref: { ...sourceReply, uidvalidity: mailboxUidvalidity }, secret: replyAgent.secret, fetchJobs: request => app.fetch(request) });
      expect(send.dispatch.pid).not.toBe(send.restart.pid);
      expect(send.dispatch.ackDropped).toBe(true);
      expect(send.dispatch.cases.map(item => [item.case, item.status, item.reachedTransport, item.providerCalls])).toEqual([
        ['unapproved', 'not_sent', true, 0], ['edited-before-send', 'not_sent', true, 0], ['approved', 'sent', true, 1],
      ]);
      expect(send.dispatch.requests.map(({ method, status }) => [method, status])).toEqual([
        ['POST', 200], ['GET', 200], ['POST', 200], ['GET', 200], ['POST', 200], ['GET', 200],
      ]);
      expect(send.restart.requests).toEqual([]);
      expect(send.restart.cases.map(item => [item.case, item.status, item.reachedTransport, item.providerCalls])).toEqual([
        ['exact-replay', 'sent', false, 0], ['edited-replay', 'conflict', false, 0], ['fresh-command', 'already_sent', false, 0],
      ]);
      expect(send.restart.receipt).toEqual({ status: 'sent', message_id: 'fixture-jobs-reply-102' });
      expect(await prisma.jobApplication.findUniqueOrThrow({ where: submittedKey })).toEqual(beforeSend);
      expect(await receiptEvents()).toEqual(originalReceipt);
      expect(portal.requests()).toBe(portalRequests);
      console.info('Jobs threaded reply rehearsal', JSON.stringify({ applicationId: matchedId, sourceReply, mailboxUidvalidity,
        receiptEventId: originalReceipt[0].id, fixtureOnlyOwnerApproval: true, ...send }));
      return;
    }

    // A separate queued submission simulates corrupted storage without changing the delivered application.
    phase = 'corrupt';
    const corruptId = randomUUID();
    const corruptReference = 'fixture-corrupt-pdf';
    stored.set(corruptReference, syntheticPdf(1));
    await prisma.$transaction(async tx => {
      await tx.jobApplication.create({ data: { ...syntheticPosting, ownerId, id: corruptId, sourceKey: 'synthetic-corrupt',
        resumeTrack: 'web', revision: 2,
        status: 'queued', approvedRevision: 2, approvedPreviewDigest: digest } });
      await tx.jobRevision.create({ data: { ownerId, applicationId: corruptId, revision: 2, summaryMarkdown: ownerSummary,
        pdfSha256: digest, pdfReference: corruptReference } });
      await tx.jobWorkItem.create({ data: { ownerId, applicationId: corruptId, kind: 'submit', revision: 2 } });
    });
    let browserPrepared = false;
    expect(await runJobsMacOnce({ ...worker, async prepareBrowser() { browserPrepared = true; } })).toBe(true);
    expect(browserPrepared).toBe(false);
    expect(portal.clicks()).toBe(1);
    expect(await prisma.jobApplication.findUnique({ where: { ownerId_id: { ownerId, id: corruptId } } }))
      .toMatchObject({ status: 'needs_attention', issueCode: 'runner_unavailable', receipt: null });
    expect(await prisma.jobEvent.count({ where: { ownerId, applicationId: corruptId, kind: 'submit_started' } })).toBe(0);
    console.info('Jobs rehearsal', JSON.stringify({
      apiCalls: calls, milliseconds: timings, modelCalls, pdfs: stored.size - 1,
      portalRequests: portal.requests(), portalReads: portal.pageReads(), portalPosts: portal.clicks(),
      receiptStatuses: receiptReports.map(report => report.status),
    }));
  } catch (error) {
    console.error('Jobs fixture failed', JSON.stringify({ mode, phase, apiCalls: calls, replyRequests,
      portalReads: portal?.pageReads(), portalPosts: portal?.clicks() }));
    throw error;
  } finally {
    deliverGate.resolve();
    if (child && child.exitCode === null && child.signalCode === null) killWorkerGroup(child.pid);
    releasePortal.resolve();
    await child?.exited;
    try { if (mode === 'crash') await closeCrashedBrowserRuntime(); }
    finally { await portal?.close(); }
    await server.stop(true);
    await prisma.apiIdempotencyKey.deleteMany({ where: { OR: [{ clientId: { in: issuedClientIds } }, { idempotencyKey: { in: ownerCommandKeys } },
      { clientId: { startsWith: `jobs-worker:${ownerId}:` } }] } });
    await prisma.apikey.deleteMany({ where: { referenceId: ownerId } });
    if (handoff) await prisma.jobInterviewAppointment.deleteMany({ where: {
      interview: { ownerId, applicationId: handoff.application[0].id },
    } });
    await prisma.agentWriteAudit.deleteMany({ where: { ownerId } });
    await prisma.jobApplication.deleteMany({ where: { ownerId } });
    await prisma.jobPrivateField.deleteMany({ where: { ownerId } });
    await prisma.jobRunner.deleteMany({ where: { ownerId } });
    await prisma.authOwner.deleteMany({ where: { userId: ownerId } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.$disconnect();
    if (previousProof === undefined) delete process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
    else process.env.QUANTSELF_OWNER_INGRESS_TOKEN = previousProof;
    if (previousOrigin === undefined) delete process.env.QUANTSELF_PUBLIC_ORIGIN;
    else process.env.QUANTSELF_PUBLIC_ORIGIN = previousOrigin;
    if (previousHome === undefined) delete process.env.QUANTSELF_JOBS_HOME;
    else process.env.QUANTSELF_JOBS_HOME = previousHome;
    if (previousEncryptionKey === undefined) delete process.env.QUANTSELF_JOBS_PRIVATE_FIELDS_KEY;
    else process.env.QUANTSELF_JOBS_PRIVATE_FIELDS_KEY = previousEncryptionKey;
    if (previousTemplates === undefined) delete process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR;
    else process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR = previousTemplates;
    await rm(directory, { recursive: true, force: true });
  }
}

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
