# Agents work in Bot HQ and own their tasks; Sandcastle is for engineering only

Status: accepted, 2026-11-12. Partly supersedes ADR 0027. Replaces ADRs 0039, 0043 and 0044 (deleted). Amends ADRs 0040, 0041, 0042 and 0045. Amended 2026-11-14 by ADR 0047: Agents may be the Delegate on an Owner to-do. Amended 2026-11-14 by ADR 0049: domains, Agent mailboxes and the personal assistant.

**Bot HQ is the agent interface, and Quantself builds no messaging app.** The Owner chats, calls and works with Agents in [Bot HQ](https://github.com/nickvasilescu/bot-hq), an MIT-licensed web app on top of the Agents' Hermes gateways. It provides chat that shows each step, a live screen per Agent that the Owner can take over, routines and event triggers, per-Agent tasks, group chats, bot-to-bot messages, approval cards and voice calls. It replaces the planned custom Messages and Agency views, the Thread/Message/Topic model, Jarvis-as-Threads, Matrix bridges and Quantself's webhook pings to Agents. Quantself keeps the Owner's own records (calendar, to-dos, Job Applications, budgeting, inventory, habits, health) and exposes them to Agents through the scoped API and CLI.

Bot HQ is self-hosted. Its Orgo layer (cloud computers and screens) is replaced with the Owner's own machines: each screen becomes a local virtual display with a VNC relay, and the server runs commands locally. Bot HQ assumes all bots share one computer and that its first bot's gateway runs beside it. The Owner's Agents run on separate machines (ADR 0045), so the setup has to connect one Bot HQ to remote gateways and screens. That adaptation is done at Agent setup.

Bot HQ's voice calls use xAI's realtime voice model, which hands real work to the Agent's Hermes as text. Messages sent while an Agent is working are queued; Bot HQ cannot steer a running turn, although Hermes supports steering on its other channels.

**Email: only sending stays.** The Jobs runner sends through SES from the Owner's domain before Gmail Send-as ends in January 2027 (ADR 0040). Inbound mail keeps going to a normal mailbox.

**Agents keep their own tasks.** An Agent is a coworker equal to the Owner, not a feature of Quantself. It has its own accounts, email, password manager, phone number, voice, personality, memory and task list. Its tasks live with the Agent, in Bot HQ, not in the Owner's Quantself to-dos. Quantself does not assign, store or display an Agent's private task list.

**Sandcastle is for engineering only.** Sandcastle runs the software implementation workflow and nothing else. Non-coding work (operations, marketing, research, anything that needs a computer and judgment) goes to Hermes Agents, which can use a computer and are far more capable at it. Routing ordinary to-dos through Sandcastle was a way to use subscriptions instead of API pricing. Hermes Agents remove that reason. ADR 0027's to-do execution labels (`agent:implement`, `agent:queued`) and its statement that "the separate to-do workflow already owns agent execution" no longer describe the target design.

**Repetitive work goes to n8n, judgment to Agents.** The job search runs as an n8n feed that finds postings, filters them with a cheap model and tailors the résumé. Sam Lee submits applications through hiring portals and handles replies, which needs computer use and judgment. The filter uses an Anthropic API key; Claude Max's monthly API credits can cover it. No workflow drives a CLI through a subscription login.

**GitHub as the to-do backend is a mistake to undo later.** ADR 0027 chose GitHub Issues so that to-dos could reach Sandcastle agents. With Sandcastle limited to engineering, that reason is gone. Storing to-do data as JSON and fields in issues is slow and inefficient. The current GitHub integration stays until a replacement is chosen. Do not invest further in the GitHub-backed design.

**The calendar stays.** Quantself keeps its own calendar. The remaining work is the updates that bring it to the Apple Calendar look.

**Agents are scoped by role, not hardware.** Agents are equals with their own roles, strengths and access levels. Machine size does not decide what an Agent does: most work is calls to hosted frontier models, and 8 GB is rarely a limit. There are three Agents, all on the agency side: Sam Lee (sales development), Stacy Ross (growth and marketing) and Tyler Scott (operations and sales assistant), listed in ADR 0041. Stacy and Tyler have their own minis; Sam runs on an 8 GB VM on `atlas` that can grow to 16 GB (ADR 0045). No CEO Agent for now; one may come later.

**Agent password managers** are researched in #214. Proton Pass was tried and does not work well for Agents.

## Open questions

- **Where the Owner's to-dos move.** Leaning towards Quantself's own Postgres next to the calendar, because to-dos schedule onto it. Asana is reconsidered only with human collaborators. Slack is not planned: Bot HQ already covers agent chat.
- **How shared work is tracked.** Some large tasks need several people or Agents. Rare with two working Agents; undecided.
- **How Agents run around the clock.** Process supervision, restarts, updates and monitoring are decided at Agent setup.
- **Who handles the Owner's personal admin.** All three Agents serve the agency; Sam also takes the job search. Decided in ADR 0049: a personal assistant Agent handles it, with delegated access to the Owner's personal mailbox.
- **Acting in the Owner's name.** Sam's role runs outreach from the Owner's own LinkedIn profile and Stacy publishes the Owner's posts. ADR 0041 says anything sent as the Owner waits for the Owner to send it. Undecided: when, if ever, an Agent may send from the Owner's accounts, and how that squares with LinkedIn's rules on automation.
- **Client data at home.** Tyler handles client onboarding paperwork and the CRM, but ADR 0045 keeps client data off home machines. Undecided: where client records live.
