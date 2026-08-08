# Manent Vault Specification v0.1

The contract between a Markdown vault and every tool in the ecosystem. Code follows spec, never the reverse.

## 1. Core invariant

**Markdown files are the only source of truth.** Search indexes, embeddings, graphs, caches are derived artifacts: any of them must be rebuildable from the files alone, at any time, with no data loss. A tool that makes derived state authoritative is non-conforming.

## 2. Vault layout

```
vault/
├─ MEMORY.md          # global index (type: index) — loaded every session; one line per memory
├─ HOME.md            # human navigation hub (type: moc)
├─ memory/            # global lessons: feedback_*.md, reference_*.md
├─ projects/<p>/      # per-project: project_*.md, handoffs/, retros/
├─ moc/               # one map-of-content per knowledge branch (type: moc)
├─ people/            # person notes (type: persona)
├─ library/           # raw sources, dated: YYYY-MM-DD-<slug>.md (type: raw-source)
├─ wiki/              # compounding wiki: entities/, concepts/, queries/
├─ knowledge/         # read-only mirrors synced from external repos — never hand-edited
└─ secrets/           # FORBIDDEN: never synced, never indexed, never served
```

Directories are conventions, not constraints — notes may live anywhere except that tools MUST honor `secrets/` (and any dir listed in `FORBIDDEN_DIRS`) as a hard exclusion at every layer: sync, index, serve.

An optional `.manentignore` file at the vault root excludes additional paths from loading, linting and serving: one vault-relative path prefix per line, `#` comments, no globs. Use it for read-only mirrors (`knowledge/`), raw corpora, git submodules — content that lives in the vault but is not conforming notes. `secrets/` stays excluded whether listed or not.

## 3. Note contract

One note = one file = one atomic fact/entity/lesson. YAML frontmatter validated against `schemas/note-base.schema.json`:

```yaml
---
name: cpanel-cron-wrapper-script      # canonical slug = filename without .md
description: cPanel cron silently drops commands with nested quoting; use a versioned wrapper .sh
type: feedback                        # closed enum, see §4
created: 2026-08-08
updated: 2026-08-08
tags: [cpanel, cron]
provenance: [2026-08-01-debug-session-transcript]
confidence: high
status: active
---
```

- `name` MUST equal the filename slug (exception: root-level entry points `MEMORY.md` / `HOME.md` keep conventional uppercase filenames). Wikilinks resolve against `name`.
- `description` is the retrieval surface: one line that lets a ranker judge relevance without opening the note.
- Unknown extra fields are allowed (`additionalProperties: true`) — forward compatibility.
- YAML dates parse as Date objects; tools MUST normalize to `YYYY-MM-DD` strings before validation.
- Notes are hand-written, so invalid YAML happens (a `description` containing `": "` is the common
  case). Tools MUST NOT fail the whole run on one bad note: load it with empty frontmatter and its
  body intact, and report it as `frontmatter-invalid`. A vault stays usable while a note is broken.

### Body conventions by type

- `feedback` — MUST contain `**Why:**` and `**How to apply:**` sections (lint: warning).
- `raw-source` — lives in `library/`, filename `YYYY-MM-DD-<slug>.md` (lint: warning).
- `moc` / `index` — link hubs; exempt from orphan detection.

## 4. Note types (closed enum)

| type | meaning |
|---|---|
| `feedback` | a lesson on how to work: correction or confirmed approach, with why |
| `reference` | pointer/distillation of an external resource |
| `project` | ongoing work, goals, constraints not derivable from code |
| `wiki-entity` | a thing: person, system, company, product |
| `wiki-concept` | an idea, pattern, algorithm |
| `raw-source` | verbatim external material, dated |
| `persona` | a person: role, how to work with them, history |
| `handoff` | session-resume snapshot |
| `retro` | end-of-task retrospective |
| `moc` | map of content: navigation hub for a branch |
| `index` | the global always-loaded index |

Adding a type = spec PR + minor version bump.

## 5. Edges (typed graph)

| kind | source | semantics |
|---|---|---|
| `wikilink` | `[[name]]` in body | associative link; an unresolved target is NOT an error — it marks a note worth writing |
| `provenance` | frontmatter | synthesis → raw source it came from |
| `supersedes` | frontmatter | this note replaces that one (target should become `status: deprecated`) |
| `contradicts` | frontmatter | flagged conflict — surfaced for human resolution, never auto-resolved |

## 6. Lint rules (v0.1)

| rule | severity |
|---|---|
| `frontmatter-invalid` (YAML does not parse) | error |
| `frontmatter-missing` | error |
| `schema` (base schema violation) | error |
| `duplicate-name` | error |
| `name-mismatch` (frontmatter vs filename) | warning |
| `link-unresolved` | warning (error with `--strict-links`) |
| `feedback-body` (missing Why / How to apply) | warning |
| `raw-source-path` | warning |
| `orphan` (no edges, not moc/index) | info |

## 7. Versioning

Spec follows semver (`SPEC_VERSION`). Patch = clarification. Minor = additive (new type, new optional field). Major = breaking (field removed/renamed, semantics changed). Tools declare the spec version they implement.
