import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

test('application PDF links use one registered identity and fail closed', () => {
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', import.meta.dir, '-p', 'application_links_test.py'], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  expect(result.status, result.stderr).toBe(0);
});
