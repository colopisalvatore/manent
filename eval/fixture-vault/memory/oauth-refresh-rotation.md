---
name: oauth-refresh-rotation
description: "Rotating refresh tokens log people out when two clients refresh at the same moment."
type: reference
audience: [tech]
created: 2026-01-12
tags: [oauth, auth]
---

With rotation on, every refresh returns a new refresh token and invalidates the old one, so a
stolen token is usable once and then detectable. The failure mode is two tabs refreshing within
the same second: the second one presents a token that was just retired and is logged out, and
because reuse is treated as theft the whole family of tokens can be revoked with it.

What works: a short grace window in which the previous token still refreshes and returns the
same new one, and a single-flight refresh in the client so two tabs cannot both ask. What does
not work: turning rotation off, which trades a rare logout for a permanent credential.

Related: [[invoice-portal]], [[ask-before-destructive-ops]].
