# Paper

*Manent: File-First, Git-Versioned Memory for AI Agents. Specification, evaluation harness, and
retrieval ablations on atomic notes.* Preprint, September 2026.

- `manent-paper.html` — the source. A single HTML file with print CSS; no TeX toolchain needed.
- `manent-paper.pdf` — rendered with headless Chrome:

  ```
  chrome --headless=new --disable-gpu --no-pdf-header-footer \
    --print-to-pdf=paper/manent-paper.pdf file:///<repo>/paper/manent-paper.html
  ```

- `results/` — the raw outputs every table in the paper was transcribed from, dated.

## Reproducing the numbers

The corpus is a private vault (479 Markdown notes, Italian, personal and work knowledge) and is
not distributed. The queries asked of it are in `eval/golden-aios.json`, with the notes they expect
**named by hash** (`note:<sha256 truncated>`): publishing an index of a private archive would say
more about the vault than the measurement needs. The aliases resolve against the vault that holds
those notes and nowhere else, so the run and its miss list read normally there.

`paper/results/` holds the raw outputs the tables were transcribed from, except Table 2's: that run
was not captured (the file kept in its place was the trace of a failed invocation and has been
removed). The command is listed below and reproduces it.

Every script
takes a vault path and a golden set path, so the same measurements run on any spec-conforming
vault:

```
node packages/cli/dist/index.js eval <vault> --golden <golden.json> --retriever all --save out.json
node scripts/bm25-naive-baseline.mjs <vault> <golden.json>     # tokenization ablation
node scripts/tune-fusion.mjs <vault> <golden.json>             # lexical/dense balance
node scripts/tune-retrieval.mjs <vault> <golden.json>          # graph expansion grid
node scripts/tune-chunking.mjs <vault> <golden.json>           # passage size, prefix, aggregation
```

Dense retrieval needs the optional dependency (`npm install @huggingface/transformers`); the
model is `Xenova/multilingual-e5-small`, quantized q8, run locally on CPU.

The gap-register similarity threshold (§7) was measured with `scripts/gaps-threshold.mjs`.
