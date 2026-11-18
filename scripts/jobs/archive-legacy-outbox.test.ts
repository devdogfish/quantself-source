import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { archiveLegacyOutbox } from './archive-legacy-outbox';

const application = '10000000-0000-4000-8000-000000000001';

async function withHome(run: (home: string, write: (path: string, value: string) => Promise<void>) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'qs-legacy-jobs-'));
  try {
    await run(home, async (path, value) => {
      const target = join(home, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, value);
    });
  } finally { await rm(home, { recursive: true, force: true }); }
}

test('preserves legacy result, question and send journals byte-for-byte in a private archive', async () => {
  await withHome(async (home, write) => {
    const revision = `applications/${application}/2`;
    const evidence = [
      ['outbox/submit/receipt.json', '{"token":"synthetic-lease","result":{"kind":"applied"}}\n'],
      ['outbox/revise/result.json.tmp', '{"incomplete":'],
      ['outbox/requirements/question.json.invalid', 'malformed prior question'],
      [`${revision}/smtp-result.json`, '{"state":"pending"}'],
      [`${revision}/ses-result.json.fixture.tmp`, '{"state":"accepted","messageId":"synthetic-receipt"}'],
      [`${revision}/browser-result.json`, '{"kind":"failed","code":"submission_uncertain"}'],
      [`applications/${application}/indeed-final-submit-attempt.json`, '{"stage":"final_submit_attempted"}'],
    ];
    for (const [path, value] of evidence) await write(path, value);
    await write('worker-v2/outbox/receipt.json', 'active worker outbox');
    await write('private.json', 'private config');
    await write(`${revision}/resume.pdf`, 'private PDF');
    const result = await archiveLegacyOutbox(home);
    expect(result.files).toBe(evidence.length);
    expect((await lstat(result.directory)).mode & 0o777).toBe(0o700);
    const manifestPath = join(result.directory, 'manifest.json');
    expect((await lstat(manifestPath)).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(manifest.version).toBe(1);
    expect(manifest.entries.map((entry: { path: string }) => entry.path)).toEqual(evidence.map(([path]) => path).sort());
    for (const [path, value] of evidence) {
      expect(await readFile(join(home, path), 'utf8')).toBe(value);
      expect(await readFile(join(result.directory, path), 'utf8')).toBe(value);
      expect((await lstat(join(result.directory, path))).mode & 0o777).toBe(0o600);
      expect(manifest.entries).toContainEqual({ path, bytes: Buffer.byteLength(value),
        sha256: createHash('sha256').update(value).digest('hex') });
    }
    expect((await readdir(result.directory)).sort()).toEqual(['applications', 'manifest.json', 'outbox']);
  });
});

test('refuses a live legacy lock and never publishes a partial archive when evidence is a symbolic link', async () => {
  await withHome(async (home, write) => {
    await write('submit.lock', String(process.pid));
    await expect(archiveLegacyOutbox(home)).rejects.toThrow('legacy_worker_still_running');
    expect(await readdir(home)).toEqual(['submit.lock']);
  });
  await withHome(async (home, write) => {
    await write('private.json', 'private config');
    await write('outbox/submit/receipt.json', 'pending');
    await symlink(join(home, 'private.json'), join(home, 'outbox/submit/symlink.json'));
    await expect(archiveLegacyOutbox(home)).rejects.toThrow();
    expect((await readdir(home)).sort()).toEqual(['outbox', 'private.json']);
    expect(await readFile(join(home, 'outbox/submit/receipt.json'), 'utf8')).toBe('pending');
  });
});
