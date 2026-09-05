---
name: 2026-01-10-load-test-report
description: "Load test report of 2026-01-10: where the invoice portal broke and at what concurrency."
type: raw-source
audience: [tech]
created: 2026-01-10
---

Raw notes from the load test run on 2026-01-10 against a copy of the portal.

Setup: one container, the production database size, synthetic invoices, concurrency stepped from
10 to 400 in eight steps of five minutes each.

Findings, unedited: latency flat to 120 concurrent; at 160 the queue depth on the pool starts to
grow and p95 doubles; at 240 the first client timeouts appear, all of them waiting for a
connection rather than for the database; the export endpoint returns 504 at every step above 80,
which turned out to be the proxy and not the application.

Synthesised into [[connection-pool-exhaustion]] and [[nginx-proxy-timeout]].
