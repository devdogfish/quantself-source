# Routines in productivity tools

**Strongest insight:** shipped apps split a routine into three separate fields: a time window (when it may happen), a size (minimum and ideal duration), and a completion record (did it count). The best-modeled tools keep the window flexible, make completion one tap in the day view, and show trends on a separate weekly view. Plain recurring tasks (Things, Todoist, Sunsama) have no window and no streak model, so they behave like chores.

## Survey

| Product | Modeling | Where it appears | Completion / skip | Weekly review / stats | Steal |
|---|---|---|---|---|---|
| [Reclaim.ai](https://help.reclaim.ai/en/articles/4129152) (legacy 1.0 help article) | Min and max session length; time window (work, personal, or custom hours); Critical to Low priority; reschedules on conflict | Target calendar; Habits page, Planner | Not in article | Not in article | Min / ideal / max duration; shrink to minimum when full |
| [Motion](https://www.usemotion.com/help/time-management/auto-scheduling/reference-auto-scheduling) | ASAP / High / Medium / Low priority; deadlines before duration; pause auto-schedule | Auto-placed on calendar | Not verified | Not verified | Priority ladder; pause toggle |
| [Structured](https://apps.apple.com/app/structured-daily-planner/id1499198946) | Habits share one day timeline with calendar and tasks | Day timeline, widget | Not verified | Not verified | One timeline; swipe-to-replan missed items |
| [Sunsama](https://help.sunsama.com/docs/tasks-recurring-tasks) | Recurring tasks without a calendar time; roll over until they collide with the next instance | Daily plan list | Task checkoff | None; official Pro-Tips say it is not built for habit tracking | Keep routines off the calendar; daily planning ritual |
| [Things 3](https://apps.apple.com/us/app/id904237743) | Repeating to-do; can sit in This Evening; unfinished repeats move forward, not overdue | Today list, evening section | Normal checkbox; early completion; Create Next Copy | None built in | Evening bucket; repeats do not pile up |
| [Todoist](https://get.todoist.help/hc/en-us/articles/206209959) | Recurring dates; days-off setting | Task list | Task complete | Karma: daily goal 5, weekly 25, trend; streaks | Days-off protects streaks; but 4+ days overdue costs points |
| [TickTick](https://blog.ticktick.com/2020/05/22/a-healthier-life-with-ticktick-habit/) | Habit goal modes (Auto, Manual, Complete all) | Separate Habit tab | Tap check icon; tap a past date on calendar to backfill | Weekly habit status (2020 post; deeper stats unverified) | Check from list; backfill from calendar |
| [Akiflow](https://akiflow.featurebase.app/en/help/articles/0805246-rituals) | Daily Planning and Shutdown rituals with set times; weekly planning and shutdown (release 2.45) | Ritual flow | Reviewed inside the ritual | Weekly Shutdown reviews progress | Scheduled ritual; weekly shutdown |
| [Linear](https://linear.app/docs/use-cycles) | Team cycles with shared duration and start day; capacity from last three cycles | Cycle view | Issue state | Capacity from prior cycles | Fixed cadence unit; rolling capacity |
| [Notion habit templates](https://www.notioneverything.com/templates/notion-habit-tracker-and-goal-setter) | DIY database with checkboxes | Separate database page | Checkbox | Streak counter; weekly review view (third-party guides) | Weekly review as a filtered view |
| [Amie](https://apps.apple.com/app/id1548277133) | Calendar-first; recurring tasks (review-site claim) | Calendar | Not verified | Not verified | Calendar as the habit ledger |
| Cron / Notion Calendar | No routine features found in research | n/a | n/a | n/a | Not researched further |

## Pattern families

1. **Habit as calendar block** (Reclaim, Motion, Amie). Time is honest and visible. Cost: blocks fight meetings, and the schedule shifts under the user.
2. **Habit as separate tab with stats** (TickTick, Notion). Streaks and charts are easy. Cost: disconnected from the day plan, so it gets ignored.
3. **Habit inside the daily plan ritual** (Sunsama, Akiflow, Structured). Routines compete with tasks at planning time, and completion happens in the day view. Cost: needs a ritual habit.
4. **Habit as recurring task** (Things, Todoist, Sunsama recurring). Cheapest to build. Cost: no window, no minimum, no streak model, and overdue guilt.

## Recommendation: family 3, with family 1's fields

Use the daily plan as the home for routines, since the app already has a To-Do workspace.

- **Model:** a routine is a recurring to-do with an anchor time (the cue), a window (preferred time plus or minus flex), a minimum minutes value, and a priority.
- **Day view:** the routine appears in the plan list with a one-tap check. Skip is a separate state from missed, so it does not feed guilt or overdue logic.
- **Calendar Habit lane:** keep it read-only as a projection of each routine's planned window.
- **Weekly review:** a Linear-style fixed week. Show per-routine completion, streaks with days-off (Todoist), and misses grouped by anchor, so the user sees which cue failed.

**Steal:** Reclaim's min / ideal / max; Things' evening bucket; Todoist's days-off; TickTick's backfill from the calendar; Akiflow's weekly shutdown; Motion's priority ladder.

## Caveats

- Reclaim's source is the legacy 1.0 article, not the current product.
- Things' evening-repeat workaround is a community script, not a feature.
- TickTick's stats and Motion's habit behavior were not confirmed from official current pages; TickTick's help center search returned nothing current.
- Sunsama habit-streak requests appear on its roadmap only; no shipped evidence found.
- Structured, Amie, and Notion details come mostly from App Store listings, reviews, and vendor blogs.
