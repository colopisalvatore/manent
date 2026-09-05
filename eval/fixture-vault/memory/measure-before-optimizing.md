---
name: measure-before-optimizing
description: "Two weeks went into the wrong optimisation because nobody measured where the time went first."
type: feedback
audience: [tech, product]
created: 2026-01-18
confidence: high
---

The plan was to cache the report. The profile, once someone took it, showed ninety percent of the
time in a serialisation step nobody suspected and four percent in the query the cache would have
saved.

**Why:** intuition about performance is trained on the last system, not this one. A measurement
costs an hour; the wrong optimisation costs a fortnight and has to be maintained afterwards.

**How to apply:** before any performance work, produce one number that says where the time goes,
and keep it as the thing the change is judged against. If the number cannot be produced, that is
the first task, not an excuse to skip it. Related: [[connection-pool-exhaustion]],
[[2026-01-10-load-test-report]].
