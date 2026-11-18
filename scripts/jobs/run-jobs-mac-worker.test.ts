import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeLocal } from './config';
import type { EmailPacket } from './email-application';
import { questionKey } from './private-fields';
import { resumeHeader } from './resume-document';
import { runJobsMacOnce } from './run-jobs-mac-worker';
import { createJobsWorkClient, type RunnerWork } from './work-client';
import { createJobsWorkOutbox } from './work-outbox';

const prefix = '/api/internal/jobs';
const applicationId = '10000000-0000-4000-8000-000000000001';
const posting = { track: 'web', sourceUrl: 'https://jobs.example.test/example', company: 'Example Studio',
  role: 'Web Editor', applicationAddress: 'luigi.2222@luigigirke.com' } as const;
const revision = 4;
const now = '2026-11-14T20:00:00.000Z';
const leaseUntil = '2026-11-14T20:02:00.000Z';
const pdf = Buffer.from('%PDF-1.4\nsynthetic approved revision');
const digest = createHash('sha256').update(pdf).digest('hex');
const pdfPath = `/applications/${applicationId}/revisions/${revision}/pdf`;
const renderClaim: RunnerWork = { id: '10000000-0000-4000-8000-000000000002', applicationId, revision, leaseUntil,
  leaseToken: 'synthetic-render-lease', kind: 'render',
  input: { ...posting, resumeMarkdown: resumeHeader + '## Summary\n\nOriginal Summary.\n\n## Experience\n\nSample project.\n',
    summaryMarkdown: '- Published accessible web content.' } };
const submitClaim: RunnerWork = { id: '10000000-0000-4000-8000-000000000003', applicationId, revision, leaseUntil,
  leaseToken: 'synthetic-submit-lease', kind: 'submit', input: { ...posting, sha256: digest } };
const question = { id: 'example_reason', label: 'Why are you interested in this role?', type: 'textarea',
  required: true, options: [] } as const;
const accepted = () => Response.json({ accepted: true });
type RequestRecord = { path: string; method: string; headers: Headers; body: any };

async function configureEmailRoute({ questions = [], subjectNamePrefix }: { questions?: string[]; subjectNamePrefix?: string } = {}) {
  await writeLocal('email-routes.json', [{
    company: posting.company, role: posting.role, sourceUrls: [posting.sourceUrl],
    recipient: 'hiring@example.test', questions, subjectNamePrefix,
  }]);
  await writeLocal('mail-ses.json', { region: 'ca-central-1', profile: 'fixture-profile' });
}

async function withFixture(run: (fixture: {
  requests: RequestRecord[];
  claims: RunnerWork[];
  options: Parameters<typeof runJobsMacOnce>[0];
  directory: string;
  intercept: (handler: (request: RequestRecord) => Response | Promise<Response> | undefined) => void;
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'qs-jobs-mac-work-'));
  const previous = process.env.QUANTSELF_JOBS_HOME;
  process.env.QUANTSELF_JOBS_HOME = directory;
  try {
    await writeLocal('private.json', { resumePaths: { web: '/synthetic/template.tex' } });
    await writeLocal('public-candidate-form-manifests.json', { forms: [{ ...posting, listingUrl: posting.sourceUrl,
      kind: 'discovered', identityCheck: 'verified', fields: [question] }] });
    const claims: RunnerWork[] = [];
    const requests: RequestRecord[] = [];
    let handler: Parameters<Parameters<typeof run>[0]['intercept']>[0] | undefined;
    let artifact = pdf;
    const api = createJobsWorkClient({ baseUrl: 'https://private-api.example.test', secret: 'synthetic-token',
      fetchImpl: (async (url: URL, init: RequestInit) => {
        const path = url.pathname.slice(prefix.length);
        const method = init.method!;
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
        const headers = new Headers(init.headers);
        const request = { path, method, headers, body };
        expect(url.pathname.startsWith(prefix + '/')).toBe(true);
        expect(headers.get('authorization')).toBe('Bearer synthetic-token');
        requests.push(request);
        const overridden = await handler?.(request);
        if (overridden) return overridden;
        if (path === '/work/claim') return Response.json({ work: claims.shift() ?? null });
        if (path.endsWith('/private-fields')) return Response.json({ candidateContext: { markdown: '', version: 0 },
          fields: [{ key: 'email', label: 'Application email', type: 'email', scope: { kind: 'listing', applicationId },
            value: posting.applicationAddress }] });
        if (path === pdfPath && method === 'PUT') {
          artifact = Buffer.from(body);
          return accepted();
        }
        if (path === pdfPath && method === 'GET') return new Response(artifact);
        if (/\/(events|complete|fail)$/.test(path)) return accepted();
        return new Response(null, { status: 404 });
      }) as typeof fetch,
    });
    const options = {
      api, outbox: createJobsWorkOutbox(join(directory, 'outbox'), api), workerId: 'synthetic-mac',
      cdpUrl: 'http://127.0.0.1:9', now: () => Date.parse(now), paused: false,
      prepareBrowser: async () => {},
    };
    await run({ requests, claims, options, directory, intercept: next => { handler = next; } });
  } finally {
    if (previous === undefined) delete process.env.QUANTSELF_JOBS_HOME;
    else process.env.QUANTSELF_JOBS_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('renders the assigned revision and uploads only those bytes under its lease', async () => {
  await withFixture(async ({ requests, claims, options }) => {
    claims.push(renderClaim);
    expect(await runJobsMacOnce({ ...options, paused: true, render: async (snapshot, config) => {
      expect(snapshot).toMatchObject({ applicationId, revision, summary: renderClaim.input.summaryMarkdown });
      expect(snapshot.resumeMarkdown).toContain('## Summary\n\n- Published accessible web content.\n\n## Experience');
      expect(snapshot.resumeMarkdown).not.toContain('Original Summary.');
      const scoped = JSON.parse(await readFile(config!.privateConfigPath!, 'utf8'));
      expect(scoped.personal.email).toBe(posting.applicationAddress);
      return { path: '', pdf };
    } })).toBe(true);
    expect(requests.map(request => [request.method, request.path])).toEqual([
      ['POST', '/work/claim'], ['POST', `/work/${renderClaim.id}/private-fields`], ['PUT', pdfPath],
    ]);
    expect(requests[0].body.kinds).toEqual(['render']);
    expect(requests[2].headers.get('x-job-work-id')).toBe(renderClaim.id);
    expect(requests[2].headers.get('x-job-lease-token')).toBe(renderClaim.leaseToken);
    expect(requests[2].headers.get('x-content-sha256')).toBe(digest);
    expect(requests[2].body).toEqual(pdf);
  });
});

test('rejects a changed PDF before preparing the browser or loading private fields', async () => {
  await withFixture(async ({ requests, claims, options, intercept }) => {
    claims.push(submitClaim);
    intercept(request => request.path === pdfPath ? new Response('%PDF-1.4\ndifferent revision') : undefined);
    let browserPrepared = false;
    await runJobsMacOnce({ ...options, prepareBrowser: async () => { browserPrepared = true; } });
    expect(browserPrepared).toBe(false);
    expect(requests.map(request => request.path)).toEqual([
      '/work/claim', `/submissions/${applicationId}/events`, pdfPath, `/work/${submitClaim.id}/fail`,
    ]);
    expect(requests[2].headers.get('x-job-work-id')).toBe(submitClaim.id);
    expect(requests[2].headers.get('x-job-lease-token')).toBe(submitClaim.leaseToken);
    expect(requests[3].body.code).toBe('runner_unavailable');
  });
});

test.each(['browser', 'email'] as const)('%s rejects a different valid Application Address in the private snapshot', async channel => {
  await withFixture(async ({ requests, claims, options, intercept }) => {
    if (channel === 'email') await configureEmailRoute();
    claims.push(submitClaim);
    intercept(request => {
      if (!request.path.endsWith('/private-fields')) return;
      return Response.json({ candidateContext: { markdown: '', version: 0 },
        fields: [{ key: 'email', label: 'Application email', type: 'email',
          scope: { kind: 'listing', applicationId }, value: 'luigi.3333@luigigirke.com' }] });
    });
    let submissions = 0;
    await runJobsMacOnce({ ...options, emailEnabled: channel === 'email',
      submit: async () => { submissions++; return { kind: 'applied', receiptCode: 'confirmation_page' }; },
      deliverEmail: async () => { submissions++; return { kind: 'accepted', messageId: 'unexpected' }; },
    });
    expect(submissions).toBe(0);
    expect(requests.some(request => request.body?.step === 'submit_started')).toBe(false);
    expect(requests.at(-1)).toMatchObject({ path: `/work/${submitClaim.id}/fail`, body: { code: 'runner_unavailable' } });
  });
});

test('approved email is opt-in and uses SES only after the server acknowledges submission start', async () => {
  await withFixture(async ({ requests, claims, options, intercept }) => {
    await configureEmailRoute({ questions: [question.label], subjectNamePrefix: 'Fixture application' });
    claims.push(submitClaim, submitClaim);
    const deliveries: EmailPacket[] = [];
    const send = {
      ...options,
      prepareBrowser: async () => { throw new Error('email opened a browser'); },
      deliverEmail: async (packet: EmailPacket) => {
        expect(requests.at(-1)?.body?.step).toBe('submit_started');
        deliveries.push(packet);
        return { kind: 'accepted', messageId: 'ses-fixture-accepted' } as const;
      },
    };
    await runJobsMacOnce(send);
    expect(deliveries).toHaveLength(0);
    expect(requests.at(-1)).toMatchObject({ path: `/work/${submitClaim.id}/fail`, body: { code: 'unsupported_portal' } });

    const gate = Promise.withResolvers<Response>();
    const waiting = Promise.withResolvers<void>();
    intercept(request => {
      if (request.path.endsWith('/private-fields')) {
        const scope = { kind: 'listing', applicationId };
        return Response.json({ candidateContext: { markdown: '', version: 0 }, fields: [
          { key: 'email', label: 'Application email', type: 'email', scope, value: posting.applicationAddress },
          { key: 'firstName', label: 'First name', type: 'text', scope, value: 'Example' },
          { key: 'lastName', label: 'Last name', type: 'text', scope, value: 'Applicant' },
          { key: questionKey(question.label), label: question.label, type: 'text', scope, value: 'Synthetic saved answer.' },
        ] });
      }
      if (request.body?.step !== 'submit_started') return;
      waiting.resolve();
      return gate.promise;
    });
    const pending = runJobsMacOnce({ ...send, emailEnabled: true });
    await Promise.race([waiting.promise, pending.then(() => { throw new Error('Email never requested the send gate'); })]);
    expect(deliveries).toHaveLength(0);
    gate.resolve(accepted());
    await pending;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      from: posting.applicationAddress, to: 'hiring@example.test',
      subject: 'Fixture application – Example Applicant', attachment: { sha256: digest },
    });
    expect(deliveries[0].body).toContain(`${question.label}\nSynthetic saved answer.`);
    expect(Buffer.from(deliveries[0].attachment.bytes)).toEqual(pdf);
    expect(requests.at(-1)).toMatchObject({ path: `/work/${submitClaim.id}/complete`,
      body: { result: { receipt: { code: 'confirmation_message', capturedAt: now, sesMessageId: 'ses-fixture-accepted' } } } });
  });
});

test('restart recovers the confirmed SES acceptance and replays only its receipt after a lost response', async () => {
  await withFixture(async ({ requests, claims, options, intercept, directory }) => {
    await configureEmailRoute();
    claims.push(submitClaim);
    let deliveries = 0;
    const persist = options.outbox.stage;
    const send = {
      ...options, emailEnabled: true,
      outbox: {
        ...options.outbox,
        async stage(report: Parameters<typeof persist>[0]) {
          if (report.action === 'complete') throw new Error('fixture stopped after SES acceptance');
          await persist(report);
        },
      },
      deliverEmail: async () => {
        deliveries++;
        return { kind: 'accepted', messageId: 'ses-fixture-recovered' } as const;
      },
    };
    await expect(runJobsMacOnce(send)).rejects.toThrow('fixture stopped after SES acceptance');
    expect(deliveries).toBe(1);
    expect(requests.filter(request => /\/(complete|fail)$/.test(request.path))).toHaveLength(0);
    await rm(join(directory, 'mail-ses.json'));

    let receiptResponses = 0;
    intercept(request => request.path.endsWith('/complete') && receiptResponses++ === 0
      ? new Response(null, { status: 503 }) : undefined);
    const restart = () => runJobsMacOnce({
      ...options, emailEnabled: false,
      outbox: createJobsWorkOutbox(join(directory, 'outbox'), options.api),
      deliverEmail: async () => { throw new Error('restart sent email again'); },
    });
    await expect(restart()).rejects.toThrow('jobs_work_api_503');
    expect(await restart()).toBe(false);
    const receipts = requests.filter(request => request.path.endsWith('/complete'));
    expect(receipts).toHaveLength(2);
    expect(receipts[0].body).toMatchObject({ leaseToken: submitClaim.leaseToken,
      result: { receipt: { code: 'confirmation_message', capturedAt: now, sesMessageId: 'ses-fixture-recovered' } } });
    expect(receipts[1].body).toEqual(receipts[0].body);
    expect(requests.filter(request => request.path.endsWith('/fail'))).toHaveLength(0);
  });
});

test('an ambiguous SES result survives a lost report response as a hold and never resends', async () => {
  await withFixture(async ({ requests, claims, options, intercept, directory }) => {
    await configureEmailRoute();
    claims.push(submitClaim);
    let deliveries = 0;
    let failures = 0;
    intercept(request => request.path.endsWith('/fail') && failures++ === 0
      ? new Response(null, { status: 503 }) : undefined);
    const send = { ...options, emailEnabled: true, deliverEmail: async () => {
      deliveries++;
      return { kind: 'uncertain' } as const;
    } };
    await expect(runJobsMacOnce(send)).rejects.toThrow('jobs_work_api_503');
    expect(await runJobsMacOnce({
      ...send, outbox: createJobsWorkOutbox(join(directory, 'outbox'), options.api),
    })).toBe(false);
    expect(deliveries).toBe(1);
    const reports = requests.filter(request => /\/(complete|fail)$/.test(request.path));
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ path: `/work/${submitClaim.id}/fail`, body: { code: 'submission_uncertain' } });
    expect(reports[1].body).toEqual(reports[0].body);
  });
});

test('a definite SES refusal reports that the message was not sent and permits a normal retry', async () => {
  await withFixture(async ({ requests, claims, options, intercept, directory }) => {
    await configureEmailRoute();
    const work = { ...submitClaim, attempt: 1 };
    claims.push(work);
    let calls = 0;
    let refuseFailureReport = true;
    intercept(request => {
      if (!request.path.endsWith('/fail') || !refuseFailureReport) return;
      refuseFailureReport = false;
      return new Response(null, { status: 503 });
    });
    const send = { ...options, emailEnabled: true, deliverEmail: async () => {
      if (++calls === 1) return { kind: 'not_sent' } as const;
      return { kind: 'accepted', messageId: 'ses-after-definite-refusal' } as const;
    } };
    await expect(runJobsMacOnce(send)).rejects.toThrow('jobs_work_api_503');
    claims.push({ ...work, leaseToken: 'replacement-submit-lease', attempt: 2 });
    await runJobsMacOnce({ ...send, outbox: createJobsWorkOutbox(join(directory, 'outbox'), options.api) });
    const failures = requests.filter(request => request.path.endsWith('/fail'));
    expect(failures).toHaveLength(2);
    expect(failures[0].body).toMatchObject({ code: 'runner_unavailable', emailNotSent: true });
    expect(failures[1].body).toEqual(failures[0].body);
    expect(requests.filter(request => request.body?.step === 'submit_started').map(request => request.body.channel)).toEqual(['ses', 'ses']);
    expect(requests.at(-1)?.body.result.receipt.sesMessageId).toBe('ses-after-definite-refusal');
    expect(calls).toBe(2);
  });
});

test('a stale SES failure before the send gate is preserved and a restart continues claiming work', async () => {
  await withFixture(async ({ requests, claims, options, intercept, directory }) => {
    await configureEmailRoute();
    claims.push({ ...submitClaim, attempt: 1 });
    let failureResponses = 0;
    intercept(request => {
      if (request.path === pdfPath) return new Response(null, { status: 409 });
      if (request.path.endsWith('/fail')) return new Response(null, { status: ++failureResponses === 1 ? 503 : 409 });
    });
    const send = { ...options, emailEnabled: true, deliverEmail: async () => {
      throw new Error('a pre-gate failure sent email');
    } };
    await expect(runJobsMacOnce(send)).rejects.toThrow('jobs_work_api_503');
    expect(requests.find(request => request.body?.step === 'runner_claimed')?.body).toMatchObject({ channel: 'ses' });
    expect(requests.some(request => request.body?.step === 'submit_started')).toBe(false);
    const restart = { ...send, outbox: createJobsWorkOutbox(join(directory, 'outbox'), options.api) };
    expect(await runJobsMacOnce(restart)).toBe(false);
    expect(requests.at(-1)?.path).toBe('/work/claim');
    const reports = requests.filter(request => request.path.endsWith('/fail'));
    expect(reports).toHaveLength(2);
    expect(reports[1].body).toEqual(reports[0].body);
    const names = await readdir(join(directory, 'outbox'));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/\.conflict$/);
    expect(JSON.parse(await readFile(join(directory, 'outbox', names[0]), 'utf8')).report.body).toEqual(reports[0].body);
  });
});

test('clicks only after the server acknowledges submit_started and replays the same receipt after a lost response', async () => {
  await withFixture(async ({ requests, claims, options, intercept, directory }) => {
    claims.push(submitClaim);
    const gateReached = Promise.withResolvers<void>();
    const acknowledgement = Promise.withResolvers<Response>();
    let clicks = 0;
    let loseReceiptResponse = true;
    intercept(request => {
      if (request.body?.step === 'submit_started') {
        gateReached.resolve();
        return acknowledgement.promise;
      }
      if (request.path.endsWith('/complete') && loseReceiptResponse) {
        loseReceiptResponse = false;
        return new Response(null, { status: 503 });
      }
    });
    const run = runJobsMacOnce({ ...options, submit: async (work, browser) => {
      expect(work.applicationAddress).toBe(posting.applicationAddress);
      expect(await readFile(browser.pdfPath)).toEqual(pdf);
      await browser.beforeSubmit!();
      clicks++;
      return { kind: 'applied', receiptCode: 'confirmation_page' };
    } });
    const result = run.then(() => undefined, (error: unknown) => error);
    await Promise.race([gateReached.promise, result.then(error => {
      throw new Error('submission finished before requesting acknowledgement', { cause: error });
    })]);
    expect(clicks).toBe(0);
    const journals = await readdir(join(directory, 'outbox'));
    expect(journals).toHaveLength(1);
    const journalPath = join(directory, 'outbox', journals[0]);
    expect(JSON.parse(await readFile(journalPath, 'utf8')).body.code).toBe('submission_uncertain');
    acknowledgement.resolve(accepted());
    expect(await result).toMatchObject({ message: 'jobs_work_api_503' });
    expect(await runJobsMacOnce(options)).toBe(false);
    expect(clicks).toBe(1);
    expect(requests.flatMap(request => request.body?.step ? [request.body.step] : [])).toEqual([
      'runner_claimed', 'portal_opened', 'form_filled', 'submit_started', 'submitted', 'receipt_captured',
    ]);
    const completions = requests.filter(request => request.path.endsWith('/complete'));
    expect(completions).toHaveLength(2);
    expect(completions[0].body).toEqual(completions[1].body);
    expect(completions[0].body.result.receipt).toEqual({ code: 'confirmation_page', capturedAt: now });
    expect(requests.at(-2)?.path).toBe(`/work/${submitClaim.id}/complete`);
    expect(await readdir(join(directory, 'outbox'))).toEqual([]);
  });
});

test('reports uncertainty and never clicks when the send-start response is lost', async () => {
  await withFixture(async ({ requests, claims, options, intercept }) => {
    claims.push(submitClaim);
    intercept(request => request.body?.step === 'submit_started' ? new Response(null, { status: 503 }) : undefined);
    let clicks = 0;
    await runJobsMacOnce({ ...options, submit: async (_work, browser) => {
      await browser.beforeSubmit!();
      clicks++;
      return { kind: 'applied', receiptCode: 'confirmation_page' };
    } });
    expect(clicks).toBe(0);
    expect(requests.at(-1)).toMatchObject({ path: `/work/${submitClaim.id}/fail`, body: { code: 'submission_uncertain' } });
  });
});

test('a lost uncertainty response replays the same failure before any new claim', async () => {
  await withFixture(async ({ requests, claims, options, intercept }) => {
    claims.push(submitClaim);
    let failResponsesLost = 0;
    intercept(request => request.path.endsWith('/fail') && failResponsesLost++ === 0
      ? new Response(null, { status: 503 }) : undefined);
    let clicks = 0;
    await expect(runJobsMacOnce({ ...options, submit: async (_work, browser) => {
      await browser.beforeSubmit!();
      clicks++;
      return { kind: 'failed', code: 'submission_uncertain' };
    } })).rejects.toThrow('jobs_work_api_503');
    expect(await runJobsMacOnce(options)).toBe(false);
    expect(clicks).toBe(1);
    const failures = requests.filter(request => request.path.endsWith('/fail'));
    expect(failures).toHaveLength(2);
    expect(failures[0].body).toMatchObject({ code: 'submission_uncertain' });
    expect(failures[1].body).toEqual(failures[0].body);
    expect(requests.at(-1)?.path).toBe('/work/claim');
  });
});

test('reports a scoped private question and can fill the approved revision after the answer is saved', async () => {
  await withFixture(async ({ requests, claims, options, intercept }) => {
    claims.push(submitClaim);
    const key = questionKey(question.label);
    await runJobsMacOnce({ ...options, submit: async () => ({ kind: 'failed', code: 'manual_required', safeToResume: true,
      attention: { questions: [{ ...question, options: [] }], variables: [] } }) });
    const requirement = { key, type: 'text', label: question.label, scope: { kind: 'listing', applicationId } };
    expect(requests.at(-1)).toMatchObject({ path: `/work/${submitClaim.id}/fail`,
      body: { code: 'manual_required', requirements: [requirement] } });
    expect(requests.some(request => request.body?.step === 'submit_started')).toBe(false);

    claims.push({ ...submitClaim, id: '10000000-0000-4000-8000-000000000004', leaseToken: 'synthetic-resumed-lease' });
    intercept(request => request.path.endsWith('/private-fields') ? Response.json({
      candidateContext: { markdown: '', version: 0 }, fields: [{ ...requirement, key: 'email', type: 'email',
        label: 'Application email', value: posting.applicationAddress }, { ...requirement, value: 'Synthetic saved answer.' }],
    }) : undefined);
    await runJobsMacOnce({ ...options, submit: async (_work, browser) => {
      const scoped = JSON.parse(await readFile(browser.privateConfigPath, 'utf8'));
      expect(scoped.answers[posting.sourceUrl][question.label]).toEqual({ type: 'text', value: 'Synthetic saved answer.' });
      expect(await readFile(browser.pdfPath)).toEqual(pdf);
      await browser.beforeSubmit!();
      return { kind: 'applied', receiptCode: 'confirmation_message' };
    } });
    expect(requests.at(-1)?.path).toBe('/work/10000000-0000-4000-8000-000000000004/complete');
    expect(requests.filter(request => request.path === pdfPath)).toHaveLength(2);
  });
});
