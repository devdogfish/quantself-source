import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { jobsHome } from './config';

const legacyQueues = ['revise', 'submit', 'requirements'] as const;
const applicationId = z.uuid();
const revisionJournal = /^(?:approved|(?:browser|email|ses|smtp)-result)\.json(?:\.[\w-]+)*$/;
const maxEvidenceBytes = 4 * 1024 * 1024;

async function directoryEntries(path: string) {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!metadata) return [];
  if (!metadata.isDirectory()) throw new Error('invalid_legacy_evidence_path');
  return readdir(path, { withFileTypes: true });
}

async function readEvidence(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maxEvidenceBytes) throw new Error('invalid_legacy_evidence_path');
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await file.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('legacy_evidence_changed');
    }
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

async function checkLegacyLocks(home: string) {
  for (const kind of ['revise', 'submit'] as const) {
    const lock = await readEvidence(join(home, `${kind}.lock`)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!lock) continue;
    const value = lock.toString('utf8').trim();
    const pid = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(pid) || pid < 1) throw new Error('legacy_worker_lock_requires_review');
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue;
      throw error;
    }
    throw new Error('legacy_worker_still_running');
  }
}

async function evidencePaths(home: string) {
  const paths: string[] = [];
  const outbox = await directoryEntries(join(home, 'outbox'));
  for (const kind of legacyQueues) {
    if (!outbox.some(entry => entry.name === kind)) continue;
    for (const item of await directoryEntries(join(home, 'outbox', kind))) {
      paths.push(join('outbox', kind, item.name));
    }
  }
  for (const application of await directoryEntries(join(home, 'applications'))) {
    if (!applicationId.safeParse(application.name).success) continue;
    const parent = join('applications', application.name);
    for (const entry of await directoryEntries(join(home, parent))) {
      if (/^indeed-[\w-]+\.json(?:\.tmp)?$/.test(entry.name)) paths.push(join(parent, entry.name));
      if (!/^\d+$/.test(entry.name)) continue;
      for (const item of await directoryEntries(join(home, parent, entry.name))) {
        if (revisionJournal.test(item.name)) paths.push(join(parent, entry.name, item.name));
      }
    }
  }
  return paths.sort();
}

async function syncDirectory(path: string) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeEvidence(path: string, bytes: Uint8Array) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function archiveLegacyOutbox(home = jobsHome()) {
  const root = await realpath(home);
  await checkLegacyLocks(root);
  const paths = await evidencePaths(root);
  const capturedAt = new Date().toISOString();
  const directory = join(root, `legacy-outbox-${capturedAt.replace(/[:.]/g, '-')}-${randomUUID()}`);
  const staging = await mkdtemp(join(root, '.legacy-outbox-'));
  try {
    const entries: { path: string; bytes: number; sha256: string }[] = [];
    const folders = new Set([staging]);
    for (const path of paths) {
      const bytes = await readEvidence(join(root, path));
      const target = join(staging, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      for (let folder = dirname(target); folder !== staging; folder = dirname(folder)) folders.add(folder);
      await writeEvidence(target, bytes);
      entries.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
    }
    await checkLegacyLocks(root);
    const currentPaths = await evidencePaths(root);
    if (currentPaths.length !== paths.length || currentPaths.some((path, index) => path !== paths[index])) {
      throw new Error('legacy_evidence_changed');
    }
    for (const entry of entries) {
      if (sha256(await readEvidence(join(root, entry.path))) !== entry.sha256) throw new Error('legacy_evidence_changed');
    }
    await writeEvidence(join(staging, 'manifest.json'), Buffer.from(JSON.stringify({ version: 1, capturedAt, entries }, null, 2) + '\n'));
    for (const folder of [...folders].sort((a, b) => b.length - a.length)) await syncDirectory(folder);
    await rename(staging, directory);
    await syncDirectory(root);
    return { directory, files: entries.length };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await archiveLegacyOutbox().then(({ directory, files }) => {
    console.log(`Archived ${files} legacy evidence files in ${directory}`);
  }).catch(error => {
    const code = error instanceof Error ? error.message : '';
    console.error(/^(legacy_worker_still_running|legacy_worker_lock_requires_review|legacy_evidence_changed|invalid_legacy_evidence_path)$/.test(code)
      ? code : 'legacy_archive_failed');
    process.exitCode = 1;
  });
}
