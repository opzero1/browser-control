// bin entry. Foundation ships `mcp`, `pool` and `--version`; the packaging slice owns this file and adds
// install, doctor and config.
import { packageAssets } from "./assets";
import { runStdioServer } from "./entry";
import { runPoolCommand } from "./pool/operator";

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "mcp") return runStdioServer();
  if (command === "pool") return runPoolCommand(rest);
  if (command === "--version") {
    process.stdout.write(`${packageAssets().version}\n`);
    return 0;
  }
  process.stderr.write("usage: browser-control <mcp|pool|--version>\n");
  return 2;
}

main(process.argv.slice(2)).then((code) => {
  if (code !== 0) process.exitCode = code;
}, () => {
  process.exitCode = 1;
});
