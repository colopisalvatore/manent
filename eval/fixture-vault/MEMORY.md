---
name: memory-index
description: "Global index of this fixture vault. One line per note, loaded every session."
type: index
audience: [public]
created: 2026-01-02
---

# MEMORY — index of the fixture vault

Infrastructure notes hang off [[infrastructure]]. Everything else is one line here.

- [[connection-pool-exhaustion]] — the API stalls under load and nobody is at fault but the pool
- [[systemd-restart-loop]] — a unit that restarts forever because the port is not free yet
- [[nginx-proxy-timeout]] — 504 on long requests, and which timeout actually fires
- [[oauth-refresh-rotation]] — refresh tokens that rotate, and the race two clients hit
- [[backup-notturno-incrementale]] — il backup notturno incrementale e cosa tiene fuori
- [[cache-invalidation-by-hash]] — cache keyed by content hash instead of by time
- [[measure-before-optimizing]] — the rule that saved two weeks of work on the wrong thing
- [[ask-before-destructive-ops]] — what an agent asks before it deletes anything
- [[invoice-portal]] — the project the rest of these notes were written during
- [[retrieval-augmented-generation]] — what retrieval augmented generation is, in one page
- [[acme-hosting]] — the hosting provider this fixture pretends to run on
- [[old-deploy-recipe]] — how deploys used to work, kept for the archaeology
