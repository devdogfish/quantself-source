import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'bun:test';
import { workflow as generated } from './build-pilot-workflow.mjs';

const exported = JSON.parse(readFileSync(new URL('./pilot-workflow.json', import.meta.url), 'utf8'));
const nodes = new Map(exported.nodes.map(node => [node.name, node]));
const config = { gatewayOrigin: 'https://pilot.example.test', permitId: 'c1c1d8b0-2cf1-4d4b-95ec-8a55cbdee2e7',
  sourceIdentity: 'greenhouse:global:synthetic-studio:197' };
const run = (js, context = {}) => runInNewContext(`(() => {${js}})()`, context)[0].json;

test('the pilot ships as an inactive manual workflow with only private gateway requests', () => {
  expect(exported).toEqual(generated);
  expect(exported.active).toBe(false);
  expect(exported.nodes.filter(node => /trigger/i.test(node.type)).map(node => node.type)).toEqual(['n8n-nodes-base.manualTrigger']);
  const requests = exported.nodes.filter(node => node.type.endsWith('.httpRequest'));
  expect(requests.map(node => node.parameters.url)).toEqual(['/screen', '/held-import', '/held-import'].map(route =>
    `={{ $('Pilot configuration').first().json.gatewayOrigin + '${route}' }}`));
  for (const request of requests) {
    expect(request.credentials).toBeUndefined();
    expect(request.retryOnFail).toBeUndefined();
    expect(request.parameters.options.redirect.redirect.followRedirects).toBe(false);
  }
  expect(exported.settings.saveManualExecutions).toBe(false);
});

test('configuration and gateway responses bind intake to the exact permitted posting', () => {
  const configure = nodes.get('Pilot configuration').parameters.jsCode;
  const configured = overrides => configure.replace(/const config = \{[^}]*\};/, () => `const config = ${JSON.stringify({ ...config, ...overrides })};`);
  expect(() => run(configure)).toThrow('Configure the inactive pilot');
  expect(() => run(configured({ gatewayOrigin: 'http://pilot.example.test' }))).toThrow('Configure the inactive pilot');
  expect(() => run(configured({ sourceIdentity: 'lever:global:studio:197' }))).toThrow('Configure the inactive pilot');
  expect(run(configured()).body).toEqual({ sourceIdentity: config.sourceIdentity });

  const prepare = nodes.get('Prepare held intake').parameters.jsCode;
  const plan = (statusCode, body) => run(prepare, {
    $: () => ({ first: () => ({ json: config }) }), $input: { first: () => ({ json: { statusCode, body } }) },
  });
  const application = { sourceIdentity: config.sourceIdentity, role: 'Editor' };
  expect(plan(200, { outcome: 'keep', application })).toEqual({ kept: true, screening: 'keep', screenStatus: 200,
    idempotencyKey: 'n8n-jobs-pilot-' + config.permitId, body: { applications: [application] } });
  expect(plan(409, { outcome: 'keep', application })).toEqual({ kept: false, screening: 'blocked', screenStatus: 409 });
  expect(plan(200, { outcome: 'keep', application: { ...application, sourceIdentity: 'greenhouse:global:other:197' } }).kept).toBe(false);
});
