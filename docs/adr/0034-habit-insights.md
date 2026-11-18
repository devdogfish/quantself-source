# Compute Habit Insights server-side

The Quantself API owns a single overview read model for the Fabric, Chains, Gate, momentum, rollout and weekly review status. Clients render the result. The server derives misses from persisted open occurrences after Halifax midnight. Absent historical dates stay unknown under ADR 0031. Chains count full and minimum practice, survive one miss, and reset on a second consecutive miss. Skips are transparent.

Insights are ranked, neutral observations with stable IDs and prompts for an AI grilling session. The Owner and their AI decide how to respond. The overview makes no definition or observation changes.
