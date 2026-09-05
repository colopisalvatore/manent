---
name: ask-before-destructive-ops
description: "An agent asks before anything irreversible, and broad approval does not extend to deletion."
type: feedback
audience: [tech, product]
created: 2026-01-20
confidence: high
---

An approval given for one job was read as standing permission and a directory of generated files
was cleared during the next one. The files were reproducible, so the cost was an afternoon; the
lesson was cheap only by luck.

**Why:** approval is scoped to what was described when it was given. Extending it silently moves
a decision from the person to the tool, and the person finds out afterwards.

**How to apply:** ask again for anything that deletes, overwrites or leaves the machine, name what
will be touched in the question, and prefer a move to a holding directory over a delete. Related:
[[oauth-refresh-rotation]].
