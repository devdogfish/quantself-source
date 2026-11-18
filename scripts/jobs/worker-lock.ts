import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { jobsHome } from './config';

export async function acquireWorkerLock(kind: string) {
  await mkdir(jobsHome(), { recursive: true, mode: 0o700 });
  const lock = join(jobsHome(), `${kind}.lock`);
  const attempt = async () => {
    const handle = await open(lock, 'wx', 0o600);
    try { await handle.writeFile(String(process.pid)); } finally { await handle.close(); }
    return async () => { await rm(lock, { force: true }); };
  };
  try { return await attempt(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error('runner_lock_requires_review');
    try { process.kill(pid, 0); throw new Error('runner_already_running'); }
    catch (processError) { if ((processError as NodeJS.ErrnoException).code !== 'ESRCH') throw processError; }
    await rm(lock); return attempt();
  }
}
