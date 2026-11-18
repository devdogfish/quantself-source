import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MODEL } from '../screening/screening.mjs';
import { board, boardResponse, criteria, importBody, screenBody } from './pilot-posting.mjs';

const exec = promisify(execFile);
const workflowId = 'JobsFeedFixture';
const Anthropic = { id: 'FixtureAnthropic', name: 'Fixture Anthropic', type: 'httpHeaderAuth',
  data: { name: 'x-api-key', value: 'fixture-model-key' } };
const Quantself = { id: 'FixtureQuantself', name: 'Fixture Quantself', type: 'httpHeaderAuth',
  data: { name: 'X-API-Key', value: '' } };

const apiOrigin = 'http://api:3001';
const pilot = process.env.QUANTSELF_JOBS_PILOT_N8N_FIXTURE === '1';
const pilotGateway = 'http://127.0.0.1:3001';
const pilotImports = [];
let permit;
let execution = 1;
let lostSnapshot;
const listing = id => ({
  id, internal_job_id: id, title: `Reporting role ${id}`,
  absolute_url: `https://${execution === 2 && id === 1 ? 'boards' : 'job-boards'}.greenhouse.io/fixture/jobs/${id}`,
  content: '<p>Maintain Excel reporting.</p>', location: { name: 'Remote Canada' },
});

const leverPostingId = '11111111-2222-3333-4444-555555555555';
const imports = [];
const requests = [];
const failures = [];
const latencies = [];

async function fixture(endpoint, method = 'GET') {
  const response = await fetch(apiOrigin + '/__fixture/' + endpoint, { method, redirect: 'error' });
  assert.equal(response.status, 200, 'Fixture ' + endpoint);
  return response.json();
}

function reply(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function serve(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  requests.push({ execution, route: url.pathname + url.search });
  const started = performance.now();
  res.on('close', () => latencies.push({ execution, route: url.pathname + url.search,
    elapsedMs: Math.round(performance.now() - started), responseFinished: res.writableFinished }));
  if (url.pathname.startsWith('/boards/')) {
    assert.equal(req.method, 'GET');
    assert.equal(req.headers['x-api-key'], undefined);
    if (pilot) {
      assert.equal(url.pathname, '/boards/greenhouse');
      return reply(res, boardResponse);
    }
    if (url.pathname === '/boards/greenhouse') {
      const jobs = [1, 2, 3, 4, 4].map(listing);
      return reply(res, { jobs, meta: { total: jobs.length } });
    }
    assert.equal(url.pathname, '/boards/lever');
    // One full page followed by a short page exercises native pagination.
    return reply(res, url.searchParams.has('skip') ? [] : Array.from({ length: 100 }, () => ({
      id: leverPostingId, text: 'Reporting role 5', descriptionPlain: 'Build workbooks.',
      hostedUrl: `https://jobs.lever.co/fixture/${leverPostingId}`,
    })));
  }

  assert.equal(req.method, 'POST');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  if (pilot) {
    const screen = url.pathname === '/v1/messages';
    assert.equal(url.pathname, screen ? '/v1/messages' : '/api/v1/jobs/applications/import');
    assert.equal(req.headers['x-fixture-permit'], permit);
    assert.equal(raw, screen ? screenBody : importBody);
    const headers = { 'x-fixture-permit': req.headers['x-fixture-permit'], 'content-type': 'application/json' };
    if (!screen) {
      headers['idempotency-key'] = req.headers['idempotency-key'];
      assert.match(headers['idempotency-key'], /^n8n-jobs-import-/);
    }
    const response = await fetch(pilotGateway + (screen ? '/screen' : '/held-import'), {
      method: 'POST', headers, body: raw, redirect: 'error',
    });
    assert.equal(response.status, 200, 'Pilot gateway rejected ' + url.pathname);
    const result = await response.json();
    if (screen) {
      res.setHeader('request-id', response.headers.get('request-id'));
    } else {
      pilotImports.push({ key: headers['idempotency-key'], raw, result });
      if (pilotImports.length === 1) return req.socket.destroy();
    }
    return reply(res, result);
  }
  const body = JSON.parse(raw);
  if (url.pathname === '/v1/messages') {
    assert.equal(req.headers['x-api-key'], Anthropic.data.value);
    assert.equal(body.model, MODEL);
    const role = JSON.parse(body.messages[0].content).role;
    const skip = role.endsWith('3');
    const result = skip
      ? { decision: 'skip', category: 'none', fitNote: 'Fixture role excluded.' }
      : { decision: 'keep', category: 'excel', fitNote: 'Maintains reporting in Excel.' };
    return reply(res, {
      type: 'message', model: MODEL, stop_reason: role.endsWith('5') ? 'max_tokens' : 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(result) }],
      usage: { input_tokens: 1000, output_tokens: 50 },
    });
  }

  assert.equal(url.pathname, '/api/v1/jobs/applications/import');
  assert(req.headers['x-api-key'] === Quantself.data.value, 'Expected the scoped fixture key');
  const idempotencyKey = req.headers['idempotency-key'];
  assert.match(idempotencyKey, /^n8n-jobs-import-/);
  for (const application of body.applications) {
    assert.equal(application.track, 'admin');
    assert.match(application.postingText, /^Fit note \(excel\):/);
    assert.match(application.sourceIdentity, /^greenhouse:global:fixture:[124]$/);
    assert.equal(application.recordedStatus, undefined);
    assert.equal(application.resumeMarkdown, undefined);
  }
  const apiStarted = performance.now();
  const response = await fetch(apiOrigin + url.pathname, {
    method: 'POST', redirect: 'error', body: raw,
    headers: { 'X-API-Key': Quantself.data.value, 'Idempotency-Key': idempotencyKey, 'Content-Type': 'application/json' },
  });
  const result = await response.json();
  const apiMs = Math.round(performance.now() - apiStarted);
  assert.equal(response.status, 200, 'Real Jobs import status: ' + JSON.stringify(result));
  imports.push({ idempotencyKey, raw, result, apiMs, execution });
  if (imports.length === 1) {
    assert.deepEqual(result, { imported: 3, duplicates: 0 });
    lostSnapshot = await fixture('snapshot');
    assert.equal(lostSnapshot.applications.length, 3);
    assert.deepEqual(lostSnapshot.imports, [result]);
    return req.socket.destroy();
  }
  return reply(res, result);

}

function configure(workflow, origin) {
  assert.equal(workflow.active, false);
  workflow.id = workflowId;
  const node = name => {
    const match = workflow.nodes.find(candidate => candidate.name === name);
    assert.ok(match, name);
    return match;
  };
  const config = node('Feed configuration');
  const original = config.parameters.jsCode;
  const fixtureBoards = pilot ? [board] : [
    { provider: 'greenhouse', board: 'fixture', company: 'Example Office' },
    { provider: 'lever', board: 'fixture', company: 'Example Tools' },
  ];
  config.parameters.jsCode = original.replace(/prepareFeedConfig\(\{[\s\S]*?\}\);/, () => `prepareFeedConfig({
    quantselfBaseUrl: 'https://quantself.example.org',
    careerCriteria: ${JSON.stringify(pilot ? criteria : 'Fixture remote Canadian reporting roles.')},
    maxScreenings: ${pilot ? 1 : 10},
    boards: ${JSON.stringify(fixtureBoards)},
  });
  config.quantselfBaseUrl = ${JSON.stringify(origin)};`);
  assert.notEqual(config.parameters.jsCode, original);
  const plans = node('Plan board requests').parameters;
  const originalPlans = plans.jsCode;
  plans.jsCode = plans.jsCode.replace('json: { ...request, boardIndex }',
    `json: { ...request, boardIndex, url: ${JSON.stringify(origin + '/boards/')} + request.provider + (request.provider === 'lever' ? '?limit=100' : '') }`);
  assert.notEqual(plans.jsCode, originalPlans);
  const model = node('Screen with Anthropic');
  model.parameters.url = origin + '/v1/messages';

  const credentialRef = ({ id, name, type }) => ({ [type]: { id, name } });
  model.credentials = credentialRef(Anthropic);
  for (const name of ['Import Jobs drafts', 'Retry Jobs drafts']) node(name).credentials = credentialRef(Quantself);
  return workflow;
}

const scratch = await mkdtemp(join(tmpdir(), 'jobs-feed-n8n-smoke-'));
const env = {
  ...process.env, N8N_USER_FOLDER: scratch, DB_TYPE: 'sqlite',
  N8N_DIAGNOSTICS_ENABLED: 'false', N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
  N8N_TEMPLATES_ENABLED: 'false', N8N_LOG_LEVEL: 'info', N8N_RUNNERS_MODE: 'internal',
};
const n8n = (...args) => exec('n8n', args, { env, maxBuffer: 4_000_000, timeout: 45_000 });
const server = createServer((req, res) => {
  serve(req, res).catch(error => {
    failures.push(error);
    reply(res, { message: 'Fixture request failed' }, 500);
  });
});
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const exportBytes = await readFile(new URL('../workflow.json', import.meta.url));
  const exportSha256 = createHash('sha256').update(exportBytes).digest('hex');
  const workflow = configure(JSON.parse(exportBytes), origin);
  if (pilot) {
    const response = await fetch(pilotGateway + '/ready', { redirect: 'error' });
    assert.equal(response.status, 200);
    ({ permit } = await response.json());
    assert.ok(permit);
    for (const credential of [Anthropic, Quantself]) credential.data = { name: 'X-Fixture-Permit', value: permit };
  } else {
    Quantself.data.value = (await fixture('key')).key;
  }
  assert.ok(Quantself.data.value);
  const workflowFile = join(scratch, 'fixture-workflow.json');
  const credentialsFile = join(scratch, 'fixture-credentials.json');
  await writeFile(workflowFile, JSON.stringify(workflow));
  await writeFile(credentialsFile, JSON.stringify([Anthropic, Quantself]));
  const setupStarted = performance.now();
  await n8n('import:credentials', '--input=' + credentialsFile);
  await n8n('import:workflow', '--input=' + workflowFile);
  const n8nSetupMs = Math.round(performance.now() - setupStarted);

  async function execute() {
    const startTime = performance.now();
    const { stdout } = await n8n('execute', '--id=' + workflowId, '--rawOutput');
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    assert.ok(start >= 0 && end >= start, 'Missing n8n execution JSON');
    const result = JSON.parse(stdout.slice(start, end + 1));
    assert.equal(result.data.resultData.lastNodeExecuted, 'Record run');
    assert.equal(result.data.resultData.runData['Record run'].length, 1);
    return { report: result.data.resultData.runData['Record run'][0].data.main[0][0].json,
      elapsedMs: Math.round(performance.now() - startTime) };
  }
  const first = await execute();
  if (pilot) {
    assert.deepEqual(failures, []);
    assert.deepEqual(requests.map(({ route }) => route), [
      '/boards/greenhouse', '/v1/messages', '/api/v1/jobs/applications/import', '/api/v1/jobs/applications/import',
    ]);
    assert.equal(pilotImports.length, 2);
    assert.deepEqual(pilotImports[0], pilotImports[1]);
    assert.deepEqual(pilotImports[0].result, { imported: 1, duplicates: 0 });
    assert.equal(first.report.screening.kept, 1);
    assert.equal(first.report.imports.retryAttempts, 1);
    assert.equal(first.report.imports.imported, 1);
    console.log(JSON.stringify({ exportSha256, n8nSetupMs, run: first, requests, latencies,
      lostAfterDurableCommit: true, retryIdenticalKeyAndBody: true }));
  } else {
    const afterReplay = await fixture('snapshot');
    execution = 2;
    const second = await execute();
    const afterRepeat = await fixture('snapshot');
    assert.deepEqual(failures, []);
    for (const [round, { report }, expectedImports] of [[1, first, 2], [2, second, 1]]) {
      assert.equal(report.status, 'completed_with_errors');
      assert.equal(report.source.responses, 3);
      assert.equal(report.source.unique, 5);
      assert.equal(report.screening.kept, 3);
      assert.equal(report.screening.skipped, 1);
      assert.equal(report.screening.errors[0]?.outcome, 'screen_incomplete_response');
      assert.equal(report.cost.requests, 5);
      assert.equal(report.cost.estimatedCostUsd, 0.000625);
      const paths = requests.filter(entry => entry.execution === round).map(entry => entry.route);
      assert.equal(paths.filter(path => path.startsWith('/boards/')).length, 3);
      assert.equal(paths.filter(path => path === '/boards/lever?limit=100&skip=100').length, 1);
      assert.equal(paths.filter(path => path === '/v1/messages').length, 5);
      assert.equal(paths.filter(path => path === '/api/v1/jobs/applications/import').length, expectedImports);
    }
    assert.notEqual(first.report.executionId, second.report.executionId);
    assert.equal(first.report.imports.retryAttempts, 1);
    assert.equal(first.report.imports.imported, 3);
    assert.equal(first.report.imports.duplicates, 0);
    assert.equal(first.report.imports.tailoring.status, 'enrichment_queued');
    assert.equal(second.report.imports.retryAttempts, 0);
    assert.equal(second.report.imports.imported, 0);
    assert.equal(second.report.imports.duplicates, 3);
    assert.equal(second.report.imports.tailoring.status, 'no_new_drafts');
    assert.equal(imports.length, 3);
    assert.equal(imports[0].raw, imports[1].raw);
    assert.equal(imports[0].idempotencyKey, imports[1].idempotencyKey);
    assert.deepEqual(imports[0].result, imports[1].result);
    assert.notEqual(imports[1].idempotencyKey, imports[2].idempotencyKey);
    assert.notEqual(imports[1].raw, imports[2].raw, 'Fresh run must test a changed provider URL');
    assert.deepEqual(lostSnapshot, afterReplay);
    assert.deepEqual(afterRepeat, { ...afterReplay, imports: [{ imported: 3, duplicates: 0 }, { imported: 0, duplicates: 3 }] });
    assert.equal(afterRepeat.applications.length, 3);
    assert(afterRepeat.applications.every(row => row.status === 'draft' && row.description.includes('Fit note (excel):')));
    assert.deepEqual(afterRepeat.bindings.map(row => row.sourceIdentity), [1, 2, 4].map(id => 'greenhouse:global:fixture:' + id));
    assert.deepEqual(afterRepeat.bindings.map(row => row.applicationId).sort(), afterRepeat.applications.map(row => row.id));
    assert.deepEqual(afterRepeat.work, afterRepeat.applications.map(row => ({ applicationId: row.id, kind: 'enrich', state: 'queued', revision: 0 })));
    const work = await fixture('finish', 'POST');
    const evidence = { exportSha256, n8nSetupMs, runs: [first, second], requests, latencies,
      realImports: imports.map(({ result, apiMs, execution }) => ({ result, apiMs, execution })),
      lostAfterDurableCommit: true, retryIdenticalKeyAndBody: true, freshKey: true, providerBindings: afterRepeat.bindings, work };
    console.log(JSON.stringify(evidence));
  }
} catch (error) {
  for (const failure of failures) console.error(failure.message);
  console.error(error.code ? 'Fixture failed: ' + error.code : error.message);
  process.exitCode = 1;
} finally {
  server.close();
  await rm(scratch, { recursive: true, force: true });
}
