// Newline-delimited JSON-RPC over stdio, like the SDK's StdioServerTransport, except that tools/call
// arguments keep integral float literals (100.0) as PyFloat. Python's JSON parser keeps them floats, which the
// strict int fields refuse; JSON.parse alone would make them ints.
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { PyFloat, reviveFloats } from "./args";

const MAX_BUFFER = 10 * 1024 * 1024;

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
  private buffer: Buffer | undefined;
  private started = false;

  constructor(private readonly stdin: NodeJS.ReadableStream, private readonly stdout: NodeJS.WritableStream) {}

  private readonly onData = (chunk: Buffer | string) => {
    const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if ((this.buffer?.length ?? 0) + data.length > MAX_BUFFER) {
      this.buffer = undefined;
      this.onerror?.(new Error(`ReadBuffer exceeded maximum size of ${MAX_BUFFER} bytes`));
      void this.close();
      return;
    }
    this.buffer = this.buffer ? Buffer.concat([this.buffer, data]) : data;
    while (this.buffer) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      const line = this.buffer.toString("utf8", 0, index).replace(/\r$/, "");
      this.buffer = this.buffer.subarray(index + 1);
      try {
        this.onmessage?.(deserializeMessage(line));
      } catch (error) {
        this.onerror?.(error as Error);
      }
    }
  };

  private readonly onError = (error: Error) => {
    this.onerror?.(error);
  };

  async start(): Promise<void> {
    if (this.started) throw new Error("StdioTransport already started");
    this.started = true;
    this.stdin.on("data", this.onData);
    this.stdin.on("error", this.onError);
    // A client that closed its end makes late writes fail with EPIPE; that must not crash the shutdown.
    this.stdout.on("error", this.onError);
  }

  async close(): Promise<void> {
    this.stdin.off("data", this.onData);
    this.stdin.off("error", this.onError);
    if (this.stdin.listenerCount("data") === 0) this.stdin.pause();
    this.buffer = undefined;
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
