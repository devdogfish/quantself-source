import { inspectJobsPilotBilling } from '../../apps/api/src/jobs-pilot-billing-preflight';

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--fixture')) throw new Error('Invalid arguments');
  const input = args.length ? await import('../../automation/n8n/jobs-feed/smoke/pilot-posting.mjs').then(({ posting, criteria }) => ({
    sourceIdentity: posting.sourceIdentity, posting, criteria, previousScreen: 'none',
  })) : await Bun.stdin.json();
  console.log(JSON.stringify(inspectJobsPilotBilling(input), null, 2));
  process.exitCode = 2;
} catch {
  console.error('Supply valid pilot JSON on stdin or use --fixture. No provider request was made.');
  process.exitCode = 1;
}
