#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { isJsonRpcRequest, parseJsonRpcMessage, type JsonRpcMessage } from "../shared/rpc";

const socketPath = process.env.OPZERO_CHROME_HOST_SOCKET || path.join(os.homedir(), ".opzero-chrome", "default.sock");
const useTcp = process.platform === "win32" || process.env.OPZERO_CHROME_HOST_TRANSPORT === "tcp";
const port = Number(process.env.OPZERO_CHROME_HOST_PORT || 17365);
const epoch = randomUUID();
const protocolRequestId = `protocol:${epoch}`;
let extensionProtocol: "checking" | "ready" | "unsupported" = "checking";
const protocolTimer = setTimeout(() => { extensionProtocol = "unsupported"; }, 10000);
protocolTimer.unref();
const maxBytes = 1024 * 1024;
const maxResponseBytes = 64 * maxBytes;
const clients = new Map<net.Socket, { session: string; authenticated: boolean; ids: Set<string>; profileEvents: boolean }>();
const pending = new Map<number, { socket: net.Socket; id: number | string; private: boolean; timer: NodeJS.Timeout }>();
let nextId = 1;
let ownsSocket = false;
let tcpToken: Buffer | undefined;

function native(message: unknown) {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > maxBytes) return false;
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
  return true;
}

function result(id: unknown, value: unknown) { return { jsonrpc: "2.0", id, result: value }; }
function error(id: unknown, message: string) { return { jsonrpc: "2.0", id, error: { code: -32000, message } }; }
function reply(socket: net.Socket, message: unknown) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

function release(socket: net.Socket) {
  const client = clients.get(socket);
  if (!client) return;
  clients.delete(socket);
  for (const [id, request] of pending) {
    if (request.socket !== socket) continue;
    clearTimeout(request.timer);
    pending.delete(id);
  }
  if (client.authenticated && extensionProtocol === "ready") native({ jsonrpc: "2.0", method: "internal.releaseClient", params: { session_id: client.session } });
}

function handleNative(message: JsonRpcMessage) {
  if (!isJsonRpcRequest(message)) {
    if (message.id === protocolRequestId) {
      if (extensionProtocol !== "checking") return;
      clearTimeout(protocolTimer);
      extensionProtocol = !message.error && typeof message.result === "object" && message.result !== null
        && "protocolVersion" in message.result && message.result.protocolVersion === 2 ? "ready" : "unsupported";
      return;
    }
    const request = typeof message.id === "number" ? pending.get(message.id) : undefined;
    if (!request) return;
    pending.delete(Number(message.id));
    clearTimeout(request.timer);
    if (request.private) {
      const ok = !message.error && typeof message.result === "object" && message.result !== null
        && "status" in message.result && message.result.status === "filled";
      reply(request.socket, result(request.id, { status: ok ? "filled" : "not-filled-or-unknown", retry: false }));
    } else {
      reply(request.socket, message.error ? error(request.id, message.error.message) : result(request.id, message.result));
    }
    return;
  }
  if (message.id != null) {
    if (message.method === "ping") native(result(message.id, "pong"));
    else if (message.method === "getHostInfo") native(result(message.id, {
      name: "opzero-chrome-native-host", version: "0.2.1", protocolVersion: 2, extensionProtocol, epoch, pid: process.pid,
      transport: useTcp ? "tcp" : "unix", endpoint: useTcp ? `127.0.0.1:${port}` : socketPath
    }));
    else native(error(message.id, "Unsupported native host method"));
    return;
  }
  if (extensionProtocol !== "ready") return;
  const params = typeof message.params === "object" && message.params !== null ? message.params : {};
  const session = "session_id" in params ? params.session_id : undefined;
  for (const [socket, client] of clients) {
    if (!client.authenticated) continue;
    if (typeof session === "string" ? client.session === session
      : message.method === "onControlStopped" || (message.method === "onDownloadChange" && client.profileEvents)) {
      reply(socket, message);
    }
  }
  if (message.method === "onControlStopped") {
    for (const socket of clients.keys()) { release(socket); socket.end(); }
  }
}

function handleClient(socket: net.Socket, message: JsonRpcMessage) {
  const client = clients.get(socket);
  if (!client) return;
  if (!isJsonRpcRequest(message) || (typeof message.id !== "number" && typeof message.id !== "string")) {
    reply(socket, error(null, "Expected JSON-RPC request with a non-null id"));
    return;
  }
  const id = JSON.stringify(message.id);
  if (client.ids.has(id)) {
    reply(socket, error(message.id, "Duplicate id; action not replayed"));
    return;
  }
  if (client.ids.size >= 10000) {
    reply(socket, error(message.id, "Connection request limit reached; no action dispatched; connection revoked"));
    release(socket);
    socket.end();
    return;
  }
  client.ids.add(id);
  const params = typeof message.params === "object" && message.params !== null && !Array.isArray(message.params) ? message.params : {};
  if (!client.authenticated) {
    const token = "token" in params && typeof params.token === "string" ? Buffer.from(params.token) : Buffer.alloc(0);
    if (message.method !== "host.authenticate" || !tcpToken || token.length !== tcpToken.length || !timingSafeEqual(token, tcpToken)) {
      reply(socket, error(message.id, "Authentication required"));
      socket.end();
      return;
    }
    client.authenticated = true;
    reply(socket, result(message.id, { authenticated: true }));
    return;
  }
  if (message.method === "host.ping") { reply(socket, result(message.id, "pong")); return; }
  if (message.method === "host.info") {
    reply(socket, result(message.id, { protocolVersion: 2, extensionProtocol, epoch, session_id: client.session, reconnect: "new-session-no-replay" }));
    return;
  }
  if (message.method === "host.subscribeProfileEvents") {
    client.profileEvents = "enabled" in params && params.enabled === true;
    reply(socket, result(message.id, { enabled: client.profileEvents }));
    return;
  }
  if (message.method.startsWith("internal.") || message.method.startsWith("host.")) {
    reply(socket, error(message.id, "Reserved method"));
    return;
  }
  if (extensionProtocol !== "ready") {
    reply(socket, message.method === "privateFill"
      ? result(message.id, { status: extensionProtocol === "checking" ? "not-ready" : "unsupported", retry: false })
      : error(message.id, "Extension protocol v2 is not ready; no action dispatched"));
    return;
  }
  const extensionId = nextId++;
  const timer = setTimeout(() => {
    pending.delete(extensionId);
    reply(socket, error(message.id, "Outcome unknown; connection revoked; do not replay"));
    release(socket);
    socket.end();
  }, Number(process.env.OPZERO_CHROME_REQUEST_TIMEOUT_MS || 30000));
  pending.set(extensionId, { socket, id: message.id, private: message.method === "privateFill", timer });
  const sent = native({ jsonrpc: "2.0", id: extensionId, method: message.method,
    params: { ...params, session_id: client.session, sessionId: client.session, turn_id: epoch, turnId: epoch } });
  if (!sent) {
    clearTimeout(timer);
    pending.delete(extensionId);
    reply(socket, error(message.id, "Request exceeds native frame limit; no action dispatched"));
  }
}

const server = net.createServer(socket => {
  clients.set(socket, { session: randomUUID(), authenticated: !useTcp, ids: new Set(), profileEvents: false });
  socket.on("close", () => release(socket));
  socket.on("error", () => { release(socket); socket.destroy(); });
  socket.setEncoding("utf8");
  let text = "";
  socket.on("data", chunk => {
    text += chunk;
    if (Buffer.byteLength(text) > maxBytes) { socket.destroy(); return; }
    let index;
    while ((index = text.indexOf("\n")) !== -1) {
      const line = text.slice(0, index);
      text = text.slice(index + 1);
      if (!line.trim()) continue;
      try { handleClient(socket, parseJsonRpcMessage(JSON.parse(line))); }
      catch { reply(socket, error(null, "Invalid JSON-RPC request")); }
    }
  });
});

function shutdown(code: number) {
  for (const socket of clients.keys()) socket.destroy();
  if (ownsSocket) { try { fs.unlinkSync(socketPath); } catch {} }
  process.exit(code);
}

server.on("error", () => {
  process.stderr.write("Native endpoint unavailable; no existing endpoint was replaced\n");
  shutdown(1);
});

try {
  if (useTcp) {
    const file = process.env.OPZERO_CHROME_HOST_TOKEN_FILE;
    if (!file) throw new Error("token file required");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("private token file required");
    tcpToken = Buffer.from(fs.readFileSync(file, "utf8").trim());
    if (tcpToken.length < 32) throw new Error("token too short");
    server.listen(port, "127.0.0.1");
  } else {
    process.umask(0o077);
    const directory = path.dirname(socketPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("private socket directory required");
    if (!fs.existsSync(socketPath)) listenUnix();
    else {
      const existing = fs.lstatSync(socketPath);
      if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new Error("endpoint exists");
      reclaimStaleSocket();
    }
  }
} catch {
  refuseEndpoint();
}

function refuseEndpoint() {
  process.stderr.write("Native endpoint setup refused; use a private directory or authenticated TCP\n");
  shutdown(1);
}

function listenUnix() {
  server.listen(socketPath, () => { ownsSocket = true; fs.chmodSync(socketPath, 0o600); });
}

// A host killed without cleanup leaves its socket file behind. Only a
// refused connection proves no live host owns it; anything else is left alone.
function reclaimStaleSocket() {
  const probe = net.connect(socketPath);
  probe.once("connect", () => { probe.destroy(); refuseEndpoint(); });
  probe.once("error", (probeError: NodeJS.ErrnoException) => {
    if (probeError.code !== "ECONNREFUSED") { refuseEndpoint(); return; }
    try { fs.unlinkSync(socketPath); } catch { refuseEndpoint(); return; }
    listenUnix();
  });
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (length > maxResponseBytes) shutdown(1);
    if (buffer.length < length + 4) break;
    const body = buffer.subarray(4, length + 4);
    buffer = buffer.subarray(length + 4);
    try { handleNative(parseJsonRpcMessage(JSON.parse(body.toString("utf8")))); }
    catch { /* Malformed native frames are never echoed. */ }
  }
});
process.stdin.on("end", () => shutdown(0));
process.stdin.on("error", () => shutdown(1));
process.stdout.on("error", () => shutdown(1));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
native({ jsonrpc: "2.0", id: protocolRequestId, method: "getInfo", params: {} });
