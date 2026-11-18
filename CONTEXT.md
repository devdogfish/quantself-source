# Quantself

Personal operating system for choosing the next useful action from health, productivity, and environment signals.

## Language

**Owner**:
The person whose Quantself instance and personal data are being managed.
_Avoid_: User, account, tenant

**Client**:
Software that uses the Quantself API with an owner's authorization, such as an app, agent, script, device, integration, or service. An owner is a person, never a client.
_Avoid_: Caller, actor, principal, machine

**Credential**:
Proof presented to Quantself to establish authorized access for an owner and client.
_Avoid_: Login, identity, permission

**Owner Session**:
A time-limited credential created after the owner authenticates interactively.
_Avoid_: Cookie, login

**API Key**:
A revocable bearer credential that authenticates one client.
_Avoid_: Token, secret, machine credential

**Access Context**:
The owner, client, and permission set governing one interaction with Quantself.
_Avoid_: Actor, identity, session, credential

**Permission Area**:
A part of Quantself whose client access can be granted independently, such as Inventory, Health, Productivity, or Notes.
_Avoid_: Domain, container, endpoint group

**Permission**:
An action a client may perform within one permission area.
_Avoid_: Role, privilege, endpoint scope

**Permission Set**:
The complete collection of permissions granted to one client.
_Avoid_: Role, preset, scopes

**Quantself API**:
The platform-neutral application used by every client.
_Avoid_: Backend, web API, integration API

**Web Client**:
The built-in browser interface through which an owner uses the Quantself API.
_Avoid_: Main app, backend, database client

**Focus Session**:
A prescribed block of work or recovery with one clear mode, duration, outcome, and next action.
_Avoid_: Pomodoro, task, block

**Work Session**:
An actual period when productive work happened, tracked as a source fact for later productivity analysis.
_Avoid_: Task, todo, planned focus block

**Task Timing**:
A task's single optional start and end. The same task appears in the calendar for that range and in task lists; its duration is derived from the range. Scheduling does not establish that work happened or complete the task.
_Avoid_: Planned Work Session, separate calendar event, duplicate task

**Daily Plan**:
The day's view of tasks, priorities, order, and task timing, derived from the current task records. It is not a separately saved record or versioned daily snapshot.
_Avoid_: Move Queue, separate plan record, Work Session

**Next Move**:
The app's recommended near-term action, shown with enough upcoming moves to make the day legible without turning the UI into a full calendar.
_Avoid_: Recommendation, suggestion, task

**Move Queue**:
The small ordered set of visible upcoming moves, led by the current move and followed by the next few likely moves.
_Avoid_: Calendar, schedule, agenda

**Move Reason**:
A short explanation for why a move is recommended now, based on simple day rhythm and recent activity signals.
_Avoid_: AI rationale, explanation, insight

**Drift**:
The normal gap between the planned move queue and what the user actually did.
_Avoid_: Failure, noncompliance, broken rule

**Resync**:
The act of adjusting the move queue after drift so the next recommendation still fits the real day.
_Avoid_: Backtrack, correction, penalty

**Recovery Debt**:
An overdue need for rest, movement, food, water, or environment change created by extended work or skipped resets.
_Avoid_: Missed break, penalty, failure

**Work Mode**:
The posture and environment used for productive activity, such as sitting deep work, standing admin, or TV review.
_Avoid_: Workspace, posture, activity

**Recovery Mode**:
The kind of break chosen to answer a specific fatigue trigger, such as stillness, breathing, movement, food/water, or outside walking.
_Avoid_: Break, pause, rest

**Recovery Session**:
An actual period when the user recovered instead of working, tracked with when it happened and which recovery mode it used.
_Avoid_: Rest, break, pause

**Fatigue Trigger**:
The user-visible state that determines which recovery mode fits now.
_Avoid_: Symptom, mood, feeling

**Fatigue Check**:
A brief user prompt used to identify the current fatigue trigger before choosing a recovery mode.
_Avoid_: Survey, questionnaire, assessment

**Day Setup**:
The short opening ritual that establishes the day's length, starting energy, and first concrete outcome before the move queue is generated.
_Avoid_: Onboarding, planning, daily setup

**Outcome**:
The concrete result a focus session is meant to produce, stated as a short editable phrase.
_Avoid_: Task, todo, goal

**Check-in**:
The moment when the app asks what actually happened after a timer ends or the user returns after being away.
_Avoid_: Notification, alert, reminder

**Substance**:
A non-food thing the user takes for its active or effect-bearing contents, such as coffee, matcha, alcohol, cannabis, tobacco, medication, homeopathy, or supplements.
_Avoid_: Consumable, food, meal, caffeine field, app-specific input

**Substance Intake**:
A timestamped source record that the user took a measured or estimated amount of a substance.
_Avoid_: Consumable intake, caffeine log, dose widget, health tag

**Meal**:
An eating event tracked so the user can reason about when food happened and how it relates to energy, recovery, and productivity.
_Avoid_: Food log, diet entry, calorie record, nutrition plan

**Active Substance**:
An effect-bearing component of a substance, such as caffeine, ethanol, nicotine, THC, creatine, or ibuprofen.
_Avoid_: Consumed item, food, meal

**Intake Estimate**:
A substance intake amount recorded with imperfect precision because the user often cannot measure exact dose.
_Avoid_: Missing data, invalid dose, bad measurement

**Derived Value**:
A value generated from source records rather than entered as an original fact.
_Avoid_: Source fact, canonical record

**App-Specific Plan**:
A planning model owned by one application experience, such as the 9 to 5 tracker, whose fields should not become canonical health or productivity facts.
_Avoid_: Domain model, universal schedule, source of truth

**Inventory Item**:
The canonical shared identity and description of an interchangeable belonging or item group. It owns facts that should not be duplicated across placements, such as title, description, images, category, tags, and aliases.
_Avoid_: Inventory Product, Inventory Placement, physical copy, SKU

**Inventory Placement**:
The quantity of an Inventory Item kept in one Container or Inventory Location. One Item may have several Placements whose quantities add up to its total owned quantity.
_Avoid_: Inventory Item, duplicate item, physical copy

**Inventory Category**:
The single controlled classification of an inventory item that determines whether it belongs in a specialist inventory view. Generic items may be uncategorized; an item with a specialist profile must use that profile's matching category.
_Avoid_: Collection, inventory type, tag

**Inventory Profile**:
The specialist facts attached to an Inventory Item, such as clothing attributes or remedy potencies. Profiles extend the shared Item without turning specialist facts into generic inventory fields.
_Avoid_: Custom metadata, item subtype, separate item

**Clothing Item**:
An Inventory Item categorized as clothing.
_Avoid_: Garment

**Clothing Profile**:
The stable clothing facts attached to a clothing item that help an owner or client decide when and how to wear it.
_Avoid_: Garment profile, clothing metadata, generic tags

**Clothing Wear State**:
The clothing item's current readiness to be worn: clean or dirty. A planned outfit does not change this state; the owner confirms actual wear once.
_Avoid_: Garment state, clothing profile, laundry status, item status

**Clothing Recommendation**:
A daily or event-specific outfit selection published by an authorized AI Client and presented on the Clothing page. Confirming it as worn marks its Clothing Items dirty; saving or viewing it does not.
_Avoid_: Deterministic outfit rule, wardrobe record, wear state

**Remedy Profile**:
The minimal homeopathy-specific facts attached to one owned remedy Inventory Item: its owned potencies, brief selection summary, and external knowledge references. Detailed remedy knowledge remains outside Quantself.
_Avoid_: Materia medica, Substance Intake, copied remedy database

**External Knowledge Reference**:
A source-qualified identifier that lets a client retrieve detailed product-domain knowledge from an external provider when needed.
_Avoid_: Imported knowledge, local knowledge record, unqualified external ID

**OOREP**:
The initial external repertory and materia-medica knowledge system used by AI Clients through its MCP/SDK. Quantself stores only its remedy reference and source URL, not copied OOREP content.
_Avoid_: Local remedy knowledge database, drug-label database

**Provings.info**:
The backup external source reserved for a future Remedy upgrade, especially proving, taxonomy, and literature references. Initial scope stores links only and adds no automated integration.
_Avoid_: Primary repertory, copied proving database

**Globuli.de**:
A Ralph-recommended remedy-specific source to evaluate for future external remedy matching; the recorded reference is its Aconitum napellus page. It is not an authorized automated integration or local knowledge import.
_Avoid_: Approved recommendation engine, copied remedy database

**H. Zeeden Publications**:
A Ralph-recommended general homeopathic publication source to evaluate for future external remedy matching. It is not an authorized automated integration or local knowledge import.
_Avoid_: Approved recommendation engine, copied remedy database

**Remedy Registration**:
The API-first creation of an owned remedy Inventory Item by a research-capable client, including its Remedy Profile.
_Avoid_: Inventory Enrichment, remedy import, Web Client capture

**Remedy Intake**:
A Substance Intake linked to an owned remedy Inventory Item through its automatically maintained HOMEOPATHY Substance. Its potency may be recorded, but it does not decrement Inventory quantity.
_Avoid_: Remedy recommendation, Inventory unit removal, separate remedy-intake model

**Inventory Item Status**:
The user's current decision about what should happen to a belonging, such as keep, donate, trash, or unsure.
_Avoid_: Inventory workflow status, React state

**Inventory Workflow Status**:
The progress of an inventory item through capture, preprocessing, enrichment, review, and completion.
_Avoid_: Inventory item status, React state

**Capture Session**:
A repeated inventory capture context with default origin, destination, and container values.
_Avoid_: Batch, import job, cleanup task

**Inventory Location**:
A named place where belongings came from or can be found after the owner searches for an item. It is retrieval information, not necessarily a browsing destination.
_Avoid_: Address, warehouse, site

**Container Label**:
A free-form label for a bin, bag, pouch, shelf section, or similar holder used to find belongings.
_Avoid_: Container record, storage unit, box ID

**Item Image**:
A photo attached to an inventory item for later visual confirmation.
_Avoid_: Attachment, media asset

**Item Asset**:
An arbitrary file attached to an inventory item. Images and audio keep their
specialized records; other file types use an item asset record.
_Avoid_: Inventory item, belonging

**Inventory Preprocessing**:
A fixed step that turns captured media and manual capture fields into text evidence before inventory enrichment runs.
_Avoid_: Inventory enrichment, raw media handoff, capture save

**Inventory Text Bundle**:
The text-only evidence package produced by inventory preprocessing and sent to inventory enrichment.
_Avoid_: Raw upload, media payload, enrichment prompt

**Inventory Enrichment**:
A derived value produced from existing inventory source facts and an inventory text bundle.
_Avoid_: Source fact, manual edit, AI overwrite

**Inventory Proposal**:
An inventory enrichment held for user approval before it changes search-visible inventory fields.
_Avoid_: Queue job, AI suggestion, automatic edit

**Archived Inventory Item**:
An Inventory Item retained for historical reference but excluded from active inventory views, searches, counts, and Container contents.
_Avoid_: Inventory Product, deleted item, disposed item, inventory status

**Owner**:
The single person whose Quantself data is being accessed.
_Avoid_: Client, Actor, Principal

**Client**:
The named software using the Quantself API, such as the Web Client or a headless API Key Client.
_Avoid_: Owner, Actor, Principal, machine, caller

**Permission**:
One explicit capability granted to a Client, such as Inventory Read, Inventory Write, or Inventory Delete.
_Avoid_: Scope, role

**Access Context**:
The request-local combination of Owner, Client, and Permission Set established from a verified Credential.
_Avoid_: Actor, Principal, session payload

**Appointment**:
A task tied to a fixed date and time that scheduling must preserve unless the Owner explicitly asks to move it. Other tasks must fit around it.
_Avoid_: Flexible Task, suggested time

**Flexible Task**:
A task without a fixed start time whose scheduled dates and times can change around Appointments.
_Avoid_: Appointment, fixed-time commitment

**Delegated Scheduling**:
An explicit Owner request authorizing scheduling choices across the requested dates, such as “plan next week.” Changes remain ordinary task edits; there is no separate planning mode or day-completion state.
_Avoid_: Planning Mode, Daily Plan, planning complete

**Prerequisite Task**:
A task that must be completed before another task can proceed. Tasks can form a chain of prerequisites.
_Avoid_: Subtask, optional step

**Someday Task**:
A possible future action retained outside the active task list without a commitment to complete it.
_Avoid_: Overdue task, active commitment

**Habit**:
A repeating behaviour with a minimum and full version, either built through practice or broken through a replacement plan.
_Avoid_: Recurring Task, Work Session

**Habit Stack**:
An ordered routine of Habits sharing a cue and optional anchor time.
_Avoid_: Task list, calendar event

**Habit Occurrence**:
One tracked build Habit's observation for one local day, including its status and optional note.
_Avoid_: Task completion, recurring event

**Missed Occurrence**:
A Habit Occurrence still open after its local day ends; a derived interpretation of an observation.
_Avoid_: Failure, stored missed status

**Skipped Occurrence**:
A Habit Occurrence excused on or before its day, excluded from practice counts and evaluation windows.
_Avoid_: Retrospective excuse, missed occurrence

**Slip**:
An observed moment of temptation for a break Habit, recorded as resisted or slipped without changing build Habit observations.
_Avoid_: Failure, streak reset

**Habit Review**:
A weekly reflection on Habit observations and system improvements.
_Avoid_: Daily Plan, automatic assessment

**Gate**:
A required number of practice observations within a defined window used to decide whether another Habit may start.
_Avoid_: Task prerequisite, approval

**Habit System Repo**:
The Owner's private repository for Habit operating rules, temptation playbook and reviews.
_Avoid_: Task repository, Habit Catalog, observation store

**Habit Catalog**:
The Owner's authoritative collection of Habit and Habit Stack definitions and Gate defaults. Changes are recorded as Habit Revisions.
_Avoid_: Habit System Repo, observation store

**Habit Revision**:
One recorded change to the Habit Catalog, including its reason, source Client and time.
_Avoid_: Habit Occurrence revision, document commit

**Calendar Source**:
A source of scheduled items shown together in Calendar, such as Task Timing or Habit Stack routines.


**Chain**:
A run of Habit practice that survives one missed eligible occurrence and ends after two consecutive misses. Minimum practice counts; skipped occurrences are transparent.
_Avoid_: Perfect streak, failure count

**Insight**:
A neutral observation of a Habit pattern, paired with context for the Owner and an AI Client to explore.
_Avoid_: Automatic advice, judgment, prescribed change

**Cash Runway**:
How long the Owner's available cash is projected to last under a spending plan and expected cash inflows.

**Budget Note**:
The Owner's freeform account of cash, spending plans, and expected changes. Explicit changes become part of the budget when the Owner approves them.

**Cash Balance Checkpoint**:
The Owner's stated available cash at a particular time. It anchors the Cash Runway forecast.

**Receipt**:
A merchant's record of a purchase or refund. Its original and reconstructed views represent the same record.

**Budget Document**:
A receipt, invoice, agreement, or other record kept as evidence in Budgeting. It can exist independently of a payment.


**Subscription**:
An ongoing service that renews at an agreed price and interval until billing stops. A trial can precede its first charge. An identified subscription without a known billing schedule is retained for clarification.

**Expected Subscription Payment**:
A subscription charge projected for a particular date. It is a commitment, not evidence of payment. Matching an actual transaction replaces the estimate.

**Subscription Billing Terms**:
The amount, recurrence, and renewal anchor applying from a given date. Earlier terms describe earlier expected charges.

**Subscription Cancellation**:
The date on and after which no further charges are expected. Recording it does not cancel the service with its provider or erase earlier payments.


**Original Money**:
An amount in the currency in which a purchase, invoice, account transaction, or subscription is stated.

**Budget Money**:
The CAD amount used for spending totals and cash forecasts, taken from actual settlement when known or a labeled conversion estimate otherwise.

**Conversion Estimate**:
A dated reference-rate valuation of Original Money into Budget Money. It is not proof of the amount charged by a bank or payment processor.

**Settlement Amount**:
The amount actually posted by the bank or payment processor. It takes precedence over a Conversion Estimate for that payment.

**Application Address**:
The email address unique to one Job Application, `luigi.<code>@luigigirke.com` (ADR 0050). It is used in that application's forms, portal account, résumé and mail, so a reply's recipient address identifies the application. The résumé track belongs to the Job Application, not to the address.
_Avoid_: Job Search Address (single shared address, retired), category alias, track alias, sender identity

**Agent**:
An AI coworker on its own machine, with its own accounts, Bot HQ Tasks, API Key, Permission Set, personality and memory. It acts on Quantself data through the Quantself API.
_Avoid_: Bot, worker, CEO, assistant service

**Bot HQ Task**:
An Agent's own work item, tracked in Bot HQ and managed by that Agent. The Owner rarely views these tasks and leaves edits to the Agent.
_Avoid_: Agent to-do, Agent task (ambiguous)

**Quantself To-do**:
A work item on the Owner's to-do list in Quantself. The Owner retains ownership whether an Agent creates it or works on it as Delegate.
_Avoid_: Agent to-do, Agent task (ambiguous)

**Personal Assistant**:
The one Agent with delegated access to the Owner's personal mailbox. It may answer routine mail as the Owner; everything else sent as the Owner waits for the Owner (ADR 0049).
_Avoid_: Secretary, PA bot

**Outreach Domain**:
A separate `.com` used only for Agents' cold email, so complaints never reach `dawnshiftagency.com` (ADR 0049).
_Avoid_: Burner domain, sending domain

**Delegate**:
An Agent the Owner assigns to work on a Quantself To-do and hand the result back to the Owner (ADR 0047).
_Avoid_: Assignee (for the Agent), worker, handed-over task

**Delegate Activity**:
The current Delegate's most recent authorized read or write on that to-do through the Quantself API. For a working delegation, the time since that activity or since assignment determines when the to-do is stale.

**Brain**:
The shared Git-backed Markdown knowledge repository (`brain`) that the Owner and every Agent use, opened as an Obsidian vault (ADR 0042). It holds durable knowledge, never live state or secrets.
_Avoid_: Vault, knowledge vault, shared vault, second-brain vault

**Private Brain**:
The Owner's separate repository for sensitive material, such as application answers and personal finance, health and relationship details. It is never cloned onto Agent machines.
_Avoid_: Private vault

**Client Brain**:
A separate Brain repository (`brain-client-<slug>`) for deep research into one business client (ADR 0048). Here, "client" means a business the Owner works for, not a Client of the Quantself API.
_Avoid_: Client vault, client wiki

**Audience**:
The Brain page property that says where its content may go: `public`, `internal` or `client-<slug>` (ADR 0048).
_Avoid_: Visibility, permission, access level

**Password Vault**:
A password manager store, such as Vaultwarden or the Hermes credential vault. Always name the product.
_Avoid_: Vault (alone)

**Vault file space**:
The OpenCloud file space for the Owner's sensitive documents (ADR 0045). Say "Vault file space" or "OpenCloud Vault", never "Vault" alone.
_Avoid_: Vault (alone), Brain


**System health**:
A weighted view of showing up (Minimum counts), recovery, gates, autopilot share and completed Sunday review habits. It does not judge consistency trends or the difficulty of the full version.
_Avoid_: Completion trend verdict, difficulty score

**Ready for a new habit**:
Every building Habit passes its Gate, none has two consecutive misses in the last two weeks, and the newest active Habit has run at least four weeks.
_Avoid_: Automatic activation, completion streak

**Autopilot**:
An active build Habit marked established in the Habit Catalog. Its start on autopilot is the recorded status-change date, never an estimate from age.
_Avoid_: Ten-week estimate, guaranteed automaticity
