// A fake native host on a real private Unix socket: the port of test_opchrome.Host.
import fs from "node:fs";
import net from "node:net";

export type Request = { jsonrpc: string; id: number; method: string; params: Record<string, unknown> };
export type Handler = (socket: net.Socket, request: Request, authority: string) => void | Promise<void>;

export function send(socket: net.Socket, message: unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

export function result(socket: net.Socket, request: Request, value: unknown): void {
  send(socket, { jsonrpc: "2.0", id: request.id, result: value });
}

export interface FakeHostOptions {
  handler?: Handler;
  hostInfo?: unknown;
  extensionInfo?: unknown;
}

export class FakeHost {
  readonly requests: Array<[string, Request]> = [];
  readonly connections: net.Socket[] = [];
  readonly errors: unknown[] = [];
  /** Request lines received so far, counted as they arrive (before any handler runs). */
  lines = 0;
  private readonly server: net.Server;
  private readonly handler: Handler;

  private constructor(readonly path: string, private readonly options: FakeHostOptions) {
    this.handler = options.handler ?? ((socket, request, authority) => result(socket, request, authority));
    this.server = net.createServer((socket) => this.serve(socket));
  }

  static async start(file: string, options: FakeHostOptions = {}): Promise<FakeHost> {
    const host = new FakeHost(file, options);
    await new Promise<void>((resolve, reject) => {
      host.server.once("error", reject);
      host.server.listen(file, () => resolve());
    });
    fs.chmodSync(file, 0o600);
    return host;
  }

  private serve(socket: net.Socket) {
    const authority = `host-session-${this.connections.length + 1}`;
    this.connections.push(socket);
    let buffer = Buffer.alloc(0);
    let queue = Promise.resolve();
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let end: number;
      while ((end = buffer.indexOf(0x0a)) >= 0) {
        const line = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 1);
        this.lines += 1;
        queue = queue.then(() => this.dispatch(socket, line, authority)).catch((error) => { this.errors.push(error); });
      }
    });
  }

  private async dispatch(socket: net.Socket, line: string, authority: string) {
    const request = JSON.parse(line) as Request;
    this.requests.push([authority, request]);
    if (request.method === "host.info") {
      result(socket, request, this.options.hostInfo !== undefined ? this.options.hostInfo
        : { protocolVersion: 2, extensionProtocol: "ready", session_id: authority });
    } else if (request.method === "getInfo") {
      result(socket, request, this.options.extensionInfo !== undefined ? this.options.extensionInfo
        : { protocolVersion: 2, pageProtocolVersion: 2 });
    } else {
      await this.handler(socket, request, authority);
    }
  }

  async close(): Promise<void> {
    for (const socket of this.connections) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (this.errors.length) throw this.errors[0];
  }
}
