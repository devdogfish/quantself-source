import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { readEmailRoutes } from './email-routes';
import { readCandidateRules } from './local-candidate-rules';
import { readPrivatePostingFile } from './private-posting-file';
import { readPublicPostingHosts } from './public-posting';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const entry = z.strictObject({ count: z.number().int().positive(), digest });
const inventory = z.strictObject({ emailRoutes: entry, candidateRules: entry, postingHosts: entry });

function summarize(values: unknown[]) {
  if (values.length === 0) throw new Error('missing_posting_config');
  return { count: values.length, digest: createHash('sha256').update(JSON.stringify(values)).digest('hex') };
}

function currentInventory(role: 'runner' | 'api' | 'web') {
  return {
    ...(role !== 'web' && { emailRoutes: summarize(readEmailRoutes()) }),
    ...(role !== 'api' && { candidateRules: summarize(readCandidateRules()) }),
    ...(role === 'runner' && { postingHosts: summarize([...readPublicPostingHosts()].sort()) }),
  };
}

export async function writePostingConfigInventory(path: string) {
  await writeFile(path, JSON.stringify(currentInventory('runner'), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

export function checkPostingConfig(role: string | undefined, inventoryPath: string | undefined) {
  if (role !== 'runner' && role !== 'api' && role !== 'web') throw new Error('choose_runner_api_or_web');
  if (!inventoryPath) throw new Error('missing_posting_inventory');
  const expected = inventory.safeParse(readPrivatePostingFile(inventoryPath, {
    maxBytes: 2_048, errorCode: 'invalid_posting_inventory',
  }));
  if (!expected.success) throw new Error('invalid_posting_inventory');
  return Object.fromEntries(Object.entries(currentInventory(role)).map(([key, actual]) => {
    const reviewed = expected.data[key as keyof typeof expected.data];
    if (actual.count !== reviewed.count || actual.digest !== reviewed.digest) throw new Error('posting_config_mismatch');
    return [key, actual.count];
  }));
}

if (import.meta.main) {
  try {
    const [, , action, path] = process.argv;
    if (action === 'inventory' && path) await writePostingConfigInventory(path);
    else console.log(JSON.stringify(checkPostingConfig(action, path)));
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const safe = ['choose_runner_api_or_web', 'missing_posting_config', 'invalid_email_routes',
      'invalid_candidate_rules', 'invalid_public_posting_hosts', 'missing_posting_inventory',
      'invalid_posting_inventory', 'posting_config_mismatch'];
    console.error(safe.includes(code) ? code : 'posting_config_unavailable');
    process.exitCode = 1;
  }
}
