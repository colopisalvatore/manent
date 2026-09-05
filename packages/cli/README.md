# manent

File-first, git-versioned memory for AI agents: a vault of markdown notes with a spec, a linter, a
measured retriever, and an MCP server that serves it to Claude and anything else that speaks the
protocol.

```
npx manent init my-brain          # scaffold a vault
npx manent lint my-brain          # validate every note against the spec
npx manent serve my-brain         # serve it over MCP on stdio
npx manent eval my-brain          # measure retrieval quality on it
npx manent promote my-brain       # what agents wrote and is waiting for a person
```

Serving it over HTTP, per-agent identities and audiences, the write gate, the gap register and the
retrieval numbers are documented in the repository:
[github.com/colopisalvatore/manent](https://github.com/colopisalvatore/manent#readme).

Apache-2.0.
