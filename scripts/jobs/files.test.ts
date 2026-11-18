import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalContactRequired, localFiles, missingContactOutcome } from './local-files';

test('local resume assembly preserves everything outside the reviewed summary', () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('./files_test.py', import.meta.url))], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('Ran 12 tests');
});

test('renderer subprocess exposes only exact missing contact aliases and creates no PDF', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jobs-missing-contact-'));
  const python = process.env.QUANTSELF_JOBS_PYTHON;
  process.env.QUANTSELF_JOBS_PYTHON = 'python3';
  const source = join(directory, 'source.md');
  const work = join(directory, 'work.json');
  const config = join(directory, 'config.json');
  const output = join(directory, 'resume.pdf');
  try {
    await writeFile(source, '# Synthetic Person\nold@example.test\n+1 (555) 234-5678\n\n## Summary\n\nOriginal facts.\n\n## Experience\n\nExisting text.\n');
    await writeFile(work, JSON.stringify({ resumeTrack: 'web', summary: 'Current facts.' }));
    const run = () => localFiles(['pdf', '--private-config', config, '--work', work, '--output', output]);
    for (const [personal, fields] of [
      [{}, ['email', 'phone']],
      [{ email: 'current@example.test' }, ['phone']],
      [{ phone: '+1 (555) 987-6543' }, ['email']],
    ] as const) {
      await writeFile(config, JSON.stringify({ resumePaths: { web: source }, personal }));
      const error = await run().catch(error => error);
      expect(error).toBeInstanceOf(LocalContactRequired);
      expect(error.message).toBe(`current_contact_${fields[0]}_required`);
      expect(missingContactOutcome(error)).toEqual({ kind: 'failed', code: 'manual_required', attention: { questions: [], variables: fields } });
      expect(JSON.stringify(error)).not.toContain('example.test');
      await expect(stat(output)).rejects.toThrow();
    }
    await writeFile(config, '{}');
    const failure = await run().catch(error => error);
    expect(failure.message).toBe('local_file_operation_failed');
    expect(missingContactOutcome(failure)).toBeUndefined();
  } finally {
    if (python === undefined) delete process.env.QUANTSELF_JOBS_PYTHON;
    else process.env.QUANTSELF_JOBS_PYTHON = python;
    await rm(directory, { recursive: true, force: true });
  }
});
