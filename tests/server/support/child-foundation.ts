// Subprocess helper for foundation tests. Modes:
//   lock <dir> <name> <shared|exclusive> <hold|exit|kill> [barrier]
//     Take the lock, print "held", then: hold until the barrier file exists; exit without releasing; or wait
//     for the parent's SIGKILL. A busy lock prints "busy <code>".
//   server <log>
//     Run the stdio MCP server with a small synthetic app that records its cleanup to <log>.
import fs from "node:fs";
import type { App, AppOptions } from "../../../src/server/app";
import { runStdioServer } from "../../../src/server/entry";
import { existingDirectory } from "../../../src/server/fs-private";
import { Gate, gateResult } from "../../../src/server/gate";
import { lockNow } from "../../../src/server/lock";
import { monotonic } from "../../../src/server/time";

async function lockMode([directory, name, mode, ending, barrier]: string[]) {
  const dir = existingDirectory(directory);
  if (!dir) throw new Error("missing directory");
  try {
    lockNow(dir, name, mode === "exclusive");
  } catch (error) {
    process.stdout.write(`busy ${error instanceof Gate ? error.code : "error"}\n`);
    return;
  }
  process.stdout.write("held\n");
  if (ending === "exit") process.exit(0);
  if (ending === "kill") {
    setInterval(() => undefined, 1000);
    return;
  }
  while (!fs.existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 10));
}

function serverMode([log]: string[]) {
  const record = (line: string) => fs.appendFileSync(log, `${line}\n`);
  const app = ({ shutdown }: AppOptions): App => ({
    serverInfo: { name: "browser-control", version: "0.0.0-test" },
    instructions: "synthetic",
    listTools: () => [
      { name: "echo", inputSchema: { type: "object", properties: {} } },
      { name: "wait", inputSchema: { type: "object", properties: {} } }
    ],
    async callTool(name, args, meta) {
      if (name === "echo") return { content: [{ type: "text", text: JSON.stringify({ args, meta }) }] };
      if (name === "wait") {
        record("wait-started");
        await shutdown.wait(30000);
        record(`wait-ended shutdown=${shutdown.isSet}`);
        try {
          shutdown.refuseInput();
        } catch (error) {
          if (error instanceof Gate) return gateResult(name, error.code);
        }
        return { content: [{ type: "text", text: "waited" }] };
      }
      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    },
    async cleanup(deadline) {
      record(`cleanup remaining=${(deadline - monotonic()).toFixed(3)}`);
    }
  });
  void runStdioServer({ app });
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "lock") void lockMode(rest);
else if (mode === "server") serverMode(rest);
else process.exit(2);
