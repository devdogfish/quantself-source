import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const tracks = ['engineering', 'web', 'admin'] as const;
export type Track = (typeof tracks)[number];
export type JobsApiConfig = { apiBaseUrl: string; apiKey: string };
export const submissionPaused = () => process.env.QUANTSELF_JOBS_SUBMIT_DISABLED === '1';
export type PrivateConfig = {
  personal: Record<string, string>;
  resumePaths: Record<Track, string>;
  rendererPath?: string;
  rendererPython?: string;
  resumeTrackingLinks?: Record<Track, Record<string, string>>;
  applicationTracking?: { url: string; registryUrl: string; token: string };
  answers?: Record<string, unknown>;
};

export function jobsHome() {
  return process.env.QUANTSELF_JOBS_HOME || join(homedir(), '.local/share/quantself/jobs');
}

export async function readLocal<T>(name: string): Promise<T> {
  // Do not log these files or errors with their contents. Some contain PII or keys.
  return JSON.parse(await readFile(join(jobsHome(), name), 'utf8')) as T;
}

export async function writeLocal(name: string, value: unknown) {
  const directory = jobsHome();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const target = join(directory, name);
  const temporary = target + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
}

export function apiOrigin(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('invalid_api_origin');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('invalid_api_origin');
  return url.origin;
}

export async function api<T>(config: JobsApiConfig, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  if (!config.apiKey) throw new Error('missing_api_key');
  const response = await fetch(`${apiOrigin(config.apiBaseUrl)}/api/v1/jobs${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-API-Key': config.apiKey, 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`jobs_api_${response.status}`);
  return response.json() as Promise<T>;
}
