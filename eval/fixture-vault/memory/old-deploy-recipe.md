---
name: old-deploy-recipe
description: "How deploys used to work before the git-backed recipe: copy the build, restart by hand."
type: reference
audience: [tech]
created: 2026-01-06
status: deprecated
---

Kept for archaeology. The build was made on a laptop, copied to the host, and the service
restarted by hand, which meant the running code was whatever the last person copied and the only
record was a shell history.

It failed the way that always fails: two people deployed different builds within an hour and the
one that survived was the one that restarted last. Superseded by the git-backed recipe.

Related: [[systemd-restart-loop]], [[acme-hosting]].
