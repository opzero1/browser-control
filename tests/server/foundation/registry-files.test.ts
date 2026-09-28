// fs-private.ts and lock.ts: the dir_fd registry model and the SQLite replacement for fcntl.flock (design 4.4).
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkFileStats, childDirectory, existingDirectory, fixedErrors, FsError, openDirectory, readJson, readPrivate, removeFile,
  syncDirectory, writeJson, writePrivate
} from "../../../src/server/fs-private";
import { Gate } from "../../../src/server/gate";
import { lockNow, lockUntil, lockWait } from "../../../src/server/lock";
import { monotonic } from "../../../src/server/time";
import { killChildren, startChild } from "../support/children";
import { privateTemp, removeTempRoots } from "../support/temp";

afterEach(() => {
  vi.restoreAllMocks();
  killChildren();
  removeTempRoots();
});

function gateCode(body: () => unknown): string | null {
  try {
    body();
    return null;
  } catch (error) {
    if (error instanceof Gate) return error.code;
    throw error;
  }
}

function journals(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/-(journal|wal|shm)$/.test(entry.name)) found.push(file);
    }
  };
  walk(root);
  return found;
}

describe("private registry directories and files", () => {
  it("creates owner-only directories and refuses links, foreign modes and missing parents", () => {
    const root = privateTemp();
    const dir = openDirectory(path.join(root, "a/b/c"));
    expect(fs.statSync(dir.path).mode & 0o777).toBe(0o700);
    expect(existingDirectory(path.join(root, "a/missing/c"))).toBeNull();
    expect(existingDirectory(path.join(root, "a/b/c"))?.ino).toBe(dir.ino);
    fs.symlinkSync(path.join(root, "a"), path.join(root, "link"));
    expect(() => openDirectory(path.join(root, "link/b"))).toThrow(FsError);
    expect(gateCode(() => fixedErrors(() => openDirectory(path.join(root, "link/b"))))).toBe("browser-controller-invalid-registry");
    fs.chmodSync(path.join(root, "a/b/c"), 0o750);
    expect(gateCode(() => openDirectory(path.join(root, "a/b/c")))).toBe("browser-controller-unsafe-registry");
    const child = childDirectory(openDirectory(path.join(root, "a")), "leases");
    expect(fs.statSync(child.path).mode & 0o777).toBe(0o700);
  });

  it.each([["0777", 0o777], ["0770", 0o770], ["0707", 0o707]])("checks every directory above a private directory on each use: one with mode %s refuses it and nothing is made there", (_mode, mode) => {
    const root = privateTemp();
    const shared = path.join(root, "shared");
    const state = openDirectory(path.join(shared, "state"));
    // Accepted while `shared` is private; once others can write to it, they could replace the state root.
    fs.chmodSync(shared, mode);
    for (const use of [() => openDirectory(state.path), () => existingDirectory(state.path), () => openDirectory(path.join(state.path, "pool/registry")),
      () => openDirectory(path.join(shared, "other"))]) {
      expect(gateCode(use)).toBe("browser-controller-unsafe-registry");
    }
    expect(fs.readdirSync(shared)).toEqual(["state"]);
    expect(fs.readdirSync(state.path)).toEqual([]);
    // The sticky bit lets only an entry's owner rename it, as in /tmp.
    fs.chmodSync(shared, mode | 0o1000);
    expect(openDirectory(path.join(state.path, "pool/registry")).path).toBe(path.join(state.path, "pool/registry"));
  });

  it("writes JSON atomically with Python's separators and reads it back within its limit", () => {
    const dir = openDirectory(path.join(privateTemp(), "registry"));
    writeJson(dir, "claim.json", { owner: "ses_x", lease_id: "é" });
    expect(fs.readFileSync(path.join(dir.path, "claim.json"), "utf8")).toBe("{\"owner\": \"ses_x\", \"lease_id\": \"\\u00e9\"}\n");
    expect(fs.statSync(path.join(dir.path, "claim.json")).mode & 0o777).toBe(0o600);
    expect(readJson(dir, "claim.json")).toEqual({ owner: "ses_x", lease_id: "é" });
    expect(readJson(dir, "missing.json")).toBeNull();
    writeJson(dir, "big.json", "x".repeat(40000));
    expect(gateCode(() => readJson(dir, "big.json"))).toBe("browser-controller-invalid-state");
    expect(readJson(dir, "big.json", 131072)).toHaveLength(40000);
    expect(fs.readdirSync(dir.path).filter((name) => name.startsWith(".write-"))).toEqual([]);
    removeFile(dir, "claim.json");
    removeFile(dir, "claim.json");
    expect(readJson(dir, "claim.json")).toBeNull();
  });

  it("refuses linked, shared or foreign registry files", () => {
    const dir = openDirectory(path.join(privateTemp(), "registry"));
    writeJson(dir, "claim.json", null);
    fs.linkSync(path.join(dir.path, "claim.json"), path.join(dir.path, "hard.json"));
    expect(gateCode(() => readJson(dir, "claim.json"))).toBe("browser-controller-unsafe-registry");
    fs.unlinkSync(path.join(dir.path, "hard.json"));
    fs.chmodSync(path.join(dir.path, "claim.json"), 0o640);
    expect(gateCode(() => readJson(dir, "claim.json"))).toBe("browser-controller-unsafe-registry");
    fs.symlinkSync(path.join(dir.path, "claim.json"), path.join(dir.path, "link.json"));
    expect(gateCode(() => fixedErrors(() => readJson(dir, "link.json")))).toBe("browser-controller-invalid-registry");
    expect(gateCode(() => checkFileStats(fs.lstatSync(dir.path)))).toBe("browser-controller-unsafe-registry");
    fs.writeFileSync(path.join(dir.path, "bad.json"), "{", { mode: 0o600 });
    expect(gateCode(() => fixedErrors(() => readJson(dir, "bad.json")))).toBe("browser-controller-invalid-registry");
  });

  it("reads and replaces private files with their own bound and gate", () => {
    const dir = openDirectory(path.join(privateTemp(), "host"));
    writePrivate(dir, "browser-control-host", Buffer.from("#!/bin/sh\n"), 0o700);
    expect(fs.statSync(path.join(dir.path, "browser-control-host")).mode & 0o777).toBe(0o700);
    expect(readPrivate(dir, "browser-control-host")?.toString()).toBe("#!/bin/sh\n");
    fs.chmodSync(path.join(dir.path, "browser-control-host"), 0o750);
    expect(gateCode(() => readPrivate(dir, "browser-control-host"))).toBe("browser-controller-unsafe-host-manifest");
    writePrivate(dir, "manifest.json", Buffer.from("{}"), 0o600);
    expect(readPrivate(dir, "manifest.json")?.toString()).toBe("{}");
    writePrivate(dir, "manifest.json", Buffer.alloc(65537), 0o600);
    expect(gateCode(() => readPrivate(dir, "manifest.json"))).toBe("browser-controller-unsafe-host-manifest");
    expect(readPrivate(dir, "missing.json")).toBeNull();
  });

  it("refuses a directory replaced after it was verified", () => {
    const root = privateTemp();
    const dir = openDirectory(path.join(root, "registry"));
    fs.renameSync(dir.path, path.join(root, "moved"));
    fs.mkdirSync(dir.path, { mode: 0o700 });
    expect(gateCode(() => writeJson(dir, "claim.json", null))).toBe("browser-controller-unsafe-registry");
  });

  it("fsyncs a directory without following a symlink put in its place after it was verified", () => {
    const root = privateTemp();
    const dir = openDirectory(path.join(root, "registry"));
    const elsewhere = openDirectory(path.join(root, "elsewhere"));
    const open = fs.openSync;
    const swapped: string[] = [];
    vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode | null) => {
      if (String(file) === dir.path && !swapped.length) {
        // verified() has just passed the directory; only the uid or root could make this swap.
        fs.renameSync(dir.path, path.join(root, "moved"));
        fs.symlinkSync(elsewhere.path, dir.path);
        swapped.push(String(file));
      }
      return open(file, flags, mode);
    }) as typeof fs.openSync);
    let thrown: unknown = null;
    try {
      syncDirectory(dir);
    } catch (error) {
      thrown = error;
    }
    expect(swapped).toEqual([dir.path]);
    // macOS reports the symlink as ENOTDIR under O_DIRECTORY, Linux as ELOOP.
    expect(thrown).toBeInstanceOf(FsError);
    expect(["ELOOP", "ENOTDIR"]).toContain((thrown as FsError).errno);
  });
});

describe("cross-process locks", () => {
  it("shares read locks and excludes writers within one process", async () => {
    const root = privateTemp();
    const dir = openDirectory(path.join(root, "isolated-1"));
    const first = lockNow(dir, "lease.lock", false);
    const second = lockNow(dir, "lease.lock", false);
    expect(gateCode(() => lockNow(dir, "lease.lock", true))).toBe("browser-controller-pinned");
    first.release();
    expect(gateCode(() => lockNow(dir, "lease.lock", true))).toBe("browser-controller-pinned");
    second.release();
    const exclusive = lockNow(dir, "lease.lock", true);
    expect(gateCode(() => lockNow(dir, "lease.lock", false))).toBe("browser-controller-pinned");
    exclusive.release();
    exclusive.release();
    expect(fs.statSync(path.join(dir.path, "lease.lock")).size).toBe(0);
    expect(fs.statSync(path.join(dir.path, "lease.lock")).mode & 0o777).toBe(0o600);
    expect(journals(root)).toEqual([]);
  });

  it("waits for a lock without blocking the event loop and bounds a deadline wait", async () => {
    const dir = openDirectory(path.join(privateTemp(), "isolated-1"));
    const held = lockNow(dir, "startup.lock", true);
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 5);
    const start = monotonic();
    await expect(lockUntil(dir, "startup.lock", monotonic() + 0.15)).rejects.toMatchObject({ code: "browser-controller-startup-timeout" });
    expect(monotonic() - start).toBeGreaterThanOrEqual(0.14);
    await expect(lockUntil(dir, "startup.lock", monotonic() + 0.05, "vault-busy")).rejects.toMatchObject({ code: "vault-busy" });
    const waiting = lockWait(dir, "startup.lock", false);
    setTimeout(() => held.release(), 60);
    const acquired = await waiting;
    clearInterval(ticker);
    expect(ticks).toBeGreaterThan(5);
    acquired.release();
    (await lockUntil(dir, "startup.lock", monotonic() + 1)).release();
  });

  it("refuses unsafe lock files", () => {
    const root = privateTemp();
    const dir = openDirectory(path.join(root, "isolated-1"));
    fs.writeFileSync(path.join(root, "target"), "", { mode: 0o600 });
    fs.symlinkSync(path.join(root, "target"), path.join(dir.path, "registry.lock"));
    expect(gateCode(() => fixedErrors(() => lockNow(dir, "registry.lock", true)))).toBe("browser-controller-invalid-registry");
    fs.writeFileSync(path.join(dir.path, "lease.lock"), "", { mode: 0o600 });
    fs.linkSync(path.join(dir.path, "lease.lock"), path.join(dir.path, "other.lock"));
    expect(gateCode(() => lockNow(dir, "lease.lock", false))).toBe("browser-controller-unsafe-registry");
    fs.writeFileSync(path.join(dir.path, "open.lock"), "", { mode: 0o644 });
    expect(gateCode(() => lockNow(dir, "open.lock", false))).toBe("browser-controller-unsafe-registry");
  });

  it("conflicts across processes and frees the lock when the holder exits or is killed", async () => {
    const root = privateTemp();
    const dir = openDirectory(path.join(root, "isolated-1"));
    const barrier = path.join(root, "barrier");
    const holder = startChild("child-foundation", ["lock", dir.path, "lease.lock", "shared", "hold", barrier]);
    expect(await holder.line()).toBe("held");
    const reader = startChild("child-foundation", ["lock", dir.path, "lease.lock", "shared", "exit"]);
    expect(await reader.line()).toBe("held");
    expect(await reader.exited).toBe(0);
    expect(gateCode(() => lockNow(dir, "lease.lock", true))).toBe("browser-controller-pinned");
    const writer = startChild("child-foundation", ["lock", dir.path, "lease.lock", "exclusive", "exit"]);
    expect(await writer.line()).toBe("busy browser-controller-pinned");
    fs.writeFileSync(barrier, "");
    expect(await holder.exited).toBe(0);
    lockNow(dir, "lease.lock", true).release();

    const exiting = startChild("child-foundation", ["lock", dir.path, "startup.lock", "exclusive", "exit"]);
    expect(await exiting.line()).toBe("held");
    expect(await exiting.exited).toBe(0);
    lockNow(dir, "startup.lock", true).release();

    const killed = startChild("child-foundation", ["lock", dir.path, "startup.lock", "exclusive", "kill"]);
    expect(await killed.line()).toBe("held");
    expect(gateCode(() => lockNow(dir, "startup.lock", false))).toBe("browser-controller-pinned");
    killed.process.kill("SIGKILL");
    expect(await killed.exited).toBe("SIGKILL");
    lockNow(dir, "startup.lock", true).release();
    expect(journals(root)).toEqual([]);
    expect(holder.stderr() + reader.stderr() + killed.stderr()).toBe("");
  }, 20000);

  it("grants an exclusive lock to exactly one of many racing processes", async () => {
    const root = privateTemp();
    const dir = openDirectory(path.join(root, "isolated-1"));
    const barrier = path.join(root, "barrier");
    const racers = Array.from({ length: 20 }, () => startChild("child-foundation", ["lock", dir.path, "allocation.lock", "exclusive", "hold", barrier]));
    const lines = await Promise.all(racers.map((racer) => racer.line(10000)));
    fs.writeFileSync(barrier, "");
    await Promise.all(racers.map((racer) => racer.exited));
    expect(lines.filter((line) => line === "held")).toHaveLength(1);
    expect(lines.filter((line) => line === "busy browser-controller-pinned")).toHaveLength(19);
    expect(journals(root)).toEqual([]);
  }, 30000);
});
