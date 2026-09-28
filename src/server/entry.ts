// The stdio MCP server. Stdin EOF (or close) and SIGTERM start one bounded shutdown (design 4.8).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Readable, Writable } from "node:stream";
import { createApp, type App, type AppOptions } from "./app";
import type { Env } from "./config";
import { gateResult } from "./gate";
import { SHUTDOWN_SECONDS, Shutdown } from "./runtime/shutdown";

/** Extra time after the cleanup deadline before the backstop forces exit. */
const BACKSTOP_SECONDS = 0.3;

export interface StdioServerOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  env?: Env;
  shutdownSeconds?: number;
  installSignalHandlers?: boolean;
  exit?: (code: number) => void;
  app?: (options: AppOptions) => App;
}

function flush(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => {
    const writable = stream as Writable;
    if (writable.writableLength === 0 || writable.destroyed) return resolve();
    const timer = setTimeout(resolve, 200);
    writable.write("", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Serve MCP over stdio until EOF or SIGTERM, then clean up within the shutdown bound and exit 0. */
export async function runStdioServer(options: StdioServerOptions = {}): Promise<number> {
  const stdin: NodeJS.ReadableStream = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const shutdown = new Shutdown(options.shutdownSeconds ?? SHUTDOWN_SECONDS);
  const app = (options.app ?? createApp)({ env, shutdown });

  const server = new Server(app.serverInfo, { capabilities: { tools: { listChanged: false } }, instructions: app.instructions });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: app.listTools() }));
  // extra.signal is ignored: a running body is never aborted, so its tab stays busy until it settles.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (shutdown.isSet) return gateResult(request.params.name, "fast-chrome-shutting-down");
    return app.callTool(request.params.name, request.params.arguments ?? {}, request.params._meta);
  });
  const transport = new StdioServerTransport(stdin as Readable, stdout as Writable);

  return new Promise<number>((resolve) => {
    let finishing = false;
    const onSignal = () => shutdown.begin();
    const onEnd = () => shutdown.begin();
    const finish = async () => {
      if (finishing) return;
      finishing = true;
      const deadline = shutdown.deadline as number;
      const backstop = setTimeout(() => exit(0), (shutdown.seconds + BACKSTOP_SECONDS) * 1000);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("close", onEnd);
      if (options.installSignalHandlers ?? true) process.removeListener("SIGTERM", onSignal);
      // Stop reading stdin; running bodies still settle and cleanup waits for them up to the deadline.
      await transport.close().catch(() => undefined);
      try {
        await app.cleanup(deadline);
      } catch {
        // Cleanup is best-effort within the bound; unconfirmed tabs keep their markers.
      }
      await flush(stdout);
      clearTimeout(backstop);
      resolve(0);
      exit(0);
    };
    shutdown.onBegin(() => { void finish(); });
    stdin.on("end", onEnd);
    stdin.on("close", onEnd);
    if (options.installSignalHandlers ?? true) process.on("SIGTERM", onSignal);
    server.connect(transport).catch(() => shutdown.begin());
  });
}
