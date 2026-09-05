---
name: retro-cache-work
description: "Retro of the cache work: what the measurement changed and what would be done differently."
type: retro
audience: [tech]
created: 2026-01-24
---

# What happened

Two weeks were planned for caching the report. One hour of profiling moved the work to
serialisation, and the cache ended up being a smaller change than the one it replaced.

# What worked

Producing a single number before touching anything, and keeping it as the thing every change was
judged against.

# What would be done differently

The profile should have been taken when the ticket was written, not when the work was half done.
Distilled into [[measure-before-optimizing]] and [[cache-invalidation-by-hash]].
