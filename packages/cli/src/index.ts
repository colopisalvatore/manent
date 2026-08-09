#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import { formatFindings, lintVault } from "@manent/lint";
import { serveHttp, serveStdio } from "@manent/server";
import { initVault } from "./init.js";
import { RETRIEVERS, runEvalCommand } from "./eval.js";

const program = new Command();

program
  .name("manent")
  .description("Manent — verba volant, scripta manent. File-first, git-versioned memory for AI agents")
  .version("0.0.1");

program
  .command("init")
  .description("scaffold a new vault (never overwrites existing files)")
  .argument("[dir]", "vault directory", ".")
  .action(async (dir: string) => {
    const root = resolve(dir);
    const created = await initVault(root);
    console.log(`vault ready at ${root}`);
    for (const f of created) console.log(`  + ${f}`);
  });

program
  .command("lint")
  .description("validate every note against the spec (schema, links, structure)")
  .argument("[dir]", "vault directory", ".")
  .option("--strict-links", "treat unresolved wikilinks as errors")
  .action(async (dir: string, opts: { strictLinks?: boolean }) => {
    const res = await lintVault(resolve(dir), { strictLinks: !!opts.strictLinks });
    console.log(formatFindings(res));
    if (res.errors > 0) process.exitCode = 1;
  });

program
  .command("eval")
  .description("measure retrieval quality on a vault (recall@k, MRR, nDCG) and gate regressions")
  .argument("[dir]", "vault directory", ".")
  .option("--golden <file>", "curated golden set (JSON)")
  .option("--no-auto", "skip queries auto-derived from note descriptions")
  .option("--retriever <name>", "bm25 | hybrid | dense | fused | both | all", "both")
  .option("--model <id>", "embedding model for dense/fused (default: multilingual-e5-small)")
  .option("--depth <n>", "how many results to score", "10")
  .option("--worst <n>", "list up to N misses", "5")
  .option("--save <file>", "write the report as JSON")
  .option("--baseline <file>", "fail if any metric dropped against this saved report")
  .action(
    async (
      dir: string,
      opts: { golden?: string; auto: boolean; retriever: string; model?: string; depth: string; worst: string; save?: string; baseline?: string },
    ) => {
      if (!RETRIEVERS.includes(opts.retriever as (typeof RETRIEVERS)[number])) {
        console.error(`--retriever must be one of: ${RETRIEVERS.join(", ")}`);
        process.exitCode = 1;
        return;
      }
      const code = await runEvalCommand(resolve(dir), {
        golden: opts.golden,
        auto: opts.auto,
        retriever: opts.retriever,
        model: opts.model,
        depth: Number(opts.depth),
        worst: Number(opts.worst),
        save: opts.save,
        baseline: opts.baseline,
      });
      if (code !== 0) process.exitCode = code;
    },
  );

program
  .command("serve")
  .description("serve the vault over MCP — stdio by default, Streamable HTTP with --http")
  .argument("[dir]", "vault directory", ".")
  .option("--http <port>", "serve Streamable HTTP on this port instead of stdio")
  .option("--host <host>", "bind address for --http", "127.0.0.1")
  .option("--token <token>", "bearer token for --http (or env MANENT_HTTP_TOKEN)")
  .option(
    "--era <era>",
    "protocol era for --http: auto | legacy (handshake revisions) | modern (2026-07-28)",
    "auto",
  )
  .option("--retriever <name>", "ranking: bm25 (default) | fused (best, needs embedding model) | dense | hybrid", "bm25")
  .option("--model <id>", "embedding model for dense/fused")
  .action(
    async (
      dir: string,
      opts: { http?: string; host: string; token?: string; era: string; retriever: string; model?: string },
    ) => {
    const root = resolve(dir);
    const allowed = ["bm25", "hybrid", "dense", "fused"] as const;
    if (!allowed.includes(opts.retriever as (typeof allowed)[number])) {
      console.error(`--retriever must be one of: ${allowed.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    const retriever = opts.retriever as (typeof allowed)[number];
    if (!opts.http) {
      await serveStdio(root, retriever, opts.model);
      return;
    }
    if (!["auto", "legacy", "modern"].includes(opts.era)) {
      console.error(`--era must be auto, legacy or modern (got "${opts.era}")`);
      process.exitCode = 1;
      return;
    }
      const token = opts.token ?? process.env.MANENT_HTTP_TOKEN ?? "";
      await serveHttp(root, {
        port: Number(opts.http),
        host: opts.host,
        token,
        era: opts.era as "auto" | "legacy" | "modern",
        retriever,
        model: opts.model,
      });
    },
  );

await program.parseAsync();
