# Productivity Dashboard Hierarchy Redesign

Date: 2026-06-26
App: `apps/web`
Status: historical design; UI foundation superseded on 2026-10-25

The Web Client uses Chakra UI and Inter typography. The instructions below describe the original redesign.
See [current frontend setup](../../../README.md).

## Summary

Small redesign of the Daily productivity cockpit. Preserve the current typography and simple Pomodoro timer, but improve page-level visual hierarchy, remove repeated dashboard content, and add a restrained calendar-like schedule showing the next proposed work sessions plus a few synced meetings.

## Problem

The current card internals are mostly acceptable, especially the timer. The larger page composition is weak:

- Header gives too much weight to the workday card.
- Cards compete evenly, so there is no clear first read.
- `Work mix`, `Plan quality`, badges, and readout repeat similar planning/status information.
- No near-future schedule exists, even though the dashboard should guide what happens next.
- The first viewport shows several competing summaries instead of one clear workflow.

## Goals

- Keep the existing fonts and general minimalist tone.
- Keep the timer visually similar and prominent.
- Make page hierarchy obvious: timer/action first, signal model second, readout/supporting info third.
- Replace repeated lower summary cards with one compact planning surface.
- Add a calendar-like schedule UI for upcoming sessions and meetings.
- Show only the next few calendar items to preserve focus.
- Keep behavior local/mock for now, ready for future calendar sync.

## Non-Goals

- No dark theme redesign.
- No major design-system rewrite.
- No new persistence or calendar API integration in this pass.
- No change to timer logic beyond layout placement.
- No dense all-day calendar view.

## Proposed Layout

Use a denser, calmer page composition:

```text
Header: title + small status chips + compact workday progress

Main grid:
+--------------------+-------------------------------------+
| Pomodoro           | Signal model                        |
| simple timer       | main chart + key signal controls    |
| primary actions    |                                     |
+--------------------+-------------------------------------+
| Today schedule     | Readout + compact work mix          |
| next 3-5 items     | fewer repeated metrics              |
+--------------------+-------------------------------------+
```

Header should no longer contain a large workday card. Workday progress becomes a compact inline strip: label, progress bar, and active/closed badge.

## Schedule UI

Add a `Today schedule` panel with a calendar-like vertical agenda, not a full calendar grid.

Show 3-5 upcoming items max:

- Proposed focus session
- Meeting from synced calendar
- Proposed recovery break
- Admin/follow-up block

Each item includes:

- Time range
- Short title
- Type badge or subtle color marker
- Optional context line only when useful

Example items:

- `14:00-14:25` Deep work sprint
- `14:30-15:00` Team sync
- `15:05-15:15` Walk break
- `15:30-16:10` Admin sweep

Visual treatment:

- Use a left time column and a thin vertical rule.
- Small colored markers distinguish session vs meeting vs break.
- Meetings should read as calendar-synced but not dominate.
- Proposed sessions should feel actionable, not decorative.

## Repetition Cleanup

Remove or merge:

- Separate `Work mix` card.
- Separate `Plan quality` card.
- Repeated explanatory subtitles where titles are self-evident.

Keep one compact planning/readout area with:

- `Best window`
- `Next move`
- Small work mix totals, if space allows

## Component Notes

Primary changed file should be:

- `components/productivity-dashboard.tsx`

Possible local helpers:

- `ScheduleItem`
- `Metric`
- `CompactWorkdayProgress`, if header markup becomes hard to scan inline

Avoid changing reusable UI primitives unless blocked.

## Data Shape

Use static mock schedule data for now:

```ts
type ScheduleItem = {
  id: string;
  kind: "focus" | "meeting" | "break" | "admin";
  title: string;
  time: string;
  detail?: string;
};
```

Future calendar sync can replace this array without changing the UI contract.

## Responsive Behavior

- Desktop: two-column main grid, timer left and signal model right.
- Tablet/mobile: stack in priority order: header, timer, signal model, schedule, readout.
- Schedule remains short and scannable on mobile.
- No text overlap or clipped controls.

## Acceptance Criteria

- Timer remains visually close to current screenshot.
- Header is smaller and does not compete with cards.
- First viewport clearly prioritizes timer and signal model.
- Calendar-like schedule is visible without overwhelming page.
- `Work mix` and `Plan quality` repetition is removed or merged.
- Dashboard still builds and lints.
- No unrelated files changed.

## Verification

Run:

```bash
bun run lint
bun run build
```

If implementation starts a local server, inspect desktop and mobile widths for hierarchy, overflow, and schedule density.
