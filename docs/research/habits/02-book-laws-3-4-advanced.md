# Atomic Habits: Laws 3-4, inversions, advanced tactics

## Headline insight

Clear's core tracker rule is **"Don't put up a zero"** (Ch. 16). A minimum version (two-minute rule) counts as a full success on the chain, not a partial. Pair with **"never miss twice"**: one miss is survivable and should look survivable. The UI should never show a bare reset after one miss. It should show a neutral gap plus a "back on track" prompt, and escalate only on the second consecutive miss. Existing chain logic (survive one miss, reset on two) already matches this; the gap is presentation and the minimum-counts-as-done rule.

## Law 3: Make it easy

**Idea:** Friction, not willpower, decides. Reduce steps between intent and action; scale habits down to a two-minute version; use one-time setup actions (commitment devices, automation) that pay off repeatedly.

- **Two-minute rule** (Ch. 13). Start with a version under two minutes. Habit shaping: master the first two minutes, then scale up in stages.
  - UI: `minimum version` field is the default action on Today. One tap logs `minimum`. Show the full version as an optional upgrade, not the default.
  - Must-have. Shaping ladder (stage 1..n per habit) is nice-to-have.
- **Environment design / friction** (Ch. 12, 14). Remove steps; place the habit on an existing path.
  - UI: optional "cue/setup" note per habit (e.g. "shoes by door"). Stack anchor already covers this. Must-have if stacks exist.
- **Decisive moments** (Ch. 13). A few choices per day set the trajectory.
  - UI: Today ordered by the stack anchor time, so the next decisive moment is at the top. Nice-to-have.
- **Commitment devices / Ulysses contract** (Ch. 14). Lock in future behavior now; make bailing cost effort.
  - UI: "lock" option for a habit (e.g. requires a reason to skip, or a skip costs a sentence). Nice-to-have.
- **Make bad habits difficult** (inversion, Ch. 14). Add friction to bad habits.
  - UI: for `break` habits, show friction notes (e.g. "remove app from home screen"). Nice-to-have.

## Law 4: Make it satisfying

**Idea:** Behavior repeats when the immediate experience is rewarding. Brains prefer immediate payoffs. Cardinal rule: what is immediately rewarded is repeated. Delayed rewards need a visible proxy.

- **Immediate reward / reinforcement** (Ch. 15). Give a small reward right after completion.
  - UI: a completion micro-feedback (check animation, streak count tick). Must-have. Keep minimal, no confetti.
- **Habit tracker as reward** (Ch. 16). Clear's three benefits: it is a cue (seeing the streak prompts the next action), it motivates (progress is the strongest motivator; the empty square pulls you), and it is satisfying in itself.
  - UI: a visible streak strip or calendar of X's. Each completion is a mark. Must-have.
- **"Never miss twice"** (Ch. 16). After a miss, recover fast. One miss is an accident; two in a row starts a new habit.
  - UI: after any miss, show a single prompt: "Back on it today?" with minimum-version button. Escalate language only after two consecutive misses. Must-have.
- **Don't break the chain** (Ch. 16). Chain streaks motivate, but Clear warns: optimize the behavior, not the number.
  - UI: show the streak as secondary. Primary signal is weekly consistency. Nice-to-have.
- **Goodhart's Law** (Ch. 16): once a measure becomes a target, it stops being a good measure. Clear's example: measure outcomes, not proxies (customers who finish the meal, not customers who pay).
  - UI: track counts per habit, not a single score. Avoid an aggregate "discipline score" that users game. Must-have as a principle; the "graduate at 10/14" gate is an app-level metric and should be explained as a proxy. Nice-to-have to show the proxy in UI.
- **Accountability partner / habit contract** (Ch. 17). Public commitment plus a social cost makes the behavior matter now. Clear's inversion: add an immediate cost to bad habits.
  - UI: optional share-to-partner or a contract text per habit with a stated consequence. Nice-to-have, probably out of scope for a single-user app.

## Inversions for breaking bad habits

- **Make it invisible** (Law 1 inverse): hide cues. Not core to a tracker. Nice-to-have.
- **Make it unattractive** (Law 2 inverse, Ch. 10): reframe, highlight the benefit of avoiding the habit. UI: `break` habits show "why" text on resist. Nice-to-have.
- **Make it difficult** (Law 3 inverse): commitment device. Nice-to-have.
- **Make it unsatisfying** (Law 4 inverse, Ch. 17): immediate cost. Must-have is a "slip" log that is honest but not punitive. Clear's point: the more immediate the pain, the less likely the behavior. Keep the slip cost low (log it, no shame copy) to avoid abandonment.
- **Resist and slip logging** already exists in the app. Clear implies a slip should trigger the same "never miss twice" recovery as a missed build habit.

## Advanced tactics

- **Goldilocks rule** (Ch. 19): motivation peaks when tasks sit just past current ability. Once a habit is established, raise the minimum version or the full version by a small increment.
  - UI: a "level up" suggestion after N consecutive `done`. Nice-to-have.
- **Boredom is the main threat** (Ch. 19): stay with habits past the novelty stage. Show a light variety cue (e.g. optional variant) only when the habit is established. Nice-to-have.
- **Downside of habits** (Ch. 20): automatic habits stop producing feedback; "good enough" can slide. Clear's fix: periodic reflection.
  - UI: scheduled reflection prompt. Must-have as a reflection surface (below).
- **Reflection and review** (Ch. 20). Clear's review format: "what went well, what didn't, what did I learn?" Annual review tallies habits; integrity report at six months asks core values, current integrity, and a higher standard.
  - UI: weekly review already exists. Add the three questions as its template. Annual or half-year review is nice-to-have. Keep it a few minutes long.
- **Decision journal** (Ch. 20): record decisions, reasons, expected outcomes; review monthly.
  - UI: nice-to-have; could be the slip/urge log with an "expected" field.

## What Clear says a tracker looks like

- **The most basic format is a calendar and you cross off each day.** Track only a few important habits; automate measurement where possible; log right after the action (habit stacking plus tracking).
- **Show a streak and an empty square.** Clear says the empty square motivates action, since nobody wants to break the streak.
- **Misses are not a reset.** He does not specify a red or X-out treatment for misses. His rule implies misses are neutral gaps. Recovery is the event that matters. Do not draw alarm colors on a single miss.
- **Don't measure everything.** Consistently tracking one habit beats sporadically tracking ten.

## Must-have vs nice-to-have

**Must-have**
1. Minimum version as one-tap default, counts as done on chain.
2. Calendar or streak strip; completion marks, no zero.
3. Single-miss state is neutral; "never miss twice" recovery prompt after miss.
4. Per-habit counts, not one aggregate score (Goodhart).
5. Immediate completion feedback (small, not gamified).
6. Reflection surface with the three review questions.

**Nice-to-have**
Habit shaping ladder; Goldilocks level-up; commitment lock; accountability sharing; decision journal; annual or integrity review; variable-reward novelty.

## Caveats

- Clear's text is an audiobook transcript (no visual spec). "Show an X on the calendar" is the only literal layout.
- "Gate" (10 of 14 days) and graduation states are app features, not from the book. Clear's closest concept is Goldilocks/habit shaping.
