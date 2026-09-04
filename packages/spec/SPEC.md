# Manent Vault Specification v0.2

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
├─ quarantine/        # notes written by agents with no human in the loop, awaiting promotion (§3.3)
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
status: active                        # active | quarantine | deprecated | archived, see §3.2
audience: [tech]                      # who may read it, see §3.1 — absent means private
author: owner                         # who wrote it through the write path, see §3.3
---
```

- `name` MUST equal the filename slug (exception: root-level entry points `MEMORY.md` / `HOME.md` keep conventional uppercase filenames). Wikilinks resolve against `name` first — see §5.1.
- `description` is the retrieval surface: one line that lets a ranker judge relevance without opening the note.
- Unknown extra fields are allowed (`additionalProperties: true`) — forward compatibility.
- YAML dates parse as Date objects; tools MUST normalize to `YYYY-MM-DD` strings before validation.
- Notes are hand-written, so invalid YAML happens (a `description` containing `": "` is the common
  case). Tools MUST NOT fail the whole run on one bad note: load it with empty frontmatter and its
  body intact, and report it as `frontmatter-invalid`. A vault stays usable while a note is broken.

### 3.1 Audience (visibility)

A vault read by more than one agent needs to say, per note, who may read it. That lives in the
frontmatter, not in the folder: the same note often serves two audiences, and a folder forces it
into one home.

- `audience` is a list of labels (a single string is read as a one-element list). Labels are
  slugs. Two are reserved:
  - `private` — the owner alone. **This is what a note means when the field is absent or
    empty.** The default is the most restrictive reading on purpose: a note written without
    thinking about it cannot become visible by accident — the same principle as `secrets/`.
  - `public` — any reader, and the only label that may be served outside the organisation.
- Every other label is defined by the vault (for instance `tech`, `business`, `product`). The
  vault closes its own set at the lint gate (`manent lint --audiences tech,business,product`): an
  unknown label is reported, and until it is fixed it makes the note *less* visible, never more,
  because no reader's scope names it.
- A reader holds a **scope**: a list of labels, or `*` for everything (the owner). A note is
  visible to a scope when it is `public` or when one of its labels is in the scope. `private` is
  never granted to a scope; it is the absence of a grant.
- **The filter is applied when the vault is loaded for a reader, before any index is built over
  it.** A reader's search, listing, grep, raw read and neighbourhood are computed from the notes
  that reader may see, so a tool that bypasses the ranker cannot bypass the filter. Filtering
  after ranking is non-conforming.

### 3.2 Status

`status` is consumed by ranking. `quarantine`, `deprecated` and `archived` notes MUST rank below
an `active` note of equal relevance (the reference implementation multiplies the ranker's score
by 0.5, 0.5 and 0.25). They still surface when nothing better exists, and they are still served.

`quarantine` is the state of a note written by an agent with no human in the loop (§3.3). It is
promoted by a human edit — the status, the audience, usually the wording — and that edit is a
commit with a name on it.

### 3.3 Writes by agents

Whoever the caller is, a tool that persists text MUST scan it first and refuse text that carries
personal data (email addresses, phone numbers, bank and card numbers, national identifiers) or
reads as an instruction aimed at a model ("ignore previous instructions", hidden directives,
zero-width characters). A vault lives in git, and git history is forever: the gate is before
storage, not a cleanup afterwards, and a knowledge base that agents with tools read must not be
a place where an outsider's words can become instructions.

A write by an identity other than the owner:

- MUST land in the directory that identity was granted, and nowhere else;
- MUST carry `status: quarantine`, `author: <identity>` and `audience: [private]`, whatever the
  caller asked for;
- SHOULD go through the client's approval when the protocol offers one (MCP 2026-07-28
  `resultType: "input_required"`): the agent proposes, the person confirms.

Readers and writers are identified by their credential, never by a name they typed. Every
tool call SHOULD be auditable with that identity.

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
| `wikilink` | `[[name]]`, `[[dir/name]]` or `[[../dir/name]]` in body | associative link; an unresolved target is NOT an error — it marks a note worth writing |
| `provenance` | frontmatter | synthesis → raw source it came from |
| `supersedes` | frontmatter | this note replaces that one (target should become `status: deprecated`) |
| `contradicts` | frontmatter | flagged conflict — surfaced for human resolution, never auto-resolved |

### 5.1 Wikilink resolution

A vault is written by a human in an editor and read by a machine through the
index, and the two do not identify a note the same way: Obsidian resolves
`[[foo]]` by file name and `[[dir/foo]]` by path, while a note's identity here is
its canonical `name`. Where those disagree — a note named `moc-ops` living in
`moc/ops.md` — a link that works in the editor would look broken to the index.
A resolver MUST therefore try, in order:

1. **canonical `name`**, exact match;
2. **path relative to the linking note** — `[[../people/rossi]]`;
3. **path from the vault root** — `[[moc/ops]]`;
4. **file name alone** — `[[rossi]]` — when exactly one note carries it, or,
   when several do, when exactly one of them sits in the linking note's own
   directory.

A trailing `.md` is ignored at every step. Resolution always yields the target's
canonical `name`, so the graph stays keyed by name whatever form the link took.
An ambiguous file name that proximity cannot settle MUST stay unresolved:
guessing would wire the graph to the wrong note, silently.

A reader's graph is built from the notes that reader may see (§3.1); an edge into a note outside
that view is dropped, so a neighbourhood cannot name what its reader cannot open.

## 6. Lint rules (v0.2)

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
| `pii` (email, phone, IBAN, card, national id in the body) | warning (error with `--strict-content`) |
| `injection` (text that reads as an instruction to a model) | warning (error with `--strict-content`) |
| `audience-unknown` (label outside `--audiences`, reserved ones aside) | warning |
| `orphan` (no edges, not moc/index) | info |

Run `manent lint --strict-content --audiences <labels>` as the gate in CI: a note that fails it
never lands in the shared branch.

## 7. Versioning

Spec follows semver (`SPEC_VERSION`). Patch = clarification. Minor = additive (new type, new optional field). Major = breaking (field removed/renamed, semantics changed). Tools declare the spec version they implement.

- **0.2.0** — `audience`, `author`; `status: quarantine`; ranking consumes `status`; write gate
  and agent-write rules (§3.1–3.3); lint rules `pii`, `injection`, `audience-unknown`. Additive:
  a v0.1 vault is a valid v0.2 vault in which every note is private.
- **0.1.0** — initial contract.
