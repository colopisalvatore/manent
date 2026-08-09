# Manent

> *Verba volant, scripta manent.* — Spoken words fly away, written words remain.

**File-first, git-versioned memory for AI agents.** A specification plus a toolchain that turns a plain Markdown vault (Obsidian-compatible) into a queryable, lintable, MCP-served brain that any agent can mount.

Context windows evaporate — *verba volant*. Manent is the written memory that remains: plain files you can read, diff, and own.

## Why

Agent memory today is either a proprietary vector-DB dump (lock-in, no audit trail, no human curation) or an unstructured pile of notes (no schema, no retrieval quality, no guarantees). Manent takes a third path:

- **Markdown files are the source of truth.** Everything else — search indexes, graphs, embeddings — is derived and rebuildable from scratch.
- **Git is the sync and audit backbone.** Every memory write is a commit: who, when, why.
- **A closed, versioned schema** (JSON Schema 2020-12) for note types and typed edges. Linted in CI — a malformed note never lands.
- **MCP is the access layer.** Any MCP client (Claude, ChatGPT, VS Code, Cursor, your own agent) mounts the brain with a URL — no custom SDK.

## Packages

| Package | What |
|---|---|
| `@manent/spec` | The vault specification: note types, frontmatter schemas, typed edges, layout |
| `@manent/core` | Parser (frontmatter + wikilinks), vault loader, graph builder |
| `@manent/retrieval` | Ranking: BM25 lexical, local dense embeddings, graph expansion, RRF fusion |
| `@manent/eval` | Eval harness: golden sets, recall@k / MRR / nDCG, regression gate |
| `@manent/lint` | Rule engine: schema-lint, link-lint, duplicate/orphan detection |
| `@manent/server` | MCP server over a vault: `brain_search`, `brain_read`, `brain_neighbors` — see [Protocol eras](#protocol-eras) |
| `@manent/cli` | `manent init | lint | serve` |

## Quickstart

```
npm install
npm run build

# scaffold a new vault
node packages/cli/dist/index.js init my-vault

# lint it
node packages/cli/dist/index.js lint my-vault

# serve it over MCP (stdio)
node packages/cli/dist/index.js serve my-vault

# or over Streamable HTTP with bearer auth (for remote clients / claude.ai)
node packages/cli/dist/index.js serve my-vault --http 3939 --token <long-random-token>
```

Register with Claude Code:

```
claude mcp add mybrain -- node <repo>/packages/cli/dist/index.js serve <vault>
```

### Use from claude.ai (web)

Verified working. claude.ai will not connect to a remote MCP server that has no discoverable
OAuth metadata, so the HTTP server ships its own single-owner authorization server: your vault
token is the login password.

1. Serve over HTTP and expose it — a tunnel (`cloudflared tunnel --url http://127.0.0.1:3939`)
   or a reverse proxy. HTTPS is required by OAuth for non-localhost redirects.
2. claude.ai → Settings → Connectors → Add custom connector → URL `https://<your-host>/mcp`.
   Leave the OAuth Client ID empty; discovery and registration are automatic.
3. claude.ai opens the consent page. Paste your vault token, approve, done.

Access tokens are HMAC-derived from the vault token rather than stored, so a connected client
survives server restarts. Rotating the vault token invalidates every issued token.

Three details worth knowing:

- The endpoint binds `127.0.0.1` by default and refuses to start without a token — a vault never
  reaches the network unauthenticated by accident.
- Redirect URIs are restricted to an allowlist (`claude.ai`, `claude.com`, localhost) and must be
  HTTPS. PKCE S256 is mandatory; authorization codes are single-use and expire in five minutes.
- `/t/<token>/mcp` also works for clients that can neither set headers nor do OAuth. That URL
  **is** a credential — treat it like a password.

Run `npm run test:oauth` to exercise the whole flow, including wrong token, failed PKCE, code
replay, forged token and disallowed redirect.

## Retrieval, measured

Ranking changes are decided by an eval harness, not by intuition. `manent eval` scores a
retriever against three kinds of query, and each kind answers a different question:

| Source | How it's built | What it measures |
|---|---|---|
| `curated` | hand written, wording close to the note | lexical recall |
| `oblique` | asks for the concept **without** the note's words | semantic recall — the hard case |
| `auto` | derived from each note's own description | broad regression signal, no labelling |

```
manent eval <vault> --golden eval/golden-aios.json          # bm25 vs hybrid side by side
manent eval <vault> --golden ... --save baseline.json       # record a baseline
manent eval <vault> --golden ... --baseline baseline.json   # exits 1 if a metric dropped
```

Results on a real 305-note vault (298 queries), in the order they were measured:

| Ranker | curated hit@1 | curated MRR | oblique MRR | auto hit@1 |
|---|---|---|---|---|
| BM25, naive tokenizer | 45.0% | 0.621 | — | 97.8% |
| BM25 + stopwords, length-gated prefix/fuzzy | 75.0% | 0.863 | 0.099 | **97.8%** |
| Hybrid (graph expansion + recency + centrality) | 75.0% | 0.863 | 0.104 | 93.0% |
| Dense only (multilingual-e5-small, local) | 95.0% | 0.975 | 0.131 | 94.4% |
| **Fused, lexical 1 : dense 2 (RRF)** | **100.0%** | **1.000** | **0.208** | 95.9% |

Four findings worth keeping:

1. **Tokenization was the first big win.** Dropping stopwords and allowing prefix/fuzzy matching
   only on longer terms moved curated hit@1 by 30 points. With prefix matching on, `di` matches
   *diritto*, *disposizione*, *documento* — long notes then win on accumulated noise.
2. **Graph expansion did not pay.** Once retrieval is lexically sound, Personalized PageRank over
   wikilinks adds nothing measurable and the recency/centrality multipliers cost ~5 points on the
   auto set. `hybrid` stays available for vaults with a much denser link structure. PPR amplifies a
   good seed — it cannot create one.
3. **Lexical and dense fail in opposite directions, so fusing them beats both.** Dense alone found
   the notes BM25 missed but blurred exact slugs and identifiers; at equal RRF weights the lexical
   list pulled correct answers off the top spot. Weighting dense twice reached 100% hit@1 on
   hand-written queries, trading ~2 points on the synthetic set.
4. **Vocabulary mismatch is improved, not solved**: `oblique` MRR went 0.099 → 0.208 and recall@5
   25% → 37.5%. A question whose wording shares nothing with its note is still often unreachable.
5. **Chunking made it worse here, and that is informative.** Splitting notes into passages was the
   obvious next step; measured, it cost 10–15 points of curated hit@1. With ~2400 passages instead
   of 307 notes, max-scoring gives a long note one chance per passage to match by luck, so retros
   and legal texts float up — the same length bias BM25 normalizes away. Damping by passage count
   (`max-norm`) recovers oblique recall (MRR 0.221) but still trades away curated and auto accuracy.

| Passages | curated hit@1 | oblique MRR | auto hit@1 | Configuration |
|---|---|---|---|---|
| 307 | **95.0%** | 0.133 | **95.9%** | one passage per note, full body |
| 2419 | 90.0% | 0.096 | 96.3% | 1000-char passages, best-passage scoring |
| 2419 | 85.0% | **0.221** | 91.9% | 1000-char passages, length-damped |
| 1181 | 75.0% | 0.013 | 95.9% | 2000-char passages, best-passage |
| 1181 | 55–75% | ≤0.19 | 73–79% | any size, **without** the contextual prefix |

   Two things to keep from that: the **contextual prefix is not optional** — a passage stripped of
   its note's name and description loses the subject and everything collapses; and **truncation
   beats completeness** on this corpus (1400-char single passage scored 100%, full body 95%).
   Notes here are atomic and front-loaded — one fact each, stated at the top — so the tail is
   elaboration that only blurs the vector. Raise `maxPassages` for vaults of long, multi-topic
   documents, where the answer can sit in the middle of a note.

Reproduce any sweep: `scripts/tune-retrieval.mjs` (graph/scoring params), `scripts/tune-fusion.mjs`
(lexical/dense balance), `scripts/tune-chunking.mjs` (passage size, prefix, aggregation).

### Dense retrieval setup

Embeddings run **locally** — no API key, nothing leaves the machine, and query time needs no
network. The model is an optional dependency, so `bm25` keeps working without it:

```
npm install @huggingface/transformers      # ~120 MB model, downloaded on first use
manent serve <vault> --retriever fused     # or --retriever dense
manent eval <vault> --golden ... --retriever all
```

Vectors are cached in `<vault>/.manent/embeddings.json`, keyed by content hash: editing one note
re-embeds one note. Changing the model invalidates the cache. `manent init` gitignores that
directory — it is derived data, rebuildable from the notes.

## Protocol eras

MCP revision `2026-07-28` removed the `initialize` handshake and sessions; every shipping client
still speaks the older, handshake-based revisions. Manent serves **both, as two separate
implementations** rather than one blended path:

| Era | Revisions | How | File |
|---|---|---|---|
| legacy | `2025-11-25`, `2025-06-18`, `2025-03-26` | official SDK, `initialize` handshake | `src/legacy.ts` |
| modern | `2026-07-28` | native: no handshake, `resultType`, caching hints, `server/discover` | `src/modern.ts` |

Both adapters expose the same tools because the tool definitions live in one place
(`src/tools.ts`); the eras cannot drift in capability. `src/http.ts` only routes.

```
manent serve <vault> --http 3939            # auto: routes each request to its era
manent serve <vault> --http 3939 --era legacy   # pin: modern requests get the fallback signal
manent serve <vault> --http 3939 --era modern   # pin: 2026-07-28 only
```

Auto-detection keys on the RPC itself (`server/discover`, `subscriptions/listen`) or a declared
2026+ protocol version — never on the `Mcp-Method` transport header alone, since dual-era clients
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
└─ secrets/           # NEVER synced, NEVER indexed (enforced)
```

## Roadmap

- [x] Spec v0.1 + lint + graph + BM25 search + MCP stdio server
- [x] Eval harness: three query kinds, recall@k / MRR / nDCG, regression gate
- [x] Lexical retrieval done properly (stopwords, length-gated prefix/fuzzy): +30 pts hit@1
- [x] Graph expansion (Personalized PageRank) + RRF fusion — built, measured, **not** default
- [x] Local dense embeddings + RRF fusion: curated hit@1 75% → 100%, oblique MRR 0.10 → 0.21
- [x] Chunk-level embeddings — implemented, measured, **not** default: worse on atomic notes
- [ ] Curation: embedding-cluster dedup, contradiction detection, Leiden community → MOC suggestions
- [x] Streamable HTTP transport, stateless, bearer-token auth
- [x] OAuth 2.1 (RFC 9728 metadata, dynamic registration, PKCE) — connects from claude.ai
- [x] Two protocol eras as separate implementations: legacy handshake (SDK) and native 2026-07-28
- [ ] Vault hot-reload — the server currently indexes at startup
- [ ] Tasks extension (`io.modelcontextprotocol/tasks`) on the modern path — long-running skills
- [ ] MCP Apps (`ui://`): skill launcher, review queue, graph explorer
- [ ] MCP spec 2026-07-28 wire upgrade (no-handshake core, `server/discover`, cacheable results, Tasks extension) — when the official SDK ships it
- [ ] Write path: `brain_write` behind MRTR approval (`input_required`)
- [ ] MCP Apps: skill launcher, review queue, graph explorer (`ui://` templates)

## License

Apache-2.0 — see [LICENSE](LICENSE).
