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
| `@manent/lint` | Rule engine: schema-lint, link-lint, duplicate/orphan detection |
| `@manent/server` | MCP server over a vault: `brain_search`, `brain_read`, `brain_neighbors` |
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

1. Serve over HTTP (above) and expose it, e.g. `cloudflared tunnel --url http://127.0.0.1:3939`.
2. claude.ai → Settings → Connectors → Add custom connector → URL `https://<your-host>/mcp`.
3. Auth: add a request header `Authorization: Bearer <token>` (beta feature). If your account
   doesn't have request headers yet, use the capability-URL fallback:
   `https://<your-host>/t/<token>/mcp` — that URL **is** a credential; treat it like a password
   and rotate it by restarting with a new token.

The HTTP endpoint binds `127.0.0.1` by default and refuses to start without a token — a vault
never goes on the network unauthenticated by accident.

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
- [ ] Hybrid retrieval: BM25 ∥ dense embeddings → Reciprocal Rank Fusion
- [ ] Graph expansion: Personalized PageRank over wikilinks
- [ ] Scoring: relevance × recency-decay × importance (Generative Agents model)
- [ ] Curation: embedding-cluster dedup, contradiction detection, Leiden community → MOC suggestions
- [ ] Eval harness: golden set, recall@k / MRR, CI regression gate
- [x] Streamable HTTP transport, stateless, bearer-token auth
- [ ] MCP spec 2026-07-28 wire upgrade (no-handshake core, `server/discover`, cacheable results, Tasks extension) — when the official SDK ships it
- [ ] Write path: `brain_write` behind MRTR approval (`input_required`)
- [ ] MCP Apps: skill launcher, review queue, graph explorer (`ui://` templates)

## License

Apache-2.0 — see [LICENSE](LICENSE).
