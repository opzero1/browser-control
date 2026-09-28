#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseJsonRpcMessage, isJsonRpcRequest } from "../shared/rpc";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const streaming = args[0] === "--stdio";
const method = args[0] || "ping";
if (args.length > 1 || (!streaming && !["ping", "getInfo", "host.ping", "host.info"].includes(method))) {
  process.stderr.write("Payloads are accepted only through --stdio JSONL; never pass private values in argv\n");
  process.exit(1);
}
const useTcp = process.platform === "win32" || process.env.BROWSER_CONTROL_HOST_TRANSPORT === "tcp";
const socket = useTcp ? net.connect(Number(process.env.BROWSER_CONTROL_HOST_PORT || 17365), "127.0.0.1")
  : net.connect(process.env.BROWSER_CONTROL_HOST_SOCKET || path.join(os.homedir(), ".opzero-chrome", "default.sock"));
const pending = new Map<number | string, string>();
let ready = false;
let inputEnded = false;
let input = "";
let output = "";
let stopped = false;
const maxBytes = 1024 * 1024;
const maxResponseBytes = 64 * maxBytes;

function fail() {
  if (stopped) return;
  stopped = true;
  process.stderr.write("Private client stopped; outcome may be unknown; do not replay\n");
  socket.destroy();
  process.exitCode = 1;
  process.stdin.destroy();
}
function finish() {
  socket.setTimeout(pending.size ? 35000 : 0);
  if (inputEnded && pending.size === 0) socket.end();
}
function drain() {
  if (!ready) return;
  let index;
  while ((index = input.indexOf("\n")) !== -1) {
    const line = input.slice(0, index);
    input = input.slice(index + 1);
    if (!line.trim()) continue;
    try {
      const request = parseJsonRpcMessage(JSON.parse(line));
      if (!isJsonRpcRequest(request) || request.id == null || request.id === "__auth" || pending.has(request.id)) throw new Error();
      pending.set(request.id, request.method);
      socket.write(`${JSON.stringify(request)}\n`);
    } catch { fail(); return; }
  }
  finish();
}
function start() {
  ready = true;
  if (!streaming) {
    input = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} })}\n`;
    inputEnded = true;
  }
  drain();
}
socket.setEncoding("utf8");
socket.setTimeout(35000);
socket.on("timeout", fail);
socket.on("connect", () => {
  if (!useTcp) { start(); return; }
  try {
    const file = process.env.BROWSER_CONTROL_HOST_TOKEN_FILE;
    if (!file) throw new Error();
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: "__auth", method: "host.authenticate", params: { token: fs.readFileSync(file, "utf8").trim() } })}\n`);
  } catch { fail(); }
});
socket.on("data", chunk => {
  output += chunk;
  if (Buffer.byteLength(output) > maxResponseBytes) { fail(); return; }
  let index;
  while ((index = output.indexOf("\n")) !== -1) {
    const line = output.slice(0, index);
    output = output.slice(index + 1);
    try {
      const response = parseJsonRpcMessage(JSON.parse(line));
      if (isJsonRpcRequest(response)) continue;
      if (response.id === "__auth") { if (response.error) fail(); else start(); continue; }
      if (response.id == null || !pending.has(response.id)) continue;
      const requestMethod = pending.get(response.id);
      pending.delete(response.id);
      if (requestMethod === "privateFill") {
        const value = response.result;
        const filled = !response.error && typeof value === "object" && value !== null && "status" in value && value.status === "filled";
        const unsupported = !response.error && typeof value === "object" && value !== null && "status" in value && value.status === "unsupported";
        const notReady = !response.error && typeof value === "object" && value !== null && "status" in value && value.status === "not-ready";
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: response.id, result: { status: filled ? "filled" : unsupported ? "unsupported" : notReady ? "not-ready" : "not-filled-or-unknown", retry: false } })}\n`);
      } else process.stdout.write(`${JSON.stringify(response)}\n`);
      if (response.error) process.exitCode = 1;
    } catch { fail(); return; }
  }
  finish();
});
socket.on("error", fail);
socket.on("close", () => { if (pending.size || output) fail(); process.stdin.destroy(); });
if (streaming) {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    input += chunk;
    if (Buffer.byteLength(input) > maxBytes) { fail(); return; }
    drain();
  });
  process.stdin.on("end", () => { inputEnded = true; if (input.trim()) input += "\n"; drain(); });
  process.stdin.on("error", fail);
}
