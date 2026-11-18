// Each successful sandbox produces a draft PR for human review.
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { withSharedCodexAuth } from "./shared-auth.mjs";
import { blockers, selectReady, type QueueIssue } from "./queue.mjs";

const repo = "devdogfish/quantself";
const githubEnv = { ...process.env };
delete githubEnv.GH_TOKEN;
delete githubEnv.GITHUB_TOKEN;
const gh = (...args: string[]) => execFileSync("gh", args, { encoding: "utf8", env: githubEnv }).trim();
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const complete = "<promise>COMPLETE</promise>";
const blocked = "<promise>BLOCKED</promise>";
const issueFields = "number,title,state,body,labels";
const queue: QueueIssue[] = JSON.parse(gh("issue", "list", "-R", repo, "--state", "open",
  "--label", "Sandcastle", "--label", "ready-afk", "--limit", "1000", "--json", issueFields));
const getStates = (issues: QueueIssue[]) => new Map<number, string>(
  [...new Set(issues.flatMap(issue => blockers(issue) ?? []))].map(number =>
    [number, JSON.parse(gh("issue", "view", String(number), "-R", repo, "--json", "state")).state]),
);
const states = getStates(queue);
const existing = new Set<string>(JSON.parse(gh("pr", "list", "-R", repo, "--state", "all",
  "--limit", "200", "--json", "headRefName")).map((pr: { headRefName: string }) => pr.headRefName));
const ready = selectReady(queue, states).filter(issue => !existing.has(`sandcastle/issue-${issue.number}`));
if (!ready.length) {
  console.log("No eligible issues without an existing PR.");
  process.exit(0);
}
git("fetch", "origin", "main");
const base = git("rev-parse", "origin/main");
const implementation = readFileSync(".sandcastle/implement-prompt.md", "utf8")
  .replace("bun test", "bun run test");
const review = readFileSync(".sandcastle/review-prompt.md", "utf8");
const agent = sandcastle.codex("gpt-6.1-sol");

await withSharedCodexAuth(async ({ home, signal }) => {
  const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", env: githubEnv }).trim();
  const sandboxProvider = docker({
    cpus: 2,
    network: "quantself-sandcastle_quantself_internal",
    env: { CODEX_HOME: "/home/agent/.codex", GH_TOKEN: token,
      DATABASE_URL: "postgresql://unused:unused@invalid:5432/unused" },
    mounts: [{ hostPath: home, sandboxPath: "/home/agent/.codex" }],
  });
  const hooks = { sandbox: { onSandboxReady: [{
    timeoutMs: 300_000,
    command: "rm -rf node_modules && mkdir -p /home/agent/node_modules && ln -s /home/agent/node_modules node_modules && bun install --frozen-lockfile --linker hoisted && bun run db:generate",
  }] } };
  // Full repository checks are memory-intensive; run one sandbox at a time.
  for (let offset = 0; offset < ready.length; offset += 1) {
    const results = await Promise.allSettled(ready.slice(offset, offset + 1).map(async issue => {
      const branch = `sandcastle/issue-${issue.number}`;
      const current = JSON.parse(gh("issue", "view", String(issue.number), "-R", repo, "--json", issueFields));
      if (!selectReady([current], getStates([current])).length) throw new Error(`#${issue.number} is no longer eligible`);
      // Existing branches need explicit inspection rather than accidental reuse or force-push.
      const local = execFileSync("git", ["branch", "--list", branch], { encoding: "utf8" }).trim();
      const remote = git("ls-remote", "--heads", "origin", branch);
      if (local || remote) throw new Error(`${branch} already exists; inspect it before resuming`);
      const sandbox = await sandcastle.createSandbox({ branch, baseBranch: base, sandbox: sandboxProvider, hooks });
      try {
        const prompt = implementation.replaceAll("{{TASK_ID}}", String(issue.number))
          .replaceAll("{{ISSUE_TITLE}}", issue.title).replaceAll("{{BRANCH}}", branch);
        const result = await sandbox.run({ name: `issue-${issue.number}`, agent, signal,
          maxIterations: 100, completionSignal: [complete, blocked],
          prompt: `${prompt}\nNever push, merge, close issues, or modify docs/github-systems/. Fetch and API changes are in scope when required by the issue. Follow AGENTS.md performance rules: avoid N+1, bound requests, and cover fan-out regressions. Follow docs/responsive-interaction.md and verify mutation UI with deferred responses.` });
        if (!result.stdout.trim().endsWith(complete) || !result.commits.length)
          throw new Error(`Issue #${issue.number} incomplete; branch preserved`);
        const checked = await sandbox.run({ name: `review-${issue.number}`, agent, signal,
          maxIterations: 1, completionSignal: [complete, blocked],
          prompt: `Read issue #${issue.number} and its parent, and review against their acceptance criteria. ${review.replaceAll("{{BRANCH}}", branch).replaceAll("{{TARGET_BRANCH}}", base)}
Use git diff ${base}...HEAD. Check AGENTS.md performance rules, authorization and docs/responsive-interaction.md; test deferred responses for mutation UI. Run bun run typecheck and bun run test. If requirements or checks fail, report findings and output ${blocked}, not ${complete}. Do not push, merge, close issues, or modify docs/github-systems/.` });
        if (!checked.stdout.trim().endsWith(complete)) throw new Error(`Review of #${issue.number} incomplete`);
      } finally {
        await sandbox.close();
      }
      git("push", "origin", `refs/heads/${branch}:refs/heads/${branch}`);
      const body = `Implements #${issue.number}.\n\nDraft pending coordinator review of acceptance criteria and verification.\n`;
      const url = gh("pr", "create", "-R", repo, "--draft", "--base", "main", "--head", branch,
        "--title", issue.title, "--body", body);
      console.log(`Draft PR for #${issue.number}: ${url}`);
    }));
    for (const result of results) {
      if (result.status === "rejected") {
        console.error(result.reason);
        process.exitCode = 1;
      }
    }
  }
});
