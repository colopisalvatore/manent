# Contributing

Pre-1.0: the spec (`packages/spec/SPEC.md`) is the contract. Changes to note types, frontmatter fields or edge kinds require a spec PR first — code follows spec, never the reverse.

- `npm install && npm run build && npm run smoke` must pass.
- One change per PR. Lint rules need a fixture note demonstrating the violation.
- Derived data (indexes, embeddings, graphs) must always be rebuildable from the Markdown files alone. PRs that make derived state authoritative will be rejected — this is the project's core invariant.
