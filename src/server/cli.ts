// bin entry: `browser-control <mcp|install|doctor|config|pool|--version>`.
import { packageAssets } from "./assets";
import { runConfig } from "./commands/config";
import { runDoctor } from "./commands/doctor";
import { runInstall } from "./commands/install";
import type { CommandIo } from "./commands/shared";
import { runStdioServer } from "./entry";
import { runPoolCommand } from "./pool/operator";

const USAGE = `usage: browser-control <command>

  mcp       Run the MCP server over stdio (npx -y @op1/browser-control mcp).
  install   Set up the native host, Chrome manifest, clipboard guard and skills.
            [--state-dir <dir>] [--chrome-manifest-dir <dir>] [--skills-dir <dir>]... [--dry-run] [--force] [--json]
  doctor    Check that setup without changing it. [--smoke] [--json] and the install directory options.
  config    Print the MCP configuration for opencode, claude, codex or cursor. [--state-dir <dir>]
  pool      Operate isolated browsers: status, claim, ensure, release, reap, reset.
  --version Print the package version.
`;

async function main(argv: readonly string[], io: CommandIo = { stdout: process.stdout, stderr: process.stderr, env: process.env }): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "mcp":
      if (rest.length) break;
      return runStdioServer();
    case "install":
      return runInstall(rest, io);
    case "doctor":
      return runDoctor(rest, io);
    case "config":
      return runConfig(rest, io);
    case "pool":
      return runPoolCommand(rest, { stdout: io.stdout, env: io.env });
    case "--version":
      io.stdout.write(`${packageAssets().version}\n`);
      return 0;
    case "--help":
    case "help":
      io.stdout.write(USAGE);
      return 0;
  }
  io.stderr.write(USAGE);
  return 2;
}

main(process.argv.slice(2)).then((code) => {
  if (code !== 0) process.exitCode = code;
}, (error: unknown) => {
  process.stderr.write(`browser-control: ${error instanceof Error ? error.name : "error"}\n`);
  process.exitCode = 1;
});
