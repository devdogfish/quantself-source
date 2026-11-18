# Atomic Habits: Intro, Ch 1-3, Laws 1-2 (habit tracker UI)

## Strongest insight

**Make the cue a required, first-class field and render the habit as a sentence: "After [anchor], I will [habit] at [time] in [place]."** Implementation intentions lifted exercise from 35-38% to 91% of a study group (ch 5). The app already has cue fields; the redesign should make them the primary element on Today, not metadata.

## Concepts

**1. Compounding / 1% better (Intro, ch 1)**
- Idea: small daily gains compound; progress is invisible until a threshold. Focus on systems, not goals.
- UI: show process metrics (done vs minimum, streak-of-days) over outcome numbers. Weekly review shows trend, not single-day failures.
- Must: process-first metrics on Today and habit detail.
- Nice: "1% better" chart (cumulative occurrences, not weight/outcome).

**2. Identity (ch 2)**
- Idea: each action is a vote for the person you want to become; habits change beliefs, not just results.
- UI: identity statement on every habit row and detail header (already in data model). Per-identity "votes" count (completed occurrences / total).
- Ch 2 scorecard question: "Does this vote for who I want to be?" Use it to tag habits as vote-for or vote-against.
- Must: show identity statement on habit card; votes count on detail.
- Nice: identity-level rollup ("Health identity: 42 votes this month").

**3. Habit loop: cue, craving, response, reward (ch 3)**
- Idea: every habit is cue, craving, response, reward. Break habits strengthen the same loop.
- UI: habit detail renders the loop. Cue is the anchor (already in data). Reward is optional text.
- Must: cue stored per habit (exists); visible on card.
- Nice: reward field; loop diagram on detail.

**4. Four laws framework (ch 3)**
- Use as the spine of the habit-setup flow: Obvious, Attractive, Easy, Satisfying. Ch 3 summary gives the ordering.
- UI: setup wizard steps map to laws 1-2 here; laws 3-4 belong to a later pass.
- Nice: law-based coaching card on a stuck habit.

**5. Habit scorecard (ch 4, Law 1)**
- Idea: write down every current behavior and rate it. Awareness comes before change. No judgment at this stage.
- UI: one-time onboarding inventory screen. Free text list, then tag each as vote-for or vote-against identity.
- Must: none (not required to track). Nice: onboarding inventory that seeds habits.
- Pointing-and-calling (train operators name what they check): micro-interaction, e.g. tapping "done" with a short confirm text. Nice.

**6. Implementation intentions (ch 5, Law 1)**
- Idea: "I will [behavior] at [time] in [location]." Pre-planned when/where. Time and location are the strongest cues.
- UI: structured inputs for time and place (not free-text). Sentence preview under the form. Flag habits missing time or place.
- Data: `plannedTime`, `location` (text or place tag) on habit or stack.
- Must: time + location fields; sentence rendering.
- Nice: place tags reused across habits.

**7. Habit stacking (ch 5, Law 1)**
- Idea: "After [current habit], I will [new habit]." Attach new habits to existing routines.
- UI: stacks already model this. Show chain order on Today; stacked habit shows its anchor.
- Must: anchor-habit link on Today (existing stacks).
- Nice: suggested anchors from habits already at "established" status.

**8. Environment design (ch 6, Law 1)**
- Idea: context becomes the cue. Make good-habit cues visible; setup reduces friction.
- UI: optional "setup" note per habit (what to place where). Cue visibility checklist.
- Nice: environment checklist per stack; reminders tied to location.

**9. Make it invisible: reduce exposure (ch 7, inversion of Law 1)**
- Idea: removing bad-habit cues beats willpower. Self-control is short-term.
- UI: break habits show "triggers to remove" and an exposure note. Urge log can record exposure.
- Must: break habits support a trigger/cue field (urge logging already has triggers).
- Nice: "exposure removed" checklist item on break habit detail.

**10. Temptation bundling (ch 8, Law 2)**
- Idea: pair a want with a need: "I only get X while doing Y." Ronan Byrne's Netflix-only-while-cycling. ABC's TGIT popcorn/wine.
- UI: optional "bundle" field: a want (e.g. podcast, coffee) linked to the habit. Show bundle on Today card.
- Must: none. Nice: "bundle" field; bundle shown as first line on habit card.

**11. Supernormal stimuli / wanting vs liking (ch 8)**
- Idea: anticipation drives action more than reward. Make habits feel attractive before doing them.
- UI: anticipation copy on Today card (for example, the bundled want). Avoid reward-heavy gamification that replaces the habit itself.
- Nice: pre-action prompt.

**12. Social norms and tribe (ch 9, Law 2)**
- Idea: behavior follows the group's normal. Join a culture where the desired behavior is normal and you share something with the group.
- UI: optional accountability partner, or shared habit view. Identity-rollup on profile.
- Nice: group view or accountability partner (out of scope for personal app v1).

**13. Underlying motives and reframing (ch 10, Law 2)**
- Idea: cravings are surface wants. Underneath are motives: reduce uncertainty, belonging, status, relief. Reframing a craving changes it.
- UI: urge log adds an optional "what I actually want" motive picklist and a reframe text, shown back on the urge.
- Nice: motive picklist on urge logging; reframe prompt on slip.

**Gap:** the motivation ritual (brief item) is not present in the transcript. Searched all of ch 8-10 and found no section by that name. Check the book directly before designing it.

## Must-have summary

- Process metrics over outcome numbers (ch 1)
- Identity statement on card; votes count on detail (ch 2)
- Cue shown per habit (ch 3)
- Structured time + location; sentence rendering (ch 5)
- Stack anchor shown on Today (ch 5)
- Break-habit trigger field (ch 7, uses existing urge triggers)

## Nice-to-have summary

- Scorecard onboarding inventory (ch 4)
- Bundle field and anticipation copy (ch 8)
- Motive picklist and reframe on urges (ch 10)
- Environment checklist (ch 6)
- Identity rollup, accountability/shared view (ch 2, ch 9)
