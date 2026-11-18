# History visualization for repeated behaviours

**Strongest insight:** Shipped products separate *what happened on a day* (a state, drawn as a fixed-position glyph) from *how consistent you've been* (a rate or score, drawn as a number or curve). Streak-only apps conflate the two, so one miss erases the picture. Loop and WHOOP show the rate survives a miss. Use glyph-per-state cells for the day record and a rate for the verdict.

## Reference table

| Product | Visual encoding | Partial / miss encoding | Time ranges | Why it reads fast |
|---|---|---|---|---|
| [GitHub contribution graph](https://docs.github.com/en/account-and-profile/concepts/contributions-on-your-profile) | Day-cell heatmap, weeks as columns | Shade intensity only (no shape) | Trailing 1 year | Fixed grid; shape of the year visible in one glance |
| [Loop Habit Tracker](https://github.com/iSoron/uhabits) | Strength score curve, plus streak and history views | Score rises per completion, falls per miss; not a gap in the chart | Scrollable full history | A miss dents the curve; a long streak isn't erased |
| Everyday.app | Per-habit history from the habit's detail screen | Unverified; reviews say no calendar grid | Unverified | Minimal, but no grid overview (per App Store review) |
| [Streaks](https://apps.apple.com/us/app/id6504493690) | Stats widget, completion-success chart with custom date range | Unverified from primary source | Custom ranges | Widget-first; comparison of periods (this vs last month) |
| [Apple Fitness](https://support.apple.com/108359) | Rings per day, tap calendar date; Trends 90 vs 365 days | Ring closed = goal met; overlap = exceeded; no partial state beyond fill % | Day, 90d, 365d | Ring fill is a single-glance percentage |
| [WHOOP Sleep Consistency](https://www.whoop.com/thelocker/new-feature-sleep-consistency-why-we-track-it/) | Single 0–100% score over a 4-day window | Score drops; no per-night glyph in sources read | Rolling 4 days | Number plus one benchmark (~68% average, 80%+ goal) |
| Oura sleep regularity | Unverified (fetch 404) | Unverified | Unverified | n/a |
| Strava Training Log | Calendar of activities, day/week/month | Unverified (fetch 404) | Day/week/month | Familiar calendar grid |
| [Duolingo streak](https://blog.duolingo.com/how-duolingo-streak-builds-habit) | Day count, flame icon; Streak Freeze shown as flame outlines ("0 of 2 equipped") | Freeze = shape-based protection, not a color; miss breaks streak | Count only | Freeze is a visible glyph in the streak UI, not hidden in a setting |
| Exist.io | Unverified (domain not reachable) | Unverified | Unverified | n/a |
| Gyroscope | Daily/weekly/monthly trend charts; last 30–60 days underpin grade | Unverified | Day/week/month; full history is Pro | Grade + trend, not per-habit grid |
| [Daylio Year in Pixels](https://en.wikipedia.org/wiki/Daylio) | Year mosaic, one colored dot per day | Color only per mood; no miss state | 1 year | Dense; mood color is the sole encoding |

## Visual families

1. **Calendar heatmap (GitHub, Strava, Daylio).** Fixed-position cells over a year. Densest. Weakness: color-only intensity, so misses look like "no data."
2. **Strength / rate curve (Loop, WHOOP, Gyroscope).** One line or number per habit. Handles misses gracefully because a miss lowers the curve rather than breaking it. Weakness: hides which days failed.
3. **Ring / progress fill (Apple Fitness).** One glyph per day that fills to a goal. Best for a single "goal met" test with overflow. Weakness: partial states are continuous, not discrete.
4. **Streak counter with protection glyphs (Duolingo, Streaks).** A count plus icons. Motivating, but a miss resets the count, and the count is the only summary.
5. **Widget / period comparison (Streaks, Gyroscope).** Current period vs previous. Good for a dashboard overview, weak for day-level detail.

## Recommendations

**(1) Per-habit row strip (sparkline).** Fixed cells, last 14 to 28 days, one glyph per day. Shape carries state; color is secondary.
- Done: filled circle
- Minimum (partial): half-filled circle
- Skipped: dash in an outlined circle (excluded from the rate)
- Missed: empty outline with X
- No data: dotted outline, no fill
- Freeze or grace day: a shield or snowflake glyph in the cell (Duolingo-style), which preserves the chain without faking completion.
- End of strip: the strength or rate number. The strip shows days, the number shows the verdict.

**(2) Whole-system overview.** A habits x days matrix, last 28 days, same glyph set per cell. Add a summary row per day (count done / count due) so one glance shows the worst day. Pair with a single system score (weighted rate) rather than a sum of streaks.

**Chains that survive one miss:** Show the rate or strength curve as the primary metric. Show a streak count only as secondary, labelled "current run." A miss dents the rate; it doesn't reset the visual history.

**Gates (e.g. 10 of 14 days to graduate):** Render the 14-day window as one row of 14 cells above a progress indicator "7 of 10 needed." The gate is a count inside a fixed window, so the cell row is the proof. Mark the window boundary with a bracket or divider, not a color change.

## Accessibility and theming

- **Status is never color-only.** Every state needs a distinct shape or pattern and an accessible name ("done", "partial", "skipped", "missed", "no data"). Color reinforces only. Daylio's mood-color mosaic is the cautionary example.
- **Non-text contrast.** Glyphs and outlines should meet WCAG 1.4.11 (3:1 against the adjacent background). Verify in both themes.
- **Light and dark.** Use semantic tokens (e.g. `--state-done`, `--state-missed`), not hex values. Keep the intensity ramp monotonic in both themes. Outlines must stay visible on dark backgrounds, so avoid thin low-contrast strokes.
- **Text alternative for charts.** Provide a visually hidden list or table of the same data for screen readers.

## Gaps

Oura, Strava, Exist.io, and Everyday.app were not verified against primary sources. Search was rate-limited and three fetches returned 404 or unreachable. Treat their rows as unverified. Apple's HIG activity-rings page returned only its title, so its accessibility guidance was not checked.
