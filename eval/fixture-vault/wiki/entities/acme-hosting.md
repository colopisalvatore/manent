---
name: acme-hosting
description: "Acme Hosting, the invented provider this fixture vault pretends to run on."
type: wiki-entity
audience: [tech]
created: 2026-01-04
---

An invented hosting provider, used so the fixture notes have somewhere to run.

What it is assumed to offer: a container host with a fixed CPU allowance, block storage that
survives a rebuild, nightly archives kept for thirty days, and a control panel whose cron runner
does not inherit the shell environment.

That last detail is the one that shows up in the notes: anything scheduled has to set its own
environment. Related: [[backup-notturno-incrementale]], [[old-deploy-recipe]].
