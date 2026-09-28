// Port of test_opchrome.py. Protocol tests use real private Unix sockets, never a browser or native host.
import fs from "node:fs";
import type net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTHORITY_KEYS, Connection, METHODS, REQUEST_LIMIT, RESPONSE_LIMIT } from "../../../src/server/host-connection";
import { Gate } from "../../../src/server/gate";
import { FakeHost, RawJson, result, send, type FakeHostOptions, type Request } from "../support/fake-host";
import { code } from "../support/renames";
import { privateTemp, removeTempRoots, socketPath } from "../support/temp";

const hosts: FakeHost[] = [];
const connections: Connection[] = [];
let directory = "";

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close();
  const open = hosts.splice(0);
  for (const host of open) await host.close();
  removeTempRoots();
  vi.restoreAllMocks();
  directory = "";
});

function dir(): string {
  directory ||= privateTemp();
  return directory;
}

async function hostFactory(options: FakeHostOptions = {}): Promise<FakeHost> {
  const host = await FakeHost.start(socketPath(dir(), `s${hosts.length}`), options);
  hosts.push(host);
  return host;
}

async function open(file: string, timeout?: number, options?: { responseLimit?: number }): Promise<Connection> {
  const connection = await Connection.open(file, timeout, options);
  connections.push(connection);
  return connection;
}

async function gate(promise: Promise<unknown>, python: string): Promise<Gate> {
  const error = await promise.then(() => null, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(Gate);
  expect((error as Gate).code).toBe(code(python));
  expect((error as Gate).message).toBe(code(python));
  return error as Gate;
}

function rendered(error: Error): string {
  return `${String(error)}\n${error.stack ?? ""}\n${JSON.stringify(error)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("host connection (test_opchrome.py)", () => {
  it("keeps one persistent connection per open with independent host authorities", async () => {
    const host = await hostFactory();
    const first = await open(host.path);
    const second = await open(host.path);
    expect(first.alive && second.alive).toBe(true);
    expect(await first.call("getTabs")).toBe("host-session-1");
    expect(await second.call("getTabs")).toBe("host-session-2");
    expect(await first.call("createTab")).toBe("host-session-1");
    expect(host.connections).toHaveLength(2);
    for (const authority of ["host-session-1", "host-session-2"]) {
      const requests = host.requests.filter(([session]) => session === authority).map(([, request]) => request);
      expect(requests.map((request) => request.id)).toEqual(requests.map((_, index) => index + 1));
      expect(requests.slice(0, 2).map((request) => request.method)).toEqual(["host.info", "getInfo"]);
      expect(requests.every((request) => Object.keys(request.params).every((key) => !AUTHORITY_KEYS.has(key)))).toBe(true);
    }
    first.close();
    first.close();
    second.close();
    expect(first.alive).toBe(false);
  });

  it("allowlists nameSession as a display method", async () => {
    const host = await hostFactory({ handler: (socket, request) => result(socket, request, { name: request.params.name, confirmed: true }) });
    const connection = await open(host.path);
    expect(await connection.call("nameSession", { name: "Tester · Preview 1704" })).toEqual({ name: "Tester · Preview 1704", confirmed: true });
  });

  const HANDSHAKES: Array<{ name: string; hostInfo?: unknown; extensionInfo?: unknown }> = [
    { name: "host protocol 1", hostInfo: { protocolVersion: 1, extensionProtocol: "ready" } },
    { name: "extension still checking", hostInfo: { protocolVersion: 2, extensionProtocol: "checking" } },
    { name: "extension unsupported", hostInfo: { protocolVersion: 2, extensionProtocol: "unsupported" } },
    { name: "empty host info", hostInfo: {} },
    { name: "extension protocol 1", extensionInfo: { protocolVersion: 1, pageProtocolVersion: 1 } },
    { name: "page protocol 1", extensionInfo: { protocolVersion: 2, pageProtocolVersion: 1 } },
    { name: "boolean page protocol", extensionInfo: { protocolVersion: 2, pageProtocolVersion: true } },
    { name: "list extension info", extensionInfo: [] },
    // Python's type(value) is int refuses a float literal even when its value is 2.
    { name: "float host protocol", hostInfo: new RawJson("{\"protocolVersion\":2.0,\"extensionProtocol\":\"ready\"}") },
    { name: "float extension protocol", extensionInfo: new RawJson("{\"protocolVersion\":2e0,\"pageProtocolVersion\":2}") },
    { name: "float page protocol", extensionInfo: new RawJson("{\"protocolVersion\":2,\"pageProtocolVersion\":2.0}") }
  ];
  it.each(HANDSHAKES)("refuses an incompatible handshake: $name", async ({ hostInfo, extensionInfo }) => {
    const host = await hostFactory({ hostInfo, extensionInfo });
    await gate(Connection.open(host.path), "opchrome-protocol-mismatch");
    expect(host.requests.some(([, request]) => request.method === "getTabs")).toBe(false);
  });

  it("refuses a missing socket as unavailable", async () => {
    const error = await gate(Connection.open(path.join(dir(), "missing")), "opchrome-unavailable");
    expect(error.code).toBe(error.message);
  });

  const TIMEOUTS: unknown[] = [0, -1, Infinity, NaN, true, "35", 1e30];
  it.each(TIMEOUTS)("refuses an invalid timeout: %s", async (timeout) => {
    await gate(Connection.open(path.join(dir(), "missing"), timeout as number), "opchrome-invalid-request");
  });

  const FOREIGN: Array<"parent" | "endpoint"> = ["parent", "endpoint"];
  it.each(FOREIGN)("refuses a foreign-owned %s", async (target) => {
    const host = await hostFactory();
    const foreign = target === "parent" ? path.dirname(host.path) : host.path;
    const lstat = fs.lstatSync;
    // Non-root tests cannot chown; the socket is real, only its observed UID differs.
    vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options?: fs.StatSyncOptions) => {
      const observed = lstat(file, options as fs.StatSyncOptions & { bigint?: false }) as fs.Stats;
      if (String(file) !== foreign) return observed;
      return Object.assign(Object.create(Object.getPrototypeOf(observed)), observed, { uid: observed.uid + 1 });
    }) as typeof fs.lstatSync);
    await gate(Connection.open(host.path), "opchrome-unavailable");
    expect(host.requests).toHaveLength(0);
  });

  const UNSAFE = ["parent-mode", "socket-mode", "socket-link", "parent-link", "file"] as const;
  it.each(UNSAFE)("refuses an unsafe endpoint: %s", async (unsafe) => {
    const host = await hostFactory();
    let endpoint = host.path;
    const root = dir();
    if (unsafe === "parent-mode") fs.chmodSync(root, 0o750);
    else if (unsafe === "socket-mode") fs.chmodSync(endpoint, 0o660);
    else if (unsafe === "socket-link") {
      endpoint = path.join(root, "link");
      fs.symlinkSync(host.path, endpoint);
    } else if (unsafe === "parent-link") {
      const link = path.join(root, "link");
      fs.symlinkSync(root, link);
      endpoint = path.join(link, path.basename(host.path));
    } else {
      endpoint = path.join(root, "file");
      fs.writeFileSync(endpoint, "not a socket", { mode: 0o600 });
    }
    try {
      await gate(Connection.open(endpoint), "opchrome-unavailable");
      expect(host.requests).toHaveLength(0);
    } finally {
      fs.chmodSync(root, 0o700);
    }
  });

  const AUTHORITY = [...AUTHORITY_KEYS].sort().flatMap((key) => [false, true].map((nested) => ({ key, nested })));
  it.each(AUTHORITY)("rejects caller authority $key (nested: $nested)", async ({ key, nested }) => {
    const host = await hostFactory();
    const connection = await open(host.path);
    let params: Record<string, unknown> = { [key]: "caller-authority" };
    if (nested) params = { nested: [params] };
    await gate(connection.call("getTabs", params as never), "opchrome-invalid-request");
    expect(connection.alive).toBe(true);
    expect(host.requests).toHaveLength(2);
  });

  const INVALID: Array<{ name: string; method: unknown; params: unknown }> = [
    { name: "evaluate", method: "evaluate", params: {} },
    { name: "host.authenticate", method: "host.authenticate", params: {} },
    { name: "getPassword", method: "getPassword", params: {} },
    { name: "internal.releaseClient", method: "internal.releaseClient", params: {} },
    { name: "a list method", method: [], params: {} },
    { name: "list params", method: "getTabs", params: [] },
    { name: "an oversized request", method: "actPage", params: { text: "x".repeat(REQUEST_LIMIT) } },
    { name: "a NaN value", method: "actPage", params: { value: NaN } },
    { name: "a non-string key", method: "actPage", params: { [Symbol("bad-key")]: "bad-key" } }
  ];
  it.each(INVALID)("never sends an invalid request: $name", async ({ method, params }) => {
    const host = await hostFactory();
    const connection = await open(host.path);
    await gate(connection.call(method as string, params as never), "opchrome-invalid-request");
    expect(host.requests).toHaveLength(2);
    expect(connection.alive).toBe(true);
  });

  it("redacts remote errors and skips notifications", async () => {
    const secret = "DO-NOT-EXPOSE-remote-or-input";
    const host = await hostFactory({
      handler: (socket, request) => {
        send(socket, { jsonrpc: "2.0", method: "event", params: { secret } });
        if (request.method === "actPage") {
          send(socket, { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: secret, data: { secret } } });
        } else {
          result(socket, request, { safe: true });
        }
      }
    });
    const connection = await open(host.path);
    const error = await gate(connection.call("actPage", { text: secret }), "opchrome-operation-refused");
    expect(rendered(error)).not.toContain(secret);
    expect(connection.alive).toBe(true);
    expect(await connection.call("getTabs")).toEqual({ safe: true });
  });

  const MALFORMED: Array<{ name: string; payload: Buffer }> = [
    ["a wrong id", "{\"jsonrpc\":\"2.0\",\"id\":99,\"result\":\"sensitive\"}\n"],
    ["a boolean id", "{\"jsonrpc\":\"2.0\",\"id\":true,\"result\":null}\n"],
    ["a float id equal to the request id", "{\"jsonrpc\":\"2.0\",\"id\":3.0,\"result\":\"sensitive\"}\n"],
    ["an exponent id equal to the request id", "{\"jsonrpc\":\"2.0\",\"id\":3e0,\"result\":\"sensitive\"}\n"],
    ["an error with a float code", "{\"jsonrpc\":\"2.0\",\"id\":3,\"error\":{\"code\":-32000.0,\"message\":\"sensitive\"}}\n"],
    ["result and error", "{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":null,\"error\":{}}\n"],
    ["neither result nor error", "{\"jsonrpc\":\"2.0\",\"id\":3}\n"],
    ["an error without a code", "{\"jsonrpc\":\"2.0\",\"id\":3,\"error\":{\"message\":\"sensitive\"}}\n"],
    ["a duplicate key", "{\"jsonrpc\":\"2.0\",\"id\":3,\"id\":3,\"result\":null}\n"],
    ["a NaN result", "{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":NaN}\n"],
    ["no jsonrpc version", "{\"id\":3,\"result\":null}\n"],
    ["a result without an id", "{\"jsonrpc\":\"2.0\",\"result\":\"sensitive\"}\n"],
    ["a notification with string params", "{\"jsonrpc\":\"2.0\",\"method\":\"event\",\"params\":\"sensitive\"}\n"],
    ["not JSON", "not-json-sensitive\n"],
    ["invalid UTF-8", Buffer.from([0xff, 0x0a])],
    ["a list", "[]\n"],
    ["an empty line", "\n"]
  ].map(([name, payload]) => ({ name: name as string, payload: Buffer.isBuffer(payload) ? payload : Buffer.from(payload as string) }));
  it.each(MALFORMED)("poisons the connection without replay on $name", async ({ payload }) => {
    const host = await hostFactory({ handler: (socket) => { socket.write(payload); } });
    const connection = await open(host.path);
    const error = await gate(connection.call("actPage"), "opchrome-outcome-unknown");
    expect(rendered(error)).not.toContain("sensitive");
    expect(connection.alive).toBe(false);
    await gate(connection.call("actPage"), "opchrome-outcome-unknown");
    expect(host.connections).toHaveLength(1);
    expect(host.requests).toHaveLength(3);
  });

  const UNCERTAIN = ["timeout", "disconnect", "notifications", "host-timeout"] as const;
  it.each(UNCERTAIN)("never reconnects or replays an uncertain outcome: %s", async (mode) => {
    const host = await hostFactory({
      handler: async (socket: net.Socket, request: Request) => {
        if (mode === "disconnect") {
          socket.destroy();
        } else if (mode === "host-timeout") {
          send(socket, { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Outcome unknown; connection revoked; do not replay" } });
        } else if (mode === "notifications") {
          for (let i = 0; i < 100 && !socket.destroyed; i += 1) {
            send(socket, { jsonrpc: "2.0", method: "event", params: { private: "discard" } });
            await sleep(10);
          }
        } else {
          await sleep(300);
          result(socket, request, "late result must not trigger replay");
        }
      }
    });
    const connection = await open(host.path, 0.12);
    const start = performance.now();
    await gate(connection.call("actPage", { text: "once only" }), "opchrome-outcome-unknown");
    expect(performance.now() - start).toBeLessThan(600);
    expect(connection.alive).toBe(false);
    await gate(connection.call("actPage"), "opchrome-outcome-unknown");
    expect(host.connections).toHaveLength(1);
    expect(host.requests).toHaveLength(3);
  });

  const REFUSALS: Array<{ message: string; expected: string }> = [
    ...["private-quarantine", "populated-private-input", "restored-private-selector", "embedded-surface",
      "invalid-private-selectors", "unsupported-shadow-root"].map((reason) => ({ message: reason, expected: `opchrome-${reason}` })),
    { message: "Legacy private document quarantine requires a new tab", expected: "opchrome-private-quarantine" },
    { message: "Capture or observation blocked: private fields or frames", expected: "opchrome-private-page" },
    { message: "Private document quarantined until cross-document navigation", expected: "opchrome-private-page" },
    { message: "Capture or observation blocked: author shadow roots unsupported", expected: "opchrome-unsupported-page" },
    { message: "embedded-surface synthetic-secret", expected: "opchrome-operation-refused" }
  ];
  it.each(REFUSALS)("maps the refusal $message to a safe diagnostic", async ({ message, expected }) => {
    const host = await hostFactory({ handler: (socket, request) => send(socket, { jsonrpc: "2.0", id: request.id, error: { code: -32000, message } }) });
    const connection = await open(host.path);
    const error = await gate(connection.call("observePage"), expected);
    expect(String(error.message)).not.toContain("synthetic-secret");
  });

  it("bounds response bytes", async () => {
    // Exercise the bound branch without allocating 64 MiB, as Python did by lowering RESPONSE_LIMIT.
    const host = await hostFactory({ handler: (socket) => { socket.write(Buffer.alloc(1025, "x")); } });
    const connection = await open(host.path, undefined, { responseLimit: 1024 });
    await gate(connection.call("capturePage"), "opchrome-outcome-unknown");
    expect(connection.alive).toBe(false);
  });

  it("bounds an unterminated frame at the production response limit", async () => {
    expect(RESPONSE_LIMIT).toBe(64 * 1024 * 1024);
    expect(REQUEST_LIMIT).toBe(1024 * 1024);
    const host = await hostFactory({
      handler: async (socket) => {
        // An unterminated frame must be bounded too, without waiting for a newline.
        const chunk = Buffer.alloc(1024 * 1024, "x");
        for (let i = 0; i < 64 && !socket.destroyed; i += 1) {
          if (!socket.write(chunk)) {
            await new Promise<void>((resolve) => {
              const done = () => {
                socket.off("drain", done);
                socket.off("close", done);
                resolve();
              };
              socket.on("drain", done);
              socket.on("close", done);
            });
          }
        }
        if (!socket.destroyed) socket.write("x");
      }
    });
    const connection = await open(host.path);
    await gate(connection.call("capturePage"), "opchrome-outcome-unknown");
    expect(connection.alive).toBe(false);
  }, 30000);

  it("treats a partial response before EOF as an unknown outcome", async () => {
    const host = await hostFactory({
      handler: (socket) => {
        socket.write("{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":\"partial-sensitive");
        socket.end();
      }
    });
    const connection = await open(host.path);
    const error = await gate(connection.call("actPage"), "opchrome-outcome-unknown");
    expect(rendered(error)).not.toContain("partial-sensitive");
    expect(connection.alive).toBe(false);
  });

  it("reassembles a fragmented response", async () => {
    const host = await hostFactory({
      handler: async (socket, request) => {
        const payload = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "café" })}\n`, "utf8");
        for (const byte of payload) {
          socket.write(Buffer.from([byte]));
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    });
    const connection = await open(host.path);
    expect(await connection.call("getTabs")).toBe("café");
  });

  it("serializes concurrent calls", async () => {
    let host: FakeHost;
    host = await hostFactory({
      handler: async (socket, request) => {
        const before = host.lines;
        await sleep(25);
        // No second request is pipelined while this one is unanswered.
        expect(host.lines).toBe(before);
        result(socket, request, request.params.index);
      }
    });
    const connection = await open(host.path);
    const results = await Promise.all([0, 1, 2, 3].map((index) => connection.call("getTabs", { index })));
    expect([...(results as number[])].sort()).toEqual([0, 1, 2, 3]);
    expect(host.requests.map(([, request]) => request.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("allowlists the upload RPC", () => {
    expect(METHODS.has("uploadFile")).toBe(true);
  });
});
