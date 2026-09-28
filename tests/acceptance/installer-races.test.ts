// Both com.opzero.chrome installers run concurrently as real processes: the release zip's
// scripts/install-native-host.js and the npm package's `browser-control install`. Every target is a temporary
// directory, and the real home directory's default install paths are checked before and after.
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireInstallLock, acquireInstallLockSync, InstallLockBusy, InstallLockUnsafe, manifestLockPath, type InstallLock
} from "../../src/shared/install-lock";
import { trustedPath } from "../../src/shared/trusted-path";
import { childPath } from "../server/support/children";
import { realDefaultPaths, snapshotTree } from "../server/support/packaging";
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

/** The refusal of a directory at or above the lock's parent. */
function directoryMessage(lockPath: string, at: string): string {
  return `Refusing the installer lock ${lockPath}: ${at} must be a directory owned by you or root that only its owner can write to, unless it has the sticky bit.`;
}

/** Every directory from / down to `directory`, in order. */
function chain(directory: string): string[] {
  const { root } = path.parse(directory);
  const result = [root];
  for (const part of directory.slice(root.length).split(path.sep).filter(Boolean)) result.push(path.join(result[result.length - 1], part));
  return result;
}

/** `text` as a literal in a RegExp. */
function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The staging directory an acquisition has made beside the lock, by name. */
function stagingIn(directory: string): string {
  const names = fs.readdirSync(directory).filter((name) => /^x\.lock\.[0-9a-f-]{36}\.tmp$/.test(name));
  expect(names).toHaveLength(1);
  return names[0];
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
  const zipArgs = [zipInstaller, "--extension-id", "testextensionid", "--manifest-path", manifest];
  const npmArgs = [cli, "install", "--state-dir", state, "--chrome-manifest-dir", manifests, "--json"];
  return {
    root, state, manifest, env, zipArgs, npmArgs,
    zipWrapper: path.join(state, "hosts/skill/browser-control-host"),
    npmWrapper: path.join(state, "hosts/user/browser-control-host"),
    zip: (...extra: string[]) => start([...zipArgs, ...extra], { ...env, BROWSER_CONTROL_STATE_DIR: state }),
    npm: (...extra: string[]) => start([...npmArgs, ...extra], env)
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

  it("replaces a copy that became a symlink, and deletes nothing where it pointed", async () => {
    const { root, state, zip, zipWrapper } = setup();
    expect((await zip().done).code).toBe(0);
    const copy = path.dirname(path.dirname(wrapperHost(zipWrapper)));
    const outside = path.join(root, "outside");
    fs.mkdirSync(path.join(outside, "native-host"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(outside, "native-host/host.js"), "keep");
    fs.rmSync(copy, { recursive: true });
    fs.symlinkSync(outside, copy);
    expect(await zip().done).toMatchObject({ code: 0, stderr: "" });
    expect(fs.lstatSync(copy).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(outside, "native-host/host.js"), "utf8")).toBe("keep");
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
    expect(zipResult).toMatchObject({ code: 1, stderr: `${directoryMessage(manifestLockPath(manifest), directory)}\n` });
    const npmResult = await npm().done;
    expect(npmResult.code).toBe(1);
    expect(JSON.parse(npmResult.stdout).steps.find((item: { id: string }) => item.id === "manifest"))
      .toMatchObject({ level: "fail", status: "unsafe-lock", path: directory, code: UNSAFE_CODE });
    expect(fs.readdirSync(directory)).toEqual([]);
  }, 30000);
});

describe("a manifest directory reached through a symlink", () => {
  /** `manifests` is a real 0755 directory; `link` leads to it from `holder`. */
  function linked(holderMode: number | null) {
    const context = setup();
    const manifests = path.dirname(context.manifest);
    fs.mkdirSync(manifests);
    fs.chmodSync(manifests, 0o755);
    const holder = holderMode === null ? context.root : path.join(context.root, "shared");
    if (holderMode !== null) {
      fs.mkdirSync(holder);
      fs.chmodSync(holder, holderMode);
    }
    const link = path.join(holder, "link");
    fs.symlinkSync(manifests, link);
    const given = path.join(link, "com.opzero.chrome.json");
    return {
      ...context, manifests, holder, given,
      zipThrough: (file: string) => start([zipInstaller, "--extension-id", "testextensionid", "--manifest-path", file], { ...context.env, BROWSER_CONTROL_STATE_DIR: context.state }),
      npmThrough: (directory: string) => start([cli, "install", "--state-dir", context.state, "--chrome-manifest-dir", directory, "--json"], context.env)
    };
  }

  it.each([["0770", 0o770], ["0777", 0o777]])("is refused by both installers when the symlink is in a directory with mode %s, and nothing is written", async (_mode, mode) => {
    const { manifests, holder, given, zipThrough, npmThrough } = linked(mode);
    expect(await zipThrough(given).done).toMatchObject({ code: 1, stderr: `${directoryMessage(manifestLockPath(given), holder)}\n` });
    const npmResult = await npmThrough(path.dirname(given)).done;
    expect(npmResult.code).toBe(1);
    expect(JSON.parse(npmResult.stdout).steps.find((item: { id: string }) => item.id === "manifest"))
      .toMatchObject({ level: "fail", status: "unsafe-lock", path: holder, code: UNSAFE_CODE });
    expect(fs.readdirSync(manifests)).toEqual([]);
    expect(fs.readdirSync(holder)).toEqual(["link"]);
  }, 30000);

  it("is written in its real directory by both installers when the symlink is in a trusted directory, as macOS /var is", async () => {
    const { root, manifests, given, zipThrough, npmThrough, zipWrapper, npmWrapper } = linked(null);
    // The same symlink, reached through the unresolved temporary directory (/var/folders on macOS).
    const lexical = path.join(process.env.BROWSER_CONTROL_TEST_TMPDIR || path.join(os.tmpdir(), "opencode"), path.basename(root), "link/com.opzero.chrome.json");
    for (const file of [given, lexical]) {
      const zipResult = await zipThrough(file).done;
      expect(zipResult, zipResult.stderr).toMatchObject({ code: 0, stderr: "" });
      expect(zipResult.stdout).toContain(`Installed native messaging manifest:\n${file}\n`);
      expect(JSON.parse(fs.readFileSync(path.join(manifests, "com.opzero.chrome.json"), "utf8")).path).toBe(zipWrapper);
      expect(fs.readdirSync(manifests)).toEqual(["com.opzero.chrome.json"]);
      fs.rmSync(path.join(manifests, "com.opzero.chrome.json"));
      const npmResult = await npmThrough(path.dirname(file)).done;
      expect(JSON.parse(npmResult.stdout).steps.find((item: { id: string }) => item.id === "manifest"))
        .toMatchObject({ level: "ok", status: "created", path: file });
      expect(JSON.parse(fs.readFileSync(path.join(manifests, "com.opzero.chrome.json"), "utf8")).path).toBe(npmWrapper);
      expect(fs.readdirSync(manifests)).toEqual(["com.opzero.chrome.json"]);
      fs.rmSync(path.join(manifests, "com.opzero.chrome.json"));
    }
  }, 30000);
});

describe("a manifest directory symlink repointed while an installer holds the lock", () => {
  const FOREIGN = `${JSON.stringify({ name: "com.opzero.chrome", path: "/opt/other/host", type: "stdio", allowed_origins: [] })}\n`;

  /**
   * The manifest directory is given as a symlink to `a`, which the lock accepts. `b` holds another host's
   * manifest. Once an installer holds the lock and has found no manifest in `a`, the preloaded hook points the
   * symlink at `b`, as another user who owned the symlink could, just before the temporary manifest is made.
   */
  function retarget() {
    const context = setup();
    const a = path.join(context.root, "a");
    const b = path.join(context.root, "b");
    for (const directory of [a, b]) {
      fs.mkdirSync(directory);
      fs.chmodSync(directory, 0o755);
    }
    fs.writeFileSync(path.join(b, "com.opzero.chrome.json"), FOREIGN);
    const link = path.dirname(context.manifest);
    fs.symlinkSync(a, link);
    const mark = path.join(context.root, "mark");
    const hooked = (args: string[], env: Record<string, string | undefined>) => start(["--require", childPath("child-retarget-manifest"), ...args],
      { ...env, RETARGET_LINK: link, RETARGET_TARGET: b, RETARGET_MARK: mark });
    return {
      ...context, a, b, link,
      /** The temporary manifest paths the installer opened once the symlink was repointed: exactly one, made in `a`. */
      opened: () => fs.readFileSync(mark, "utf8").split("\n").filter(Boolean),
      zipHooked: () => hooked(context.zipArgs, { ...context.env, BROWSER_CONTROL_STATE_DIR: context.state }),
      npmHooked: () => hooked(context.npmArgs, context.env)
    };
  }

  function temporaryIn(directory: string) {
    return new RegExp(`^${escaped(directory)}/\\.com\\.opzero\\.chrome\\.json\\.[0-9a-f-]{36}\\.tmp$`);
  }

  it("the zip installer classifies and writes only in the locked directory, leaves the other manifest, and refuses", async () => {
    const { a, b, link, manifest, opened, zipHooked } = retarget();
    const result = await zipHooked().done;
    expect(fs.readFileSync(path.join(b, "com.opzero.chrome.json"), "utf8")).toBe(FOREIGN);
    expect(fs.readdirSync(b)).toEqual(["com.opzero.chrome.json"]);
    expect(opened()).toEqual([expect.stringMatching(temporaryIn(a))]);
    expect(result).toMatchObject({ code: 1,
      stderr: `The native messaging manifest directory ${link} no longer resolves to ${a}, so no manifest was written. Make sure nothing else is changing it, then try again.\n` });
    expect(result.stdout).not.toContain(manifest);
    expect(fs.readdirSync(a)).toEqual([]);
  }, 30000);

  it("browser-control install classifies and writes only in the locked directory, leaves the other manifest, and refuses", async () => {
    const { a, b, manifest, opened, npmHooked } = retarget();
    const result = await npmHooked().done;
    expect(fs.readFileSync(path.join(b, "com.opzero.chrome.json"), "utf8")).toBe(FOREIGN);
    expect(fs.readdirSync(b)).toEqual(["com.opzero.chrome.json"]);
    expect(opened()).toEqual([expect.stringMatching(temporaryIn(a))]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).steps.find((item: { id: string }) => item.id === "manifest")).toEqual({
      id: "manifest", level: "fail", status: "moved", path: manifest,
      message: "The directory of the Chrome native messaging manifest changed while install was writing the manifest, so nothing was written. Make sure nothing else is changing it, then run browser-control install again."
    });
    expect(fs.readdirSync(a)).toEqual([]);
  }, 30000);
});

describe("an existing manifest that another user could change", () => {
  const UNTRUSTED = (manifest: string) => "A native messaging manifest for com.opzero.chrome is already there, but it is not a regular file owned by you that only you can write to, so another user could change it.\n"
    + `Pass --force to replace it: ${manifest}\n`;

  /** The zip installer with tests/server/support/child-foreign-owner.ts reporting `foreign` as another user's and `root` as root's. */
  function hookedZip(context: ReturnType<typeof setup>, extra: string[], owners: { foreign?: string[]; root?: string[] }) {
    return start(["--require", childPath("child-foreign-owner"), ...context.zipArgs, ...extra], {
      ...context.env, BROWSER_CONTROL_STATE_DIR: context.state,
      FOREIGN_OWNED: (owners.foreign ?? []).join(path.delimiter), ROOT_OWNED: (owners.root ?? []).join(path.delimiter)
    });
  }

  it.each(["another user's", "group-writable"] as const)("is refused by the zip installer when it is %s, even naming its own wrapper, and replaced with --force", async (kind) => {
    const context = setup();
    const { manifest, zip } = context;
    expect(await zip().done).toMatchObject({ code: 0, stderr: "" });
    const text = fs.readFileSync(manifest, "utf8");
    // Others can add entries to a directory with the sticky bit, as they can to /tmp, and the trusted-path rule accepts it.
    fs.chmodSync(path.dirname(manifest), 0o1777);
    const owners = kind === "another user's" ? { foreign: [manifest] } : {};
    if (kind === "group-writable") fs.chmodSync(manifest, 0o664);
    const ino = fs.lstatSync(manifest).ino;
    expect(await hookedZip(context, [], owners).done).toMatchObject({ code: 1, stdout: "", stderr: UNTRUSTED(manifest) });
    expect(fs.lstatSync(manifest).ino).toBe(ino);
    expect(await hookedZip(context, ["--force"], owners).done).toMatchObject({ code: 0, stderr: "" });
    expect(fs.lstatSync(manifest).ino).not.toBe(ino);
    expect(fs.lstatSync(manifest).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(manifest, "utf8")).toBe(text);
    expect(fs.readdirSync(path.dirname(manifest))).toEqual(["com.opzero.chrome.json"]);
  }, 30000);

  it("is not replaced by the zip installer, even with --force, when it is another user's in a sticky directory that is not yours", async () => {
    const context = setup();
    const { manifest, zip } = context;
    expect(await zip().done).toMatchObject({ code: 0, stderr: "" });
    const text = fs.readFileSync(manifest, "utf8");
    fs.chmodSync(path.dirname(manifest), 0o1777);
    const ino = fs.lstatSync(manifest).ino;
    const result = await hookedZip(context, ["--force"], { foreign: [manifest], root: [path.dirname(manifest)] }).done;
    expect(result).toMatchObject({ code: 1, stdout: "",
      stderr: `Refusing to replace the native messaging manifest ${manifest}: another user owns it, in a directory with the sticky bit that is not yours, so only that user or root can remove it.\n` });
    expect(fs.lstatSync(manifest).ino).toBe(ino);
    expect(fs.readFileSync(manifest, "utf8")).toBe(text);
    expect(fs.readdirSync(path.dirname(manifest))).toEqual(["com.opzero.chrome.json"]);
  }, 30000);

  it("is never read by the zip installer through a manifest directory whose `..` follows a missing directory", async () => {
    const context = setup();
    // Another user's tree: others can write to `attacker`, and it holds a manifest naming another host.
    const hosts = path.join(context.root, "attacker/hosts");
    fs.mkdirSync(hosts, { recursive: true });
    fs.writeFileSync(path.join(hosts, "com.opzero.chrome.json"), `${JSON.stringify({ name: "com.opzero.chrome", path: "/opt/other/host" })}\n`);
    fs.chmodSync(path.join(context.root, "attacker"), 0o777);
    const given = `${context.root}/gap/../attacker/hosts/com.opzero.chrome.json`;
    const result = await start([zipInstaller, "--extension-id", "testextensionid", "--manifest-path", given], { ...context.env, BROWSER_CONTROL_STATE_DIR: context.state }).done;
    expect(result).toMatchObject({ code: 1, stdout: "", stderr: `ENOENT: no such file or directory, lstat '${path.join(context.root, "gap")}'\n` });
    expect(fs.existsSync(path.join(context.root, "gap"))).toBe(false);
    expect(fs.readdirSync(hosts)).toEqual(["com.opzero.chrome.json"]);
  }, 30000);
});

describe("the state root the zip installer records", () => {
  /** Every single-quoted literal in a generated wrapper: the socket, the Node it execs and the host script. */
  function literals(wrapper: string): string[] {
    return [...fs.readFileSync(wrapper, "utf8").matchAll(/'([^']*)'/g)].map((match) => match[1]);
  }

  function zipAt(context: ReturnType<typeof setup>, stateDir: string) {
    return start(context.zipArgs, { ...context.env, BROWSER_CONTROL_STATE_DIR: stateDir });
  }

  /** A tree another user could make: their own wrapper and host where `state` would put them. */
  function attackerTree(state: string) {
    fs.mkdirSync(path.join(state, "hosts/skill"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(state, "hosts/skill/browser-control-host"), "#!/bin/sh\necho attacker\n", { mode: 0o700 });
  }

  it.each([
    ["above it", (root: string) => {
      fs.mkdirSync(path.join(root, "real"), { mode: 0o700 });
      fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));
      attackerTree(path.join(root, "attacker/state"));
      return { link: path.join(root, "link"), given: path.join(root, "link/state"), real: path.join(root, "real/state"), repoint: path.join(root, "attacker") };
    }],
    ["to it", (root: string) => {
      fs.mkdirSync(path.join(root, "real/state"), { recursive: true, mode: 0o700 });
      fs.symlinkSync(path.join(root, "real/state"), path.join(root, "link"));
      attackerTree(path.join(root, "attacker/state"));
      return { link: path.join(root, "link"), given: path.join(root, "link"), real: path.join(root, "real/state"), repoint: path.join(root, "attacker/state") };
    }]
  ])("is its real path when given through a symlink %s, on the first and the matching-copy run, and repointing that symlink changes nothing Chrome runs", async (_where, layout) => {
    const context = setup();
    const { link, given, real, repoint } = layout(context.root);
    const wrapper = path.join(real, "hosts/skill/browser-control-host");
    // The first run publishes the host copy; the second finds it matching and does not take the publish lock.
    for (let run = 0; run < 2; run += 1) {
      const result = await zipAt(context, given).done;
      expect(result, result.stderr).toMatchObject({ code: 0, stderr: "" });
      expect(result.stdout).toContain(`Host executable: ${wrapper}\n`);
      expect(result.stdout).toMatch(new RegExp(`\nHost copy: ${escaped(real)}/hosts/skill-[0-9a-f]{12}\n`));
      expect(JSON.parse(fs.readFileSync(context.manifest, "utf8")).path).toBe(wrapper);
      expect(wrapperHost(wrapper)).toMatch(new RegExp(`^${escaped(real)}/hosts/skill-[0-9a-f]{12}/native-host/host\\.js$`));
    }
    expect(fs.readdirSync(path.join(real, "hosts")).filter((name) => name.startsWith("skill-"))).toHaveLength(1);
    const manifestText = fs.readFileSync(context.manifest, "utf8");
    const wrapperText = fs.readFileSync(wrapper, "utf8");

    fs.unlinkSync(link);
    fs.symlinkSync(repoint, link);
    // Through the path given, the wrapper is now the other user's; Chrome is given only the real path.
    expect(fs.realpathSync(path.join(given, "hosts/skill/browser-control-host"))).toBe(path.join(context.root, "attacker/state/hosts/skill/browser-control-host"));
    expect(fs.readFileSync(context.manifest, "utf8")).toBe(manifestText);
    expect(fs.readFileSync(wrapper, "utf8")).toBe(wrapperText);
    for (const file of [wrapper, ...literals(wrapper)]) {
      expect(fs.realpathSync(path.dirname(file)), file).toBe(path.dirname(file));
      expect(file.startsWith(`${link}${path.sep}`), file).toBe(false);
    }
    for (const file of [wrapper, wrapperHost(wrapper)]) expect(fs.realpathSync(file)).toBe(file);
  }, 30000);

  it("refuses a state root whose symlink leads under a directory other users can write to, also once its host copy is in place, and writes nothing", async () => {
    const context = setup();
    const open = path.join(context.root, "open");
    fs.mkdirSync(path.join(open, "real"), { recursive: true, mode: 0o700 });
    fs.chmodSync(open, 0o777);
    const link = path.join(context.root, "link");
    fs.symlinkSync(path.join(open, "real"), link);
    const given = path.join(link, "state");
    const refusal = { code: 1,
      stderr: `Refusing the state directory ${given}: ${open} must be a directory owned by you or root that only its owner can write to, unless it has the sticky bit.\n` };
    expect(await zipAt(context, given).done).toMatchObject(refusal);
    expect(fs.existsSync(path.join(open, "real/state/hosts"))).toBe(false);
    expect(fs.existsSync(path.dirname(context.manifest))).toBe(false);

    // Installed while the directory was safe, the matching copy needs no publish lock: the state root is checked anyway.
    fs.chmodSync(open, 0o755);
    expect(await zipAt(context, given).done).toMatchObject({ code: 0, stderr: "" });
    const installed = snapshotTree(context.root);
    fs.chmodSync(open, 0o777);
    expect(await zipAt(context, given).done).toMatchObject(refusal);
    expect(snapshotTree(context.root)).toEqual({ ...installed, open: expect.stringMatching(/^dir 777 /) });
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
    expect(error).toMatchObject({ lockPath, path: parent, code: UNSAFE_CODE, message: directoryMessage(lockPath, parent) });
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it("refuses a parent directory that another user owns, and creates nothing in it", async () => {
    const parent = privateTemp("il-");
    const lockPath = path.join(parent, "x.lock");
    const lstat = (file: string) => (file === parent ? foreign(fs.lstatSync(file)) : fs.lstatSync(file));
    const error = await acquireInstallLock(lockPath, 200, { lstat }).catch((caught: unknown) => caught);
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

describe("the directories above the installers' lock", () => {
  it.each([["0770", 0o770], ["0707", 0o707], ["0777", 0o777]])("refuse one with mode %s and no sticky bit, and are accepted once it has the sticky bit", async (_mode, mode) => {
    const shared = path.join(privateTemp("il-"), "shared");
    const parent = path.join(shared, "manifests");
    fs.mkdirSync(parent, { recursive: true });
    fs.chmodSync(parent, 0o755);
    fs.chmodSync(shared, mode);
    const lockPath = path.join(parent, "x.lock");
    const error = await acquireInstallLock(lockPath, 200).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstallLockUnsafe);
    expect(error).toMatchObject({ lockPath, path: shared, code: UNSAFE_CODE, message: directoryMessage(lockPath, shared) });
    expect(fs.readdirSync(parent)).toEqual([]);
    fs.chmodSync(shared, mode | 0o1000);
    const lock = await acquireInstallLock(lockPath, 1000);
    expect(lock.directory.path).toBe(parent);
    lock.release();
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it("refuse one that another user owns, and accept one that root owns", async () => {
    const above = privateTemp("il-");
    const parent = path.join(above, "manifests");
    fs.mkdirSync(parent);
    fs.chmodSync(parent, 0o755);
    const lockPath = path.join(parent, "x.lock");
    const ownedBy = (uid: number) => (file: string) => (file === above ? Object.assign(fs.lstatSync(file), { uid }) : fs.lstatSync(file));
    const error = await acquireInstallLock(lockPath, 200, { lstat: ownedBy(fs.lstatSync(above).uid + 1) }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstallLockUnsafe);
    expect(error).toMatchObject({ lockPath, path: above, code: UNSAFE_CODE, message: directoryMessage(lockPath, above) });
    expect(fs.readdirSync(parent)).toEqual([]);
    const lock = await acquireInstallLock(lockPath, 1000, { lstat: ownedBy(0) });
    lock.release();
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it("are the ones on the given path and the ones its symlink resolves to, and the lock stays in the resolved ones when the symlink is repointed", async () => {
    const root = privateTemp("il-");
    const open = path.join(root, "open");
    const real = path.join(open, "manifests");
    fs.mkdirSync(real, { recursive: true });
    fs.chmodSync(real, 0o700);
    fs.chmodSync(open, 0o777);
    const link = path.join(root, "link");
    fs.symlinkSync(real, link);
    const lockPath = path.join(link, "x.lock");
    // The symlink sits in a private directory and names a private one, but others could rename the one above it.
    const error = await acquireInstallLock(lockPath, 200).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "InstallLockUnsafe", lockPath, path: open, message: directoryMessage(lockPath, open) });
    expect(fs.readdirSync(real)).toEqual([]);

    fs.chmodSync(open, 0o755);
    const checked: string[] = [];
    const lstat = (file: string) => {
      checked.push(file);
      return fs.lstatSync(file);
    };
    const lock = await acquireInstallLock(lockPath, 1000, { lstat });
    expect(lock.directory.path).toBe(real);
    // The given path up to the symlink, then the path it resolves to; nothing is looked up through the symlink.
    const walked = [...chain(root), link, ...chain(real)];
    expect(checked.slice(0, walked.length)).toEqual(walked);
    expect(checked.filter((file) => file === link || file.startsWith(`${link}${path.sep}`))).toEqual([link]);
    expect(fs.readdirSync(real)).toEqual(["x.lock"]);

    // Repointed after the check, the symlink redirects nothing: release removes the lock it made, and only it.
    const other = path.join(root, "other");
    const entry = staleEntry();
    fs.mkdirSync(path.join(other, "x.lock"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(other, "x.lock", entry), "");
    fs.unlinkSync(link);
    fs.symlinkSync(other, link);
    lock.release();
    expect(fs.readdirSync(real)).toEqual([]);
    expect(fs.readdirSync(path.join(other, "x.lock"))).toEqual([entry]);
  });

  it("include a temporary directory reached through a symlink, as macOS /var is", async () => {
    const real = privateTemp("il-");
    const given = path.join(process.env.BROWSER_CONTROL_TEST_TMPDIR || path.join(os.tmpdir(), "opencode"), path.basename(real));
    const lock = await acquireInstallLock(path.join(given, "x.lock"), 1000);
    expect(lock.directory.path).toBe(real);
    expect(fs.readdirSync(real)).toEqual(["x.lock"]);
    lock.release();
    expect(fs.readdirSync(real)).toEqual([]);
  });

  it.runIf(process.platform === "darwin")("include a macOS home directory and Chrome's NativeMessagingHosts in it (read only)", () => {
    const home = os.userInfo().homedir;
    for (const directory of [home, path.join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts")]) {
      if (fs.existsSync(directory)) expect(trustedPath(directory), directory).toMatchObject({ path: fs.realpathSync(directory) });
    }
  });
});

describe("the installers' lock staging cleanup", () => {
  it("deletes nothing through a staging path that the audit's substitution redirected", async () => {
    // `shared` stands in for /shared, which another uid can write to. No test can be a second uid, so its moves
    // run from the injected readdir, where the audit puts them: the staging directory exists and the held lock
    // was met. It renames `manifests` aside, renames the victim's private directory to the staging name, and
    // makes `manifests` a symlink to `shared`.
    const shared = path.join(privateTemp("il-"), "shared");
    const manifests = path.join(shared, "manifests");
    const victim = path.join(shared, "victim");
    fs.mkdirSync(manifests, { recursive: true });
    fs.chmodSync(shared, 0o700);
    fs.chmodSync(manifests, 0o755);
    fs.mkdirSync(victim, { mode: 0o700 });
    fs.writeFileSync(path.join(victim, "private"), "keep");
    const lockPath = path.join(manifests, "x.lock");
    const holder = await acquireInstallLock(lockPath);
    let staging = "";
    const readdir = (directory: string) => {
      const names = fs.readdirSync(directory);
      if (!staging) {
        staging = stagingIn(manifests);
        fs.renameSync(manifests, path.join(shared, "manifests-aside"));
        fs.renameSync(victim, path.join(shared, staging));
        fs.symlinkSync(".", manifests);
      }
      return names;
    };
    const error = await acquireInstallLock(lockPath, 0, { readdir }).catch((caught: unknown) => caught);
    expect(staging).not.toBe("");
    expect(fs.readdirSync(path.join(shared, staging))).toEqual(["private"]);
    expect(fs.readFileSync(path.join(shared, staging, "private"), "utf8")).toBe("keep");
    expect(error).toBeInstanceOf(InstallLockUnsafe);
    expect(error).toMatchObject({ lockPath, path: manifests, code: UNSAFE_CODE,
      message: `The directory ${manifests} that holds the installer lock ${lockPath} was replaced while this installer used it, so nothing was removed. Make sure no other installer is running, then try again.` });
    // Its own staging directory is left where the rename took it, with its entry.
    expect(fs.readdirSync(path.join(shared, "manifests-aside", staging))).toEqual([expect.stringMatching(new RegExp(`^${process.pid}-`))]);
    expect(() => holder.release()).toThrow(InstallLockUnsafe);
    expect(fs.readdirSync(path.join(shared, staging))).toEqual(["private"]);
  });

  it("deletes nothing at its staging path once another directory was renamed there", async () => {
    const root = privateTemp("il-");
    const lockPath = path.join(root, "x.lock");
    const other = path.join(root, "other");
    fs.mkdirSync(other, { mode: 0o700 });
    fs.writeFileSync(path.join(other, "private"), "keep");
    const holder = await acquireInstallLock(lockPath);
    let staging = "";
    const readdir = (directory: string) => {
      const names = fs.readdirSync(directory);
      if (!staging) {
        staging = stagingIn(root);
        fs.renameSync(path.join(root, staging), path.join(root, "aside"));
        fs.renameSync(other, path.join(root, staging));
      }
      return names;
    };
    const error = await acquireInstallLock(lockPath, 0, { readdir }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstallLockBusy);
    expect(fs.readdirSync(path.join(root, staging))).toEqual(["private"]);
    expect(fs.readdirSync(path.join(root, "aside"))).toEqual([expect.stringMatching(new RegExp(`^${process.pid}-`))]);
    holder.release();
    expect(fs.readdirSync(root).sort()).toEqual(["aside", staging].sort());
  });

  it("removes its own entry but leaves a staging directory that holds anything else", async () => {
    const root = privateTemp("il-");
    const lockPath = path.join(root, "x.lock");
    const holder = await acquireInstallLock(lockPath);
    let staging = "";
    const readdir = (directory: string) => {
      const names = fs.readdirSync(directory);
      if (!staging) {
        staging = stagingIn(root);
        fs.mkdirSync(path.join(root, staging, "another"));
        fs.writeFileSync(path.join(root, staging, "another", "file"), "keep");
      }
      return names;
    };
    const error = await acquireInstallLock(lockPath, 0, { readdir }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstallLockBusy);
    expect(fs.readdirSync(path.join(root, staging))).toEqual(["another"]);
    expect(fs.readFileSync(path.join(root, staging, "another", "file"), "utf8")).toBe("keep");
    holder.release();
    expect(fs.readdirSync(root)).toEqual([staging]);
  });
});
