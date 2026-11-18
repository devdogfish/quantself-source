import { expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateRules } from './candidate-rules.fixture';
import { checkPostingConfig, writePostingConfigInventory } from './check-posting-config';
import { writeLocal } from './config';
import { emailRoutes } from './email-routes.fixture';

test('checks the files required by each process and blocks partial or invalid staging', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jobs-posting-config-'));
  const previousHome = process.env.QUANTSELF_JOBS_HOME;
  const previousRoutes = process.env.QUANTSELF_JOBS_EMAIL_ROUTES;
  process.env.QUANTSELF_JOBS_HOME = home;
  process.env.QUANTSELF_JOBS_EMAIL_ROUTES = join(home, 'email-routes.json');
  try {
    const inventory = join(home, 'inventory.json');
    expect(() => checkPostingConfig('api', undefined)).toThrow('missing_posting_inventory');
    await writeLocal('email-routes.json', emailRoutes);
    await writeLocal('candidate-rules.json', candidateRules);
    await writeLocal('public-posting-hosts.json', ['careers.example.test']);
    await writePostingConfigInventory(inventory);
    expect(checkPostingConfig('api', inventory)).toEqual({ emailRoutes: 2 });
    expect(checkPostingConfig('web', inventory)).toEqual({ candidateRules: 2 });
    expect(checkPostingConfig('runner', inventory)).toEqual({ emailRoutes: 2, candidateRules: 2, postingHosts: 1 });
    expect(() => checkPostingConfig('unknown', inventory)).toThrow('choose_runner_api_or_web');
    await rm(join(home, 'candidate-rules.json'));
    expect(() => checkPostingConfig('web', inventory)).toThrow('missing_posting_config');
    await writeLocal('candidate-rules.json', candidateRules.slice(0, 1));
    expect(() => checkPostingConfig('runner', inventory)).toThrow('posting_config_mismatch');
    await writeLocal('email-routes.json', [{ ...emailRoutes[0], recipient: 'other@example.test' }, emailRoutes[1]]);
    expect(() => checkPostingConfig('api', inventory)).toThrow('posting_config_mismatch');
    await writeLocal('email-routes.json', [emailRoutes[0], { ...emailRoutes[0], sourceUrls: [emailRoutes[0].sourceUrls[1]] }]);
    expect(() => checkPostingConfig('api', inventory)).toThrow('invalid_email_routes');
    await chmod(inventory, 0o644);
    expect(() => checkPostingConfig('web', inventory)).toThrow('invalid_posting_inventory');
  } finally {
    if (previousHome === undefined) delete process.env.QUANTSELF_JOBS_HOME;
    else process.env.QUANTSELF_JOBS_HOME = previousHome;
    if (previousRoutes === undefined) delete process.env.QUANTSELF_JOBS_EMAIL_ROUTES;
    else process.env.QUANTSELF_JOBS_EMAIL_ROUTES = previousRoutes;
    await rm(home, { force: true, recursive: true });
  }
});
