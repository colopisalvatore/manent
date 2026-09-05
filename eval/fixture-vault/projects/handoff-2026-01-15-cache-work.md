---
name: handoff-2026-01-15-cache-work
description: "Handoff of 2026-01-15: state of the cache work on the portal and what the next session picks up."
type: handoff
audience: [tech]
created: 2026-01-15
---

# Goal

Make the report endpoint fast enough that nobody opens a ticket about it.

# Current state

The profile is taken and the serialisation step is the cost, not the query. Keying the cache by
content hash is implemented behind a flag and measured on the copy of the data, not in
production.

# Next step

Turn the flag on for one tenant, watch the hit rate for a week, and only then decide whether the
report needs its own pool. Related: [[cache-invalidation-by-hash]], [[measure-before-optimizing]].
