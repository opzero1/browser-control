// The pool's probe of a controller endpoint and its removal of a stale one (trusted roots round): both go only
// through privateSocket's canonical path, and a removal only unlinks the socket that was probed, in its private
// directory, while both still have the identities that were checked.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearStaleEndpoint, endpointState, metadata } from "../../../src/server/pool/registry";
import { closeServer, gate, listen, pool, staleSocket, type Pool } from "./helpers";
import { removeTempRoots } from "../support/temp";

afterEach(() => {
  vi.restoreAllMocks();
  removeTempRoots();
});

/** isolated-1 of `target` with its sockets directory at `sockets`, as a PoolContext with that path names it. */
function controller(target: Pool, sockets = target.ctx.sockets) {
  return metadata("isolated-1", { ...target.ctx, sockets });
}

/** Run `during` inside the probe's net.createConnection, then connect as the probe asked. */
function atProbe(during: (file: string) => void): string[] {
  const seen: string[] = [];
  const createConnection = net.createConnection;
  vi.spyOn(net, "createConnection").mockImplementation(((...args: Parameters<typeof net.createConnection>) => {
    seen.push(String(args[0]));
    const socket = (createConnection as (...values: unknown[]) => net.Socket)(...args);
    during(String(args[0]));
    return socket;
  }) as typeof net.createConnection);
  return seen;
}

describe("the pool's controller endpoint", () => {
  it.each([["0777", 0o777], ["0770", 0o770]])("refuses a socket path through a directory with mode %s and never probes or unlinks through it", async (_mode, mode) => {
    const target = pool();
    // Another user's tree: their private sockets directory holds a stale socket of theirs (here, this user's).
    // Short names: every socket path must fit sun_path.
    const victim = path.join(target.root, "v/s");
    fs.mkdirSync(victim, { recursive: true, mode: 0o700 });
    await staleSocket(path.join(victim, "isolated-1.sock"));
    const shared = path.join(target.root, "w");
    fs.mkdirSync(shared);
    fs.chmodSync(shared, mode);
    // Above the sockets directory, where a check of only it and the socket follows the symlink.
    fs.symlinkSync(path.join(target.root, "v"), path.join(shared, "l"));
    const info = controller(target, path.join(shared, "l/s"));
    const probes = atProbe(() => undefined);
    expect(await gate(endpointState(info))).toBe("browser-controller-unsafe-socket");
    expect(await gate(clearStaleEndpoint(info))).toBe("browser-controller-unsafe-socket");
    expect(probes).toEqual([]);
    expect(fs.lstatSync(path.join(victim, "isolated-1.sock")).isSocket()).toBe(true);
  });

  it("probes and removes only the canonical endpoint when a symlink on its path is repointed at the probe", async () => {
    const target = pool();
    const [real, other] = ["r", "o"].map((name) => path.join(target.root, name, "s"));
    for (const directory of [real, other]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      await staleSocket(path.join(directory, "isolated-1.sock"));
    }
    const alias = path.join(target.root, "a");
    fs.symlinkSync(path.dirname(real), alias);
    const info = controller(target, path.join(alias, "s"));
    // After the checks, just as the probe connects, the symlink is pointed at the other tree.
    const probes = atProbe(() => {
      fs.unlinkSync(alias);
      fs.symlinkSync(path.dirname(other), alias);
    });
    expect(await clearStaleEndpoint(info)).toBe("removed");
    expect(probes).toEqual([path.join(real, "isolated-1.sock")]);
    expect(fs.existsSync(path.join(real, "isolated-1.sock"))).toBe(false);
    expect(fs.lstatSync(path.join(other, "isolated-1.sock")).isSocket()).toBe(true);
  });

  it("leaves a socket that replaced the probed one before the removal, and says the endpoint is unconfirmed", async () => {
    const target = pool();
    const info = controller(target);
    await staleSocket(info.socket);
    const replacement = path.join(target.root, "n.sock");
    await staleSocket(replacement);
    const ino = fs.lstatSync(replacement).ino;
    atProbe((file) => fs.renameSync(replacement, file));
    expect(await gate(clearStaleEndpoint(info))).toBe("browser-controller-endpoint-unconfirmed");
    expect(fs.lstatSync(info.socket).ino).toBe(ino);
  });

  it("reports absent, live and stale endpoints at the default sockets directory, and removes only a stale one", async () => {
    const info = controller(pool());
    expect(await endpointState(info)).toBe("absent");
    expect(await clearStaleEndpoint(info)).toBe("absent");
    const server = await listen(info.socket);
    try {
      expect(await endpointState(info)).toBe("live");
      expect(await clearStaleEndpoint(info)).toBe("live");
    } finally {
      await closeServer(server);
    }
    await staleSocket(info.socket);
    expect(await endpointState(info)).toBe("stale");
    expect(await clearStaleEndpoint(info)).toBe("removed");
    expect(fs.existsSync(info.socket)).toBe(false);
  });
});
