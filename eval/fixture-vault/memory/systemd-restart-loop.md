---
name: systemd-restart-loop
description: "A service restarts forever after deploy because the previous process still holds the port."
type: reference
audience: [tech]
created: 2026-01-07
tags: [systemd, deploy]
---

After a deploy the unit entered a restart loop: start, bind failure on the port, exit, restart,
five times a second until systemd gave up. The old process was still shutting down and holding
the socket.

What fixed it: `Restart=on-failure` with `RestartSec=2`, a `TimeoutStopSec` long enough for the
old process to drain, and the new process waiting for the port instead of assuming it. What did
not fix it: raising `StartLimitBurst`, which only made the loop last longer before systemd
noticed.

Read the journal for the unit, not the application log: the application never got far enough to
write one. Related: [[old-deploy-recipe]], [[nginx-proxy-timeout]].
