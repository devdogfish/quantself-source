# One time range per task

The Owner chose one optional start/end range per task across storage, API, Web Client and Jarvis. Duration is derived; scheduling is part of the ordinary task save, and calendar views display that same task. This supersedes ADR 0027's multiple Planned Work Sessions and separate session-edit flow. Existing single known ranges remain readable; ambiguous legacy schedules are retained with review diagnostics rather than silently dropping or combining their data.

Implementation clarification for #121: rescheduling replaces this range. Multiple work blocks, split sessions and retaining historical blocks are not represented; no duplicate task is created to simulate them. A missing bound on a new range defaults to thirty elapsed minutes; editing one bound on an existing range preserves the other. Due remains the native issue date and an optional deadline time is separate from the work range. Calendar deadline flags do not create work blocks.
