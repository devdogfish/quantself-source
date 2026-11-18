# Dev Issue System

This document explains the GitHub issue system used for software projects: how bugs and features become issues, what each label means, and how AI agents turn approved issues into code. It stands on its own, and each term is explained the first time it appears. It is based on Matt Pocock's open-source skills, Sandcastle, and Course Video Manager repositories. Those repositories differ in places, and this document marks where.

## 1. Core idea

Three layers work together. Skills define the work, GitHub stores it, and Sandcastle runs the agents. GitHub Actions can trigger those agents. A report becomes an issue, is triaged into a clear brief, is implemented by an agent as a pull request, is reviewed, and is merged by you.

### Terms

| Term | Meaning |
| --- | --- |
| Skill | A reusable instruction file an AI follows for one kind of job, invoked by name, such as `/triage`. |
| Issue | GitHub's tracker item. One per bug, feature, or task. |
| Label | A tag on an issue. Most workflow state lives in labels. |
| Sub-issue | A child issue nested under a parent issue. |
| Blocked-by | A native GitHub link saying an issue cannot start until another issue closes. |
| Branch | A separate line of code changes, kept apart from the main code. |
| Pull request (PR) | A proposal to merge a branch into the main code. It waits for review. |
| Agent | An AI that reads an issue and does the work. |
| Sandcastle | A tool that runs coding agents, usually inside isolated Docker containers, and can run several at once. |
| GitHub Actions | GitHub's automation. A workflow runs when something happens, such as a label being added. |
| Spec (PRD) | A document describing a larger feature: what to build and why. |
| Grilling | An AI interviewing you until a request's requirements and decisions are pinned down. |
| Agent Brief | A comment on an issue that acts as the implementation contract for an agent. |

## 2. From request to issues

The path depends on how well understood the work is.

| Starting point | Skills used | GitHub result |
| --- | --- | --- |
| Incoming bug or feature request | `/triage`: investigate, verify, ask questions if needed | The existing issue gets an Agent Brief and a readiness label |
| Small, understood change | `/grill-with-docs`, then `/implement` | Implemented directly. No spec or sub-issues required. |
| Larger, understood feature | `/grill-with-docs`, then `/to-spec`, then `/to-tickets` | A spec as a parent issue, plus implementable child issues |
| Large effort with unresolved decisions | `/wayfinder`, then decisions, then `/to-spec`, then `/to-tickets` | A decision map first. Implementation issues come afterward. |

`/triage` prepares incoming work and does not implement it. Tickets created by `/to-tickets` are already ready for agents and need no triage pass.

A triaged standalone issue gets an Agent Brief comment covering current behavior, desired behavior, relevant interfaces, acceptance criteria, and exclusions. The brief becomes the implementation contract. The original report stays as context.

## 3. Labels

Label names below come from the source repositories. Yours may rename them, which the triage section explains.

### GitHub's default labels

These categorize work. They do not start any agent.

| Label | Meaning |
| --- | --- |
| `bug` | Broken behavior |
| `enhancement` | Feature or improvement |
| `documentation` | Documentation work |
| `duplicate` | Already reported elsewhere |
| `invalid` | Invalid or inapplicable report |
| `question` | Information requested |
| `good first issue` | Suitable for newcomers |
| `help wanted` | Contributions wanted |
| `wontfix` | Will not be pursued |
| `accessibility` | Accessibility barrier |

GitHub's current documentation includes `accessibility`. Older repositories may keep a different default set.

### Triage labels

Triage means sorting an incoming issue. A triaged issue gets one category (`bug` or `enhancement`) and exactly one of these states.

| Label | Meaning |
| --- | --- |
| `needs-triage` | A maintainer must evaluate it |
| `needs-info` | Waiting on the reporter |
| `ready-for-agent` | Fully specified. An agent can implement it. |
| `ready-for-human` | A person must implement it |
| `wontfix` | Rejected. Close with an explanation. |

These are roles, and the label names are configurable. In Course Video Manager, the `ready-for-agent` role maps to a label actually named `Sandcastle`, so you do not necessarily need both.

In the skills repository, GitHub Actions adds `needs-triage` to new issues automatically. A scheduled workflow closes `needs-info` issues left unanswered for 14 days and returns updated ones to triage.

### Wayfinder labels

Wayfinder issues hold decisions, not code. They carry only these labels, never readiness labels. Native blocked-by links decide what can proceed, and assignees claim tickets.

| Label | Purpose |
| --- | --- |
| `wayfinder:map` | The overall decision map |
| `wayfinder:grilling` | A decision that needs a conversation |
| `wayfinder:research` | An investigation |
| `wayfinder:prototype` | A prototype built to clarify a decision |
| `wayfinder:task` | Preparatory action needed before deciding |

### Agent labels

These are the controls of Matt Pocock's own repository workflows. They are not supported by every Sandcastle installation.

| Label | Effect |
| --- | --- |
| `agent:implement` on an issue | Implement a standalone issue, or a parent spec where supported |
| `agent:implement` on a PR | Address feedback on the existing branch |
| `agent:to-issues` | Split a spec into native sub-issues |
| `agent:queued` | Wait for native blocked-by issues to close, then start |
| `agent:review` | Review a PR, make improvements, and post findings |
| `agent:update-branch` | Update a PR against its base branch and resolve conflicts |
| `agent:explore` | Investigate queued reports, group duplicates, and route outcomes |
| `agent:in-progress` | A workflow is running |
| `agent:blocked` | The run failed or refused, or exploration found an external blocker |

Trigger labels are generally removed when work starts. A failure adds `agent:blocked`, and re-applying the trigger retries. The explore workflow routes clear fixes to `agent:implement`, human decisions to `ready-for-human`, and blocked work to `agent:blocked`.

## 4. How agents run

| Route | What happens |
| --- | --- |
| Local Sandcastle | A generated query selects issues with the Sandcastle label, and your chosen template orchestrates them |
| Parallel planner with review | Plans dependencies, implements independent issues at the same time, reviews them, merges the successful branches locally, and repeats |
| GitHub Actions | Applying an `agent:*` trigger label starts a workflow on GitHub's own servers |

The default parallel template merges locally. Stopping at a PR needs different orchestration. One repository's local runner caps concurrency at four, which is that repository's choice and not a Sandcastle limit.

The Actions workflows use Claude Code OAuth, with Sandcastle running directly on GitHub's runner. They are not local Docker agents receiving remote commands.

### Larger features: specs and dependencies

In Course Video Manager's Actions, a spec is implemented like this:

1. Write the spec.
2. Create its children with `/to-tickets`, or let `agent:to-issues` split it automatically.
3. Add `agent:implement` to the parent. The workflow detects the native sub-issues, so no special spec label is needed.
4. The workflow implements the first open child on one shared branch, then closes that child.
5. Re-trigger it for each next child. All of them reuse one draft PR.
6. When every child is done, trigger the automated review. The parent closes when the PR merges.

This loop is sequential, in sub-issue order. Parallel implementation comes from the local parallel runner or the `/implement-spec` skill, which works through the dependency graph on separate branches. These are two distinct mechanisms.

`agent:queued` uses native blocked-by links to start issues after their blockers close. A parent-child relationship alone does not create a dependency. Applying `agent:implement` directly skips the waiting.

## 5. Review and completion

`/implement` uses `/tdd` (write the tests first), then `/code-review`, which checks coding standards and compliance with the specification. The Actions review agent also fixes what it finds, and `agent:implement` on the PR handles later feedback. `/pr` shapes the PR description. `/retro` improves instructions and checks afterward.

## 6. How it runs in this setup

| Piece | Runs where | Job |
| --- | --- | --- |
| Hermes | Docker on your Mac, beside the client relay | Reads client messages forwarded into Discord. Files actionable bug issues in the correct repo. Escalates features and unclear requests to you. |
| Sandcastle implementation and review agents | Docker on your Mac, using each app's own Sandcastle setup | Pick up ready issues, implement and test the change, then open PRs. Currently configured to stop before merging. |
| You and Codex | Codex desktop app | Grilling and wayfinder for features, decisions, and PR review. Approved implementation issues then go to Sandcastle. |

n8n only forwards messages and is not an agent. A local timer checks for Sandcastle work every five minutes and is not an agent either. All automated agents depend on your Mac being awake. A future server migration moves Hermes, n8n, and Sandcastle there, while your interactive work stays in Codex.

## 7. Repository-specific extras

These labels appear only in some repositories: `source:architecture-review` (automatically proposed architecture specs), `ai-drafted-feedback` and `unsure` in the skills repository, and plain `blocked` in Course Video Manager. The labels `waiting-on-events`, plain `in-progress`, and `awaiting-review` were not present in any of the three source repositories, so do not treat them as defaults.

## Sources

- [Triage skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/triage/SKILL.md) and [Agent Brief format](https://github.com/mattpocock/skills/blob/main/skills/engineering/triage/AGENT-BRIEF.md)
- [Triage label mapping](https://github.com/mattpocock/course-video-manager/blob/main/docs/agents/triage-labels.md)
- [Wayfinder skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/wayfinder/SKILL.md)
- [Course Video Manager Actions workflows](https://github.com/mattpocock/course-video-manager/tree/main/.github/workflows)
- [Parallel implementation skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/implement-spec/SKILL.md)
- [Queue rules](https://github.com/mattpocock/course-video-manager/blob/main/docs/agents/queued-promotion.md)
