# Breaking habits: urges, slips, and triggers in shipped apps

**Strongest insight:** shipped apps split into two camps that never meet. Logging apps (I Am Sober, Quitzilla, Bearable, Daylio) capture urges and triggers well but intervene little. Friction apps (one sec, Opal, Freedom, Screen Time) intervene at the cue but learn nothing from it. The gap is one loop: capture the urge, run a protocol, record the outcome, then show patterns.

## Landscape

| App | Urge / slip capture | Slip framing | Patterns | In-the-moment |
|---|---|---|---|---|
| [I Am Sober](https://iamsober.com/en/tools/alcohol-app) | Log Urge: pick habit, rate strength, pick triggers, note. Paid tier | Setbacks as learning, no counter reset described | Urge history, common-triggers view | Coping exercises, reasons |
| [Reframe](https://reframeapp.com) | No trigger log found | Not addressed | None found | Cravings mode, meditation, game |
| [Quitzilla](https://www.quitzilla.com) | Diary entry with relapse switch, money spent | "A relapse is a diary entry, not a failure." Timer restarts, longest streak kept | Stats free, charts Premium | Reasons opened on craving, live timer |
| [quitSTART (NCI SmokeFree)](https://smokefree.gov/) | Daily check-ins, custom triggers alerts | "Get back on track quickly if you slip" | Progress, badges | Not described |
| [QuitGenius](https://www.pelagohealth.com/) | Unverified: site did not describe the tools | Unverified | Unverified | Unverified |
| [Opal](https://help.opalapp.com/legacyopal/what-is-opal) | None; blocks by session | None | Focus reports, Focus Score | Mindful block screens unconfirmed on legacy page |
| [one sec](https://www.one-sec.app) | None | None | No detailed logs | Breathing, 4-7-8, mirror, rotate phone, type text, intention prompt |
| [Clearspace](https://www.getclearspace.com/) | Unverified: page returned other-app content | Unverified | Unverified | Unverified |
| [Freedom](https://www.freedom.to/) | None; no tracking by design | None | None | Blocks, Locked Mode, focus audio |
| [Apple Screen Time](https://support.apple.com/en-us/105121) | None | None | Usage reports (not confirmed on this page) | App limits with a pass-through option |
| Calm / Headspace SOS | Unverified: both pages blocked (403 / 404) | n/a | n/a | Not verified |
| [Bearable](https://www.bearable.app) | Custom symptoms, triggers, factors, intensity, notes | Not addressed | Correlation and pattern reports (subscription), timeline | n/a |
| [Daylio](https://daylio.net) | Two taps: mood plus activities, optional note | n/a | Mood trends, activity-to-mood correlations, year in pixels | n/a |

## Pattern families

1. **Two-tap capture, depth optional.** I Am Sober and Daylio default to speed. Detail (intensity, trigger, note) is a choice, not a gate.
2. **A slip is a log entry, not a reset.** Quitzilla keeps the longest streak visible and calls relapse a diary entry. This matches James Clear's "never miss twice": the next action matters more than the broken chain.
3. **Friction at the cue, with a chosen exit.** one sec lets the user pick the interruption (breathing, mirror, typing). Screen Time offers a pass-through. These work because they interrupt the reflex, not because they track it.
4. **Patterns come from repeated logs.** Bearable and Daylio correlate logged factors with outcomes. I Am Sober shows the most frequent triggers. Patterns only appear if capture happens often, so capture must stay cheap.

## Recommendation for a "break" habit

Minimal, professional, no gamification:

- **Protocol card.** Shown first when an urge starts: "Put phone on charger. Three slow breaths." One tap to start, one line for the substitution the user chose.
- **Urge outcome.** Two buttons: *Resisted* and *Slipped*. Trigger chips come from the user's list. Note and time are optional; time defaults to now and can be backdated.
- **Slip handling.** Log it, ask one question ("What came before?"), then show the next plan. No counter reset; show "resisted X of Y urges" instead.
- **Patterns.** Trigger bar chart (resisted vs slipped per trigger) and a time-of-day strip. Lead with resisted counts, not slips.
- **Clear's inversions.** Make the cue invisible (charger outside the bedroom, app hidden). Make slipping unattractive by making the protocol the default path. Make it difficult by requiring the protocol before logging a slip-free outcome. Make it unsatisfying by showing the outcome log without celebration.

Keep the data model to: habit, trigger list, protocol text, substitution, urge (timestamp, outcome, optional trigger, optional note).

*Limits:* several official pages were blocked or redirected, and searches hit rate limits. Rows marked unverified need a direct check before any claim is published.
