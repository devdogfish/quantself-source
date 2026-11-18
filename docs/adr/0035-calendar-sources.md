# Give Calendar its own page and compose it from sources

Calendar lives at `/calendar`. The task list and task details remain available at `/todo`. Legacy calendar URLs on `/todo` redirect with their query parameters. Jarvis calendar navigation and task opening target `/calendar`, and the list view targets `/todo`.

Calendar sources supply dated items and their rendering and interaction capabilities. The task source uses the existing optimistic projection and timing queue. The habit source loads a bounded range from the Habits API. It keeps its read-only lane and opens the stack quick-log. Habits appear in day and week, and task capacity stays independent.

This amends the placement in ADR 0032. Its derivation, permissions, quick-log and reminders still apply.
