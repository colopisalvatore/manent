#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import { formatFindings, lintVault } from "@manent/lint";
import { serveHttp, serveStdio } from "@manent/server";
import { initVault } from "./init.js";

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
  .action(async (dir: string, opts: { http?: string; host: string; token?: string; era: string }) => {
    const root = resolve(dir);
    if (!opts.http) {
      await serveStdio(root);
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
    });
  });

await program.parseAsync();
