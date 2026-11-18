# Agents help with the Owner's to-dos through delegation; Bot HQ runs separately on `atlas`

Status: accepted, 2026-11-14. Amends ADR 0046 (agents and tasks) and ADR 0045 (where Bot HQ runs). Decided in the To-Do redesign (#171).

**Two kinds of agent work, kept apart.** Agents are coworkers (ADR 0041). Like human coworkers, they have their own work, and they help with the Owner's work. These stay separate:

- **An Agent's own tasks** live in Bot HQ only. Quantself does not store, mirror or display them (ADR 0046 holds).
- **An Owner to-do an Agent helps with** stays the Owner's to-do in Quantself. The Owner stays its owner and is accountable for the result; the Agent is its **Delegate**. The working steps, chat and screen stay in Bot HQ.

Why: one home for each thing. The outcome of an Owner to-do belongs on the Owner's list next to the calendar it schedules onto; how an Agent works belongs where the Agent works. Mirroring Bot HQ tasks into Quantself would duplicate state and fight ADR 0046. It is also the pattern proven products use: Linear keeps the human assignee and sets the agent as a delegate; GitHub assigns an issue to an agent and keeps the session elsewhere.

**The link is thin and goes through the existing API.** A delegated to-do carries only: the Delegate, a delegation state (working, waiting on the Owner, handed back), the Agent's hand-back (a summary or a question, plus links) and a link to the Agent in Bot HQ. Nothing else crosses over.

- Each Agent finds to-dos delegated to it through its scoped key and the `quantself` CLI (#189, #191), typically from a Bot HQ routine. Quantself still never calls or pings Agents (ADR 0045's network rules hold).
- The Agent writes its hand-back through the API, audited with Undo and acting on the revision it read (ADR 0041 limits).
- The Owner accepts (the to-do closes) or returns it with a note (it goes back to the Agent).

Why: Agents already have API access and routines, so no Bot HQ integration or bridge is needed. Quantself stays the system of record for the Owner's to-dos, and Bot HQ stays replaceable.

**Delegation first; handing a to-do over later.** Fully handing a to-do over, so that it leaves the Owner's list and becomes the Agent's own Bot HQ task, is not built now. Delegation covers "help me with my tasks", and handing over can be added on top without changing the model.

**What the To-Do views show.** "Waiting on you" means Agents handing the Owner's work back. "With agents" means the Owner's to-dos being worked on. Each delegated to-do opens the Agent in Bot HQ. What an Agent is doing overall stays in Bot HQ; the To-Do space does not compete with it. Until the delegation API exists, the views read the older runner labels (`ready-for-agent`, `agent:*`, `ready-for-human`) as a stand-in.

**The delegation data must not deepen the GitHub-backed design.** ADR 0046 calls GitHub as the to-do store a mistake to undo. The Delegate, state and hand-back are defined in Quantself's own API contract, independent of GitHub labels or comments, so they move with the to-dos when the store changes.

**Bot HQ is hosted separately, on `atlas`.** Bot HQ is its own app and deploy, not part of the Quantself codebase, and meets Quantself only through Agents' API use. It runs in its own small VM or container on `atlas`, reachable only over Tailscale like `dashboard.girke.dev`, with no public exposure. Its Tailscale tag lets it reach each Agent's Hermes gateway and screen, and nothing on `keep`.

Why: `keep` holds the Owner's sensitive data and Quantself, and ADR 0045 keeps agent-facing services on other machines. Bot HQ talks to Agents all day and is the most exposed agent-facing service, so it belongs on the less sensitive machine with no route to `keep`.

## Agent-created Inbox To-dos

Quantself stores Agent-created Inbox To-dos in Postgres. A Quantself To-do belongs to the Owner from creation. An Agent uses its scoped CLI credential to create it, and the Owner sees it in the To-Do Inbox. Agent-owned work stays in Bot HQ Tasks.

The creation, audit entry and retry receipt commit together. Owner Undo cancels the To-do only while it is at its creation revision. This preserves a subsequent Owner edit or completion. Existing GitHub-backed To-dos retain their existing source.

## Follow-ups

Three backend tickets under #171, each a vertical slice: #235 delegate a to-do to an Agent (blocked by #189); #236 Agent hand-back with Accept and Return; #237 delegate state and the Bot HQ link in the views (both blocked by #235).
