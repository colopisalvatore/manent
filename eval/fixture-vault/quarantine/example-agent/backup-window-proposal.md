---
name: backup-window-proposal
description: "Proposal from an agent: move the backup window an hour earlier to clear the reporting run."
type: reference
audience: [private]
author: example-agent
status: quarantine
created: 2026-01-26
---

Written by an agent, waiting for a person: the nightly backup at 03:00 overlaps the reporting run
that starts at 02:40 on the first of the month, and both are slower for it.

Proposed: move the backup to 04:30, after reporting has finished on every month observed so far.
Not verified against the archive retention window, which is the reason this is a proposal and not
a note. Related: [[backup-notturno-incrementale]].
