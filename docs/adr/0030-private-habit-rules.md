# Private Habit rules through a separate GitHub App

For #143 (PRD #142), the private Habit System Repo owns `habits.yaml` and system documents. A dedicated Habit App has selected-repository Contents access; the task App and ADR 0027's task boundary remain unchanged. Daily tracking mints repository-restricted Contents-read tokens; future document writes must explicitly request Contents write and validate the current source SHA. PostgreSQL never becomes the authority for definitions.

The API refreshes a disposable projection at most once per minute, coalescing concurrent reads and using conditional Contents reads. Invalid entries produce diagnostics and are excluded; a whole-document error retains the last valid projection and SHA, visibly stale, with writes paused. A denied/revoked App or repository clears the projection. The webhook is disabled. Foreground reads and the daily worker provide polling. Repository membership is validated completely by requiring exactly one private repository in the restricted token response, rejecting a larger collection rather than truncating pagination.

Habits has independent read/write/delete Permissions. Existing API Key presets and existing credentials gain no Habit grants. Owner Sessions receive this area's Permissions. Only explicitly granted API Keys can read or write observations.
