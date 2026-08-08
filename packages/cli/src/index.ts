#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import { formatFindings, lintVault } from "@manent/lint";
import { serveStdio } from "@manent/server";
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
  .description("serve the vault over MCP (stdio transport)")
  .argument("[dir]", "vault directory", ".")
  .action(async (dir: string) => {
    await serveStdio(resolve(dir));
  });

await program.parseAsync();
