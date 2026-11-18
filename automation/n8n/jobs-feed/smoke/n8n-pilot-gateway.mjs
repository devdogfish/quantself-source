import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { importBody, posting } from './pilot-posting.mjs';

const gateway = 'http://127.0.0.1:3001';
const workflowId = 'JobsPilotGatewayFixture';
const auth = { id: 'PilotGatewayAuth', name: 'Jobs pilot loopback', type: 'httpHeaderAuth' };
const { permit, key } = await fetch(gateway + '/ready', { redirect: 'error' }).then(res => {
  assert.equal(res.status, 200);
  return res.json();
});
const scratch = await mkdtemp(join(tmpdir(), 'jobs-pilot-n8n-'));
const env = { ...process.env, N8N_USER_FOLDER: scratch, DB_TYPE: 'sqlite', N8N_DIAGNOSTICS_ENABLED: 'false',
  N8N_VERSION_NOTIFICATIONS_ENABLED: 'false', N8N_TEMPLATES_ENABLED: 'false', N8N_RUNNERS_MODE: 'internal' };
const executeFile = promisify(execFile);
const n8n = (...args) => executeFile('n8n', args, { env, maxBuffer: 2_000_000, timeout: 40_000 });
const requests = [];
const imports = [];
const faults = [];
let scenario = 'missing';

async function forward(req, res) {
  assert.equal(req.method, 'POST');
  assert.ok(['/screen', '/held-import'].includes(req.url));
  assert.equal(req.headers['x-jobs-pilot-permit'], permit);
  assert.equal(req.headers['x-jobs-pilot-key'], key);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  const headers = { 'x-jobs-pilot-key': key, 'content-type': 'application/json' };
  if (scenario !== 'missing') headers['x-jobs-pilot-permit'] = permit;
  if (req.url === '/screen') {
    assert.deepEqual(JSON.parse(raw), { sourceIdentity: posting.sourceIdentity });
  } else {
    assert.equal(scenario, 'active');
    assert.deepEqual(JSON.parse(raw), JSON.parse(importBody));
    assert.equal(req.headers['idempotency-key'], 'n8n-jobs-pilot-' + permit);
    headers['idempotency-key'] = req.headers['idempotency-key'];
  }
  const started = performance.now();
  const response = await fetch(gateway + req.url, { method: 'POST', headers, body: raw, redirect: 'error' });
  const body = await response.text();
  const record = { scenario, path: req.url, status: response.status, elapsedMs: Math.round(performance.now() - started) };
  requests.push(record);
  if (req.url === '/held-import') {
    assert.equal(response.status, 200);
    imports.push({ raw, key: headers['idempotency-key'], body });
    if (imports.length === 1) {
      record.responseDropped = true;
      return req.socket.destroy();
    }
  }
  res.writeHead(response.status, { 'Content-Type': 'application/json' });
  res.end(body);
}

const relay = createServer((req, res) => {
  forward(req, res).catch(error => {
    faults.push(error.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"message":"Fixture relay failed."}');
  });
});

async function run(expectedStatus, imported) {
  const started = performance.now();
  const { stdout } = await n8n('execute', '--id=' + workflowId, '--rawOutput');
  const { data: { resultData } } = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1));
  assert.equal(resultData.lastNodeExecuted, 'Record run');
  const report = resultData.runData['Record run'][0].data.main[0][0].json;
  assert.equal(report.sourceIdentity, posting.sourceIdentity);
  assert.equal(report.screenStatus, expectedStatus);
  assert.equal(report.screening, imported ? 'keep' : 'blocked');
  const intake = imported ? JSON.parse(imports[0].body) : null;
  assert.deepEqual(report.imports, imported ? { imported: 1, status: 200, requests: 2, retryAttempts: 1,
    applicationId: intake.applicationId, revision: 0 }
    : { imported: 0, status: null, requests: 0, retryAttempts: 0 });
  return { report, elapsedMs: Math.round(performance.now() - started) };
}

try {
  await new Promise((resolve, reject) => {
    relay.once('error', reject);
    relay.listen(0, '127.0.0.1', resolve);
  });
  const exported = await readFile(new URL('../pilot-workflow.json', import.meta.url));
  const exportSha256 = createHash('sha256').update(exported).digest('hex');
  const workflow = JSON.parse(exported);
  assert.equal(workflow.active, false);
  const config = workflow.nodes.find(node => node.name === 'Pilot configuration');
  const blank = 'const config = {"gatewayOrigin":"","permitId":"","sourceIdentity":""};';
  assert.ok(config.parameters.jsCode.includes(blank));
  // Fill the documented inputs and bind the credential. Keep all other artifact code and routes intact.
  config.parameters.jsCode = config.parameters.jsCode.replace(blank, 'const config = ' + JSON.stringify({
    gatewayOrigin: 'http://127.0.0.1:' + relay.address().port, permitId: permit, sourceIdentity: posting.sourceIdentity,
  }) + ';');
  workflow.id = workflowId;
  for (const node of workflow.nodes.filter(node => node.type === 'n8n-nodes-base.httpRequest')) {
    assert.equal(node.credentials, undefined);
    node.credentials = { [auth.type]: { id: auth.id, name: auth.name } };
  }
  const workflowFile = join(scratch, 'pilot.json');
  const authFile = join(scratch, 'auth.json');
  await writeFile(workflowFile, JSON.stringify(workflow));
  await writeFile(authFile, JSON.stringify([{ ...auth, data: { name: 'X-Jobs-Pilot-Key', value: key } }]), { mode: 0o600 });
  const start = performance.now();
  await n8n('import:credentials', '--input=' + authFile);
  await n8n('import:workflow', '--input=' + workflowFile);
  const n8nSetupMs = Math.round(performance.now() - start);
  const missing = await run(403, false);
  const updatePermit = async path => assert.equal((await fetch(gateway + path, { method: 'POST',
    headers: { 'x-jobs-pilot-key': key }, redirect: 'error' })).status, 204);
  await updatePermit('/expire');
  scenario = 'expired';
  const expired = await run(409, false);
  await updatePermit('/restore');
  scenario = 'active';
  const accepted = await run(200, true);
  assert.deepEqual(faults, []);
  assert.deepEqual(requests.map(({ scenario, path, status }) => [scenario, path, status]), [
    ['missing', '/screen', 403], ['expired', '/screen', 409], ['active', '/screen', 200],
    ['active', '/held-import', 200], ['active', '/held-import', 200],
  ]);
  assert.equal(imports.length, 2);
  assert.deepEqual(imports[0], imports[1]);
  const receipt = JSON.parse(imports[0].body);
  assert.match(receipt.applicationId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(receipt, { imported: 1, duplicates: 0, applicationId: receipt.applicationId, revision: 0 });
  console.log(JSON.stringify({ exportSha256, n8nSetupMs, missing, expired, run: accepted, requests,
    lostAfterDurableCommit: true, retryIdenticalKeyAndBody: true }));
} catch (error) {
  console.error(JSON.stringify({ message: error.message, faults, requests }));
  process.exitCode = 1;
} finally {
  relay.close();
  await rm(scratch, { recursive: true, force: true });
}
