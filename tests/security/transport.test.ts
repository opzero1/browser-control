import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeTransport } from "../../src/native-host/transport";
import { startHost } from "../support/native-host";
import { testTemp } from "../support/temp";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A fake host at `socketPath`, mode 0600 as the host makes it, that answers the handshake and the page calls. */
async function fakeHost(socketPath: string, observationError = "unused", versions = { host: 2, transport: 2, page: 2 }) {
  const methods: string[] = [];
  const sockets = new Set<net.Socket>();
  let observations = 0;
  const server = net.createServer(socket => {
    sockets.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      for (let index; (index = buffer.indexOf("\n")) >= 0;) {
        const request = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        methods.push(request.method);
        const result = request.method === "host.info" ? { protocolVersion: versions.host, extensionProtocol: "ready", session_id: "test", epoch: "test" }
          : request.method === "getInfo" ? { protocolVersion: versions.transport, pageProtocolVersion: versions.page }
          : request.method === "createTab" ? { id: 1, active: false }
          : request.method === "observePage" ? { status: "observed", pageProtocolVersion: 2, snapshot: "fresh", url: "https://synthetic.invalid/", title: "Ready", text: "Ready", actions: [], mode: "full", partial: false, opaqueSurfaces: [], truncation: { text: false, actions: false, opaqueSurfaces: false, labels: false, title: false } }
          : {};
        const failed = request.method === "observePage" && observations++ === 0;
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(failed ? { error: { code: -1, message: observationError } } : { result }) }) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  fs.chmodSync(socketPath, 0o600);
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  return { methods, sockets, close };
}

async function endpoint(observationError: string, check: (client: ChromeTransport, methods: string[]) => Promise<void>, versions = { host: 2, transport: 2, page: 2 }) {
  const root = testTemp();
  const host = await fakeHost(path.join(root, "s"), observationError, versions);
  let client: ChromeTransport | undefined;
  try {
    client = await ChromeTransport.connect(path.join(root, "s"));
    await check(client, host.methods);
  } finally {
    await client?.close();
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function temporary(prefix?: string) {
  const directory = testTemp(prefix);
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** lstat, synchronous or not, reports another uid for each of `files`; tests cannot chown. */
function foreignOwner(...files: string[]) {
  const lstatSync = fs.lstatSync;
  const lstat = fsp.lstat;
  const foreign = (stats: fs.Stats) => Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid: stats.uid + 1 });
  vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
    const stats = lstatSync(target, options as fs.StatSyncOptions & { bigint?: false }) as fs.Stats;
    return files.includes(String(target)) ? foreign(stats) : stats;
  }) as typeof fs.lstatSync);
  vi.spyOn(fsp, "lstat").mockImplementation((async (target: fs.PathLike) => {
    const stats = await lstat(target);
    return files.includes(String(target)) ? foreign(stats) : stats;
  }) as typeof fsp.lstat);
}

it.each(["Frame with ID 0 was removed.", 'Cannot access contents of url "about:blank". Extension manifest must request permission to access this host.'])("waits through %s by repeating only observation", async observationError => {
  await endpoint(observationError, async (client, methods) => {
    const page = await client.open("https://synthetic.invalid/");
    expect((await client.waitFor(page, { text: "Ready" }, 500)).snapshot).toBe("fresh");
    expect(methods.filter(method => method === "observePage")).toHaveLength(2);
    expect(methods.filter(method => method === "navigatePage")).toHaveLength(1);
    expect(methods.filter(method => ["actPage", "privateFill", "submitPrivate"].includes(method))).toHaveLength(0);
  });
});

it.each(["Page owner revoked", "Transport closed; outcome unknown; no replay", 'Cannot access contents of url "https://synthetic.invalid/". Extension manifest must request permission to access this host.'])("does not hide %s while waiting", async error => {
  await endpoint(error, async (client, methods) => {
    const page = await client.open("https://synthetic.invalid/");
    await expect(client.waitFor(page, { text: "Ready" }, 500)).rejects.toThrow(error);
    expect(methods.filter(method => method === "observePage")).toHaveLength(1);
  });
});

it.each(["host", "transport", "page"] as const)("rejects a mismatched %s protocol before page use", async key => {
  await expect(endpoint("unused", async () => { throw new Error("unexpected connection"); }, { host: 2, transport: 2, page: 2, [key]: 1 })).rejects.toThrow(/protocol/);
});

describe("the transport's socket", () => {
  const UNSAFE = ["a group-readable directory", "another user's directory", "another user's socket", "a group-readable socket", "a symlink above it in a directory others can write to"] as const;
  it.each(UNSAFE)("refuses %s and connects nothing", async unsafe => {
    const root = temporary();
    const directory = path.join(root, "sockets");
    fs.mkdirSync(directory, { mode: 0o700 });
    let socketPath = path.join(directory, "s");
    const host = await fakeHost(socketPath);
    cleanup.push(host.close);
    if (unsafe === "a group-readable directory") fs.chmodSync(directory, 0o750);
    else if (unsafe === "a group-readable socket") fs.chmodSync(socketPath, 0o660);
    // Both the path given and the canonical path, whichever the transport inspects.
    else if (unsafe === "another user's directory") foreignOwner(directory, fs.realpathSync(directory));
    else if (unsafe === "another user's socket") foreignOwner(socketPath, path.join(fs.realpathSync(directory), "s"));
    else {
      const shared = path.join(root, "shared");
      fs.mkdirSync(shared);
      fs.chmodSync(shared, 0o777);
      cleanup.push(() => fs.chmodSync(shared, 0o700));
      // Above the socket's own directory, where a check of only that directory follows it.
      fs.symlinkSync(root, path.join(shared, "link"));
      socketPath = path.join(shared, "link/sockets/s");
    }
    await expect(ChromeTransport.connect(socketPath)).rejects.toThrow("Explicit private owned Unix socket required");
    expect(host.sockets.size).toBe(0);
    expect(host.methods).toEqual([]);
  });

  it("still throws ENOENT for a host that is not running, whose socket is gone", async () => {
    const root = temporary();
    await expect(ChromeTransport.connect(path.join(root, "s"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("connects only to the canonical path it checked when a symlink in the socket path is repointed before the connect", async () => {
    const root = temporary("t");
    const [real, attacker] = ["real", "attacker"].map(name => path.join(root, name));
    for (const directory of [real, attacker]) fs.mkdirSync(path.join(directory, "sockets"), { recursive: true, mode: 0o700 });
    const good = await fakeHost(path.join(real, "sockets/s"));
    const evil = await fakeHost(path.join(attacker, "sockets/s"));
    cleanup.push(good.close, evil.close);
    const alias = path.join(root, "alias");
    fs.symlinkSync(real, alias);
    // Just before the transport connects, after any check it made, another user who owned `alias` points it at their host.
    const createConnection = net.createConnection;
    vi.spyOn(net, "createConnection").mockImplementation(((...args: Parameters<typeof net.createConnection>) => {
      fs.unlinkSync(alias);
      fs.symlinkSync(attacker, alias);
      return (createConnection as (...values: unknown[]) => net.Socket)(...args);
    }) as typeof net.createConnection);
    const client = await ChromeTransport.connect(path.join(alias, "sockets/s"));
    await client.close();
    expect(fs.readlinkSync(alias)).toBe(attacker);
    expect(evil.methods).toEqual([]);
    expect(good.methods).toEqual(["host.info", "getInfo", "finalizeTabs"]);
  });

  it.each([
    ["the default ~/.opzero-chrome/default.sock under a temporary HOME", "h", ".opzero-chrome/default.sock", false],
    ["<state>/sockets/user.sock", "s", "state/sockets/user.sock", true]
  ] as const)("opens and closes a page through the real host at %s", async (_name, prefix, relative, explicit) => {
    // Short names: the canonical /private/var/... path must fit sun_path.
    const home = temporary(prefix);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    if (explicit) env.BROWSER_CONTROL_HOST_SOCKET = path.join(home, relative);
    else delete env.BROWSER_CONTROL_HOST_SOCKET;
    const host = await startHost(env, path.join(fs.realpathSync(home), relative));
    cleanup.push(() => host.stop());
    const client = await ChromeTransport.connect(path.join(home, relative));
    const page = await client.open("https://synthetic.invalid/");
    expect(page).toEqual({ tabId: 7, origin: "https://synthetic.invalid" });
    await client.close();
    expect(host.native.map(request => request.method)).toEqual(["getInfo", "createTab", "attach", "bindPage", "navigatePage", "finalizeTabs"]);
  });
});
