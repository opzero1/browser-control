// Bounded, non-replaying JSON-RPC client for the private native-host socket (a port of opchrome.py).
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Gate } from "./gate";
import { isPyInt, parseStrictJson, pyDumps, type JsonObject } from "./pyjson";
import { AsyncMutex } from "./runtime/mutex";
import { monotonic } from "./time";

export const REQUEST_LIMIT = 1048576;
export const RESPONSE_LIMIT = 67108864;
export const DEFAULT_TIMEOUT_SECONDS = 35;
/** The setTimeout limit, in place of threading.TIMEOUT_MAX (D12). */
const TIMEOUT_MAX_SECONDS = 2147483.647;
const READ_CHUNK = 65536;
/** Python's recursion limit bounds _valid; a fixed nesting bound stands in for it. */
const MAX_PARAMS_DEPTH = 480;

export type HostMethod = "host.info" | "getInfo" | "getTabs" | "getUserTabs" | "createTab" | "claimUserTab" | "attach" | "bindPage" | "navigatePage" | "observePage" | "actPage" | "uploadFile" | "capturePage" | "recordingState" | "finalizeTabs" | "nameSession" | "observeDocument" | "privateFill" | "preparePrivateSubmit" | "submitPrivate";

export const METHODS: ReadonlySet<string> = new Set<HostMethod>([
  "host.info", "getInfo", "getTabs", "getUserTabs", "createTab",
  "claimUserTab", "attach", "bindPage", "navigatePage", "observePage",
  "actPage", "uploadFile", "capturePage", "recordingState", "finalizeTabs",
  "nameSession",
  "observeDocument", "privateFill", "preparePrivateSubmit", "submitPrivate"
]);
export const AUTHORITY_KEYS: ReadonlySet<string> = new Set(["session_id", "sessionId", "turn_id", "turnId"]);

const REFUSAL_REASONS: Readonly<Record<string, string>> = {
  "private-quarantine": "browser-control-private-quarantine",
  "populated-private-input": "browser-control-populated-private-input",
  "restored-private-selector": "browser-control-restored-private-selector",
  "embedded-surface": "browser-control-embedded-surface",
  "invalid-private-selectors": "browser-control-invalid-private-selectors",
  "unsupported-shadow-root": "browser-control-unsupported-shadow-root",
  "Legacy private document quarantine requires a new tab": "browser-control-private-quarantine"
};

export interface HostConnection {
  readonly alive: boolean;
  call(method: string, params?: JsonObject | null): Promise<unknown>;
  close(): void;
}

export type Connect = (socketPath: string, timeoutSeconds?: number) => Promise<HostConnection>;

/** Test hooks that stand in for monkeypatching module constants. */
export interface ConnectionOptions { responseLimit?: number }

class Invalid extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function has(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** _valid: JSON-safe params with string keys, no caller authority keys, and finite numbers only. */
function valid(value: unknown, depth = 0): boolean {
  if (depth > MAX_PARAMS_DEPTH) return false;
  if (Array.isArray(value)) return value.every((item) => item !== undefined && valid(item, depth + 1));
  if (typeof value === "object" && value !== null) {
    if (!isRecord(value) || Object.getOwnPropertySymbols(value).length) return false;
    return Object.entries(value).every(([key, item]) => item === undefined || (!AUTHORITY_KEYS.has(key) && valid(item, depth + 1)));
  }
  return value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

export class Connection implements HostConnection {
  private socket: net.Socket | null = null;
  private readonly mutex = new AsyncMutex();
  private next = 0;
  /** Received bytes not yet consumed, as chunks; `newline` is the offset of the first newline or -1. */
  private chunks: Buffer[] = [];
  private buffered = 0;
  private newline = -1;
  private readonly timeout: number;
  private readonly responseLimit: number;
  /** The pending read of the call in progress; socket events settle it. */
  private waiter: { wake: () => void } | null = null;
  private failure: Error | null = null;
  private ended = false;

  private constructor(timeout: number, options: ConnectionOptions) {
    this.timeout = timeout;
    this.responseLimit = options.responseLimit ?? RESPONSE_LIMIT;
  }

  /** Connect, check the endpoint's ownership, and complete the protocol-2 handshake. */
  static async open(socketPath: string, timeoutSeconds: number = DEFAULT_TIMEOUT_SECONDS, options: ConnectionOptions = {}): Promise<Connection> {
    const timeout = timeoutSeconds as unknown;
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > TIMEOUT_MAX_SECONDS) {
      throw new Gate("browser-control-invalid-request");
    }
    const connection = new Connection(timeout, options);
    try {
      if (typeof socketPath !== "string") throw new Invalid();
      const uid = process.getuid?.();
      const parent = fs.lstatSync(path.dirname(socketPath));
      const endpoint = fs.lstatSync(socketPath);
      if (!parent.isDirectory() || parent.uid !== uid || parent.mode & 0o077 || !endpoint.isSocket()
          || endpoint.uid !== uid || endpoint.mode & 0o077) {
        throw new Invalid();
      }
      connection.socket = await connectSocket(socketPath, timeout * 1000);
      connection.attach(connection.socket);
    } catch {
      connection.close();
      throw new Gate("browser-control-unavailable");
    }
    try {
      const host = await connection.call("host.info");
      // isPyInt keeps Python's type(value) is int: a float literal such as 2.0 is not protocol 2.
      if (!isRecord(host) || !isPyInt(host, "protocolVersion") || host.protocolVersion !== 2 || host.extensionProtocol !== "ready") {
        throw new Gate("browser-control-protocol-mismatch");
      }
      const extension = await connection.call("getInfo");
      if (!isRecord(extension) || !isPyInt(extension, "protocolVersion") || extension.protocolVersion !== 2
          || !isPyInt(extension, "pageProtocolVersion") || extension.pageProtocolVersion !== 2) {
        throw new Gate("browser-control-protocol-mismatch");
      }
    } catch (error) {
      connection.close();
      throw error;
    }
    return connection;
  }

  get alive(): boolean {
    return this.socket !== null;
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners("data");
      socket.destroy();
    }
    this.failure ??= new Invalid();
    this.waiter?.wake();
  }

  private attach(socket: net.Socket) {
    // Bytes that arrive between calls stay in the kernel buffer, as they would for a blocking socket.
    socket.pause();
    socket.on("data", (chunk: Buffer) => {
      if (this.newline < 0) {
        const index = chunk.indexOf(0x0a);
        if (index >= 0) this.newline = this.buffered + index;
      }
      this.chunks.push(chunk);
      this.buffered += chunk.length;
      this.waiter?.wake();
    });
    socket.on("end", () => {
      this.ended = true;
      this.waiter?.wake();
    });
    socket.on("error", (error) => {
      this.failure ??= error;
      this.waiter?.wake();
    });
    socket.on("close", () => {
      this.ended = true;
      this.waiter?.wake();
    });
  }

  private remaining(deadline: number): number {
    const value = deadline - monotonic();
    if (value <= 0) throw new Invalid();
    return value;
  }

  /** Wait for more bytes, EOF, an error or the deadline. */
  private wait(deadline: number): Promise<void> {
    const remaining = this.remaining(deadline);
    return new Promise((resolve) => {
      const timer = setTimeout(done, remaining * 1000);
      const waiter = { wake: done };
      this.waiter = waiter;
      function done() {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  private write(socket: net.Socket, data: Buffer, deadline: number): Promise<void> {
    const remaining = this.remaining(deadline);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Invalid()), remaining * 1000);
      socket.write(data, (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async call(method: string, params: JsonObject | null = null): Promise<unknown> {
    const deadline = monotonic() + this.timeout;
    const release = await this.mutex.acquire(this.timeout * 1000);
    if (!release) {
      this.close();
      throw new Gate("browser-control-outcome-unknown");
    }
    try {
      if (!this.alive) throw new Gate("browser-control-outcome-unknown");
      let request: Buffer;
      let requestId: number;
      try {
        if (typeof method !== "string" || !METHODS.has(method) || (params !== null && params !== undefined && !isRecord(params)) || !valid(params ?? null)) {
          throw new Invalid();
        }
        requestId = this.next + 1;
        request = Buffer.from(`${pyDumps({ jsonrpc: "2.0", id: requestId, method, params: params ?? {} }, { separators: [",", ":"], allowNan: false })}\n`, "utf8");
        if (request.length > REQUEST_LIMIT) throw new Invalid();
      } catch {
        throw new Gate("browser-control-invalid-request");
      }
      this.next = requestId;
      const socket = this.socket as net.Socket;
      try {
        return await this.exchange(socket, request, requestId, deadline);
      } catch (error) {
        if (error instanceof Gate) throw error;
        this.close();
        throw new Gate("browser-control-outcome-unknown");
      }
    } finally {
      this.waiter = null;
      this.socket?.pause();
      release();
    }
  }

  /** Remove and return the bytes before the first newline, dropping the newline. */
  private takeLine(): Buffer {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
    const line = Buffer.from(all.subarray(0, this.newline));
    const rest = all.subarray(this.newline + 1);
    this.chunks = rest.length ? [rest] : [];
    this.buffered = rest.length;
    this.newline = rest.indexOf(0x0a);
    return line;
  }

  private async exchange(socket: net.Socket, request: Buffer, requestId: number, deadline: number): Promise<unknown> {
    await this.write(socket, request, deadline);
    // Bytes are counted from the leftover buffer, like Python's `received = len(self._buffer)`.
    let received = this.buffered;
    let counted = this.buffered;
    const count = () => {
      received += this.buffered - counted;
      counted = this.buffered;
      if (received > this.responseLimit) throw new Invalid();
    };
    socket.resume();
    while (true) {
      this.remaining(deadline);
      count();
      if (this.newline < 0) {
        if (this.failure) throw this.failure;
        if (this.ended || !this.alive) throw new Invalid();
        await this.wait(deadline);
        continue;
      }
      const line = this.takeLine();
      counted = this.buffered;
      const message = parseStrictJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(line)) as unknown;
      this.remaining(deadline);
      if (!isRecord(message) || message.jsonrpc !== "2.0") throw new Invalid();
      if (!has(message, "id")) {
        if (typeof message.method !== "string" || has(message, "result") || has(message, "error")
            || (has(message, "params") && !isRecord(message.params) && !Array.isArray(message.params))) {
          throw new Invalid();
        }
        continue;
      }
      if (!isPyInt(message, "id") || message.id !== requestId || has(message, "method") || has(message, "result") === has(message, "error")) {
        throw new Invalid();
      }
      if (has(message, "error")) {
        const error = message.error;
        if (!isRecord(error) || !isPyInt(error, "code") || typeof error.message !== "string") throw new Invalid();
        const text = error.message;
        if (text === "Outcome unknown; connection revoked; do not replay") throw new Invalid();
        if (text === "Page origin not ready or mismatch" || text === "Frame with ID 0 was removed.") throw new Gate("browser-control-page-not-ready");
        if (text === "Private observation refused") throw new Gate("browser-control-private-fields-unavailable");
        if (Object.prototype.hasOwnProperty.call(REFUSAL_REASONS, text)) throw new Gate(REFUSAL_REASONS[text]);
        if (text === "Capture or observation blocked: private fields or frames" || text === "Private document quarantined until cross-document navigation") {
          throw new Gate("browser-control-private-page");
        }
        if (text === "Capture or observation blocked: author shadow roots unsupported") throw new Gate("browser-control-unsupported-page");
        throw new Gate("browser-control-operation-refused");
      }
      return message.result;
    }
  }
}

function connectSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Invalid());
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}
