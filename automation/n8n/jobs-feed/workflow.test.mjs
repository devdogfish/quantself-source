import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'bun:test';
import { workflow as generated } from './build-workflow.mjs';
import { collectPostings, selectForScreening } from './workflow-steps.mjs';
import { MODEL } from './screening/screening.mjs';

const exported = JSON.parse(readFileSync(new URL('./workflow.json', import.meta.url), 'utf8'));
const nodes = new Map(exported.nodes.map(node => [node.name, node]));
const config = {
  quantselfBaseUrl: 'https://quantself.example.org',
  careerCriteria: 'Remote Canadian roles in business administration or Excel.',
  maxScreenings: 10,
  boards: [{ provider: 'greenhouse', board: 'example', company: 'Example Office' }],
};

const listing = id => ({
  id, internal_job_id: id, title: `Reporting role ${id}`,
  absolute_url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
  content: '<p>Maintain Excel reporting.</p>', location: { name: 'Remote Canada' },
});

const modelReply = (decision, { stop = 'end_turn' } = {}) => ({
  statusCode: 200,
  headers: { 'request-id': 'req_fixture' },
  body: {
    type: 'message', model: MODEL, stop_reason: stop,
    content: [{ type: 'text', text: JSON.stringify(decision === 'keep'
      ? { decision, category: 'excel', fitNote: 'Uses Excel for remote reporting.' }
      : { decision, category: 'none', fitNote: 'Criteria are not met.' }) }],
    usage: { input_tokens: 1000, output_tokens: 50 },
  },
});

function fixtureRun({ executionId, fixtures, runConfig = config, startedAt }) {
  const history = new Map();
  const connected = (from, output = 0) => exported.connections[from]?.main[output] ?? [];
  const wrap = (json, parent, index = 0) => ({ json, parent, pairedItem: { item: index } });
  let result;

  function route(name, output, items) {
    if (items.length) for (const edge of connected(name, output)) visit(edge.node, items);
  }

  function visit(name, items) {
    const node = nodes.get(name);
    const type = node.type.split('.').at(-1);
    if (type === 'splitInBatches') {
      // Keep loop outputs per iteration and collect exactly what the loop receives back.
      const done = [];
      for (let offset = 0; offset < items.length; offset += node.parameters.batchSize) {
        const batch = items.slice(offset, offset + node.parameters.batchSize);
        for (const item of batch) item.ancestors.set(name, item);
        route(name, 1, batch);
        done.push(...history.get('Read model outcomes'));
      }
      route(name, 0, done);
      return;
    }

    let output;
    switch (type) {
      case 'manualTrigger':
      case 'wait':
        output = items.map((item, index) => wrap(item.json, item, index));
        break;
      case 'code': {
        const previous = nodeName => ({
          all: () => history.get(nodeName),
          first: () => history.get(nodeName)[0],
          isExecuted: history.has(nodeName),
          itemMatching: index => {
            const item = items[index].ancestors.get(nodeName);
            if (!item) throw new Error(`Missing fixture link from ${name} to ${nodeName}`);
            return item;
          },
        });
        const body = name === 'Feed configuration' ? node.parameters.jsCode.replace(
          /prepareFeedConfig\(\{[\s\S]*?\}\);/, () => `prepareFeedConfig(${JSON.stringify(runConfig)});`,
        ) : node.parameters.jsCode;
        output = runInNewContext(`(() => {${body}\n})()`, {
          // n8n stamps fresh input indexes. Use itemMatching to recover the HTTP input link.
          $input: { all: () => items.map((item, index) => ({ json: item.json, pairedItem: { item: index } })),
            first: () => items[0] },
          $: previous, $workflow: { id: 'workflow' }, $execution: { id: executionId },
        }).map(item => wrap(item.json, items[item.pairedItem?.item ?? 0], item.pairedItem?.item));
        break;
      }
      case 'httpRequest':
        output = items.flatMap((item, index) =>
          fixtures[name](item.json).map(response => wrap(response, item, index)));
        break;
      case 'if': {
        const field = node.parameters.conditions.conditions[0].id;
        route(name, 0, items.filter(item => item.json[field]));
        route(name, 1, items.filter(item => !item.json[field]));
        return;
      }
      default:
        throw new Error(`Unhandled fixture node ${name}`);
    }

    if (name === 'Feed configuration' && startedAt !== undefined) output[0].json.startedAt = startedAt;

    for (const item of output) {
      item.ancestors = new Map(item.parent?.ancestors ?? item.ancestors);
      item.ancestors.set(name, item);
    }
    history.set(name, output);
    if (name === 'Record run') result = output[0].json;
    // The split fixture routes its next batch after the outcomes return.
    if (name !== 'Read model outcomes') route(name, 0, output);
  }

  expect(connected('Read model outcomes')[0].node).toBe('Limit model concurrency');
  visit('Manual trigger', [{ json: {}, ancestors: new Map() }]);
  return result;
}

test('keeps the exported n8n workflow current, inactive, and credential-free', () => {
  expect(exported).toEqual(generated);
  expect(exported.active).toBe(false);
  expect(exported.settings.timezone).toBe('America/Halifax');
  expect(exported.nodes.every(node => !node.credentials)).toBe(true);
  const httpNodes = exported.nodes.filter(node => node.type.endsWith('.httpRequest'));
  expect(httpNodes.map(node => node.parameters.authentication)).toEqual([
    'none', 'genericCredentialType', 'genericCredentialType', 'genericCredentialType',
  ]);
  expect(httpNodes.every(node => !node.parameters.options.redirect.redirect.followRedirects)).toBe(true);
  expect(nodes.get('Limit model concurrency').parameters.batchSize).toBe(4);
});

test('records one cost report across model batches and safely replays an uncertain import', () => {
  const persisted = new Set();
  const replay = new Map();
  const imports = [];
  const posts = [1, 2, 3, 4, 5, 5].map(listing);
  function importFixture({ idempotencyKey, body, url }) {
    expect(url).toBe('https://quantself.example.org/api/v1/jobs/applications/import');
    imports.push({ idempotencyKey, body });
    if (replay.has(idempotencyKey)) {
      expect(body).toEqual(replay.get(idempotencyKey).body);
      return [replay.get(idempotencyKey).response];
    }
    let imported = 0;
    for (const application of body.applications) {
      expect(application.track).toBe('admin');
      expect(application.postingText).toContain('Fit note (excel):');
      expect(application).not.toHaveProperty('sourceStatus');
      if (!persisted.has(application.sourceUrl)) imported++;
      persisted.add(application.sourceUrl);
    }
    const response = { statusCode: 200, body: { imported, duplicates: body.applications.length - imported } };
    replay.set(idempotencyKey, { body, response });
    return imports.length === 1 ? [{ error: 'Response lost after commit' }] : [response];
  }
  const fixtures = {
    'Fetch public boards': () => [{ statusCode: 200, body: { jobs: posts, meta: { total: posts.length } } }],
    'Screen with Anthropic': ({ posting, body }) => {
      expect(body.system).toContain(config.careerCriteria);
      expect(body.model).toBe(MODEL);
      if (posting.role.endsWith('5')) return [modelReply('keep', { stop: 'max_tokens' })];
      return [modelReply(posting.role.endsWith('3') ? 'skip' : 'keep')];
    },
    'Import Jobs drafts': importFixture,
    'Retry Jobs drafts': importFixture,
  };

  const first = fixtureRun({ executionId: '1', fixtures });
  expect(first).toMatchObject({
    status: 'completed_with_errors',
    source: { responses: 1, unique: 5, skippedRows: 1 },
    screening: { kept: 3, skipped: 1, deferred: 0, errors: [{ outcome: 'screen_incomplete_response' }] },
    cost: { requests: 5, pricedRequests: 5, estimatedCostUsd: 0.000625 },
    imports: { requests: 1, retryAttempts: 1, imported: 3, duplicates: 0,
      tailoring: { status: 'enrichment_queued', drafts: 3, path: '/jobs/applications' } },
  });
  expect(imports[1]).toEqual(imports[0]);

  const second = fixtureRun({ executionId: '2', fixtures });
  expect(second.imports).toMatchObject({
    requests: 1, retryAttempts: 0, imported: 0, duplicates: 3,
    tailoring: { status: 'no_new_drafts' },
  });
  expect(imports[2].idempotencyKey).not.toBe(imports[0].idempotencyKey);
  expect(persisted.size).toBe(3);
});

test('records zero spend and no imports on an empty board or a failed board', () => {
  for (const response of [{ statusCode: 200, body: { jobs: [], meta: { total: 0 } } }, { statusCode: 503 }]) {
    const result = fixtureRun({
      executionId: '3',
      fixtures: { 'Fetch public boards': () => [response] },
    });
    expect(result.status).toBe(response.statusCode === 200 ? 'completed' : 'completed_with_errors');
    expect(result.cost).toMatchObject({ requests: 0, estimatedCostUsd: 0 });
    expect(result.imports).toMatchObject({ requests: 0, imported: 0 });
  }
});

const approvedPosting = { board: 'example', postingId: '2' };
const boardReply = (jobs, total = jobs.length) => ({ statusCode: 200, body: { jobs, meta: { total } } });

test.each([86_399_999, 86_400_000])('preflights the approved posting at UTC time %i', startedAt => {
  const calls = { boards: 0, model: [], imports: [], retries: 0 };
  const result = fixtureRun({
    executionId: String(startedAt),
    startedAt,
    runConfig: { ...config, maxScreenings: 1, preflight: approvedPosting },
    fixtures: {
      'Fetch public boards': request => {
        calls.boards++;
        expect(request.url).toBe('https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true');
        return [boardReply([listing(3), listing(2), listing(1)])];
      },
      'Screen with Anthropic': ({ posting }) => {
        calls.model.push(posting.sourceIdentity);
        return [modelReply('keep')];
      },
      'Import Jobs drafts': ({ body }) => {
        calls.imports.push(body.applications.map(({ sourceIdentity, sourceUrl }) => ({ sourceIdentity, sourceUrl })));
        return [{ statusCode: 200, body: { imported: 1, duplicates: 0 } }];
      },
      'Retry Jobs drafts': () => {
        calls.retries++;
        return [];
      },
    },
  });
  expect(calls).toEqual({
    boards: 1,
    model: ['greenhouse:global:example:2'],
    imports: [[{ sourceIdentity: 'greenhouse:global:example:2', sourceUrl: listing(2).absolute_url }]],
    retries: 0,
  });
  expect(result).toMatchObject({
    status: 'completed',
    source: { boards: 1, responses: 1, unique: 3 },
    screening: { kept: 1, deferred: 2 },
    cost: { requests: 1 },
    imports: { requests: 1, retryAttempts: 0, imported: 1 },
  });
});

test.each([undefined, null])('rotates the exported screening window with preflight %s', preflight => {
  const screened = [];
  for (const startedAt of [86_399_999, 86_400_000]) {
    fixtureRun({
      executionId: String(startedAt),
      startedAt,
      runConfig: { ...config, maxScreenings: 1, preflight },
      fixtures: {
        'Fetch public boards': () => [boardReply([listing(3), listing(2), listing(1)])],
        'Screen with Anthropic': ({ posting }) => {
          screened.push(posting.sourceIdentity);
          return [modelReply('skip')];
        },
      },
    });
  }
  expect(screened).toEqual(['greenhouse:global:example:1', 'greenhouse:global:example:2']);
});

test.each([
  ['missing posting', {}, [boardReply([listing(1)])], 'exactly one raw row', 1],
  ['duplicate raw posting with an invalid copy', {}, [boardReply([listing(2), { id: '2' }])], 'exactly one raw row', 1],
  ['incomplete board', {}, [boardReply([listing(2)], 2)], 'matching numeric total', 1],
  ['missing board total', {}, [{ statusCode: 200, body: { jobs: [listing(2)] } }], 'matching numeric total', 1],
  ['string board total', {}, [boardReply([listing(2)], '1')], 'matching numeric total', 1],
  ['array target ID', {}, [boardReply([{ ...listing(2), id: [2] }])], 'approved numeric posting ID', 1],
  ['string target ID', {}, [boardReply([listing('2')])], 'approved numeric posting ID', 1],
  ['duplicate claim to approved URL', {}, [boardReply([listing(2), {
    id: 3, absolute_url: 'https://boards.greenhouse.io/example/jobs/2/?gh_jid=3',
  }])], 'no conflicting URL claims', 1],
  ['multiple board responses', {}, [boardReply([listing(2)]), boardReply([])], 'exactly one Greenhouse board response', 1],
  ['invalid target row', {}, [boardReply([{ ...listing(2), title: '' }])], 'verify the approved Greenhouse', 1],
  ['wrong board URL', {}, [boardReply([{ ...listing(2), absolute_url: listing(2).absolute_url.replace('/example/', '/other/') }])], 'verify the approved Greenhouse', 1],
  ['wrong ID URL', {}, [boardReply([{ ...listing(2), absolute_url: listing(3).absolute_url }])], 'verify the approved Greenhouse', 1],
  ['conflicting query ID', {}, [boardReply([{ ...listing(2), absolute_url: listing(2).absolute_url + '?gh_jid=3' }])], 'verify the approved Greenhouse', 1],
  ['duplicate encoded query ID', {}, [boardReply([{ ...listing(2), absolute_url: listing(2).absolute_url + '?gh_jid=2&gh%5Fjid=2' }])], 'verify the approved Greenhouse', 1],
  ['wrong provider URL', {}, [boardReply([{ ...listing(2), absolute_url: 'https://jobs.lever.co/example/job' }])], 'verify the approved Greenhouse', 1],
  ['wrong board config', { preflight: { ...approvedPosting, board: 'other' } }, [], 'one matching Greenhouse board', 0],
  ['wrong provider config', { boards: [{ ...config.boards[0], provider: 'lever' }] }, [], 'one matching Greenhouse board', 0],
  ['multiple configured boards', { boards: [...config.boards, ...config.boards] }, [], 'one matching Greenhouse board', 0],
  ['malformed posting ID', { preflight: { ...approvedPosting, postingId: '2/3' } }, [], 'valid posting ID', 0],
  ['missing preflight fields', { preflight: {} }, [], 'valid posting ID', 0],
  ['unrecognized preflight flag', { preflight: { ...approvedPosting, enabled: false } }, [], 'valid posting ID', 0],
])('rejects %s before model and import fixture calls', (_, overrides, responses, reason, expectedBoards) => {
  const calls = { boards: 0, model: 0, imports: 0 };
  const importFixture = () => { calls.imports++; return []; };
  expect(() => fixtureRun({
    executionId: 'rejected',
    runConfig: { ...config, preflight: approvedPosting, ...overrides },
    fixtures: {
      'Fetch public boards': () => { calls.boards++; return responses; },
      'Screen with Anthropic': () => { calls.model++; return []; },
      'Import Jobs drafts': importFixture,
      'Retry Jobs drafts': importFixture,
    },
  })).toThrow(reason);
  expect(calls).toEqual({ boards: expectedBoards, model: 0, imports: 0 });
});

test('drops incomplete Lever boards and rotates a capped screening window', () => {
  const request = { provider: 'lever', region: 'global', board: 'large', pageSize: 2 };
  const complete = { ...request, board: 'small' };
  const response = body => ({ statusCode: 200, body });
  const results = collectPostings([request, complete], new Map([
    [0, [response(['1', '2']), response(['3', '4'])]],
    [1, [response(['5', '6']), response(['7'])]],
  ]), (_, { body }) => ({
    postings: body.map(sourceIdentity => ({ sourceIdentity })), skipped: 0,
  }), 2);
  expect(results.source).toMatchObject({ responses: 4, unique: 3, errors: [
    { board: 'lever:global:large', reason: 'Pagination limit reached before the last page.' },
  ] });
  expect(selectForScreening(results.postings, 2, 0).map(job => job.sourceIdentity)).toEqual(['5', '6']);
  expect(selectForScreening(results.postings, 2, 86_400_000).map(job => job.sourceIdentity)).toEqual(['7', '5']);
});

test('links multiple Lever pages to the right board before a second provider response', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  const job = {
    id, text: 'Excel Reporting', descriptionPlain: 'Maintain reporting.',
    hostedUrl: `https://jobs.lever.co/example/${id}`,
  };
  const result = fixtureRun({
    executionId: '4',
    runConfig: { ...config, boards: [
      { provider: 'lever', board: 'example', company: 'Lever Example' },
      ...config.boards,
    ] },
    fixtures: {
      'Fetch public boards': request => request.provider === 'lever'
        ? [{ statusCode: 200, body: [job] }, { statusCode: 200, body: [] }]
        : [{ statusCode: 200, body: { jobs: [listing(10)], meta: { total: 1 } } }],
      'Screen with Anthropic': ({ posting }) => {
        expect(posting.company).toBe(posting.sourceUrl.includes('lever.co') ? 'Lever Example' : 'Example Office');
        return [modelReply('skip')];
      },
    },
  });
  expect(result.source).toMatchObject({ responses: 3, unique: 2, errors: [] });
  expect(result.screening.skipped).toBe(2);
});
