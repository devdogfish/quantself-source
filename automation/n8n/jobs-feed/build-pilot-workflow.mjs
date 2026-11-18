import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { compactImportResponse, isRetryableImport } from './workflow-steps.mjs';

const path = name => new URL(name, import.meta.url);
function readPilotImport(response) {
  const compact = compactImportResponse(response);
  const { applicationId, revision } = response.body ?? {};
  if (compact.statusCode === 200 && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(applicationId) && revision === 0) {
    return { ...compact, applicationId, revision };
  }
  return compact;
}
const importHelpers = [compactImportResponse, isRetryableImport, readPilotImport].join('\n\n');
const nodes = [];
const connections = {};

function node(name, type, typeVersion, position, parameters, extra = {}) {
  const hash = createHash('sha256').update(`quantself-jobs-pilot:${name}`).digest('hex');
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  nodes.push({ id, name, type: `n8n-nodes-base.${type}`, typeVersion, position, parameters, ...extra });
}

function connect(from, to, output = 0) {
  const main = (connections[from] ??= { main: [] }).main;
  while (main.length <= output) main.push([]);
  main[output].push({ node: to, type: 'main', index: 0 });
}

function code(name, position, jsCode) { node(name, 'code', 2, position, { jsCode: jsCode.trim() }); }

function send(name, position, route, timeout, importRequest = false) {
  node(name, 'httpRequest', 4.2, position, {
    method: 'POST', url: `={{ $('Pilot configuration').first().json.gatewayOrigin + '${route}' }}`,
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendHeaders: true, headerParameters: { parameters: [
      { name: 'X-Jobs-Pilot-Permit', value: "={{ $('Pilot configuration').first().json.permitId }}" },
      ...(importRequest ? [{ name: 'Idempotency-Key', value: '={{ $json.idempotencyKey }}' }] : []),
    ] },
    sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}',
    options: { timeout, redirect: { redirect: { followRedirects: false } },
      response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } },
  }, { onError: 'continueRegularOutput' });
}

function branch(name, position, field) {
  node(name, 'if', 2.2, position, { conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{ id: field, leftValue: `={{ $json.${field} === true }}`, rightValue: true,
      operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and',
  }, options: {} });
}

node('Manual trigger', 'manualTrigger', 1, [0, 0], {});
code('Pilot configuration', [220, 0], String.raw`
const config = {"gatewayOrigin":"","permitId":"","sourceIdentity":""};
const { gatewayOrigin, permitId, sourceIdentity } = config;
if (!/^(?:https:\/\/[a-z\d-]+(?:\.[a-z\d-]+)+(?::\d{1,5})?|http:\/\/127\.0\.0\.1:\d{1,5})$/i.test(gatewayOrigin) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(permitId) ||
    !/^greenhouse:global:[a-z0-9_-]{1,120}:[1-9][0-9]{0,15}$/.test(sourceIdentity)) {
  throw new Error('Configure the inactive pilot with its private gateway, exact permit, and one Greenhouse posting.');
}
return [{ json: { ...config, body: { sourceIdentity } } }];
`);
send('Screen permitted posting', [440, 0], '/screen', 55_000);
code('Prepare held intake', [660, 0], `
const response = $input.first().json;
const { permitId, sourceIdentity } = $('Pilot configuration').first().json;
const application = response.body?.application;
const kept = response.statusCode === 200 && response.body?.outcome === 'keep' && application?.sourceIdentity === sourceIdentity;
return [{ json: { kept, screenStatus: response.statusCode ?? null,
  screening: kept ? 'keep' : response.statusCode === 200 && response.body?.outcome === 'no_import' ? 'no_import' : 'blocked',
  ...(kept && { idempotencyKey: 'n8n-jobs-pilot-' + permitId, body: { applications: [application] } }),
} }];
`);
branch('Import approved keep?', [880, 0], 'kept');
send('Import held draft', [1100, -120], '/held-import', 20_000, true);
code('Check intake response', [1320, -120], `
${importHelpers}
const response = readPilotImport($input.first().json);
const request = $('Prepare held intake').first().json;
return [{ json: { ...request, response, retry: isRetryableImport(response) } }];
`);
branch('Retry intake?', [1540, -120], 'retry');
node('Pause before retry', 'wait', 1.1, [1760, -220], { resume: 'timeInterval', amount: 3, unit: 'seconds' });
send('Retry held draft', [1980, -220], '/held-import', 20_000, true);
code('Record run', [2200, 0], `
${importHelpers}
const plan = $('Prepare held intake').first().json;
const { sourceIdentity } = $('Pilot configuration').first().json;
const retried = $('Retry held draft').isExecuted;
const response = plan.kept ? (retried ? readPilotImport($input.first().json) : $input.first().json.response) : null;
const imported = response?.statusCode === 200 && response.applicationId !== undefined && response.body?.imported === 1 && response.body?.duplicates === 0;
return [{ json: { executionId: String($execution.id), sourceIdentity, screening: plan.screening, screenStatus: plan.screenStatus,
  imports: { imported: Number(imported), status: response?.statusCode ?? null, requests: plan.kept ? 1 + Number(retried) : 0, retryAttempts: Number(retried),
    ...(imported && { applicationId: response.applicationId, revision: response.revision }) } } }];
`);

connect('Manual trigger', 'Pilot configuration');
connect('Pilot configuration', 'Screen permitted posting');
connect('Screen permitted posting', 'Prepare held intake');
connect('Prepare held intake', 'Import approved keep?');
connect('Import approved keep?', 'Import held draft');
connect('Import approved keep?', 'Record run', 1);
connect('Import held draft', 'Check intake response');
connect('Check intake response', 'Retry intake?');
connect('Retry intake?', 'Pause before retry');
connect('Retry intake?', 'Record run', 1);
connect('Pause before retry', 'Retry held draft');
connect('Retry held draft', 'Record run');

export const workflow = { name: 'Quantself Jobs one-posting pilot', active: false, nodes, connections,
  settings: { executionOrder: 'v1', timezone: 'America/Halifax', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none',
    saveManualExecutions: false, saveExecutionProgress: false }, pinData: {},
};

if (import.meta.main) {
  const target = path('./pilot-workflow.json');
  const bytes = JSON.stringify(workflow, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== bytes) throw new Error('pilot-workflow.json is stale. Run build-pilot-workflow.mjs.');
  } else writeFileSync(target, bytes);
}
