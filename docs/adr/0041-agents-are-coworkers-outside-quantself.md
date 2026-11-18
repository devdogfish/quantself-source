# Agents are coworkers outside Quantself

Status: accepted, 2026-11-11. Supersedes the open CEO question in `docs/implementation-together.md`. Amended 2026-11-12 by ADR 0046. Amended 2026-11-14 by ADR 0049: the personal assistant Agent may answer routine mail as the Owner.

Agents are treated like human coworkers. Each runs on its own machine under its own OS user, as a Hermes Agent profile installed as a system service. Quantself does not host agent loops, prompts or models. An Agent is a Client with its own API Key and Permission Set, and it uses Quantself through a `quantself` CLI and skill generated from the OpenAPI document, the same boundary as ADR 0012. The Owner remains the CEO. No coordinating agent sits above the Agents.

The Owner talks to Agents in Bot HQ, a self-hosted agent app on top of the Agents' Hermes gateways (ADR 0046). Quantself has no messaging or agent chat of its own and does not ping Agents. Agents talk to each other through Bot HQ, which shows every exchange.

Autonomy is expressed as plain-language instructions the Owner gives the Agent, held in the Agent's own profile and memory. It is not a rule engine or set of promotion thresholds in Quantself. The Owner changes it by telling the Agent, and the Agent records corrections in the Owner's exact words. Quantself enforces only hard limits:

- Permissions are checked on every request.
- Every Agent write is audited and has an Undo.
- An Agent acts only against the record revision it read.
- Agents leave alone records the Owner touched in the last three minutes.
- The Owner sends messages in their own name. Tyler, as Personal Assistant, can send a Gmail reply in the Owner's name after an explicit approval for that exact message (ADR 0049).

Harness and model are settings of each Agent, so swapping vendors changes configuration, not Quantself. Unattended agents use the Codex subscription or Anthropic API keys, never the Owner's Claude subscription login. The Owner is on Codex today and plans to move to Anthropic. Claude Max includes monthly API credits that can pay for API-key use. Writing that people read uses Sonnet. Sandcastle is for engineering only (ADR 0046). Cloudroom was rejected for coworker agents, because it is built for interactive coding sessions and drops Hermes's memory, persona and channels.

Agents are scoped by role and form the agency's team. The founder (the Owner) runs every sales call and client delivery; the Agents take everything else. The roles and hires, chosen 2026-11-12:

- **Sam Lee, Sales Development Rep:** builds prospect lists of small and medium-sized business owners, researches each one, writes personal LinkedIn messages, follows up and books qualified calls on the Owner's calendar. Sam also runs the Owner's job applications: submitting through hiring portals and handling replies, because he has the most direct human contact and writes best.
- **Stacy Ross, Growth and Marketing Generalist:** writes the Owner's LinkedIn posts, tracks the pipeline from content to client, runs small experiments and builds a second lead channel (cold email, partners, case studies).
- **Tyler Scott, Operations and Sales Assistant:** keeps the CRM accurate, schedules calls and meetings, drafts proposals and follow-up emails, and runs client onboarding admin. He also runs the Owner's job search as a short project: submitting applications through hiring portals and handling replies, because it is the same organized, detail-heavy admin and scheduling work.

Justin Sklar, the earlier placeholder assistant, was never deployed and is retired. Agents start supervised: they draft and the Owner sends, then they take over steps as their work matches the Owner's. Copywriting is a skill of Sam and Stacy, not a separate Agent. A further Agent is added only when one Agent's context becomes crowded or a role needs different access. Short projects go to an existing Agent, not a temporary one. Agents are named as people, with the role as their title; machines carry the Agent's name. Full role descriptions and persona profiles live in the `agents` repository. Use [Fake Person Generator](https://www.fakepersongenerator.com/) when creating new Agent identities.
