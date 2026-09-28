import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { childPath } from "../server/support/children";
import { startHost } from "../support/native-host";
import { testTemp } from "../support/temp";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

/** dist/native-host/client.js with `args`, `endpoint` as BROWSER_CONTROL_HOST_SOCKET and the hooks in `preload` loaded first. */
function client(args: string[], endpoint?: string, options: { preload?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, BROWSER_CONTROL_HOST_SOCKET: endpoint, ...options.env };
  if (endpoint === undefined) delete env.BROWSER_CONTROL_HOST_SOCKET;
  const preload = (options.preload ?? []).flatMap(name => ["--require", childPath(name)]);
  const child = spawn(process.execPath, [...preload, "dist/native-host/client.js", ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  cleanup.push(() => { child.kill(); });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => child.on("close", code => resolve({ code, stdout, stderr })));
  return { child, done };
}

/** A socket server at `endpoint`, mode 0600 as the host makes it, that records what it receives and answers each request with "pong". */
async function listen(endpoint: string) {
  const received: any[] = [];
  const connections: net.Socket[] = [];
  const server = net.createServer(socket => {
    connections.push(socket);
    socket.setEncoding("utf8");
    let text = "";
    socket.on("data", chunk => {
      text += chunk;
      let index;
      while ((index = text.indexOf("\n")) >= 0) {
        const message = JSON.parse(text.slice(0, index)); text = text.slice(index + 1); received.push(message);
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: "pong" })}\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  fs.chmodSync(endpoint, 0o600);
  cleanup.push(() => new Promise<void>(resolve => { connections.forEach(socket => socket.destroy()); server.close(() => resolve()); }));
  return { received, connections };
}

function temporary(prefix?: string) {
  const directory = testTemp(prefix);
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

it("refuses argv payloads without printing them", async () => {
  const c = client(["privateFill", '{"value":"synthetic-private-value"}']);
  const result = await c.done;
  expect(result.code).toBe(1);
  expect(result.stdout + result.stderr).not.toContain("synthetic-private-value");
  expect(result.stderr).toContain("--stdio");
});

it("frames streaming responses, suppresses events, and sanitizes private errors", async () => {
  const directory = temporary();
  const endpoint = path.join(directory, "s");
  const received: any[] = [];
  const server = net.createServer(socket => {
    cleanup.push(() => { socket.destroy(); });
    socket.setEncoding("utf8");
    let text = "";
    socket.on("data", chunk => {
      text += chunk;
      let index;
      while ((index = text.indexOf("\n")) >= 0) {
        const message = JSON.parse(text.slice(0, index)); text = text.slice(index + 1); received.push(message);
        socket.write('{"jsonrpc":"2.0","method":"onCDPEvent","params":{"value":"synthetic-private-value"}}\n');
        const response = `${JSON.stringify(message.method === "privateFill"
          ? { jsonrpc: "2.0", id: message.id, error: { code: -1, message: "synthetic-private-value" } }
          : { jsonrpc: "2.0", id: message.id, result: "pong" })}\n`;
        socket.write(response.slice(0, 7));
        setImmediate(() => socket.write(response.slice(7)));
      }
    });
  });
  cleanup.push(() => { server.close(); });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  fs.chmodSync(endpoint, 0o600);
  const c = client(["--stdio"], endpoint);
  c.child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"privateFill","params":{"values":["synthetic-private-value"]}}\n');
  const result = await c.done;
  expect(received).toHaveLength(1);
  expect(result.stdout + result.stderr).not.toContain("synthetic-private-value");
  expect(JSON.parse(result.stdout).result).toEqual({ status: "not-filled-or-unknown", retry: false });
});

it("never echoes malformed stdin payloads", async () => {
  const directory = temporary();
  const endpoint = path.join(directory, "s");
  const server = net.createServer(socket => cleanup.push(() => { socket.destroy(); }));
  cleanup.push(() => { server.close(); });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  fs.chmodSync(endpoint, 0o600);
  const c = client(["--stdio"], endpoint);
  c.child.stdin.end('{synthetic-private-value\n');
  const result = await c.done;
  expect(result.code).toBe(1);
  expect(result.stdout + result.stderr).not.toContain("synthetic-private-value");
});

describe("the client's socket", () => {
  const REFUSAL = "Refusing the native host socket: it must be your socket, in a private directory that no other user can change; nothing was sent\n";

  // Another user's directory or socket is simulated through lstat (tests/server/support/child-foreign-owner.ts).
  const UNSAFE = ["a group-readable directory", "another user's directory", "another user's socket", "a group-readable socket", "a symlink above it in a directory others can write to"] as const;
  it.each(UNSAFE)("refuses %s, sends nothing and says so", async unsafe => {
    const root = temporary();
    const directory = path.join(root, "sockets");
    fs.mkdirSync(directory, { mode: 0o700 });
    let endpoint = path.join(directory, "s");
    const host = await listen(endpoint);
    const env: NodeJS.ProcessEnv = {};
    if (unsafe === "a group-readable directory") fs.chmodSync(directory, 0o750);
    else if (unsafe === "a group-readable socket") fs.chmodSync(endpoint, 0o660);
    // Both the path given and the canonical path, whichever the client inspects.
    else if (unsafe === "another user's directory") env.FOREIGN_OWNED = [directory, fs.realpathSync(directory)].join(path.delimiter);
    else if (unsafe === "another user's socket") env.FOREIGN_OWNED = [endpoint, path.join(fs.realpathSync(directory), "s")].join(path.delimiter);
    else {
      const shared = path.join(root, "shared");
      fs.mkdirSync(shared);
      fs.chmodSync(shared, 0o777);
      cleanup.push(() => fs.chmodSync(shared, 0o700));
      // Above the socket's own directory, where a check of only that directory follows it.
      fs.symlinkSync(root, path.join(shared, "link"));
      endpoint = path.join(shared, "link/sockets/s");
    }
    const result = await client(["host.ping"], endpoint, { preload: ["child-foreign-owner"], env }).done;
    expect(result).toEqual({ code: 1, stdout: "", stderr: REFUSAL });
    expect(host.connections).toHaveLength(0);
    expect(host.received).toEqual([]);
  });

  it("still reports a host that is not running, whose socket is gone, as a stopped client", async () => {
    // The reviewer steps expect this message after Pause host, which stops the host and removes its socket.
    const home = temporary("h");
    fs.mkdirSync(path.join(home, ".opzero-chrome"), { mode: 0o700 });
    for (const endpoint of [undefined, path.join(home, "missing/s")]) {
      const result = await client(["ping"], endpoint, { env: { HOME: home } }).done;
      expect(result).toEqual({ code: 1, stdout: "", stderr: "Private client stopped; outcome may be unknown; do not replay\n" });
    }
  });

  it("connects only to the canonical path it checked when a symlink in the socket path is repointed before the connect", async () => {
    // `alias` in a private directory leads to real; just before the client connects, the hook points it at another
    // user's tree, where another host listens at the same name.
    const root = temporary("c");
    const [real, attacker] = ["real", "attacker"].map(name => path.join(root, name));
    for (const directory of [real, attacker]) fs.mkdirSync(path.join(directory, "sockets"), { recursive: true, mode: 0o700 });
    const good = await listen(path.join(real, "sockets/s"));
    const evil = await listen(path.join(attacker, "sockets/s"));
    const alias = path.join(root, "alias");
    fs.symlinkSync(real, alias);
    const result = await client(["host.ping"], path.join(alias, "sockets/s"), {
      preload: ["child-socket-alias"], env: { ALIAS_LINK: alias, ALIAS_TARGET: attacker, ALIAS_AT_CONNECT: "1" }
    }).done;
    expect(fs.readlinkSync(alias)).toBe(attacker);
    expect(evil.received).toEqual([]);
    expect(good.received.map(message => message.method)).toEqual(["host.ping"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout).result).toBe("pong");
  });

  it("pings the host at the default ~/.opzero-chrome/default.sock under a temporary HOME", async () => {
    // A short name: the canonical /private/var/... path must fit sun_path.
    const home = temporary("h");
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.BROWSER_CONTROL_HOST_SOCKET;
    const host = await startHost(env, path.join(fs.realpathSync(home), ".opzero-chrome/default.sock"));
    cleanup.push(() => host.stop());
    for (const method of ["ping", "host.ping"]) {
      const result = await client([method], undefined, { env: { HOME: home } }).done;
      expect(result, result.stderr).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout).result).toBe("pong");
    }
    expect(host.native.map(request => request.method)).toEqual(["ping"]);
  });

  it("pings the host at <state>/sockets/user.sock, given through /var on macOS", async () => {
    const root = temporary("s");
    const endpoint = path.join(root, "state/sockets/user.sock");
    const host = await startHost({ ...process.env, BROWSER_CONTROL_HOST_SOCKET: endpoint }, path.join(fs.realpathSync(root), "state/sockets/user.sock"));
    cleanup.push(() => host.stop());
    const result = await client(["ping"], endpoint).done;
    expect(result, result.stderr).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout).result).toBe("pong");
    expect(fs.lstatSync(path.join(root, "state/sockets")).mode & 0o777).toBe(0o700);
  });
});
