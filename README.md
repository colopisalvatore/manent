# Manent

> *Verba volant, scripta manent.* Spoken words fly away, written words remain.

**File-first, git-versioned memory for AI agents.** A specification plus a toolchain that turns a plain Markdown vault (Obsidian-compatible) into a queryable, lintable, MCP-served brain that any agent can mount, and that several agents with different clearances can share.

Context windows evaporate: *verba volant*. Manent is the written memory that remains: plain files you can read, diff, and own.

## Why

Agent memory today is either a proprietary vector-DB dump (lock-in, no audit trail, no human curation) or an unstructured pile of notes (no schema, no retrieval quality, no guarantees). Manent takes a third path:

- **Markdown files are the source of truth.** Everything else (search indexes, graphs, embeddings) is derived and rebuildable from scratch.
- **Git is the sync and audit backbone.** Every memory write is a commit: who, when, why.
- **A closed, versioned schema** (JSON Schema 2020-12) for note types and typed edges. Linted in CI, so a malformed note never lands.
- **MCP is the access layer.** Any MCP client (Claude, ChatGPT, VS Code, Cursor, your own agent) mounts the brain with a URL, no custom SDK.
- **Identity decides visibility, before ranking.** Each agent reads the vault through a view built from the notes it may see; a note that says nothing about its audience is private.

## Packages

| Package | What |
|---|---|
| `@manent/spec` | The vault specification (v0.2): note types, frontmatter schemas, audience, typed edges, layout |
| `@manent/core` | Parser (frontmatter + wikilinks), vault loader, graph builder, audience filter, PII/injection scanner |
| `@manent/retrieval` | Ranking: BM25 lexical, local dense embeddings, graph expansion, RRF fusion, status demotion |
| `@manent/eval` | Eval harness: golden sets, recall@k / MRR / nDCG, regression gate |
| `@manent/lint` | Rule engine: schema, links, duplicates, orphans, personal data, model-directed text, audience labels |
| `@manent/server` | MCP server over a vault: read tools, gated write tools, gap register, identities, audit, hot reload; see [Protocol eras](#protocol-eras) |
| `manent` | The CLI: `init | lint | eval | serve | gaps | promote` |

## Quickstart

```
npm install
npm run build

# scaffold a new vault
node packages/cli/dist/index.js init my-vault

# lint it
node packages/cli/dist/index.js lint my-vault

# serve it over MCP (stdio); re-indexes on every edit
node packages/cli/dist/index.js serve my-vault

# or over Streamable HTTP with bearer auth (for remote clients / claude.ai)
node packages/cli/dist/index.js serve my-vault --http 3939 --token <long-random-token>

# with the gap register (needs Node 22.5 or newer), an audit log and agent identities
node packages/cli/dist/index.js serve my-vault --http 3939 --token <token> \
  --gaps ~/manent/gaps.sqlite --audit ~/manent/audit.jsonl --agents agents.json --writable
```

Register with Claude Code:

```
claude mcp add mybrain -- node <repo>/packages/cli/dist/index.js serve <vault>
```

### Use from claude.ai (web)

Verified working. claude.ai will not connect to a remote MCP server that has no discoverable
OAuth metadata, so the HTTP server ships its own single-owner authorization server: your vault
token is the login password, or an agent's token, to connect as that agent.

1. Serve over HTTP and expose it: a tunnel (`cloudflared tunnel --url http://127.0.0.1:3939`)
   or a reverse proxy. HTTPS is required by OAuth for non-localhost redirects.
2. claude.ai, Settings, Connectors, Add custom connector, URL `https://<your-host>/mcp`.
   Leave the OAuth Client ID empty; discovery and registration are automatic.
3. claude.ai opens the consent page. Paste your token, approve, done.

Access tokens are HMAC-derived from the vault token rather than stored, so a connected client
survives server restarts. Rotating the vault token invalidates every issued token. Tokens issued
to an agent carry the agent's name; tokens issued before identities existed keep working as the
owner's.

Three details worth knowing:

- The endpoint binds `127.0.0.1` by default and refuses to start without a token: a vault never
  reaches the network unauthenticated by accident.
- Redirect URIs are restricted to an allowlist (`claude.ai`, `claude.com`, localhost) and must be
  HTTPS. PKCE S256 is mandatory; authorization codes are single-use and expire in five minutes.
- `/t/<token>/mcp` also works for clients that can neither set headers nor do OAuth. That URL
  **is** a credential; treat it like a password.

Run `npm run test:oauth` to exercise the whole flow, including wrong token, failed PKCE, code
replay, forged token and disallowed redirect.

## Tools

| Tool | What |
|---|---|
| `brain_search` | ranked search, returns `{searchId, query, hits}` |
| `brain_read` / `brain_read_raw` | a note, parsed or verbatim |
| `brain_neighbors` | the notes linked to a note, up to 3 hops |
| `brain_list` / `brain_grep` | enumerate, or regex over bodies |
| `brain_feedback` | "this answer was wrong / outdated / incomplete / helpful"; see [The gap register](#the-gap-register) |
| `brain_write` / `brain_append` | listed only with `--writable`; gated, stamped, approved; see [Writes](#writes-the-gate-quarantine-and-approval) |

Every tool runs on the caller's **view** of the vault. That is the whole access model, and it is
worth stating once: a view is built from the notes the caller may read *before* any index exists
over it, so `brain_grep` and `brain_read_raw`, which never touch the ranker, cannot reach a note
the ranker would have hidden. Filtering after ranking would leave them wide open.

## One vault, several agents

A vault read by one person needs no identities: the token is the password. A vault read by a
customer-care agent, a coding agent and the owner's own sessions needs to know who is asking.

**Identities** live in a JSON file passed with `--agents` (HTTP only; stdio is the owner's own
session):

```json
{
  "customer-care": { "token": "<long random>", "read": ["product", "business"], "write": "quarantine/customer-care" },
  "coding":        { "token": "<long random>", "read": ["tech", "product"] }
}
```

- `read` is the agent's scope: the audience labels it may see. `*` is the owner's scope and sees
  everything, private notes included. `private` is never granted; it is the absence of a grant.
- `write` is the one directory the agent may write into. No `write`, no writing.
- The vault token is the **owner**. The `--agents` file, the vault token, and the OAuth tokens
  minted for either all resolve to an identity that travels with every call.

**Visibility** is a property of the note, in its frontmatter, not of the folder, because the
same note often serves two audiences:

```yaml
audience: [tech, product]   # who may read it
```

Absent or empty means **private**: the most restrictive reading, on purpose. A note written
without thinking about it cannot become visible by accident, the same principle as `secrets/`.
`public` is the one reserved label that may leave the organisation; every other label is the
vault's own, and `manent lint --audiences tech,business,product` closes the set: an unknown
label is reported, and until fixed it makes a note *less* visible, never more, because no scope
names it.

**Audit**: `--audit <file>` appends one JSONL line per tool call: timestamp, identity, tool,
redacted arguments, result names, elapsed. Enough to reconstruct an incident; not enough to
reconstruct a customer.

`npm run test:acl` exercises all of it: scoped search / list / grep / raw read / neighbours,
quarantine writes, the gate, the approval round-trip, OAuth as an agent, and both protocol eras.

## Writes: the gate, quarantine and approval

Write tools are off unless the server starts with `--writable`, and not even advertised
otherwise. When they are on:

1. **The gate.** Every write is scanned before anything touches the disk. Text that carries
   personal data (email, phone, IBAN, card, national id) or reads as an instruction aimed at a
   model ("ignore previous instructions", hidden HTML directives, zero-width characters) is
   refused with the reason. A vault lives in git and git history is forever, so the check is
   before storage, not a cleanup afterwards; and a knowledge base that agents with tools read must
   not be a place where an outsider's words can become instructions.
2. **Quarantine.** An agent's write lands in the directory it was granted and nowhere else,
   stamped `status: quarantine`, `author: <agent>`, `audience: [private]`, whatever the call
   asked for. Quarantined notes rank below active ones (score halved) and are visible to the owner only,
   who promotes them with `manent promote` (below): a commit with a name on it. The owner's
   writes keep their folder and audience, and get `author: owner`.
3. **Approval.** On MCP 2026-07-28 the write does not complete on the first call: it answers
   `resultType: "input_required"` with an elicitation form that shows the note, and completes
   on the retry that carries the person's confirmation (`inputResponses`). The request state is a
   fingerprint of what was proposed, so an altered retry is asked again instead of trusted. The agent
   proposes, the person confirms, in the standard's own primitive. Clients that cannot ask (the
   handshake eras, clients without the elicitation capability) fall through: the owner's write
   goes straight through as before, an agent's goes to quarantine.

## Promotion: the review queue

Quarantine is only half a design: something has to take notes out of it, and if that something is
three YAML edits by hand (status, audience, folder) the one that gets skipped is the audience, so
the note either stays invisible or becomes readable by everyone. `manent promote` is the other
half — one move, one commit message:

```
manent promote <vault>                                  # the queue: what is waiting, oldest first
manent promote <vault> --author customer-care           # only what one agent proposed
manent promote <vault> --note <name> --dry-run          # the whole move, nothing touched
manent promote <vault> --note <name> --audience tech,product --to memory --commit
```

The queue prints one line per quarantined note: age in days (from `created`, or the file's mtime
when it has none), name, author, current audience, path, description. Promotion sets
`status: active`, sets the audience it is given (keeps the one it has when given none), moves the
file out of `quarantine/<agent>/` when `--to` says where, stamps `updated`, and prints the commit
message a person would have written by hand:

```
promote(cache-warmup): out of quarantine

Written by tech on 2026-09-01, promoted 2026-09-05.
status: quarantine, now active
audience: private, now tech and product
moved from quarantine/tech/cache-warmup.md to memory/cache-warmup.md
```

`--commit` stages exactly those paths and commits them in the vault repository; without it the
message is printed for the person to use. What promotion never does is decide: no note leaves
quarantine because a heuristic liked it. It refuses an unknown or ambiguous name, a note that is
not in quarantine, a destination already taken or outside the vault, an audience label that is
not a slug, and `private` alongside another label — `private` is the absence of an audience, not
one more of them, and a note carrying both reads as private while being served to everybody
holding the other label. Every refusal happens before anything is written.

## The gap register

To learn from the people asking, the brain does not need their text; it needs to know **which
questions it could not answer**. `--gaps <sqlite file>` records every `brain_search`, redacted,
into a file *outside* the vault (a gap is not a fact; and unlike the embedding cache it is
observed, not derived; losing it loses weeks of real questions). Two signals carry the weight:

- **followed**: a search that no `brain_read` of one of its results follows, from the same
  identity within ten minutes, is a search that did not help. The server sees that alone.
- **count**: rows group by meaning through the ranker's own embedding model, so paraphrases
  collapse into one line; by normalized words until the model is warm. Threshold 0.9, measured on
  `multilingual-e5-small`: paraphrases scored 0.908 to 0.943, unrelated questions 0.752 to 0.835
  (`--gaps-threshold` to tune).

The caller recorded is the **agent**, never a person: the register is free of personal data by
construction, not by discipline. It is a queue, not a memory; its job is to be emptied:

```
manent gaps <vault> --gaps gaps.sqlite                       # open gaps, by asked − read
manent gaps <vault> --gaps gaps.sqlite --show g_<id>            # the searches behind one
manent gaps <vault> --gaps gaps.sqlite --close g_<id> --note <name> --golden eval/golden.json
manent gaps <vault> --gaps gaps.sqlite --dismiss g_<id>         # not a real question
manent gaps <vault> --gaps gaps.sqlite --feedback            # what agents reported
```

**Closing a gap with the note that answers it emits a golden-set entry**: the question as the
asker phrased it, the note the curator wrote: an `oblique` query by construction. That is the
set the eval is weakest on (MRR 0.208) and the one that had to be written by hand imagining how
someone else would ask. The register manufactures it from real use, and the regression gate then
keeps every closed gap reachable when the ranker changes.

The register sees what was *missing*. It cannot see "there, but wrong": a confident wrong answer
arrives with a high score and a read, and looks like a success. Only the agent or the person can
say so; that is `brain_feedback` (verdict, note, searchId, outcome), filed next to the question
it came from.

## Hot reload

`manent serve` watches the vault and re-indexes what changed: lexical index and graph rebuilt,
dense vectors re-embedded only for notes whose content hash moved, per-identity views
invalidated. Edits are coalesced (a `git checkout` touching hundreds of files costs one reload)
and reloads are serialized. Measured: a new file is searchable ~530 ms after the write. A
`post-receive` hook that checks out the shared branch is all a git-backed brain needs to serve
what was just pushed. `--no-watch` turns it off.

## Deploy: a git-backed brain

The vault is a git repository, so deploying it is a push. `deploy/` carries the layout that has
been running, and the reasoning: a bare repo whose **`pre-receive` hook is the lint gate** (a note
with personal data or model-directed text is refused at the push, not found later in a history that
is forever), a **`post-receive` that checks the tree out and restarts nothing** — the watcher
re-indexes it in about half a second, and a restart would throw away the dense index and every warm
view — a systemd unit, and an `agents.json` example.

The one line worth repeating here: the gap register and the audit log live outside the vault, under
`/var/lib/manent`, and **they are the part no git push restores**. Back that directory up
separately. Details in [`deploy/README.md`](deploy/README.md).

## Retrieval, measured

Ranking changes are decided by an eval harness, not by intuition. `manent eval` scores a
retriever against three kinds of query, and each kind answers a different question:

| Source | How it's built | What it measures |
|---|---|---|
| `curated` | hand written, wording close to the note | lexical recall |
| `oblique` | asks for the concept **without** the note's words | semantic recall, the hard case |
| `auto` | derived from each note's own description | broad regression signal, no labelling |

```
manent eval <vault> --golden eval/golden-aios.json          # bm25 vs hybrid side by side
manent eval <vault> --golden ... --save baseline.json       # record a baseline (metrics only: safe to commit)
manent eval <vault> --golden ... --baseline baseline.json   # exits 1 if a metric dropped
manent eval <vault> --golden ... --save full.json --save-full   # with per-query results: names every note, keep it private
```

Results on a real 305-note vault (298 queries), in the order they were measured:

| Ranker | curated hit@1 | curated MRR | oblique MRR | auto hit@1 |
|---|---|---|---|---|
| BM25, naive tokenizer | 45.0% | 0.621 | n/a | 97.8% |
| BM25 + stopwords, length-gated prefix/fuzzy | 75.0% | 0.863 | 0.099 | **97.8%** |
| Hybrid (graph expansion + recency + centrality) | 75.0% | 0.863 | 0.104 | 93.0% |
| Dense only (multilingual-e5-small, local) | 95.0% | 0.975 | 0.131 | 94.4% |
| **Fused, lexical 1 : dense 2 (RRF)** | **100.0%** | **1.000** | **0.208** | 95.9% |

Five findings worth keeping:

1. **Tokenization was the first big win.** Dropping stopwords and allowing prefix/fuzzy matching
   only on longer terms moved curated hit@1 by 30 points. With prefix matching on, `di` matches
   *diritto*, *disposizione*, *documento*; long notes then win on accumulated noise.
2. **Graph expansion did not pay.** Once retrieval is lexically sound, Personalized PageRank over
   wikilinks adds nothing measurable and the recency/centrality multipliers cost ~5 points on the
   auto set. `hybrid` stays available for vaults with a much denser link structure. PPR amplifies a
   good seed; it cannot create one.
3. **Lexical and dense fail in opposite directions, so fusing them beats both.** Dense alone found
   the notes BM25 missed but blurred exact slugs and identifiers; at equal RRF weights the lexical
   list pulled correct answers off the top spot. Weighting dense twice reached 100% hit@1 on
   hand-written queries, trading ~2 points on the synthetic set.
4. **Vocabulary mismatch is improved, not solved**: `oblique` MRR went from 0.099 to 0.208 and recall@5
   from 25% to 37.5%. A question whose wording shares nothing with its note is still often unreachable,
   which is what the gap register is for.
5. **Chunking made it worse here, and that is informative.** Splitting notes into passages was the
   obvious next step; measured, it cost 10 to 15 points of curated hit@1. With ~2400 passages instead
   of 307 notes, max-scoring gives a long note one chance per passage to match by luck, so retros
   and legal texts float up, the same length bias BM25 normalizes away. Damping by passage count
   (`max-norm`) recovers oblique recall (MRR 0.221) but still trades away curated and auto accuracy.

| Passages | curated hit@1 | oblique MRR | auto hit@1 | Configuration |
|---|---|---|---|---|
| 307 | **95.0%** | 0.133 | **95.9%** | one passage per note, full body |
| 2419 | 90.0% | 0.096 | 96.3% | 1000-char passages, best-passage scoring |
| 2419 | 85.0% | **0.221** | 91.9% | 1000-char passages, length-damped |
| 1181 | 75.0% | 0.013 | 95.9% | 2000-char passages, best-passage |
| 1181 | 55 to 75% | at most 0.19 | 73 to 79% | any size, **without** the contextual prefix |

   Two things to keep from that: the **contextual prefix is not optional**: a passage stripped of
   its note's name and description loses the subject and everything collapses; and **truncation
   beats completeness** on this corpus (1400-char single passage scored 100%, full body 95%).
   Notes here are atomic and front-loaded, one fact each, stated at the top, so the tail is
   elaboration that only blurs the vector. Raise `maxPassages` for vaults of long, multi-topic
   documents, where the answer can sit in the middle of a note.

Every ranker is wrapped by **status demotion**: `quarantine` and `deprecated` notes keep half their score,
`archived` a quarter, on the server and in the eval alike, so what is measured is what ships. On a
vault with no such notes the wrapper is a no-op (regression gate: no change).

The September 2026 re-measurement on the grown vault (479 notes) is in `paper/`; it moved some of
these numbers, and the paper says how.

Reproduce any sweep: `scripts/tune-retrieval.mjs` (graph/scoring params), `scripts/tune-fusion.mjs`
(lexical/dense balance), `scripts/tune-chunking.mjs` (passage size, prefix, aggregation).

### Dense retrieval setup

Embeddings run **locally**: no API key, nothing leaves the machine, and query time needs no
network. The model is an optional dependency, so `bm25` keeps working without it:

```
npm install @huggingface/transformers      # ~120 MB model, downloaded on first use
manent serve <vault> --retriever fused     # or --retriever dense
manent eval <vault> --golden ... --retriever all
```

Vectors are cached in `<vault>/.manent/embeddings.json`, keyed by content hash: editing one note
re-embeds one note. Changing the model invalidates the cache. `manent init` gitignores that
directory; it is derived data, rebuildable from the notes.

## Lint as the gate

```
manent lint <vault>                                        # what a human should look at
manent lint <vault> --strict-content --audiences tech,business,product   # what CI refuses
```

Beyond schema, links, duplicates and orphans, lint reports **personal data** in a note, text that
**reads as an instruction to a model**, and **audience labels** outside the vault's set. They are
warnings for a person and, with `--strict-content`, errors for a pipeline. Run the strict form as
a pre-commit hook or in CI on the brain repository: a note that fails it never lands in the
shared branch, which is the only place the server reads from.

## Protocol eras

MCP revision `2026-07-28` removed the `initialize` handshake and sessions; every shipping client
still speaks the older, handshake-based revisions. Manent serves **both, as two separate
implementations** rather than one blended path:

| Era | Revisions | How | File |
|---|---|---|---|
| legacy | `2025-11-25`, `2025-06-18`, `2025-03-26` | official SDK, `initialize` handshake | `src/legacy.ts` |
| modern | `2026-07-28` | native: no handshake, `resultType`, caching hints, `server/discover`, `input_required` | `src/modern.ts` |

Both adapters expose the same tools because the tool definitions live in one place
(`src/tools.ts`) and every call goes through one dispatcher (audit included); the eras cannot
drift in capability. `src/http.ts` only routes.

```
manent serve <vault> --http 3939            # auto: routes each request to its era
manent serve <vault> --http 3939 --era legacy   # pin: modern requests get the fallback signal
manent serve <vault> --http 3939 --era modern   # pin: 2026-07-28 only
```

Auto-detection keys on the RPC itself (`server/discover`, `subscriptions/listen`) or a declared
2026+ protocol version, never on the `Mcp-Method` transport header alone, since dual-era clients
send it with a legacy `initialize` too. `npm run test:era` exercises all three modes.

## Vault layout (see `packages/spec/SPEC.md`)

```
vault/
├─ MEMORY.md          # global index, loaded every session (type: index)
├─ HOME.md            # human navigation hub (type: moc)
├─ memory/            # global lessons: feedback_*.md, reference_*.md
├─ projects/<p>/      # per-project knowledge, handoffs, retros
├─ moc/               # one map-of-content per branch
├─ people/            # person notes (type: persona)
├─ library/           # raw dated sources: YYYY-MM-DD-<slug>.md
├─ wiki/              # compounding wiki: entities/ concepts/ queries/
├─ knowledge/         # read-only mirrors from external repos
├─ quarantine/        # agents' proposals, private until a person promotes them
└─ secrets/           # NEVER synced, NEVER indexed (enforced)
```

## Tests

```
npm run smoke          # init, lint, search
npm run probe          # stdio: initialize, tools/list, brain_search
npm run test:era       # both protocol eras, pinned and auto-routed
npm run test:oauth     # the whole OAuth flow and its refusals
npm run test:write     # write tools: gate and path containment
npm run test:links     # wikilink resolution by name, path and file name
npm run test:gaps      # gap register: redaction, grouping, follow, close, feedback, CLI
npm run test:acl       # identities, visibility at load, quarantine, approval, audit
npm run test:reload    # hot reload: add, edit, delete, bursts
npm run test:promote   # promotion: the queue, the refusals, the move, the commit
npm run test:warmup    # dense ranker warms up in the background
npm run lint:fixture   # the lint gate on eval/fixture-vault, content rules strict
npm run eval:fixture   # retrieval regression gate on eval/fixture-vault
MANENT_VAULT=<vault> npm run eval:gate   # the same gate on your own vault; baselines are metrics-only files
```

CI (`.github/workflows/ci.yml`) runs all of it on node 20 and 22 except `test:warmup`, which would
download the embedding model, and `npm pack --dry-run` on every package, so a release ships what it
means to. The gates run on `eval/fixture-vault`: nineteen invented notes — an invented hosting
provider, an invented project — because a corpus a public CI can read is a corpus nobody wrote
their real memory into. Its numbers have the shape of the real thing (curated hit@1 91.7%, oblique
0%, `eval/baseline-fixture-bm25.json`), so a change that breaks retrieval breaks the gate.

## Roadmap

Done, in the order it was built:

- [x] Spec v0.1 + lint + graph + BM25 search + MCP stdio server
- [x] Eval harness: three query kinds, recall@k / MRR / nDCG, regression gate
- [x] Lexical retrieval done properly (stopwords, length-gated prefix/fuzzy): +30 pts hit@1
- [x] Graph expansion (Personalized PageRank) + RRF fusion: built, measured, **not** default
- [x] Local dense embeddings + RRF fusion: curated hit@1 from 75% to 100%, oblique MRR from 0.10 to 0.21
- [x] Chunk-level embeddings: implemented, measured, **not** default; worse on atomic notes
- [x] Streamable HTTP transport, stateless, bearer-token auth
- [x] OAuth 2.1 (RFC 9728 metadata, dynamic registration, PKCE); connects from claude.ai
- [x] Two protocol eras as separate implementations: legacy handshake (SDK) and native 2026-07-28
- [x] Read tools beyond search: `brain_list`, `brain_read_raw`, `brain_grep`
- [x] Write tools, off unless the operator opts in
- [x] Wikilinks resolved by name, path and file name, so the vault reads the same in Obsidian and here
- [x] **Gap register**: unanswered searches become a work list by frequency, then `oblique` golden-set entries on closure
- [x] **Spec v0.2**: `audience`, `author`, `status: quarantine`; `status` consumed by ranking
- [x] **Identities** (`--agents`), visibility filtered at load, per-identity views on every tool
- [x] **Write gate** (personal data, model-directed text), quarantine for agents, `--audit`
- [x] **Write path behind approval**: `resultType: "input_required"` on 2026-07-28, fingerprinted retry
- [x] **Vault hot reload**: watch, coalesce, re-embed only what changed
- [x] `brain_feedback`: "there, but wrong", filed next to the question
- [x] Lint gate for CI: `pii`, `injection`, `audience-unknown`, `--strict-content`
- [x] **Promotion tooling**: `manent promote`: out of quarantine with status, audience, folder and
      a commit message in one move; a review queue of quarantined notes by age and author
- [x] **GitHub Actions**: build, every test, the lint gate and the retrieval gate on a public
      fixture vault, on two node versions; `npm pack --dry-run` on every package
- [x] **Git-backed deploy recipe** (`deploy/`): the lint gate as a `pre-receive` hook, checkout on
      `post-receive` with no restart, systemd unit, identities and audit paths as a server layout

Next, in the order it should be built:

- [ ] **Curation**: embedding-cluster dedup, contradiction detection (`contradicts` surfaced, never
      auto-resolved), Leiden communities as MOC suggestions, fed by the gap register's numbers,
      not by intuition
- [ ] npm publish (the packages carry their publish metadata and the CLI is named `manent`; the
      release itself is a person's gesture, with their own token)
- [ ] Tasks extension (`io.modelcontextprotocol/tasks`) on the modern path, for long-running skills
- [ ] MCP Apps (`ui://`): skill launcher, quarantine review queue, gap register, graph explorer
- [ ] MCP spec 2026-07-28 wire upgrade on the legacy path, when the official SDK ships it

Open questions the code does not settle: who owns the brain infrastructure once four agents
depend on it; which audience labels a given organisation wants (the spec reserves `private` and
`public` and leaves the rest to the vault, on purpose).

## License

Apache-2.0; see [LICENSE](LICENSE).
