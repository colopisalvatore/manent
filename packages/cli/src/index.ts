#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import { NOTE_STATUSES, type NoteStatus } from "@manent/spec";
import { formatFindings, lintVault } from "@manent/lint";
import { serveHttp, serveStdio, type GapsOptions } from "@manent/server";
import { initVault } from "./init.js";
import { RETRIEVERS, runEvalCommand } from "./eval.js";
import { runGapsCommand } from "./gaps.js";
import { runPromoteCommand } from "./promote.js";
import { runCurateCommand } from "./curate.js";

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
  .option("--strict-content", "treat personal data and model-directed text as errors (the CI gate)")
  .option("--audiences <labels>", "comma-separated audience labels the vault allows; others are reported")
  .action(async (dir: string, opts: { strictLinks?: boolean; strictContent?: boolean; audiences?: string }) => {
    const res = await lintVault(resolve(dir), {
      strictLinks: !!opts.strictLinks,
      strictContent: !!opts.strictContent,
      audiences: opts.audiences?.split(",").map((a) => a.trim()).filter(Boolean),
    });
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
  .option("--save <file>", "write the report as JSON (metrics only; safe to commit)")
  .option("--save-full", "include the per-query results in --save (they list every note's description-derived query)")
  .option("--baseline <file>", "fail if any metric dropped against this saved report")
  .action(
    async (
      dir: string,
      opts: { golden?: string; auto: boolean; retriever: string; model?: string; depth: string; worst: string; save?: string; saveFull?: boolean; baseline?: string },
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
        saveFull: !!opts.saveFull,
        baseline: opts.baseline,
      });
      if (code !== 0) process.exitCode = code;
    },
  );

/** The gap register is opt-in: a path, or the MANENT_GAPS environment variable. */
function gapsFrom(opts: { gaps?: string; gapsThreshold?: string }): GapsOptions | undefined {
  const path = opts.gaps ?? process.env.MANENT_GAPS;
  if (!path) return undefined;
  const threshold = opts.gapsThreshold !== undefined ? Number(opts.gapsThreshold) : undefined;
  if (threshold !== undefined && !(threshold > 0 && threshold <= 1)) {
    throw new Error(`--gaps-threshold must be a cosine similarity in (0, 1], got "${opts.gapsThreshold}"`);
  }
  return { path: resolve(path), threshold };
}

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
  .option("--writable", "enable the write tools (brain_write, brain_append) — off by default")
  .option("--gaps <path>", "record every search into a gap register (sqlite file outside the vault; or env MANENT_GAPS)")
  .option("--gaps-threshold <cosine>", "similarity above which two questions are the same gap (default 0.9)")
  .option("--agents <file>", "JSON of agent identities for --http: name → {token, read: [audiences], write: dir}")
  .option("--audit <path>", "append one JSONL line per tool call, with the calling identity")
  .option("--no-watch", "do not re-index when notes change on disk (on by default)")
  .action(
    async (
      dir: string,
      opts: {
        http?: string;
        host: string;
        token?: string;
        era: string;
        retriever: string;
        model?: string;
        writable?: boolean;
        gaps?: string;
        gapsThreshold?: string;
        agents?: string;
        audit?: string;
        watch: boolean;
      },
    ) => {
      const root = resolve(dir);
      const allowed = ["bm25", "hybrid", "dense", "fused"] as const;
      if (!allowed.includes(opts.retriever as (typeof allowed)[number])) {
        console.error(`--retriever must be one of: ${allowed.join(", ")}`);
        process.exitCode = 1;
        return;
      }
      const retriever = opts.retriever as (typeof allowed)[number];
      const writable = !!opts.writable;
      if (writable) {
        // Said out loud on purpose: an operator who did not mean this should see it.
        console.error(`[manent] WRITABLE — brain_write and brain_append can modify ${root}`);
      }
      const gaps = gapsFrom(opts);
      if (gaps) console.error(`[manent] gap register: ${gaps.path}`);
      const audit = opts.audit ? resolve(opts.audit) : undefined;
      if (audit) console.error(`[manent] audit log: ${audit}`);

      if (!opts.http) {
        if (opts.agents) console.error("[manent] --agents applies to --http only: stdio is the owner's own session");
        const ctx = await serveStdio(root, { retriever, model: opts.model, writable, gaps, audit, watch: opts.watch });
        for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void ctx.close().finally(() => process.exit(0)));
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
        writable,
        gaps,
        agents: opts.agents ? resolve(opts.agents) : undefined,
        audit,
        watch: opts.watch,
      });
    },
  );

program
  .command("gaps")
  .description("the gap register: questions the brain could not answer, by frequency; close one with the note that answers it")
  .argument("[dir]", "vault directory", ".")
  .requiredOption("--gaps <path>", "sqlite file of the register (or env MANENT_GAPS)", process.env.MANENT_GAPS)
  .option("--status <s>", "open (default) | closed | dismissed | all", "open")
  .option("--limit <n>", "rows to show", "50")
  .option("--json", "machine-readable output")
  .option("--show <id>", "the searches behind one gap")
  .option("--close <id>", "close a gap with the note that answers it (needs --note)")
  .option("--note <name>", "canonical name of the answering note")
  .option("--golden <file>", "also append the closing entry to this golden-set file")
  .option("--dismiss <id>", "close a gap without a note (not a real question, or out of scope)")
  .option("--feedback", "list feedback left by agents (brain_feedback)")
  .action(
    async (
      dir: string,
      opts: {
        gaps: string;
        status: string;
        limit: string;
        json?: boolean;
        show?: string;
        close?: string;
        note?: string;
        golden?: string;
        dismiss?: string;
        feedback?: boolean;
      },
    ) => {
      if (!["open", "closed", "dismissed", "all"].includes(opts.status)) {
        console.error(`--status must be open, closed, dismissed or all (got "${opts.status}")`);
        process.exitCode = 1;
        return;
      }
      const code = await runGapsCommand(resolve(dir), {
        db: resolve(opts.gaps),
        status: opts.status as "open" | "closed" | "dismissed" | "all",
        limit: Number(opts.limit),
        json: !!opts.json,
        show: opts.show,
        close: opts.close,
        note: opts.note,
        golden: opts.golden,
        dismiss: opts.dismiss,
        feedback: !!opts.feedback,
      });
      if (code !== 0) process.exitCode = code;
    },
  );

program
  .command("promote")
  .description("the review queue of quarantined notes, and the one move that takes a note out: status, audience, folder, commit message")
  .argument("[dir]", "vault directory", ".")
  .option("--note <name>", "the note to promote; without it, the queue is printed")
  .option("--author <agent>", "queue filter: only what this identity wrote")
  .option("--status <s>", "status the note takes (default active)", "active")
  .option("--audience <labels>", "comma-separated audience labels the note takes; unset keeps the ones it has")
  .option("--to <dir>", "vault-relative directory to move the note to (out of quarantine/)")
  .option("--dry-run", "work out the move and the message, touch nothing")
  .option("--commit", "stage the note and commit it in the vault repository")
  .option("--limit <n>", "queue rows to show")
  .option("--json", "machine-readable output")
  .action(
    async (
      dir: string,
      opts: {
        note?: string;
        author?: string;
        status: string;
        audience?: string;
        to?: string;
        dryRun?: boolean;
        commit?: boolean;
        limit?: string;
        json?: boolean;
      },
    ) => {
      if (!NOTE_STATUSES.includes(opts.status as NoteStatus)) {
        console.error(`--status must be one of: ${NOTE_STATUSES.join(", ")}`);
        process.exitCode = 1;
        return;
      }
      const code = await runPromoteCommand(resolve(dir), {
        note: opts.note,
        author: opts.author,
        status: opts.status as NoteStatus,
        audience: opts.audience,
        to: opts.to,
        dryRun: !!opts.dryRun,
        commit: !!opts.commit,
        limit: opts.limit !== undefined ? Number(opts.limit) : undefined,
        json: !!opts.json,
      });
      if (code !== 0) process.exitCode = code;
    },
  );

program
  .command("curate")
  .description("what the vault has accumulated: near-duplicate notes and declared contradictions, reported for a person to decide")
  .argument("[dir]", "vault directory", ".")
  .option("--duplicates", "only the near-duplicate report")
  .option("--contradictions", "only the contradiction report")
  .option("--dense", "compare notes by meaning (needs the embedding model) instead of by shared words")
  .option("--model <id>", "embedding model for --dense")
  .option("--threshold <n>", "similarity at or above which a pair is reported (dense 0.94, lexical 0.35)")
  .option("--include-related", "also report pairs that already link to or supersede each other")
  .option("--limit <n>", "pairs to show")
  .option("--json", "machine-readable output")
  .action(
    async (
      dir: string,
      opts: {
        duplicates?: boolean;
        contradictions?: boolean;
        dense?: boolean;
        model?: string;
        threshold?: string;
        includeRelated?: boolean;
        limit?: string;
        json?: boolean;
      },
    ) => {
      const threshold = opts.threshold !== undefined ? Number(opts.threshold) : undefined;
      if (threshold !== undefined && !(threshold > 0 && threshold <= 1)) {
        console.error(`--threshold must be a similarity in (0, 1], got "${opts.threshold}"`);
        process.exitCode = 1;
        return;
      }
      const code = await runCurateCommand(resolve(dir), {
        duplicates: !!opts.duplicates,
        contradictions: !!opts.contradictions,
        dense: !!opts.dense,
        model: opts.model,
        threshold,
        includeRelated: !!opts.includeRelated,
        limit: opts.limit !== undefined ? Number(opts.limit) : undefined,
        json: !!opts.json,
      });
      if (code !== 0) process.exitCode = code;
    },
  );

await program.parseAsync();
