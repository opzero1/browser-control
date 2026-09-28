// Both com.opzero.chrome installers run concurrently as real processes: the release zip's
// scripts/install-native-host.js and the npm package's `browser-control install`. Every target is a temporary
// directory, and the real home directory's default install paths are checked before and after.
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireInstallLock, acquireInstallLockSync, InstallLockBusy, InstallLockUnsafe, manifestLockPath, type InstallLock
} from "../../src/shared/install-lock";
import { childPath } from "../server/support/children";
import { realDefaultPaths } from "../server/support/packaging";
import { privateTemp, removeTempRoots, testEnv } from "../server/support/temp";

const repository = path.resolve(__dirname, "../..");
const zipInstaller = path.join(repository, "dist/skill/browser-control/scripts/install-native-host.js");
const cli = path.join(repository, "dist/server/cli.js");
const ZIP_REFUSAL = /^A native messaging manifest for com\.opzero\.chrome already points at another host:\n {2}.+\nPass --force to replace it: .+\n$/;
/** No process has this pid: kill(2) fails with ESRCH for it on macOS and Linux. */
const DEAD_PID = 999999999;
const UNSAFE_CODE = "browser-controller-unsafe-install-lock";

function staleEntry(): string {
  return `${DEAD_PID}-${crypto.randomUUID()}`;
}

/** What lstat or stat would report if another user owned the file; tests cannot chown. */
function foreign(stats: fs.Stats): fs.Stats {
  return Object.assign(stats, { uid: stats.uid + 1 });
}

function unsafeMessage(lockPath: string, at: string): string {
  return `Refusing the installer lock ${lockPath}: ${at} must be a real directory owned by you that no other user can write to.`;
}

let defaults: Record<string, string>;
const running = new Set<ChildProcess>();

beforeAll(() => {
  defaults = realDefaultPaths();
});

afterEach(() => {
  for (const child of running) child.kill("SIGKILL");
  running.clear();
  removeTempRoots();
});

afterAll(() => {
  expect(realDefaultPaths()).toEqual(defaults);
});

interface Run { child: ChildProcess; done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> }

function start(args: string[], env: Record<string, string | undefined>): Run {
  const child = spawn(process.execPath, args, { env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
  running.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const done = new Promise<Awaited<Run["done"]>>((resolve) => child.on("exit", (code, signal) => {
    running.delete(child);
    resolve({ code, signal, stdout, stderr });
  }));
  return { child, done };
}

function setup() {
  const root = privateTemp("ir-");
  // No xcrun, cua-driver or ffmpeg on PATH, so `browser-control install` builds no clipboard guard.
  const env = testEnv(root, { PATH: path.dirname(process.execPath), BROWSER_CONTROL_STATE_DIR: undefined, BROWSER_CONTROL_HOST_SOCKET: path.join(root, "u.sock") });
  fs.mkdirSync(env.HOME as string, { mode: 0o700 });
  const state = path.join(root, "state");
  const manifests = path.join(root, "manifests");
  const manifest = path.join(manifests, "com.opzero.chrome.json");
  return {
    root, state, manifest,
    zipWrapper: path.join(state, "hosts/skill/browser-control-host"),
    npmWrapper: path.join(state, "hosts/user/browser-control-host"),
    zip: (...extra: string[]) => start([zipInstaller, "--extension-id", "testextensionid", "--manifest-path", manifest, ...extra], { ...env, BROWSER_CONTROL_STATE_DIR: state }),
    npm: (...extra: string[]) => start([cli, "install", "--state-dir", state, "--chrome-manifest-dir", manifests, "--json", ...extra], env)
  };
}

/** Record every inode each <hosts>/skill-<sha12> copy has had, and whether one that existed disappeared. */
function watchCopies(hosts: string) {
  const inodes = new Map<string, Set<number>>();
  let vanished = false;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    let names: string[] = [];
    try {
      names = fs.readdirSync(hosts).filter((name) => /^skill-[0-9a-f]{12}$/.test(name));
    } catch {
      // Not created yet.
    }
    for (const name of names) {
      try {
        const ino = fs.lstatSync(path.join(hosts, name)).ino;
        inodes.set(name, (inodes.get(name) ?? new Set()).add(ino));
      } catch {
        vanished = true;
      }
    }
    for (const name of inodes.keys()) if (!names.includes(name)) vanished = true;
    setImmediate(tick);
  };
  tick();
  return () => {
    stopped = true;
    return { copies: [...inodes.keys()], inodes: [...inodes.values()].map((set) => set.size), vanished };
  };
}

/** The host script a zip wrapper execs. */
function wrapperHost(wrapper: string): string {
  const match = /\nexec '[^']+' '([^']+)'\n$/.exec(fs.readFileSync(wrapper, "utf8"));
  if (!match) throw new Error(`not a generated wrapper: ${wrapper}`);
  return match[1];
}

async function holdLock(lockPath: string) {
  const holder = start([childPath("child-install-lock"), "hold", lockPath], process.env);
  const held = await new Promise<string>((resolve) => holder.child.stdout?.once("data", (chunk) => resolve(String(chunk))));
  expect(held).toBe("held\n");
  return holder;
}

describe("concurrent zip installers", () => {
  it("publish one host copy that no installer moves, and leave the wrapper on it", async () => {
    for (let round = 0; round < 3; round += 1) {
      const { state, zip, zipWrapper, manifest } = setup();
      fs.mkdirSync(path.join(state, "hosts"), { recursive: true, mode: 0o700 });
      fs.chmodSync(state, 0o700);
      const stop = watchCopies(path.join(state, "hosts"));
      const results = await Promise.all(Array.from({ length: 8 }, () => zip().done));
      const seen = stop();
      for (const result of results) expect(result, result.stderr).toMatchObject({ code: 0, stderr: "" });
      // One copy, published once: nothing displaced it or left its name empty while the others ran.
      expect(seen).toEqual({ copies: [expect.stringMatching(/^skill-/)], inodes: [1], vanished: false });
      expect(fs.readdirSync(path.join(state, "hosts")).sort()).toEqual(["skill", seen.copies[0]]);
      expect(wrapperHost(zipWrapper)).toBe(path.join(state, "hosts", seen.copies[0], "native-host/host.js"));
      expect(fs.existsSync(wrapperHost(zipWrapper))).toBe(true);
      expect(JSON.parse(fs.readFileSync(manifest, "utf8")).path).toBe(zipWrapper);
    }
  }, 30000);

  it("recover from installers killed at any point, and never leave the wrapper on a missing copy", async () => {
    const { state, zip, zipWrapper } = setup();
    const runs = Array.from({ length: 8 }, () => zip());
    const kills = runs.filter((_run, index) => index % 2).map((run, index) => new Promise<void>((resolve) => setTimeout(() => {
      run.child.kill("SIGKILL");
      resolve();
    }, 30 + index * 25)));
    await Promise.all(kills);
    const results = await Promise.all(runs.map((run) => run.done));
    for (const [index, result] of results.entries()) if (index % 2 === 0) expect(result, result.stderr).toMatchObject({ code: 0, stderr: "" });
    expect(fs.existsSync(wrapperHost(zipWrapper))).toBe(true);
    // A later installer is not blocked by a lock that a killed one held.
    const started = performance.now();
    expect((await zip().done).code).toBe(0);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(fs.existsSync(path.join(state, "hosts/.skill-publish.lock"))).toBe(false);
  }, 30000);

  it("moves a copy that differs aside, and deletes it only once the new copy is in place", async () => {
    const { state, zip, zipWrapper } = setup();
    expect((await zip().done).code).toBe(0);
    const host = wrapperHost(zipWrapper);
    fs.appendFileSync(host, "// changed\n");
    const damaged = fs.lstatSync(path.dirname(path.dirname(host))).ino;
    expect((await zip().done).code).toBe(0);
    expect(fs.lstatSync(path.dirname(path.dirname(host))).ino).not.toBe(damaged);
    expect(fs.readFileSync(host, "utf8")).not.toContain("// changed");
    expect(fs.readdirSync(path.join(state, "hosts")).filter((name) => name.startsWith("."))).toEqual([]);
  });
});

describe("the zip installer and browser-control install on one manifest", () => {
  /** Start both installers while a live process holds the manifest lock, so each finds the manifest absent first. */
  async function raceAtTheLock(npmFlags: string[]) {
    const context = setup();
    const { manifest, zip, npm, zipWrapper, npmWrapper } = context;
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    const holder = await holdLock(manifestLockPath(manifest));
    const zipRun = zip();
    const npmRun = npm(...npmFlags);
    await expect.poll(() => fs.existsSync(zipWrapper) && fs.existsSync(npmWrapper), { timeout: 8000 }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fs.existsSync(manifest)).toBe(false);
    holder.child.stdin?.end();
    const [zipResult, npmResult] = await Promise.all([zipRun.done, npmRun.done]);
    const npmManifest = JSON.parse(npmResult.stdout).steps.find((item: { id: string }) => item.id === "manifest");
    const owner = JSON.parse(fs.readFileSync(manifest, "utf8")).path;
    expect(fs.existsSync(manifestLockPath(manifest))).toBe(false);
    return { ...context, zipResult, npmManifest, owner };
  }

  it("both find the manifest absent before either writes it: exactly one wins and the other refuses", async () => {
    for (let round = 0; round < 3; round += 1) {
      const { zipResult, npmManifest, owner, zipWrapper, npmWrapper } = await raceAtTheLock([]);
      if (owner === zipWrapper) {
        expect(zipResult).toMatchObject({ code: 0, stderr: "" });
        expect(npmManifest).toMatchObject({ level: "fail", status: "conflict", previous: zipWrapper });
      } else {
        expect(owner).toBe(npmWrapper);
        expect(npmManifest).toMatchObject({ level: "ok", status: "created" });
        expect(zipResult.code).toBe(1);
        expect(zipResult.stderr).toMatch(ZIP_REFUSAL);
        expect(zipResult.stderr).toContain(`\n  ${npmWrapper}\n`);
      }
    }
  }, 30000);

  it("still lets --force replace the other installer's manifest under the lock", async () => {
    const { zipResult, npmManifest, owner, zipWrapper, npmWrapper } = await raceAtTheLock(["--force"]);
    expect(owner).toBe(npmWrapper);
    if (zipResult.code === 0) expect(npmManifest).toMatchObject({ level: "ok", status: "replaced", previous: zipWrapper });
    else expect(npmManifest).toMatchObject({ level: "ok", status: "created" });
  }, 30000);

  it("run freely at once: exactly one of them owns the manifest, and the other says so", async () => {
    for (let round = 0; round < 8; round += 1) {
      const { manifest, zip, npm, zipWrapper, npmWrapper } = setup();
      // browser-control install starts more slowly, so the zip installer starts 0 to 210 ms after it.
      const npmRun = npm();
      const zipRun = await new Promise<Run>((resolve) => setTimeout(() => resolve(zip()), round * 30));
      const [zipResult, npmResult] = await Promise.all([zipRun.done, npmRun.done]);
      const npmManifest = JSON.parse(npmResult.stdout).steps.find((item: { id: string }) => item.id === "manifest");
      const owner = JSON.parse(fs.readFileSync(manifest, "utf8")).path;
      expect([zipWrapper, npmWrapper]).toContain(owner);
      expect(zipResult.code === 0).toBe(owner === zipWrapper);
      expect(npmManifest.level === "ok").toBe(owner === npmWrapper);
      if (owner === zipWrapper) expect(npmManifest).toMatchObject({ status: "conflict", previous: zipWrapper });
      else expect(zipResult.stderr).toMatch(ZIP_REFUSAL);
    }
  }, 30000);

  it("go ahead after a lock holder was killed with SIGKILL", async () => {
    const { manifest, zip, npm, npmWrapper, state } = setup();
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    for (const lockPath of [manifestLockPath(manifest), path.join(state, "hosts/.skill-publish.lock")]) {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
      const holder = await holdLock(lockPath);
      holder.child.kill("SIGKILL");
      await holder.done;
      expect(fs.readdirSync(lockPath)).toEqual([expect.stringMatching(new RegExp(`^${holder.child.pid}-`))]);
    }
    const started = performance.now();
    expect(await zip().done).toMatchObject({ code: 0, stderr: "" });
    fs.rmSync(manifest);
    const holder = await holdLock(manifestLockPath(manifest));
    holder.child.kill("SIGKILL");
    await holder.done;
    const installed = await npm().done;
    expect(JSON.parse(installed.stdout).steps.find((item: { id: string }) => item.id === "manifest")).toMatchObject({ level: "ok", status: "created" });
    expect(JSON.parse(fs.readFileSync(manifest, "utf8")).path).toBe(npmWrapper);
    expect(performance.now() - started).toBeLessThan(8000);
    expect(fs.readdirSync(path.dirname(manifest))).toEqual(["com.opzero.chrome.json"]);
  }, 30000);

  it("both refuse a manifest directory that other users can write to, and write nothing in it", async () => {
    const { manifest, zip, npm } = setup();
    const directory = path.dirname(manifest);
    fs.mkdirSync(directory);
    fs.chmodSync(directory, 0o777);
    const zipResult = await zip().done;
    expect(zipResult).toMatchObject({ code: 1, stderr: `${unsafeMessage(manifestLockPath(manifest), directory)}\n` });
    const npmResult = await npm().done;
    expect(npmResult.code).toBe(1);
    expect(JSON.parse(npmResult.stdout).steps.find((item: { id: string }) => item.id === "manifest"))
      .toMatchObject({ level: "fail", status: "unsafe-lock", path: directory, code: UNSAFE_CODE });
    expect(fs.readdirSync(directory)).toEqual([]);
  }, 30000);
});

describe("the installers' lock", () => {
  it("excludes a second holder until the first releases it", async () => {
    const lockPath = path.join(privateTemp("il-"), "x.lock");
    const first = await acquireInstallLock(lockPath);
    let second: Awaited<ReturnType<typeof acquireInstallLock>> | null = null;
    const waiting = acquireInstallLock(lockPath).then((lock) => { second = lock; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(second).toBeNull();
    first.release();
    await waiting;
    expect(second).not.toBeNull();
    second!.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("keeps a live holder's lock and names that process when it gives up", async () => {
    const lockPath = path.join(privateTemp("il-"), "x.lock");
    const holder = await holdLock(lockPath);
    const error = await acquireInstallLock(lockPath, 300).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstallLockBusy);
    expect(error).toMatchObject({ lockPath, holder: holder.child.pid });
    expect((error as Error).message).toBe(`Another installer is using ${lockPath} (process ${holder.child.pid}). If no installer is running, remove that directory and try again.`);
    holder.child.stdin?.end();
    await holder.done;
    (await acquireInstallLock(lockPath)).release();
  });

  it("removes only entries of processes that are gone, and never an entry it cannot attribute", async () => {
    const lockPath = path.join(privateTemp("il-"), "x.lock");
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "not-an-installer"), "");
    const error = await acquireInstallLock(lockPath, 200).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ holder: null });
    expect(fs.readdirSync(lockPath)).toEqual(["not-an-installer"]);
    // An empty lock directory is never held, so it is taken.
    fs.rmSync(path.join(lockPath, "not-an-installer"));
    const lock = await acquireInstallLock(lockPath, 1000);
    expect(fs.readdirSync(lockPath)).toEqual([expect.stringMatching(new RegExp(`^${process.pid}-`))]);
    lock.release();
    expect(fs.readdirSync(path.dirname(lockPath))).toEqual([]);
  });

  it("refuses a lock path that is a symlink, and removes nothing where it points", async () => {
    const root = privateTemp("il-");
    const outside = path.join(root, "outside");
    const entry = staleEntry();
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.writeFileSync(path.join(outside, entry), "");
    const lockPath = path.join(root, "x.lock");
    fs.symlinkSync(outside, lockPath);
    const error = await acquireInstallLock(lockPath, 200).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstallLockUnsafe);
    expect(error).toMatchObject({ lockPath, path: lockPath, code: UNSAFE_CODE, message: unsafeMessage(lockPath, lockPath) });
    expect(fs.readdirSync(outside)).toEqual([entry]);
    expect(fs.readdirSync(root).sort()).toEqual(["outside", "x.lock"]);
  });

  it.each([
    ["a regular file", "file"],
    ["a directory its group can write to", 0o770],
    ["a directory other users can write to", 0o707],
    ["another user's directory", "foreign"]
  ] as const)("refuses a lock that is %s, and removes nothing in it", async (_name, kind) => {
    const lockPath = path.join(privateTemp("il-"), "x.lock");
    const entry = staleEntry();
    if (kind === "file") {
      fs.writeFileSync(lockPath, "");
    } else {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      fs.writeFileSync(path.join(lockPath, entry), "");
      if (typeof kind === "number") fs.chmodSync(lockPath, kind);
    }
    const lstat = (file: string) => (kind === "foreign" && file === lockPath ? foreign(fs.lstatSync(file)) : fs.lstatSync(file));
    const error = await acquireInstallLock(lockPath, 200, { lstat }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstallLockUnsafe);
    expect(error).toMatchObject({ lockPath, path: lockPath, code: UNSAFE_CODE });
    if (kind !== "file") expect(fs.readdirSync(lockPath)).toEqual([entry]);
    expect(fs.readdirSync(path.dirname(lockPath))).toEqual(["x.lock"]);
  });

  it.each([["0770", 0o770], ["0707", 0o707], ["0777", 0o777]])("refuses a parent directory with mode %s and no sticky bit, and creates nothing in it", async (_mode, mode) => {
    const parent = path.join(privateTemp("il-"), "shared");
    fs.mkdirSync(parent);
    fs.chmodSync(parent, mode);
    const lockPath = path.join(parent, "x.lock");
    const error = await acquireInstallLock(lockPath, 200).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstallLockUnsafe);
    expect(error).toMatchObject({ lockPath, path: parent, code: UNSAFE_CODE, message: unsafeMessage(lockPath, parent) });
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it("refuses a parent directory that another user owns, and creates nothing in it", async () => {
    const parent = privateTemp("il-");
    const lockPath = path.join(parent, "x.lock");
    const stat = (file: string) => (file === parent ? foreign(fs.statSync(file)) : fs.statSync(file));
    const error = await acquireInstallLock(lockPath, 200, { stat }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstallLockUnsafe);
    expect(error).toMatchObject({ lockPath, path: parent });
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it("refuses another user's lock in a sticky directory that everyone can write to", async () => {
    const parent = path.join(privateTemp("il-"), "shared");
    fs.mkdirSync(parent);
    fs.chmodSync(parent, 0o1777);
    const lockPath = path.join(parent, "x.lock");
    const entry = staleEntry();
    fs.mkdirSync(lockPath, { mode: 0o700 });
    fs.writeFileSync(path.join(lockPath, entry), "");
    const lstat = (file: string) => (file === lockPath ? foreign(fs.lstatSync(file)) : fs.lstatSync(file));
    const error = await acquireInstallLock(lockPath, 200, { lstat }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "InstallLockUnsafe", path: lockPath });
    expect(fs.readdirSync(lockPath)).toEqual([entry]);
  });

  // Chrome's NativeMessagingHosts directory is normally 0755 and the state root 0700.
  it.each([["0700", 0o700], ["0755", 0o755], ["01777", 0o1777]])("takes the lock in a parent directory it owns with mode %s", async (_mode, mode) => {
    const parent = path.join(privateTemp("il-"), "manifests");
    fs.mkdirSync(parent);
    fs.chmodSync(parent, mode);
    const lockPath = path.join(parent, "x.lock");
    const lock = await acquireInstallLock(lockPath, 1000);
    expect(fs.readdirSync(lockPath)).toEqual([expect.stringMatching(new RegExp(`^${process.pid}-`))]);
    lock.release();
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it("never removes an entry through a lock path that became a symlink after it was checked", async () => {
    const root = privateTemp("il-");
    const lockPath = path.join(root, "x.lock");
    const aside = path.join(root, "aside");
    const outside = path.join(root, "outside");
    const entry = staleEntry();
    for (const directory of [lockPath, outside]) {
      fs.mkdirSync(directory, { mode: 0o700 });
      fs.writeFileSync(path.join(directory, entry), "");
    }
    // Once the lock directory is checked and listed, its path is pointed at another directory.
    const readdir = (directory: string) => {
      const names = fs.readdirSync(directory);
      fs.renameSync(lockPath, aside);
      fs.symlinkSync(outside, lockPath);
      return names;
    };
    const error = await acquireInstallLock(lockPath, 0, { readdir }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "InstallLockUnsafe", path: lockPath });
    expect(fs.readdirSync(outside)).toEqual([entry]);
    expect(fs.readdirSync(aside)).toEqual([entry]);
  });

  it("removes nothing from a lock directory that replaced the one it listed, and checks the new one first", async () => {
    const root = privateTemp("il-");
    const lockPath = path.join(root, "x.lock");
    const aside = path.join(root, "aside");
    const entry = staleEntry();
    fs.mkdirSync(lockPath, { mode: 0o700 });
    fs.writeFileSync(path.join(lockPath, entry), "");
    let replaced = false;
    const readdir = (directory: string) => {
      const names = fs.readdirSync(directory);
      if (!replaced) {
        replaced = true;
        fs.renameSync(lockPath, aside);
        fs.mkdirSync(lockPath, { mode: 0o700 });
        fs.writeFileSync(path.join(lockPath, entry), "");
      }
      return names;
    };
    const error = await acquireInstallLock(lockPath, 0, { readdir }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstallLockBusy);
    expect(fs.readdirSync(aside)).toEqual([entry]);
    expect(fs.readdirSync(lockPath)).toEqual([entry]);
    // The next attempt checks the directory now at the path before it removes that stale entry.
    const lock = await acquireInstallLock(lockPath, 1000, { readdir });
    expect(fs.readdirSync(lockPath)).toEqual([expect.stringMatching(new RegExp(`^${process.pid}-`))]);
    lock.release();
    expect(fs.readdirSync(root)).toEqual(["aside"]);
  });

  it("releases nothing through a lock path that was replaced while the lock was held", async () => {
    const root = privateTemp("il-");
    const lockPath = path.join(root, "x.lock");
    const lock = await acquireInstallLock(lockPath);
    const held = fs.readdirSync(lockPath);
    fs.renameSync(lockPath, path.join(root, "aside"));
    fs.mkdirSync(lockPath, { mode: 0o700 });
    let error: unknown = null;
    try {
      lock.release();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InstallLockUnsafe);
    expect(error).toMatchObject({ lockPath, path: lockPath, code: UNSAFE_CODE,
      message: `The installer lock ${lockPath} was replaced while this installer held it, so nothing was removed. Make sure no other installer is running, then try again.` });
    expect(fs.readdirSync(path.join(root, "aside"))).toEqual(held);
    expect(fs.readdirSync(lockPath)).toEqual([]);
  });

  it("lets exactly one of two waiters that found the same stale entry take the lock", async () => {
    const lockPath = path.join(privateTemp("il-"), "x.lock");
    const stale = staleEntry();
    fs.mkdirSync(lockPath, { mode: 0o700 });
    fs.writeFileSync(path.join(lockPath, stale), "");
    const listings: string[][] = [];
    let first: InstallLock | undefined;
    // The second waiter lists the stale entry. Before it removes anything, the first waiter lists the same
    // entry, removes it, and takes the emptied lock.
    const readdir = (directory: string) => {
      const names = fs.readdirSync(directory);
      if (!first) {
        listings.push(names);
        first = acquireInstallLockSync(lockPath, 1000, {
          readdir: (inner: string) => {
            const listed = fs.readdirSync(inner);
            listings.push(listed);
            return listed;
          }
        });
      }
      return names;
    };
    const second = await acquireInstallLock(lockPath, 100, { readdir }).catch((caught: unknown) => caught);
    expect(listings).toEqual([[stale], [stale]]);
    expect(first).toBeDefined();
    expect(second).toBeInstanceOf(InstallLockBusy);
    expect(second).toMatchObject({ holder: process.pid });
    expect(fs.readdirSync(lockPath)).toEqual([expect.stringMatching(new RegExp(`^${process.pid}-`))]);
    first!.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
