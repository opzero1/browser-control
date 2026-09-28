// A minimal newline-delimited JSON-RPC client for MCP over stdio (the port of test_native_stdio.Stdio).
import type { Readable, Writable } from "node:stream";

export const PROTOCOL_VERSION = "2025-06-18";

type Message = { jsonrpc: "2.0"; id?: number; method?: string; result?: unknown; error?: { code: number; message: string } };

export class McpStdio {
  private next = 0;
  private buffer = "";
  private readonly pending = new Map<number, (message: Message | Error) => void>();
  readonly notifications: Message[] = [];
  private closed = false;

  constructor(private readonly input: Writable, output: Readable) {
    output.setEncoding("utf8");
    const close = () => {
      this.closed = true;
      for (const resolve of this.pending.values()) resolve(new Error("server output closed"));
      this.pending.clear();
    };
    output.on("end", close);
    output.on("close", close);
    output.on("data", (chunk: string) => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as Message;
        const resolve = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
        if (resolve) {
          this.pending.delete(message.id as number);
          resolve(message);
        } else {
          this.notifications.push(message);
        }
      }
    });
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<Message> {
    const id = ++this.next;
    if (this.closed) return Promise.reject(new Error("server output closed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no response to ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message instanceof Error) reject(message);
        else resolve(message);
      });
      this.input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.input.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize(): Promise<Message> {
    const response = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "browser-control-tests", version: "0" }
    });
    this.notify("notifications/initialized");
    return response;
  }

  /** tools/call with optional _meta; returns the CallToolResult. */
  async call(name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    const response = await this.request("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) }, timeoutMs);
    if (response.error) throw new Error(`tools/call failed: ${response.error.message}`);
    return response.result as Record<string, unknown>;
  }

  /** Send without waiting, for a call whose response may never come. */
  send(name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>): Promise<Message> {
    return this.request("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) }, 60000).catch(() => ({ jsonrpc: "2.0" as const }));
  }
}
