// The stdio MCP server. Stdin EOF (or close) and SIGTERM start one bounded shutdown (design 4.8).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Readable, Writable } from "node:stream";
import { createApp, type App, type AppOptions } from "./app";
import type { Env } from "./config";
import { gateResult, isGate } from "./gate";
import { trustedEnv, UnsafeRoot } from "./roots";
import { SHUTDOWN_SECONDS, Shutdown } from "./runtime/shutdown";
import { StdioTransport } from "./stdio-transport";

/** Extra time after the cleanup deadline before the backstop forces exit. */
const BACKSTOP_SECONDS = 0.3;

export interface StdioServerOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
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

/** The MCP server for an app: tools only, with the app's instructions and request _meta passed through. */
export function mcpServer(app: App, shutdown: Shutdown): Server {
  const server = new Server(app.serverInfo, { capabilities: { tools: { listChanged: false } }, instructions: app.instructions });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: app.listTools() }));
  // extra.signal is ignored: a running body is never aborted, so its tab stays busy until it settles.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (shutdown.isSet) return gateResult(request.params.name, "fast-chrome-shutting-down");
    return app.callTool(request.params.name, request.params.arguments ?? {}, request.params._meta);
  });
  return server;
}

/**
 * The environment the app runs with: the state root, the artifact root and the host socket by canonical path
 * (roots.ts), or null once a refusal naming the root at fault was written to `stderr`.
 */
function startupEnv(env: Env, stderr: NodeJS.WritableStream): Env | null {
  try {
    return trustedEnv(env, { artifacts: true });
  } catch (error) {
    if (!(error instanceof UnsafeRoot) && !isGate(error)) throw error;
    stderr.write(`browser-control mcp: ${error instanceof UnsafeRoot ? error.message : error.code}\n`);
    return null;
  }
}

/**
 * Serve MCP over stdio until EOF or SIGTERM, then clean up within the shutdown bound and exit 0. A root that
 * fails the trusted-path rule refuses the start: nothing is served and the exit status is 1.
 */
export async function runStdioServer(options: StdioServerOptions = {}): Promise<number> {
  const stdin: NodeJS.ReadableStream = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const env = startupEnv(options.env ?? process.env, options.stderr ?? process.stderr);
  if (env === null) {
    exit(1);
    return 1;
  }
  const shutdown = new Shutdown(options.shutdownSeconds ?? SHUTDOWN_SECONDS);
  const app = (options.app ?? createApp)({ env, shutdown });

  const server = mcpServer(app, shutdown);
  const transport = new StdioTransport(stdin, stdout);

  return new Promise<number>((resolve) => {
    let finishing = false;
    const signals = options.installSignalHandlers ?? true;
    // Both stay registered until exit: the parent's SIGTERM usually follows EOF during cleanup, and Node's
    // default action would kill the process before cleanup ends. A second trigger is a no-op.
    const onSignal = () => shutdown.begin();
    const onEnd = () => shutdown.begin();
    const detach = () => {
      stdin.removeListener("end", onEnd);
      stdin.removeListener("close", onEnd);
      if (signals) process.removeListener("SIGTERM", onSignal);
    };
    const finish = async () => {
      if (finishing) return;
      finishing = true;
      const deadline = shutdown.deadline as number;
      const backstop = setTimeout(() => exit(0), (shutdown.seconds + BACKSTOP_SECONDS) * 1000);
      // Stop reading stdin; running bodies still settle and cleanup waits for them up to the deadline.
      await transport.close().catch(() => undefined);
      try {
        await app.cleanup(deadline);
      } catch {
        // Cleanup is best-effort within the bound; unconfirmed tabs keep their markers.
      }
      await flush(stdout);
      clearTimeout(backstop);
      detach();
      resolve(0);
      exit(0);
    };
    shutdown.onBegin(() => { void finish(); });
    stdin.on("end", onEnd);
    stdin.on("close", onEnd);
    if (signals) process.on("SIGTERM", onSignal);
    // A transport that closes for any other reason (a stdin read error) ends through the same bounded path,
    // as Python's server leaves through its lifespan cleanup however the stdio loop ends.
    server.onclose = () => shutdown.begin();
    server.connect(transport).catch(() => shutdown.begin());
  });
}
