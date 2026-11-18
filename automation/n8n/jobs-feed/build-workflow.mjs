import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ANTHROPIC_API_VERSION, ANTHROPIC_MESSAGES_URL } from './screening/screening.mjs';

const path = name => new URL(name, import.meta.url);
const inline = name => readFileSync(path(name), 'utf8').replace(/^export /gm, '').trimEnd();
const sources = inline('./sources/sources.mjs');
const screening = inline('./screening/screening.mjs');
const quantself = inline('./quantself/quantself.mjs');
const steps = inline('./workflow-steps.mjs');
const maxPages = 10;

const nodes = [];
const connections = {};
function node(name, type, version, position, parameters, extra = {}) {
  const hash = createHash('sha256').update(`quantself-jobs-feed:${name}`).digest('hex');
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  nodes.push({ parameters, id, name, type: `n8n-nodes-base.${type}`, typeVersion: version, position, ...extra });
}

function edge(from, to, output = 0) {
  const main = (connections[from] ??= { main: [] }).main;
  while (main.length <= output) main.push([]);
  main[output].push({ node: to, type: 'main', index: 0 });
}

function code(name, position, libraries, script) {
  node(name, 'code', 2, position, { jsCode: [...libraries, script.trim()].join('\n\n') });
}

function branch(name, position, field) {
  node(name, 'if', 2.2, position, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{ id: field, leftValue: `={{ $json.${field} === true }}`, rightValue: true,
        operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and',
    },
    options: {},
  });
}

function http(name, position, { url, timeout, headers, options = {}, credential = false }) {
  node(name, 'httpRequest', 4.2, position, {
    method: credential ? 'POST' : 'GET',
    url,
    authentication: credential ? 'genericCredentialType' : 'none',
    ...(credential ? {
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.body) }}',
    } : {}),
    ...(headers ? { sendHeaders: true, headerParameters: { parameters: headers } } : {}),
    options: {
      timeout,
      redirect: { redirect: { followRedirects: false } },
      response: { response: { fullResponse: true, neverError: true, responseFormat: credential ? 'json' : 'autodetect' } },
      ...options,
    },
  }, { onError: 'continueRegularOutput' });
}

node('Daily schedule', 'scheduleTrigger', 1.2, [0, 0], {
  rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 8, triggerAtMinute: 0 }] },
});
node('Manual trigger', 'manualTrigger', 1, [0, 200], {});

code('Feed configuration', [220, 100], [steps], `
const config = prepareFeedConfig({
  quantselfBaseUrl: '',
  careerCriteria: '',
  maxScreenings: 50,
  boards: [],
  preflight: null,
});
return [{ json: { ...config, startedAt: Date.now() } }];
`);
code('Plan board requests', [440, 100], [sources], `
return sourceRequests($input.first().json.boards).map((request, boardIndex) => ({
  json: { ...request, boardIndex },
}));
`);
http('Fetch public boards', [660, 100], {
  url: '={{ $json.url }}',
  timeout: 20000,
  options: {
    pagination: { pagination: {
      paginationMode: 'responseContainsNextURL',
      nextURL: "={{ $json.url + ($json.provider === 'lever' && $pageCount > 0 ? '&skip=' + ($pageCount * $json.pageSize) : '') }}",
      paginationCompleteWhen: 'other',
      completeExpression: "={{ $json.provider !== 'lever' || $response.statusCode !== 200 || !Array.isArray($response.body) || $response.body.length < $json.pageSize }}",
      limitPagesFetched: true,
      maxRequests: maxPages,
      requestInterval: 300,
    } },
  },
});
code('Collect postings', [880, 100], [sources, steps], `
const plans = $('Plan board requests').all();
const pages = new Map();
for (const [inputIndex, item] of $input.all().entries()) {
  const { boardIndex: index } = $('Plan board requests').itemMatching(inputIndex).json;
  if (!Number.isInteger(index) || !plans[index]) throw new Error('Missing public board response link.');
  if (!pages.has(index)) pages.set(index, []);
  pages.get(index).push(item.json);
}
const { preflight } = $('Feed configuration').first().json;
return [{ json: collectPostings(plans.map(item => item.json), pages, normalizeSourceResponse, ${maxPages}, preflight) }];
`);
code('Plan model calls', [1100, 100], [steps, screening], `
const { careerCriteria, maxScreenings, startedAt } = $('Feed configuration').first().json;
const selected = selectForScreening($input.first().json.postings, maxScreenings, startedAt);
return selected.length
  ? selected.map(posting => ({ json: { hasPostings: true, posting, body: buildScreenRequest(posting, careerCriteria) } }))
  : [{ json: { hasPostings: false } }];
`);
branch('Any postings?', [1320, 100], 'hasPostings');
node('Limit model concurrency', 'splitInBatches', 3, [1540, 0], { batchSize: 4, options: {} });
http('Screen with Anthropic', [1760, 220], {
  url: ANTHROPIC_MESSAGES_URL,
  timeout: 45000,
  credential: true,
  headers: [{ name: 'anthropic-version', value: ANTHROPIC_API_VERSION }],
});
code('Read model outcomes', [1980, 220], [screening], `
return $input.all().map((item, index) => {
  const { posting } = $('Limit model concurrency').itemMatching(index).json;
  const { ok, result, error, usage } = settleScreenResponse(item.json);
  return {
    json: {
      usage,
      outcome: ok ? result.decision : error,
      sourceIdentity: posting.sourceIdentity,
      ...(result?.decision === 'keep' ? { kept: { ...posting, ...result } } : {}),
    },
    pairedItem: { item: index },
  };
});
`);
code('Prepare imports', [1760, -40], [screening, quantself], `
const samples = $input.all().map(item => item.json).filter(item => item.usage);
const { quantselfBaseUrl } = $('Feed configuration').first().json;
const { source } = $('Collect postings').first().json;
const kept = samples.flatMap(sample => sample.kept ? [sample.kept] : []);
const batches = prepareQuantselfBatches(kept, $workflow.id + '-' + $execution.id);
const summary = {
  source,
  screening: {
    kept: kept.length,
    skipped: samples.filter(sample => sample.outcome === 'skip').length,
    deferred: source.unique - samples.length,
    errors: samples.filter(sample => !['keep', 'skip'].includes(sample.outcome))
      .map(({ sourceIdentity, outcome, usage }) => ({ sourceIdentity, outcome, requestId: usage.requestId })),
  },
  cost: summarizeModelUsage(samples.map(sample => sample.usage)),
};
return (batches.length ? batches : [null]).map((batch, index) => ({
  json: {
    hasImports: Boolean(batch),
    url: quantselfBaseUrl + '/api/v1/jobs/applications/import',
    index,
    ...batch,
    // Keep one copy of the run summary in order to finalize even with zero imports.
    ...(index === 0 ? { summary } : {}),
  },
}));
`);
branch('Any imports?', [1980, -40], 'hasImports');

const importRequest = {
  url: '={{ $json.url }}',
  timeout: 20000,
  credential: true,
  headers: [{ name: 'Idempotency-Key', value: '={{ $json.idempotencyKey }}' }],
};
http('Import Jobs drafts', [2200, -140], importRequest);
code('Plan import retries', [2420, -140], [steps], `
const requests = $('Prepare imports').all().map(item => item.json);
const responses = Array(requests.length);
for (const [index, item] of $input.all().entries()) {
  const request = $('Prepare imports').itemMatching(index).json;
  responses[request.index] = compactImportResponse(item.json);
}
const retry = requests.filter((_, index) => isRetryableImport(responses[index] ?? { statusCode: null }));
return (retry.length ? retry : [null]).map((request, index) => ({
  json: {
    ...request, shouldRetry: Boolean(request),
    ...(index === 0 ? { responses } : {}),
  },
}));
`);
branch('Retry imports?', [2640, -140], 'shouldRetry');
node('Pause before retry', 'wait', 1.1, [2860, -230], { resume: 'timeInterval', amount: 3, unit: 'seconds' });
http('Retry Jobs drafts', [3080, -230], importRequest);

code('Record run', [3300, 60], [steps, quantself], `
const plans = $('Prepare imports').all().map(item => item.json);
const { summary } = plans[0];
const requests = plans.filter(plan => plan.hasImports);
const retries = $('Plan import retries');
const responses = retries.isExecuted ? [...retries.first().json.responses] : [];
let retryAttempts = 0;
if ($('Retry Jobs drafts').isExecuted) {
  for (const [index, item] of $input.all().entries()) {
    const request = $('Plan import retries').itemMatching(index).json;
    responses[request.index] = compactImportResponse(item.json);
    retryAttempts++;
  }
}
const result = summarizeQuantselfImports(requests, responses);
const hasErrors = summary.source.errors.length || summary.screening.errors.length || result.failedBatches.length
  || summary.cost.unpricedRequests;
return [{ json: {
  executionId: String($execution.id),
  finishedAt: new Date().toISOString(),
  status: hasErrors ? 'completed_with_errors' : 'completed',
  ...summary,
  imports: { requests: requests.length, retryAttempts, ...result },
} }];
`);

for (const trigger of ['Daily schedule', 'Manual trigger']) edge(trigger, 'Feed configuration');
edge('Feed configuration', 'Plan board requests');
edge('Plan board requests', 'Fetch public boards');
edge('Fetch public boards', 'Collect postings');
edge('Collect postings', 'Plan model calls');
edge('Plan model calls', 'Any postings?');
edge('Any postings?', 'Limit model concurrency');
edge('Any postings?', 'Prepare imports', 1);
edge('Limit model concurrency', 'Prepare imports');
edge('Limit model concurrency', 'Screen with Anthropic', 1);
edge('Screen with Anthropic', 'Read model outcomes');
edge('Read model outcomes', 'Limit model concurrency');
edge('Prepare imports', 'Any imports?');
edge('Any imports?', 'Import Jobs drafts');
edge('Any imports?', 'Record run', 1);
edge('Import Jobs drafts', 'Plan import retries');
edge('Plan import retries', 'Retry imports?');
edge('Retry imports?', 'Pause before retry');
edge('Retry imports?', 'Record run', 1);
edge('Pause before retry', 'Retry Jobs drafts');
edge('Retry Jobs drafts', 'Record run');

export const workflow = {
  name: 'Quantself Jobs feed',
  active: false,
  nodes,
  connections,
  settings: {
    executionOrder: 'v1',
    timezone: 'America/Halifax',
    saveDataSuccessExecution: 'all',
    saveDataErrorExecution: 'all',
    saveManualExecutions: true,
    saveExecutionProgress: false,
  },
  pinData: {},
};

if (import.meta.main) {
  const target = path('./workflow.json');
  const output = JSON.stringify(workflow, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== output) throw new Error('workflow.json is stale. Run build-workflow.mjs.');
  } else {
    writeFileSync(target, output);
  }
}
