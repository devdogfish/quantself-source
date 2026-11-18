# Visual teardown (round 2): what each product actually looks like

Verified by looking at official screenshots in a browser on 2026-11-13. Agent reports in this folder hold the cited text details. Rule for round 2 (Owner): copy proven products closely; change only what Quantself needs.

## Linear: My issues
Source: https://linear.app/docs/my-issues (image `70c22a56…-1864x842.png`)
- Header: title "My issues", then **pill tabs** (Assigned · Created · Subscribed · Activity); selected pill has a filled background.
- A "Filter" row under the header.
- **Group header rows** (by status) use a slightly tinted band: status icon, name, count. No other chrome.
- **Row**: priority bars icon, muted ID (`ENG-416`), status icon, title. Meta (labels, assignee, date) sits right-aligned. Rows ~36px, no borders between rows except group bands.
- Status icons: dashed ring = backlog, empty ring = todo, half-filled yellow = in progress, green partial = in review, filled = done.

## Linear: agent delegation
Source: https://linear.app/docs/agents-in-linear (image `68c955d0…-2880x1768.png`)
- Right **Properties** panel: status, priority, **assignee (human)**, and the **agent indented under the assignee with a connector line**. "Delegate to…" menu: "No agent" / agent list with check.
- Linked PRs show inline with state ("Merged", "In review").
- Lesson: the owner stays the assignee; the agent is a delegate.

## Things 3: Today and Upcoming
Source: https://culturedcode.com/things/support/articles/4001304/ (`dates-today.jpg`, `dates-upcoming.jpg`)
- Left sidebar: Inbox (count), Today (red overdue badge + count), Upcoming, Anytime, Someday, Logbook, then Areas/Projects with progress-pie icons.
- Content: big bold title with icon ("⭐ Today"). Under it, **today's calendar events in a grey rounded box** (coloured times, event names).
- Rows: small square checkbox, title, **project name on a smaller grey second line**; deadline flag right-aligned in red ("today").
- **"This Evening"** section: moon icon + bold label, hairline rule, same rows.
- Upcoming: **large day number + weekday** as section headings, hairline, events then tasks; tag filter chips (All · Important · Office).
- Generous whitespace, white page, no columns, no borders around rows.

## Sunsama: Autoplan review
Source: https://help.sunsama.com/docs/daily-planning (`autoplan-review-…png`, `autoplan-briefing-…png`)
- Two columns. Left: **"Review Autoplan"**, a sentence summary ("added 4 tasks and deferred 1"), an emphasised button **"2 judgement calls to review →"**, then grouped change lists (TODAY / TOMORROW) with per-item duration and **per-item Undo**, plus **"Undo everything"** and "Submit feedback".
- Right: **"Today"** column of white cards: start time, title, duration pill (`2:00`), `# channel` tag, completion circle; "Add task" row with a **"Work: 2:35" total**.
- Popover on a change: "MOVED Today → tomorrow", "Autoplan made this change while fitting your day."
- Lesson: AI-made changes are reviewable, explained and undoable in one place.

## GitHub Agent HQ (mission control)
Source: https://github.blog/changelog/2025-10-28-a-mission-control-to-assign-steer-and-track-copilot-coding-agent-tasks/
- Session page: breadcrumb "Agents / task", left chat/log of the session ("Copilot started work", steps, "In progress" pill, "Steer this session"), right **Overview | Files changed**, "View pull request" button.
- Lesson: this is where sessions live. To-Do must only link: "View session", "View pull request".

## GitHub Projects (board/table)
Text-verified (see github report in this folder / agent message): view tabs Table · Board · Roadmap; View menu with Group by, Slice by, Sort, Field sum; board columns = a single-select field, header shows count and optional **column limit**; cards show repo#number, title, selected fields.

## Superhuman / Linear Inbox (triage)
Text-verified: one item at a time; E = done, H = remind later, Cmd+K palette, J/K move; split inbox tabs; inbox-zero state.
