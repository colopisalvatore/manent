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
  .action(async (dir: string, opts: { http?: string; host: string; token?: string }) => {
    const root = resolve(dir);
    if (!opts.http) {
      await serveStdio(root);
      return;
    }
    const token = opts.token ?? process.env.MANENT_HTTP_TOKEN ?? "";
    const port = Number(opts.http);
    await serveHttp(root, { port, host: opts.host, token });
    console.log(`manent MCP endpoint: http://${opts.host}:${port}/mcp (bearer auth required)`);
  });

await program.parseAsync();
