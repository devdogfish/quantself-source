import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobsHome } from './config';

const filesScript = fileURLToPath(new URL('./files.py', import.meta.url));
const customResumeScript = fileURLToPath(new URL('./resume_document.py', import.meta.url));
type ContactField = 'email' | 'phone';

export class LocalContactRequired extends Error {
  constructor(readonly fields: readonly [ContactField, ...ContactField[]]) {
    super(`current_contact_${fields[0]}_required`);
  }
}

export function missingContactOutcome(error: unknown) {
  if (error instanceof LocalContactRequired) {
    return { kind: 'failed', code: 'manual_required', attention: { questions: [], variables: [...error.fields] } } as const;
  }
}

function localFilesError(output: string) {
  try {
    const { error, fields } = JSON.parse(output) as { error?: unknown; fields?: unknown };
    if (Array.isArray(fields) && fields.length > 0 && fields.length <= 2 && new Set(fields).size === fields.length &&
        fields.every(field => field === 'email' || field === 'phone') && error === `current_contact_${fields[0]}_required`) {
      return new LocalContactRequired(fields as [ContactField, ...ContactField[]]);
    }
  } catch { /* Other local process output can contain private paths or values. */ }
  return new Error('local_file_operation_failed');
}

export function localPython() {
  const privatePython = join(jobsHome(), 'runtime/bin/python');
  const bundledPython = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
  return process.env.QUANTSELF_JOBS_PYTHON || (existsSync(privatePython) ? privatePython : existsSync(bundledPython) ? bundledPython : 'python3');
}

export async function localFiles(args: string[]) {
  return new Promise<string>((resolveResult, reject) => {
    const command = args[0] === 'custom-pdf' ? [customResumeScript, ...args.slice(1)] : [filesScript, ...args];
    const child = spawn(localPython(), command, { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', data => { if (output.length < 8_000) output += String(data).slice(0, 8_000 - output.length); });
    child.on('error', () => reject(new Error('local_file_operation_failed')));
    child.on('close', code => code === 0 ? resolveResult(output.trim()) : reject(localFilesError(output)));
  });
}
