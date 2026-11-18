# Habit tracker check-in: what shipped apps do

**Strongest insight:** the best-regarded apps never reset on a missed day. Loop lowers a strength score on a missed day ("every missed day makes it weaker"). Streaks protects scheduled off-days and resets only when a required day is missed. Way of Life's skip keeps the streak. So "skipped" and "minimum" should protect the chain, and only "missed" should cost anything.

**Caveat:** official pages were thin, several help centers returned 403, and search hit rate limits. "Unverified" means not confirmed from a source.

## Reference table

| App | Link | Check-in | Grouping | Row history | Missed / skip / streak | Steal |
|---|---|---|---|---|---|---|
| Streaks | [streaks.app](https://streaks.app) | Tap completes. Count tasks: tap-and-hold increments. Timed tasks: play button starts countdown, also from Today widget. Health-linked tasks auto-complete. | Color band per set of six habits; same order on iPhone and Watch | Icon with progress band (timed tasks); no week strip documented | Scheduled days; off-days keep streak; missed required day resets to 0 | Tap-and-hold for counts |
| Loop | [github.com/iSoron/uhabits](https://github.com/iSoron/uhabits) | Check or dismiss from notification or widget; in-app gesture unverified | Unverified | "Habit history and streaks" (screenshot caption) | Missed day lowers strength score; a few misses don't wipe progress | Strength score instead of reset |
| Way of Life | [wayoflifeapp.com](https://wayoflifeapp.com) | Color-coded check-off; yes / skip / note | Unverified | Weekly grid (2026 review) | Skip excluded from goal, keeps streak | Three-state day logging |
| Habitify | [habitify.me](https://habitify.me) | Gesture unverified. Partial completion not native; workaround is a "times" habit with % unit | Chronological calendar (App Store editor quote) | Calendar and yearly view | Partial logs count toward stats | Clock-time ordering |
| Productive | [productiveapp.io](https://productiveapp.io) | Marketing only; support site 403 | Unverified | Unverified | Unverified | None verified |
| Done | Not found | Search rate-limited | Unverified | Unverified | Unverified | None verified |
| Everyday | [everyday.app](https://everyday.app) | Gesture unverified | Unverified | Streak visuals (user review) | Vendor copy cites a skip for busy weeks | Skip for busy weeks |
| Not Boring Habits | [notboring.co/habits](https://notboring.co/habits) | Page returned 404 | Unverified | Unverified | Unverified | None verified |
| Tangerine | [tangerineapp.com](https://www.tangerineapp.com) | Domain redirects to a parked page; no official site found | Unverified | Unverified | Unverified | None verified |
| HabitKit | App Store (rate-limited) | Unverified | Unverified | Unverified | Unverified | None verified |
| Finch | [finchcare.com](https://www.finchcare.com) | Marketing only; help center 403 | Unverified | Unverified | Unverified | Self-care framed as a pet game |
| Fabulous | [thefabulous.co](https://www.thefabulous.co) | Coaches daily habits on phone | Morning, afternoon, evening routines | Unverified | Unverified | Time-of-day routines |

## Pattern families

1. **Grid of tiles.** Streaks-style icons with progress bands. Good for many small habits. Weak for partial states, and tiles hide the week.
2. **List with inline history strip.** Loop and Way of Life's weekly view. Dense, scannable, and works on desktop and mobile. Each row shows its own recent days.
3. **Timeline / time-of-day sections.** Fabulous routines and Habitify's chronological order. Matches cue order but splits one routine across buckets.
4. **Single-focus card.** One habit at a time, Finch-style. Strong on phones, but it hides the day overview and makes stacks hard to see.

## Recommendation: family 2, grouped by stack

Use a **list with an inline week strip**, with each cue-anchored stack as one card.

- **Header** is the cue, e.g. "After the kettle goes on." Rows keep their stack order (family 3's ordering, not its time buckets).
- **Row states:** done (filled), minimum (half-filled, labeled "minimum"), skipped (dash, not a miss), missed (hollow, neutral, no red).
- **Streak protection:** done, minimum, and skipped keep the chain. Missed lowers a stack score, as Loop does, rather than zeroing one habit.
- **Input:** tap cycles done and undone. Long-press or a trailing control opens minimum, skip, and note, so a stray tap can't log a skip.
- **Desktop:** the same list at wider width, with the week strip given more room. Keep the layout identical so the mental model doesn't change.

Not chosen: tiles (no room for states), single-focus card (loses the stack view).
