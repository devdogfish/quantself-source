# To-Do Issue System

This document defines the GitHub issue types, labels, and fields that run a personal to-do list. It stands on its own: each term is explained the first time it appears. Section 6 explains how it differs from the separate setup used for software projects, so the two are not confused.

## 1. Core idea

Every to-do is one GitHub issue in a dedicated to-do repository. Labels on the issue record its workflow state. Project fields hold scheduling data such as dates and ordering. AI agents never act on a to-do until you approve it.

### Terms

| Term | Meaning |
| --- | --- |
| Issue | GitHub's tracker item. One per to-do. |
| Label | A tag on an issue. Workflow state lives in labels. |
| Project field | A custom column in a GitHub Project (a board view over issues), holding dates, numbers, or choices. |
| Sub-issue | A child issue nested under a parent issue. |
| Blocked-by | A link saying an issue cannot start until another issue closes. |
| Agent | An AI that reads an issue and does the work. It runs through a workflow. |
| Workflow | GitHub automation that runs when something happens, such as a label being added. |
| Dashboard | Your own app for viewing issues and approving agent work. |
| Capture | One voice dictation, call, or client message. It is stored as a capture record with a Capture ID. |
| Provenance block | A header at the top of an issue saying where it came from. |
| Agent Brief | A comment on an issue that spells out a task for an agent. |

## 2. Issue types

| Type | How to recognize it | Notes |
| --- | --- | --- |
| Task | Has the `task` label | The default. One thing to do. |
| Project | A parent issue with sub-issues | A multi-step to-do. The parent's body describes the goal, so no separate spec document is needed. Children can use blocked-by to enforce order. |
| Decision | Carries only `wayfinder:*` labels (section 3) | A big choice with options to compare, such as which laptop or which course. Use sparingly. |

Every issue starts with a provenance block at the top of the body: the source (dictation, call, client message, or agent-spawned), the timestamp, the raw transcript or a link to it, and the Capture ID.

## 3. Labels

### Category (exactly one)

| Label | Meaning |
| --- | --- |
| `task` | A to-do. Every issue carries it. |

### Triage state (exactly one)

| Label | Meaning |
| --- | --- |
| `needs-triage` | New and unsorted. Triage is the sorting step that decides who does it and what it needs. Added automatically. |
| `needs-info` | Waiting on you to clarify. Never auto-closes; a reminder may be sent instead. |
| `ready-for-human` | Only you can do it, or an agent has finished its prep and the rest is yours. |
| `ready-for-agent` | An agent could do this. **A proposal only:** nothing runs until you approve it with `agent:implement`. |
| `wontfix` | Rejected. Close as not planned. |

Duplicates close with GitHub's native duplicate reason.

### Agent controls

| Label | Meaning |
| --- | --- |
| `agent:implement` | **Your approval, and the run trigger.** Added by you in the dashboard or by confirming on the call. Adding it tells the workflow to start the agent. |
| `agent:in-progress` | The agent is running. Set and cleared by the workflow. |
| `agent:blocked` | The run failed or hit a blocker. Re-apply `agent:implement` to retry. |
| `agent:queued` | Waits for its blocked-by issues to close, then becomes `agent:implement` automatically. You approve at the moment you queue it. |

The workflow removes `agent:implement` as soon as it starts, so the label always means "approved and not yet started."

### Decision labels (rare)

Used only on Decision issues: big choices worked out through conversation or a short investigation before any task begins. `wayfinder:map` is the overall decision map, `wayfinder:grilling` is a question to settle by conversation, and `wayfinder:research` is an investigation. These issues carry no triage or agent labels. Assign the issue to yourself to claim it.

## 4. Project fields

Labels cannot hold dates or ordering, so these live as fields in a GitHub Project.

| Field | Purpose |
| --- | --- |
| Due | Hard deadline |
| Plan date | The day you intend to do it. The nightly call sets this. |
| Priority | High, Normal, Low |
| Rank | Number. "Move this above that" is just a rank change. |
| Estimate | Minutes |
| Category | Work, School, Home, Health, Admin |
| Origin | Dictation, call, client message, agent-spawned |
| Capture ID | Links to the capture record holding the original message or audio |

## 5. Lifecycle

1. **Capture.** A dictation, call, or client message creates an issue with `needs-triage`, the provenance block, and a Capture ID.
2. **Triage.** The triage agent adds `task`, fills the fields, and picks one state: `ready-for-human`, `ready-for-agent` with an Agent Brief comment, or `needs-info`.
3. **Approval.** For `ready-for-agent` items you approve, adding `agent:implement`. Nothing starts before this.
4. **Run.** The workflow sets `agent:in-progress`. The agent produces an artifact, saves it where the brief says, and comments with what it did.
5. **Handoff.** If the agent finished everything, it closes the issue and notifies you. If it only did prep, it switches the issue to `ready-for-human`.
6. **Failure.** The workflow adds `agent:blocked`. You fix the cause and re-apply `agent:implement`.
7. **Done.** Close as completed. Rejected items close as not planned.

The Agent Brief is only for agent tasks: goal, inputs, expected output and where it is saved, constraints, and done-when. Tasks that are just yours get no brief.

## 6. How this differs from the main dev system

The dev system is a separate GitHub setup for software projects. Its issues are bugs and features, and AI agents implement them as code, opening pull requests (proposed code changes waiting for review). It uses similar-looking labels with different meanings, so the two must be kept apart. You do not need to know it to use this document.

| Area | Dev system | To-do system |
| --- | --- | --- |
| Category label | `bug` or `enhancement` | `task` |
| Meaning of `ready-for-agent` | Approved. The agent runner may start immediately. | A proposal only. It waits for your approval. |
| What starts an agent | The `ready-for-agent` state (in some repos shown as a `Sandcastle` label; Sandcastle is the tool that runs the coding agents) | Only `agent:implement` |
| Agent output | Code on a branch, opened as a pull request | An artifact: a comment or a committed file. Nothing is merged. |
| Review | `agent:review` and `agent:update-branch` have an agent review and refresh pull requests | None. You read the output yourself. |
| Planning larger work | A written spec turned into child tickets | A parent issue with sub-issues, no separate document |
| Exploration | `agent:explore` groups duplicate reports and routes them | Not used until the inbox is big enough to need it |
| Stale `needs-info` | Auto-closes after 14 days without a reply | Never auto-closes |
| Scheduling | None | Project fields for due date, plan date, rank, and so on |
| Agent instructions | Implement, test, open a pull request | Produce an artifact. Never merge. Never take side effects without approval. |
| Code-quality steps | Test-first development and code review | Not used |
| Side effects | Not applicable | Emailing, messaging, and spending always need your approval |

### Rules that follow from the differences

- Do not copy the dev executor prompt into the to-do repo. It will look for tests and a PR.
- The to-do runner must never watch `ready-for-agent`. Otherwise it starts work before you say yes.
- Once you have approved a category many times, such as research, a workflow may add `agent:implement` automatically for it. Anything with side effects always needs a manual approval.
- If a to-do spawns code work, create the issue in the dev repo and link the two. Do not copy it across.

## 7. Same Project, separate repos

The to-do repository is separate from the software-project repositories, but it can feed the same GitHub Project. One view of `ready-for-human`, `needs-info`, and `agent:blocked` then shows everything that needs you across both.
