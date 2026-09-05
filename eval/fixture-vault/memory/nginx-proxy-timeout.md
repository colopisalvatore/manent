---
name: nginx-proxy-timeout
description: "A long request returns 504 from the reverse proxy while the backend is still working on it."
type: reference
audience: [tech]
created: 2026-01-09
tags: [nginx, http]
---

An export that takes ninety seconds returned 504 after sixty, and the backend log showed the work
finishing normally afterwards. The proxy had given up, not the application.

The timeout that fires is `proxy_read_timeout`: the gap allowed between two reads from the
upstream, not the total duration of the request. A long request that streams something every few
seconds never trips it; one that computes silently for ninety seconds does. So either the
endpoint streams progress, or the timeout covers the worst case, and the second option is a
promise about a number that will change.

The client's own timeout is a third number, and it is the one users actually experience.
Related: [[connection-pool-exhaustion]].
