import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join } from "node:path";

const shards = 64;
const gib = 2 ** 30;

function testProcess(args: string[], output: "inherit" | number = "inherit") {
  return Bun.spawn([process.execPath, "test", "--isolate", ...args], {
    stdin: "inherit",
    stdout: output,
    stderr: output,
  });
}

function shardSummary(report: string) {
  const header = report.match(/<testsuites\b[^>]*>/)?.[0] ?? "";
  const attributes = Object.fromEntries(
    [...header.matchAll(/(tests|failures|skipped|assertions)="(\d+)"/g)]
      .map(([, name, value]) => [name, Number(value)]),
  );
  if (attributes.tests === undefined || attributes.failures === undefined ||
      attributes.skipped === undefined || attributes.assertions === undefined) {
    throw new Error("Missing Bun test counts");
  }
  const { tests, failures, skipped, assertions } = attributes;
  return {
    passed: tests - failures - skipped,
    failed: failures,
    skipped,
    assertions,
    files: new Set([...report.matchAll(/<testsuite\s+[^>]*\bfile="([^"]+)"/g)].map(([, file]) => file)).size,
  };
}

export async function runShardedTests(shardCount: number, workers: number, filters: string[] = []) {
  const start = performance.now();
  const directory = await mkdtemp(join(tmpdir(), "quantself-tests-"));
  const totals = { passed: 0, failed: 0, skipped: 0, assertions: 0, files: 0 };
  let next = 1;
  let failures = 0;

  async function runWorker() {
    while (next <= shardCount) {
      const shard = next++;
      const log = join(directory, `${shard}.log`);
      const report = join(directory, `${shard}.xml`);
      const output = await open(log, "w");
      let exitCode: number;
      try {
        exitCode = await testProcess([
          `--shard=${shard}/${shardCount}`,
          "--reporter=junit",
          `--reporter-outfile=${report}`,
          ...filters,
        ], output.fd).exited;
      } finally {
        await output.close();
      }

      let summary: ReturnType<typeof shardSummary> | undefined;
      try {
        summary = shardSummary(await readFile(report, "utf8"));
        totals.passed += summary.passed;
        totals.failed += summary.failed;
        totals.skipped += summary.skipped;
        totals.assertions += summary.assertions;
        totals.files += summary.files;
      } catch {
        console.error(`Shard ${shard}/${shardCount} has no readable test report.`);
      }
      if (exitCode !== 0 || !summary || summary.failed) {
        failures++;
        console.error(`\nShard ${shard}/${shardCount} failed with exit code ${exitCode}.`);
        console.error(await readFile(log, "utf8"));
      }
    }
  }

  try {
    const results = await Promise.allSettled(Array.from({ length: workers }, runWorker));
    const rejected = results.find(result => result.status === "rejected");
    if (rejected) throw rejected.reason;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }

  console.log(`${totals.passed} pass, ${totals.failed} fail, ${totals.skipped} skip/todo, ${totals.assertions} assertions`);
  console.log(`Ran ${totals.passed + totals.failed + totals.skipped} tests across ${totals.files} files in ${((performance.now() - start) / 1000).toFixed(2)}s (${workers} workers, ${shardCount} shards).`);
  return failures ? 1 : 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length) process.exit(await testProcess(args).exited);

  const cpus = Math.floor(availableParallelism() / 2);
  const memory = Math.min(process.constrainedMemory() || totalmem(), totalmem());
  const workers = Math.max(1, Math.min(3, cpus, Math.floor(memory / (4 * gib))));
  process.exit(await runShardedTests(shards, workers));
}
