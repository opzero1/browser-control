import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { testTemp } from "../support/temp";

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); });

async function host(env: NodeJS.ProcessEnv = {}, protocolVersion = 2) {
  const directory = testTemp();
  const endpoint = path.join(directory, "s");
  const child = spawn(process.execPath, ["dist/native-host/host.js"], {
    env: { ...process.env, OPZERO_CHROME_HOST_SOCKET: endpoint, ...env }, stdio: ["pipe", "pipe", "pipe"]
  });
  cleanup.push(() => { child.kill(); fs.rmSync(directory, { recursive: true, force: true }); });
  const native: any[] = [];
  let buffer = Buffer.alloc(0);
  child.stdout.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
      const length = buffer.readUInt32LE(0);
      const message = JSON.parse(buffer.subarray(4, length + 4).toString());
      if (typeof message.id === "string" && message.id.startsWith("protocol:")) { if (protocolVersion !== 0) send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion } }); }
      else native.push(message);
      buffer = buffer.subarray(length + 4);
    }
  });
  function send(message: unknown) {
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    child.stdin.write(Buffer.concat([header, body]));
  }
  await vi.waitFor(() => expect(fs.existsSync(endpoint)).toBe(true));
  async function connect() {
    const socket = net.connect(endpoint);
    cleanup.push(() => socket.destroy());
    const messages: any[] = [];
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      text += chunk;
      let index;
      while ((index = text.indexOf("\n")) >= 0) {
        messages.push(JSON.parse(text.slice(0, index))); text = text.slice(index + 1);
      }
    });
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const request = (id: number, method: string, params: object = {}) => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return { socket, messages, request };
  }
  return { child, endpoint, native, send, connect };
}

it("replaces caller-asserted session IDs with per-connection authority", async () => {
  const h = await host(); const a = await h.connect(); const b = await h.connect();
  a.request(1, "createTab", { session_id: "spoof", sessionId: "spoof", turn_id: "turn" });
  b.request(1, "createTab", { session_id: "spoof", turn_id: "turn" });
  await vi.waitFor(() => expect(h.native).toHaveLength(2));
  expect(h.native[0].params.session_id).not.toBe("spoof");
  expect(h.native[0].params.session_id).not.toBe(h.native[1].params.session_id);
});

it("refuses browser dispatch against a legacy extension with a distinct private status", async () => {
  const h = await host({}, 1); const a = await h.connect();
  a.request(1, "privateFill", { values: ["synthetic"] });
  a.request(2, "createTab");
  await vi.waitFor(() => expect(a.messages).toHaveLength(2));
  expect(a.messages[0].result).toEqual({ status: "unsupported", retry: false });
  expect(a.messages[1].error.message).toContain("no action dispatched");
  expect(h.native).toHaveLength(0);
});

it("distinguishes pending protocol negotiation and suppresses pre-negotiation events", async () => {
  const h = await host({}, 0); const a = await h.connect();
  a.request(1, "privateFill");
  await vi.waitFor(() => expect(a.messages[0]?.result?.status).toBe("not-ready"));
  h.send({ jsonrpc: "2.0", method: "onControlStopped", params: {} });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(a.messages).toHaveLength(1);
  expect(a.socket.destroyed).toBe(false);
  expect(h.native).toHaveLength(0);
});

it("preserves large native results such as screenshots", async () => {
  const h = await host(); const a = await h.connect();
  a.request(1, "executeCdp");
  await vi.waitFor(() => expect(h.native).toHaveLength(1));
  h.send({ jsonrpc: "2.0", id: h.native[0].id, result: { data: "x".repeat(2 * 1024 * 1024) } });
  await vi.waitFor(() => expect(a.messages[0]?.result?.data?.length).toBe(2 * 1024 * 1024));
});

it("rejects a request whose injected authority would exceed Chrome's native frame limit", async () => {
  const h = await host(); const a = await h.connect();
  const request = { jsonrpc: "2.0", id: 1, method: "executeCdp", params: { padding: "" } };
  request.params.padding = "x".repeat(1024 * 1024 - 32 - JSON.stringify(request).length);
  a.socket.write(`${JSON.stringify(request)}\n`);
  await vi.waitFor(() => expect(a.messages.length + h.native.length).toBeGreaterThan(0));
  expect(h.native).toHaveLength(0);
  await vi.waitFor(() => expect(a.messages[0]?.error?.message).toContain("native frame limit"));
  a.request(2, "host.ping");
  await vi.waitFor(() => expect(a.messages[1]?.result).toBe("pong"));
});

it("closes all client sessions when the extension stops control", async () => {
  const h = await host(); const a = await h.connect(); const b = await h.connect();
  a.request(1, "host.info"); b.request(1, "host.info");
  await vi.waitFor(() => expect(a.messages.length + b.messages.length).toBe(2));
  expect(a.messages[0].result.extensionProtocol).toBe("ready");
  expect(b.messages[0].result.extensionProtocol).toBe("ready");
  h.send({ jsonrpc: "2.0", method: "onControlStopped", params: { reason: "synthetic stop" } });
  await vi.waitFor(() => expect(a.socket.destroyed && b.socket.destroyed).toBe(true));
  expect(a.messages[1].method).toBe("onControlStopped");
  expect(b.messages[1].method).toBe("onControlStopped");
});

it("closes explicitly at the request limit instead of silently retaining a dead session", async () => {
  const h = await host(); const a = await h.connect();
  for (let i = 1; i <= 10001; i++) a.request(i, "host.ping");
  await vi.waitFor(() => expect(a.messages).toHaveLength(10001));
  expect(a.messages.at(-1).error.message).toContain("Connection request limit reached");
  await vi.waitFor(() => expect(a.socket.destroyed).toBe(true));
});

it("revokes disconnected clients and creates a fresh session on reconnect", async () => {
  const h = await host(); const a = await h.connect();
  a.request(1, "host.info");
  await vi.waitFor(() => expect(a.messages).toHaveLength(1));
  const original = a.messages[0].result.session_id;
  a.socket.destroy();
  await vi.waitFor(() => expect(h.native.some(message => message.method === "internal.releaseClient" && message.params.session_id === original)).toBe(true));
  const b = await h.connect(); b.request(1, "host.info");
  await vi.waitFor(() => expect(b.messages).toHaveLength(1));
  expect(b.messages[0].result.session_id).not.toBe(original);
});

it("revokes unknown outcomes on timeout without replaying requests", async () => {
  const h = await host({ OPZERO_CHROME_REQUEST_TIMEOUT_MS: "50" }); const a = await h.connect();
  a.request(1, "createTab");
  await vi.waitFor(() => expect(a.messages).toHaveLength(1));
  expect(a.messages[0].error.message).toContain("Outcome unknown");
  expect(h.native.filter(message => message.method === "createTab")).toHaveLength(1);
  await vi.waitFor(() => expect(h.native.some(message => message.method === "internal.releaseClient")).toBe(true));
});

it("protects Unix endpoint permissions and never steals a running endpoint", async () => {
  const h = await host();
  expect(fs.statSync(h.endpoint).mode & 0o777).toBe(0o600);
  const child = spawn(process.execPath, ["dist/native-host/host.js"], {
    env: { ...process.env, OPZERO_CHROME_HOST_SOCKET: h.endpoint }, stdio: ["pipe", "ignore", "pipe"]
  });
  cleanup.push(() => child.kill());
  const code = await new Promise(resolve => child.on("exit", resolve));
  expect(code).toBe(1);
  expect(fs.existsSync(h.endpoint)).toBe(true);
  const a = await h.connect(); a.request(1, "host.ping");
  await vi.waitFor(() => expect(a.messages[0]?.result).toBe("pong"));
});

it.each(["dispatch", "release"])("removes its own endpoint when the native output pipe breaks during %s", async mode => {
  const h = await host(); const a = await h.connect();
  a.request(1, "host.info");
  await vi.waitFor(() => expect(a.messages[0]?.result.extensionProtocol).toBe("ready"));
  const exited = new Promise(resolve => h.child.once("exit", resolve));
  h.child.stdout.destroy();
  if (mode === "dispatch") a.request(2, "getInfo"); else a.socket.destroy();
  expect(await exited).toBe(1);
  expect(fs.existsSync(h.endpoint)).toBe(false);
  await vi.waitFor(() => expect(a.socket.destroyed).toBe(true));
  const replacement = net.createServer(socket => socket.end());
  await new Promise<void>((resolve, reject) => { replacement.once("error", reject); replacement.listen(h.endpoint, resolve); });
  await new Promise<void>(resolve => replacement.close(() => resolve()));
});

it("refuses reserved lifecycle calls from local clients and unscoped events", async () => {
  const h = await host(); const a = await h.connect();
  a.request(1, "internal.releaseClient", { session_id: "someone-else" });
  await vi.waitFor(() => expect(a.messages[0]?.error).toBeDefined());
  expect(h.native).toHaveLength(0);
  h.send({ jsonrpc: "2.0", method: "onCDPEvent", params: { source: { tabId: 1 } } });
  h.send({ jsonrpc: "2.0", method: "onDownloadChange", params: { url: "synthetic-private-value" } });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(a.messages).toHaveLength(1);
});

it("routes CDP events only to the owning connection, never by broadcast", async () => {
  const h = await host(); const a = await h.connect(); const b = await h.connect();
  a.request(1, "createTab", { session_id: "owner-a", turn_id: "turn" });
  b.request(1, "createTab", { session_id: "owner-b", turn_id: "turn" });
  await vi.waitFor(() => expect(h.native).toHaveLength(2));
  h.send({ jsonrpc: "2.0", method: "onCDPEvent", params: { session_id: h.native[0].params.session_id, source: { tabId: 1 }, method: "Runtime.consoleAPICalled" } });
  await vi.waitFor(() => expect(a.messages).toHaveLength(1));
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(b.messages).toHaveLength(0);
});

it("does not replay a duplicate action id", async () => {
  const h = await host(); const a = await h.connect();
  a.request(1, "createTab", { session_id: "owner", turn_id: "turn" });
  a.request(1, "createTab", { session_id: "owner", turn_id: "turn" });
  await vi.waitFor(() => expect(h.native.length).toBeGreaterThan(0));
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(h.native.filter(r => r.method === "createTab")).toHaveLength(1);
});

it("redacts private fill errors and results from the extension", async () => {
  const h = await host(); const a = await h.connect();
  a.request(1, "privateFill", { values: ["synthetic-do-not-echo"] });
  await vi.waitFor(() => expect(h.native).toHaveLength(1));
  h.send({ jsonrpc: "2.0", id: h.native[0].id, error: { code: -1, message: "synthetic-do-not-echo" } });
  await vi.waitFor(() => expect(a.messages).toHaveLength(1));
  expect(JSON.stringify(a.messages)).not.toContain("synthetic-do-not-echo");
});
