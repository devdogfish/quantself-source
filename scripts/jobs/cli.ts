import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { jobsHome, readLocal, writeLocal } from './config';
import { reconcileLocalIntake } from './intake-audit';
import { addJobHelp, DirectJobArgumentsError, importJobBatch, loadIntakeConfig, parseDirectJob } from './intake';
import { localFiles } from './local-files';
import { syncPrivateRequirements } from './private-fields';

async function importJobs() {
  const config = await loadIntakeConfig();
  const sourceDirectory = process.env.QUANTSELF_JOBS_SOURCE || join(homedir(), 'dev/Excel');
  const importPath = join(jobsHome(), 'import.json');
  await localFiles(['import', '--source', sourceDirectory, '--output', importPath]);
  const source = JSON.parse(await readFile(importPath, 'utf8')) as { applications: {
    sourceStatus: string; company: string; role: string; sourceUrl: string; description?: string | null;
  }[] };
  const reconciled = await reconcileLocalIntake(source.applications);
  if (reconciled.some((row, index) => row !== source.applications[index])) {
    source.applications = reconciled;
    await writeLocal('import.json', source);
  }
  // Preserve prior submissions over same-URL fresh candidates across batches.
  const rank = (status: string) => status === 'applied' ? 0 : status === 'rejected' ? 1 : status === 'draft' ? 3 : 2;
  source.applications.sort((a, b) => rank(a.sourceStatus) - rank(b.sourceStatus));
  let imported = 0;
  let duplicates = 0;
  for (let offset = 0; offset < source.applications.length; offset += 100) {
    const result = await importJobBatch(config, source.applications.slice(offset, offset + 100));
    imported += result.imported;
    duplicates += result.duplicates;
  }
  console.log(`Imported ${imported}; already tracked ${duplicates}.`);
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...flags] = args;
  if (command === 'add') {
    const posting = parseDirectJob(flags);
    if (!posting) { console.log(addJobHelp); return; }
    const { imported, duplicates } = await importJobBatch(await loadIntakeConfig(), [posting]);
    console.log(`Imported ${imported}; already tracked ${duplicates}.`);
  } else if (command === 'import' && !flags.length) await importJobs();
  else if (command === 'requirements' && !flags.length) {
    const result = await syncPrivateRequirements(await loadIntakeConfig(), { cdpUrl: process.env.JOBS_RUNNER_CDP_URL });
    console.log(`Found ${result.requirements} private-field requirements across ${result.forms} forms. Registered ${result.registered} new requirements.`);
  } else {
    throw new Error('jobs_intake_usage');
  }
}

if (import.meta.main) {
  await main().catch(error => {
    if (error instanceof DirectJobArgumentsError) {
      console.error(`${error.message} Run bun run jobs:add --help.`);
    } else if (error instanceof Error && error.message === 'jobs_intake_usage') {
      console.error('Usage: bun run jobs:add --help or bun run jobs:import.');
    } else {
      const code = error instanceof Error ? error.message : '';
      console.error(/^(?:jobs_api_\d+|jobs_intake_configuration_required|invalid_api_origin|local_file_operation_failed)$/.test(code)
        ? code : 'jobs_intake_failed');
    }
    process.exitCode = 1;
  });
}
