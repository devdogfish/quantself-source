# Enterprise visual conventions for a habit overview

**Strongest insight:** credibility comes from restraint, not styling. Shipped products make one number the hero, put its comparison in small type beneath it, reserve color for status, and state the rule behind every threshold. Vibe-coded dashboards add gradients, colored cards and decorative icons to fill space the data doesn't need.

## Sources checked (shipped products)

- **Stripe Dashboard**, [925Studios breakdown](https://www.925studios.co/blog/stripe-dashboard-design-breakdown). Six type sizes and weights; hierarchy without color. Key metrics are large and high-contrast, each with a smaller previous-period comparison below. Palette is narrow and reserved for status. Trends are monochrome sparklines. Home is sparse. Empty states show zero with flat sparklines plus one action. Steal: the number-plus-comparison-plus-sparkline tile.
- **PostHog retention**, [docs](https://posthog.com/docs/product-analytics/retention). Cohort grid: one row per cohort, a cohort-size column, Week 0 fixed at 100%. Periods still in progress carry a tooltip and update live. Clicking a cell lists the users. Steal: marking incomplete periods explicitly.
- **Mixpanel retention**, [docs](https://docs.mixpanel.com/docs/reports/retention). Purple heatmap shaded per row, so cells compare buckets within a cohort. In-progress cells get an asterisk. Average row is weighted by cohort size. Steal: row-relative shading plus a weighted average row.
- **Datadog SLO widget**, [docs](https://docs.datadoghq.com/dashboards/widgets/slo/). Shows status and remaining error budget over selectable windows: 7/30/90-day rolling, or calendar week/month. Periods with no data show "-". Steal: "-" for missing data and side-by-side windows.
- **Google SRE, alerting on SLOs**, [workbook](https://sre.google/workbook/alerting-on-slos/). Error budget is the allowed bad events over a window. Burn rate measures how fast it is spent. Present consumption as a percentage of total budget spent in the window, not a raw error rate. Steal: "% of budget spent", not "missed count".
- **Sentry widgets**, [docs](https://docs.sentry.io/product/dashboards/widget-builder/). Big-number tiles show threshold colors only on hover. Tables are the only widget with column and sort controls. Multi-series charts cap at 10 series. Steal: threshold color that stays hidden until needed.
- **GitHub Projects insights**, [docs](https://docs.github.com/en/issues/planning-and-tracking-with-projects/viewing-insights-from-your-project/about-insights-for-projects). Default burn-up shows completed against remaining work. Steal: completed versus remaining as the progress frame.
- **Vercel dashboard**, [changelog](https://vercel.com/changelog/dashboard-navigation-redesign-rollout). Resizable, hideable sidebar; filters separate from navigation. Typography and density not covered.
- **Linear**, [changelog](https://linear.app/changelog). Insights, Cycles and Pulse ship as product surfaces. Visual conventions not verified.

**Not verified:** Amplitude, Plausible, Height, Attio, and Stripe's tabular-figure settings. Two Amplitude/Plausible URLs returned 404; the search tool hit its rate limit. Third-party claims about Söhne `tnum` are unconfirmed.

## Checklist: enterprise-ready vs vibe-coded

1. One hero number per tile; comparison in smaller type beneath. (Stripe)
2. Tabular figures (`font-variant-numeric: tabular-nums`) on every column and tile number.
3. Six or fewer type sizes and weights. Labels are smallest and lightest.
4. Base UI text around 13px; numbers are the largest element on screen.
5. Hairline borders for structure. Shadows only on overlays.
6. No gradients, glows or decorative icons on data surfaces.
7. One accent color. Status colors (green, red, amber) appear only where status is meant.
8. Sentence case for labels and headings.
9. Monochrome sparklines, not colored area charts, for trends.
10. Empty state shows zero or flat lines plus one action, never an apology.
11. "-" or a dimmed cell for no data, never a fake zero. (Datadog)
12. Incomplete periods are marked, with a tooltip or asterisk. (PostHog, Mixpanel)
13. Gauges and budgets stated as a percentage of allowance spent. (Google SRE)
14. Thresholds explained in a hover or legend, not left to guesswork. (Sentry)
15. Tables: sortable headers, right-aligned numerals, one row per entity, no zebra striping.

## Three pattern families for a habit overview

1. **Consistency grid** (habit by day, cohort-style). Shade per row, weekly average row, in-progress days marked. Best for the detail view. Source: PostHog, Mixpanel.
2. **Budget gauge** ("misses left this window", "10 of 14 days"). Express as budget spent. Use neutral language for the first miss and reserve red for a fast burn, such as two misses in a row. Source: Datadog SLO, Google SRE burn rate.
3. **Ledger tiles** (one number, comparison beneath, sparkline, sparse home). The overview's top layer. Source: Stripe.

## Recommendation

Build the overview from family 3, with one hero figure per habit and a sparkline. Add family 2 as a single budget row per habit, labeled as "misses left", not as an alarm. Put family 1 behind a drill-down. Apply the checklist to every tile before shipping.
