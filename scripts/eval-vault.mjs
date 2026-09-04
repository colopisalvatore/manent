// Runs `manent eval` on the vault named by MANENT_VAULT, so package.json
// scripts carry no local path. Everything after the script name is passed
// through to the CLI.
//
//   MANENT_VAULT=/path/to/vault npm run eval:gate
import { spawnSync } from "node:child_process";

const vault = process.env.MANENT_VAULT;
if (!vault) {
  console.error("set MANENT_VAULT to the vault directory, e.g. MANENT_VAULT=./my-vault npm run eval");
  process.exit(2);
}
const r = spawnSync(process.execPath, ["packages/cli/dist/index.js", "eval", vault, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
