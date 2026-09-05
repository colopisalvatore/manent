---
name: connection-pool-exhaustion
description: "Requests queue and time out because every database connection in the pool is checked out."
type: reference
audience: [tech]
created: 2026-01-05
tags: [database, performance]
---

Under load the API stopped answering while the database sat almost idle. The pool held twenty
connections, every one of them checked out by a request waiting on a slow report query, so new
requests queued for a connection that never came back and timed out in the client.

Three things fixed it, in this order: a statement timeout so no query can hold a connection for
minutes, the report moved to its own pool so it cannot starve the interactive path, and only then
a larger pool. Sizing the pool first would have moved the wall, not removed it — see
[[measure-before-optimizing]].

Symptoms worth recognising: latency climbs on every endpoint at once, the database CPU is flat,
and the queue depth metric rises while query time does not.
