# Future thoughts — October 27, 2026

Ideas to revisit over the next few days; not yet implementation decisions.

Historical notes: use [Work to implement together](implementation-together.md)
for the current backlog and deferrals, and the linked acceptance record for
implemented work. Unchecked items below are not an up-to-date implementation status.

- [x] **Replace the GitHub connection warning with a bottom status bar.** Replace “GitHub could not be reached. Edits paused.” with a red bar at the bottom saying “Offline” (or similar), retaining the Retry button. When connectivity returns, turn the bar green and show “Back online,” then hide it after four seconds.
- [ ] **Explore Jarvis as CEO of all agents.** Think through how Jarvis could coordinate all my agents and connect to my other agentic systems, including Discord.
- [ ] **Test agentic calendar task management.** Test how agents can prepare or complete tasks in my calendar. Revisit the ideas already discussed in the other chat.
- [ ] **Define in-app planning.** Decide what the planning feature should entail within the app.
- [ ] **Clarify the capture flow.** Better define how capture should work.
- [ ] **Build the call agent with native Twilio integration.**
- [ ] **Review issue fields and fetching.** Audit every field attached to an issue. Remove unnecessary fields, add missing ones, and review how we fetch them.
- [ ] **Add task types/categories with distinct colors.** Support different types or categories of tasks and render each in a different color. Decide how categories are stored and presented in the frontend, including whether users should be able to create new categories within the app.
- [ ] **Grill fetching, caching, and revalidation.** Stress-test the strategy, including how changes made directly on GitHub or through the app on another device become visible. Revisit whether caching belongs in the design; task-data caching is not currently part of it.
- [ ] **Build an iPhone shortcut and widget.** Get this usable ASAP.
- [ ] **Rethink Jarvis’s initial context and item views.** Explore a viewport-style approach inspired by video game optimization: provide a surface-level overview of what is visible on the page and which task is selected, so Jarvis shares the user’s view. Improve the basic and “more” views: selecting an item should not imply an intent to edit it, and the full set of fields should render clearly and readably.
- [ ] **Add calendar event URLs and alerts/reminders.** Support URLs and event alerts/reminders, as in Calendar.
- [ ] **Render due-only issues as reminders.** Integrate reminders into the calendar for issues with a due date but no start or end date. Keep them as the same kind of item—an issue—detect the reminder presentation from the fields provided, and render them distinctly in the calendar.
- [ ] **Improve list view and define trash behavior.** Work out where trash belongs in the UI and how trashed items should be represented in GitHub.
- [ ] **Give the agent easy access to recent logs and transcripts.** Make local testing event logs and very recent agent interaction transcripts readily accessible, so the agent can diagnose and fix problems quickly without requiring a repeated explanation of what happened.
- [ ] **Test and expand Jarvis.** Test more, add useful capabilities, and optimize the UX without overloading the system prompt or giving Jarvis too many options to choose from.
