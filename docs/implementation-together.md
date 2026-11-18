# Work to implement together

Updated October 30, 2026. This is the current collaboration backlog; older
[future thoughts](future-thoughts-2026-10-27.md) are historical input. Notifications and Phone Jarvis are working and deployed, confirmed by the Owner
on October 30, 2026. Remaining work: coworker agents and unified Messages (specified November 11, 2026), software-work integration,
and deferred iPhone shortcuts/widgets. Future extensions require agreement; this
backlog does not authorize autonomous execution or wider agent access.

## 1. Notifications — working and deployed

Owner confirmed notifications working and deployed on October 30, 2026 and
requested closure of [#130](https://github.com/devdogfish/quantself/issues/130).
This records Owner acceptance, not a new independent device test or confirmation
of every detail in the original Web Push proposal.

The following original discussion context is retained for future extensions;
it is not outstanding implementation scope or a blocker to closure.

Context already discussed:

- One todo model; planned time and deadline are independent. An alert is attached
  to a todo, not a separate reminder entity.
- Original preference: desktop and phone alerts, roughly ten minutes before an
  event, with per-event override. Delivery should work with the dashboard closed.
- No toasts. Date-only items must not silently acquire an invented clock time.
- Later clarification: notification behavior and delivery are **not agreed**.
  Web Push, native delivery and phone calls remain choices to resolve.
- Important-event calls, retry intervals, missed-item escalation and daily
  planning calls were parked directions, not approved automation rules.

Discuss triggers (planned start, deadline, travel time), default/override/disable,
quiet hours and time zones, device/channel preferences, duplicate suppression,
late alerts, reschedule/cancel behavior, and how alerts relate to CEO decisions.
Choose the smallest useful first delivery path. Existing research is in #130;
reverify provider/device support when implementation begins.

Done means agreed examples and exclusions, implementation, restart/cancellation
checks, and actual app-closed delivery/click tests on the chosen devices.

## 2. Inbound and outbound call agent — working and deployed

Agreed October 30, 2026: private Phone Jarvis calls only the Owner and accepts
Owner calls anytime. Hostinger's Quantself backend owns the schedule, PIN check,
delivery records and archive. ElevenLabs supplies the existing Jarvis identity and
live voice; Twilio supplies the telephone number/network. Twilio gathers the keypad
PIN before connecting ElevenLabs through register-call. No private context or
conversation recording is sent before authentication.

Call every evening at 21:00 America/Halifax, including daylight-saving changes.
Retry once at 21:10 only after no-answer/busy. No voicemail messages. Having already
planned tomorrow does not suppress the call. Planning is ordinary conversation and
task CRUD across any dates; there is no completion flag or separate planning mode.
Phone uses the same task capabilities, scoped API permissions and source verification
as in-app Jarvis, with independent provider tools/credentials for production.
Recent verified conversation summaries span days; retain transcript and original
audio until Owner deletion, under the existing retention policy.

Owner confirmed Phone Jarvis working and deployed on October 30, 2026.
[PR #140](https://github.com/devdogfish/quantself/pull/140) records successful
deployment, outbound call acceptance, PIN authentication and ElevenLabs connection.
Its earlier pending inbound acceptance note predates this Owner confirmation;
no new independent inbound, recording or restart test is claimed here.
The CEO remains a separate future service and may later request calls through
this backend; arbitrary third-party calling remains outside Phone Jarvis scope.

## 3. Coworker agents — decided November 11–12, 2026

Agents are coworkers on their own machines (Hermes), acting on Quantself data
through the Quantself API with scoped keys ([ADR 0041](adr/0041-agents-are-coworkers-outside-quantself.md)).
No CEO agent sits above them. The Owner talks to Agents in Bot HQ, a self-hosted
agent app, and Quantself builds no messaging app of its own
([ADR 0046](adr/0046-agents-own-their-tasks-and-sandcastle-is-engineering-only.md)).
The Agents are Sam Lee (sales development, LinkedIn outreach), Stacy Ross
(growth and marketing) and Tyler Scott (operations and sales assistant). Job-search
mail is sent through SES ([ADR 0040](adr/0040-email-through-amazon-ses.md)).
Memory is split into the brain, Honcho, per-Agent memory and Quantself
([ADR 0042](adr/0042-memory-layers.md)).

Hosting is decided in [ADR 0045](adr/0045-self-hosted-home-infrastructure.md): Quantself and Agents run on the Owner's own machines, with no paid VPS.

Implementation specs: [#182](https://github.com/devdogfish/quantself/issues/182) (coworker Agent support), [#183](https://github.com/devdogfish/quantself/issues/183) (the agency Agents and the brain). Owner setup: [#208](https://github.com/devdogfish/quantself/issues/208).

Still open: Agent-initiated proactive calls through Phone Jarvis, and how Agents
run around the clock.

Keep the existing boundary: Clients use the authorized Quantself API; GitHub
remains task authority. Task CRUD and scheduling use ordinary authorized commands
for any dates at any time. An explicit delegated request such as “plan next week”
authorizes scheduling choices within that request; unrelated suggestions require
acceptance. No separate planning mode, one-day scope, expiry, completion flag, or
planning-completion condition for skipping nightly calls remains. Source checks,
overlap acceptance, current revisions and stable operation IDs still apply.

Done means a recorded architecture/authority decision, deployed components,
observable trigger ownership, and actual inbound/outbound proactive-call tests
including duplicate, restart, cancellation and unanswered-call cases.

## 4. Software development work and personal time allocation

After the first Agent is running, bring software work into the same view as personal
tasks, using a software-development category and the existing todo/calendar
model. Show what agents are working on and let the Owner allocate their own time.

Discuss which repositories/tasks appear, source-of-truth links versus duplicated
tasks, status synchronization, agent activity, blocked work and approvals. Keep
agent execution time distinct from the Owner's calendar commitment. Scheduling
personal time must retain explicit requests, accepted proposals or an explicit
delegation of scheduling choices.

Done means real software work appears with traceable status, agents' progress
remains current, and the Owner can schedule/reallocate their own work without
duplicate tasks or unintended calendar changes.

## Current implementation boundary

Capture title inference (no new capture UI), timing/deadlines, existing Trash
integration, categories, API cache/live freshness and conversational
scheduling are implemented under [#117](https://github.com/devdogfish/quantself/issues/117).
[Acceptance evidence](testing/implementation-117-acceptance.md) distinguishes
local tests, live GitHub/provider checks and deployment/audio gaps.

iPhone shortcuts/widgets remain explicitly deferred. Coworker agents and unified
Messages (section 3) are specified; software-work integration remains in section 4. Notifications and Phone
Jarvis are working and deployed per Owner confirmation on October 30, 2026.
The earlier capture enrichment pipeline and separate planning screen are not
current requirements.

The Owner requested closure of #117 and #130 with remaining future work preserved
here. Earlier production-deferral notes are historical and superseded by the
Owner's deployment confirmation. Existing acceptance documents retain their
original measured evidence and limitations.
