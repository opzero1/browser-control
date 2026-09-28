// Newline-delimited JSON-RPC over stdio, like the SDK's StdioServerTransport, except that tools/call
// arguments keep integral float literals (100.0) as PyFloat. Python's JSON parser keeps them floats, which the
// strict int fields refuse; JSON.parse alone would make them ints. Unlike the SDK's ReadBuffer, a line has no
// size bound, as Python's stdin reader has none: only EOF, a read error or SIGTERM ends the input.
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { PyFloat, reviveFloats } from "./args";

function isDict(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function plain(value: unknown): unknown {
  if (value instanceof PyFloat) return value.value;
  if (Array.isArray(value)) return value.map(plain);
  if (isDict(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(result, key, { value: plain(item), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  return value;
}

/** Parse one message; only tools/call arguments keep their PyFloat markers. */
export function deserializeMessage(line: string): JSONRPCMessage {
  const raw = JSON.parse(line, reviveFloats as (key: string, value: unknown) => unknown) as unknown;
  const params = isDict(raw) && raw.method === "tools/call" && isDict(raw.params) ? raw.params : null;
  const args = params !== null && isDict(params.arguments) ? params.arguments : undefined;
  const message = plain(raw) as Record<string, unknown>;
  if (args !== undefined) (message.params as Record<string, unknown>).arguments = args;
  return JSONRPCMessageSchema.parse(message);
}

export class StdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /** The pieces of the current line; newlines are searched only in new data. */
  private pending: Buffer[] = [];
  private started = false;
  private closed = false;

  constructor(private readonly stdin: NodeJS.ReadableStream, private readonly stdout: NodeJS.WritableStream) {}

  private readonly onData = (chunk: Buffer | string) => {
    let data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    let index = data.indexOf(0x0a);
    while (index >= 0 && !this.closed) {
      const line = Buffer.concat([...this.pending, data.subarray(0, index)]);
      this.pending = [];
      data = data.subarray(index + 1);
      try {
        this.onmessage?.(deserializeMessage(line.toString("utf8").replace(/\r$/, "")));
      } catch (error) {
        this.onerror?.(error as Error);
      }
      index = data.indexOf(0x0a);
    }
    if (data.length && !this.closed) this.pending.push(data);
  };

  private readonly onError = (error: Error) => {
    this.onerror?.(error);
  };

  /** A stdin read error ends the input like EOF: the transport closes, and its owner starts the shutdown. */
  private readonly onReadError = (error: Error) => {
    this.onerror?.(error);
    void this.close();
  };

  async start(): Promise<void> {
    if (this.started) throw new Error("StdioTransport already started");
    this.started = true;
    this.stdin.on("data", this.onData);
    this.stdin.on("error", this.onReadError);
    // A client that closed its end makes late writes fail with EPIPE; that must not crash the shutdown.
    this.stdout.on("error", this.onError);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stdin.off("data", this.onData);
    this.stdin.off("error", this.onReadError);
    // A later read error has nowhere to go but must not become an uncaught exception.
    this.stdin.on("error", () => undefined);
    if (this.stdin.listenerCount("data") === 0) this.stdin.pause();
    this.pending = [];
    this.onclose?.();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve) => {
      const stream = this.stdout as NodeJS.WritableStream & { destroyed?: boolean; writable?: boolean };
      if (stream.destroyed || stream.writable === false) return resolve();
      if (stream.write(`${JSON.stringify(message)}\n`)) resolve();
      else stream.once("drain", resolve);
    });
  }
}
