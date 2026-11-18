import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { criteria, posting, screenBody } from "../../../automation/n8n/jobs-feed/smoke/pilot-posting.mjs";
import { inspectJobsPilotBilling } from "./jobs-pilot-billing-preflight";

const input = { sourceIdentity: posting.sourceIdentity, posting, criteria };

test("uses the exact screen digest and separates the public bound from conditional arithmetic", () => {
  const report = inspectJobsPilotBilling({ ...input, previousScreen: "none", estimatedInputTokens: 1 });
  expect(report.postingDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(report).toMatchObject({ decision: "blocked", estimatedInputTokens: 1, runAllowanceNanoUsd: 100_000_000,
    publicModelBound: { inputTokens: 1_000_000, maxNanoUsd: 500_960_000 },
    conditionalOnProviderProof: { inputTokensPerScreen: 20_000, maxNanoUsdPerScreen: 2_192_000, maxScreensNanoUsd: 4_384_000,
      remainingRunNanoUsdForBothModelPhases: 95_616_000 },
    request: { sha256: createHash("sha256").update(screenBody).digest("hex"), bytes: Buffer.byteLength(screenBody), maxOutputTokens: 384 },
  });
  const relabeled = inspectJobsPilotBilling({ ...input, posting: { ...posting, sourceLabel: "Other public label" } });
  expect(relabeled.request.sha256).toBe(report.request.sha256);
  expect(relabeled.postingDigest).not.toBe(report.postingDigest);
  expect(inspectJobsPilotBilling({ ...input, posting: { ...posting, role: `  ${posting.role}  ` } }).postingDigest)
    .toBe(report.postingDigest);
  expect(inspectJobsPilotBilling({ ...input, criteria: criteria + " for résumé editing" }).request.sha256).not.toBe(report.request.sha256);
  expect(inspectJobsPilotBilling({ ...input, posting: { ...posting, description: "\0".repeat(12_000) }, criteria: "\0".repeat(8_000) }).reasons)
    .toContain("canonical_request_exceeds_local_byte_limit");
  expect(() => inspectJobsPilotBilling({ ...input, sourceIdentity: "greenhouse:global:other:197" })).toThrow("exact permitted Greenhouse posting");
});

test("the CLI handles an ambiguous attempt offline and prints only sanitized evidence", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", "scripts/jobs/preflight-pilot-billing.ts"], {
    env: {}, stdin: new Blob([JSON.stringify({ ...input, previousScreen: "uncertain", estimatedInputTokens: 20 })]), stdout: "pipe", stderr: "pipe",
  });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(2);
  expect(error).toBe("");
  expect(output).not.toContain(criteria);
  expect(output).not.toContain(posting.description);
  expect(JSON.parse(output)).toMatchObject({ decision: "blocked", previousScreen: "uncertain",
    postingDigest: inspectJobsPilotBilling(input).postingDigest, reasons: expect.arrayContaining([
    "unresolved_charge_keep_full_hold_no_retry",
  ]) });
});
