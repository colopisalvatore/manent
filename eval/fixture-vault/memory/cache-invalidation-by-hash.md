---
name: cache-invalidation-by-hash
description: "Cache entries keyed by the hash of their input instead of by an expiry time."
type: feedback
audience: [tech]
created: 2026-01-16
confidence: high
tags: [cache]
---

Entries were expiring on a timer, so a value could be stale for the whole window and recomputed
for nothing when nothing had changed. Keying them by the hash of the input made both problems go
away: a changed input is a different key, an unchanged one is a hit forever.

**Why:** time is a proxy for change, and a bad one. It is either too short, and the cache does no
work, or too long, and the cache lies.

**How to apply:** derive the key from everything the value depends on, including the version of
the code that computes it, and let old keys fall out by size rather than by age. Related:
[[connection-pool-exhaustion]].
