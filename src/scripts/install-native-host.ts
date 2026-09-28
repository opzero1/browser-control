#!/usr/bin/env node
// Installs the com.opzero.chrome manifest for this skill's native host. Chrome never depends on this skill's own
// directory, which may be an extracted zip, a checkout, a package cache or a stable copy: the host is published as
// a content-addressed copy under the Browser Control state root, and the wrapper there execs this exact Node.
// Nothing is written into the skill's directory; scripts/extension-id.json is the build's default ID.
//
// The state root, the manifest directory and the socket are used by their canonical paths, once the paths given
// pass the trusted-path rule (src/shared/trusted-path.ts), and the manifest is written in the canonical directory
// the manifest lock checked. So the wrapper path in the manifest and every path in the wrapper stay the same when
// a symlink in a given path is repointed afterwards.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Effect } from "effect";
import {
  acquireInstallLockSync, created, InstallLockUnsafe, manifestLockPath, removeCreated, stillResolves, unchangedAt, type Created, type TrustedDirectory
} from "../shared/install-lock";
import { existingManifest, namedHost } from "../shared/manifest-file";
import { canonicalSocketPath, trustedPath } from "../shared/trusted-path";
import { argValue, runScript, ScriptIo } from "./effect-services";

const root = path.resolve(__dirname, "..");
const hostName = "com.opzero.chrome";
const hostEntry = "native-host/host.js";
const wrapperName = process.platform === "win32" ? "browser-control-host.cmd" : "browser-control-host";
const force = process.argv.includes("--force");
/** Serializes this installer's publications into <state>/hosts; the server's own copies use .publish.lock there. */
const publishLock = ".skill-publish.lock";

/** A refusal with a message for the user; nothing is written after one. */
class InstallError extends Error {}

function chromeManifestPath() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", `${hostName}.json`);
  }
  if (process.platform === "linux") {
    return path.join(os.homedir(), ".config", "google-chrome", "NativeMessagingHosts", `${hostName}.json`);
  }
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Local", "opzero-chrome", `${hostName}.json`);
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

function registerWindowsManifest(manifestPath: string) {
  return Effect.gen(function* () {
    if (process.platform !== "win32") return;
    const io = yield* ScriptIo;
    const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`;
    yield* io.execFileInherit("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]);
  });
}

/** BROWSER_CONTROL_STATE_DIR, default ~/.local/state/browser-control: the same root the MCP server uses. */
function stateRoot() {
  const configured = process.env.BROWSER_CONTROL_STATE_DIR;
  if (configured && !path.isAbsolute(configured)) throw new InstallError("BROWSER_CONTROL_STATE_DIR must be an absolute path.");
  return configured ? path.normalize(configured) : path.join(os.homedir(), ".local", "state", "browser-control");
}

function isPrivate(stats: fs.Stats) {
  return process.platform === "win32" || (stats.uid === process.getuid?.() && (stats.mode & 0o077) === 0);
}

/** `dir`, not followed, is a private directory; with `expected`, it is still that directory. */
function privateAt(dir: string, expected?: TrustedDirectory): TrustedDirectory {
  const stats = fs.lstatSync(dir);
  if (!stats.isDirectory() || !isPrivate(stats) || (expected && (stats.dev !== expected.dev || stats.ino !== expected.ino))) {
    throw new InstallError(`Refusing a directory that is not private to you: ${dir}`);
  }
  return { path: dir, dev: stats.dev, ino: stats.ino };
}

/**
 * The canonical path of the state root `dir`, once it passes the trusted-path rule and is private to you. Missing
 * directories are made with mode 0700, each only inside a directory that passed. Then no other user can rename
 * anything on that path.
 */
function stateDirectory(dir: string): TrustedDirectory {
  const checked = trustedPath(dir, { create: 0o700 });
  if ("unsafe" in checked) {
    throw new InstallError(`Refusing the state directory ${dir}: ${checked.unsafe} must be a directory owned by you or root that only its owner can write to, unless it has the sticky bit.`);
  }
  return privateAt(checked.path, checked);
}

/** <parent>/<name>, made with mode 0700 if missing: a private directory, not a symlink, in a checked parent. */
function privateChild(parent: TrustedDirectory, name: string): TrustedDirectory {
  const dir = path.join(parent.path, name);
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return privateAt(dir);
}

function sameDirectory(a: TrustedDirectory, b: TrustedDirectory) {
  return a.path === b.path && a.dev === b.dev && a.ino === b.ino;
}

/** The host entry and every chunk it requires, by path relative to the skill root. */
function hostFiles() {
  const files = new Map<string, Buffer>();
  const pending = [hostEntry];
  while (pending.length) {
    const relative = pending.pop() as string;
    if (files.has(relative)) continue;
    const data = fs.readFileSync(path.join(root, relative));
    files.set(relative, data);
    for (const match of data.toString("utf8").matchAll(/require\("(\.\.?\/[^"]+\.js)"\)/g)) {
      const required = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
      if (required.startsWith("../")) throw new InstallError(`The native host requires a file outside the skill: ${match[1]}`);
      pending.push(required);
    }
  }
  return files;
}

function digest(files: ReadonlyMap<string, Buffer>) {
  const hash = crypto.createHash("sha256");
  for (const [relative, data] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(`${relative}\0${data.length}\0`);
    hash.update(data);
  }
  return hash.digest("hex");
}

function listFiles(dir: string, prefix = ""): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...listFiles(dir, relative));
    else result.push(relative);
  }
  return result;
}

type TreeState = "absent" | "matches" | "differs";

/**
 * Whether `target` is a private directory holding exactly `files`, each a private regular file with the same
 * bytes. An error other than a missing target is thrown, so a copy is only ever called different once it has
 * been read.
 */
function treeState(target: string, files: ReadonlyMap<string, Buffer>): TreeState {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (!stats.isDirectory() || !isPrivate(stats)) return "differs";
  const present = listFiles(target);
  if (present.length !== files.size) return "differs";
  for (const relative of present) {
    const expected = files.get(relative);
    const file = path.join(target, relative);
    const entry = fs.lstatSync(file);
    if (expected === undefined || !entry.isFile() || !isPrivate(entry) || !fs.readFileSync(file).equals(expected)) return "differs";
  }
  return "matches";
}

/** Create `file` with `data`; if writing fails, the file is removed while it is still the one made here. */
function writeNew(file: string, data: string | Buffer, mode: number): Created {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
  let made: Created | null = null;
  try {
    made = created(file, fs.fstatSync(fd));
    fs.writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, mode);
  } catch (error) {
    fs.closeSync(fd);
    if (made) removeCreated([made]);
    throw error;
  }
  fs.closeSync(fd);
  return made;
}

function makeDirectory(dir: string): Created {
  fs.mkdirSync(dir, { mode: 0o700 });
  return created(dir, fs.lstatSync(dir));
}

/**
 * Publish `files` as <hosts>/<name>/. Publications are serialized by a lock in `hosts`, and the target is
 * checked again under it, so a matching copy that another installer published (and Chrome may be running) is
 * never moved or deleted. Returns the published directory.
 */
function publishTree(hosts: TrustedDirectory, name: string, files: ReadonlyMap<string, Buffer>) {
  const target = path.join(hosts.path, name);
  let current: TreeState | null = null;
  try {
    current = treeState(target, files);
  } catch {
    // Read again under the lock.
  }
  if (current !== "matches") {
    const lock = acquireInstallLockSync(path.join(hosts.path, publishLock));
    try {
      if (!sameDirectory(lock.directory, hosts)) throw new InstallError(`${hosts.path} was replaced while this installer used it, so no host copy was written.`);
      const state = treeState(target, files);
      if (state !== "matches") replaceTree(lock.directory, name, files, state === "differs");
    } finally {
      lock.release();
    }
  }
  if (!unchangedAt(hosts.path, hosts) || treeState(target, files) !== "matches") throw new InstallError(`Could not verify the native host copy: ${target}`);
  return target;
}

/**
 * Under the publish lock, in `hosts`: write the new copy into a private staging directory made here, then
 * rename it to `name`. A copy that differs is first moved into that staging directory, and deleted only once
 * the new copy is in place; if the new copy cannot be renamed in, the old one is put back.
 *
 * What was written is removed one entry at a time, each only while it is still what was made. The displaced
 * copy may hold anything, so it is the one tree removed recursively, and only inside the staging directory,
 * once `hosts` and the staging directory are verified to be the directories that were checked and made.
 */
function replaceTree(hosts: TrustedDirectory, name: string, files: ReadonlyMap<string, Buffer>, moveAside: boolean) {
  const target = path.join(hosts.path, name);
  const staging = makeDirectory(path.join(hosts.path, `.tmp-${crypto.randomUUID()}`));
  const copy = path.join(staging.path, "copy");
  const displaced = path.join(staging.path, "old");
  const intact = () => unchangedAt(hosts.path, hosts) && unchangedAt(staging.path, staging);
  // In the order they were made, so reversed each file comes before its directory.
  const made: Created[] = [staging];
  let moved = false;
  let placed = false;
  try {
    made.push(makeDirectory(copy));
    for (const [relative, data] of files) {
      const parts = relative.split("/");
      for (let depth = 1; depth < parts.length; depth += 1) {
        const dir = path.join(copy, ...parts.slice(0, depth));
        if (!made.some((item) => item.path === dir)) made.push(makeDirectory(dir));
      }
      made.push(writeNew(path.join(copy, ...parts), data, 0o600));
    }
    if (moveAside) {
      if (!intact()) throw new InstallError(`${hosts.path} changed while the native host copy was being replaced; nothing was moved.`);
      fs.renameSync(target, displaced);
      moved = true;
    }
    try {
      fs.renameSync(copy, target);
      placed = true;
    } catch (error) {
      if (moved) {
        try {
          fs.renameSync(displaced, target);
          moved = false;
        } catch {
          // The old copy stays in the staging directory; nothing deletes it.
        }
      }
      throw error;
    }
  } finally {
    if (placed && moved && intact()) fs.rmSync(displaced, { recursive: true, force: true });
    // Once placed, the new copy's entries are the target's, so only the staging directory is left to remove.
    removeCreated((placed ? [staging] : made).slice().reverse(), hosts);
  }
}

/** The Node running this installer, which the wrapper execs; never a PATH lookup or a fixed location. */
function nodeExecutable() {
  const node = process.execPath;
  try {
    if (!path.isAbsolute(node) || !fs.statSync(node).isFile()) throw new Error("not a file");
    if (process.platform !== "win32") fs.accessSync(node, fs.constants.X_OK);
  } catch {
    throw new InstallError(`The running Node.js is not an absolute executable file: ${node}`);
  }
  return node;
}

/** A single-quoted sh literal: `$`, backticks and backslashes stay literal; an apostrophe or control character is refused. */
function shellLiteral(value: string) {
  if (value.includes("'") || /[\x00-\x1f\x7f]/.test(value)) {
    throw new InstallError(`Refusing a path with an apostrophe or a control character: ${JSON.stringify(value)}`);
  }
  return `'${value}'`;
}

/** A value for inside double quotes in a batch file: `%` is doubled so it expands no variable. */
function cmdValue(value: string) {
  if (value.includes("\"") || /[\x00-\x1f\x7f]/.test(value)) {
    throw new InstallError(`Refusing a path with a quote or a control character: ${JSON.stringify(value)}`);
  }
  return value.replace(/%/g, "%%");
}

function launcher(node: string, host: string, socketPath: string | null) {
  if (process.platform === "win32") {
    const socketSet = socketPath ? `set "BROWSER_CONTROL_HOST_SOCKET=${cmdValue(socketPath)}"\r\n` : "";
    return `@echo off\r\n${socketSet}"${cmdValue(node)}" "${cmdValue(host)}"\r\n`;
  }
  const socketExport = socketPath ? `export BROWSER_CONTROL_HOST_SOCKET=${shellLiteral(socketPath)}\n` : "";
  return `#!/bin/sh\n${socketExport}exec ${shellLiteral(node)} ${shellLiteral(host)}\n`;
}

/**
 * Replace <directory>/<name> atomically with `text`: a temporary file beside it, then a rename. Just before the
 * rename, `intact` must hold; otherwise `refusal` is thrown. Only the temporary file is ever removed, and only
 * while it is still the one written here.
 */
function replaceFile(directory: TrustedDirectory, name: string, text: string, mode: number, intact: () => boolean, refusal: string) {
  const temporary = writeNew(path.join(directory.path, `.${name}.${crypto.randomUUID()}.tmp`), text, mode);
  try {
    if (!intact()) throw new InstallError(refusal);
    fs.renameSync(temporary.path, path.join(directory.path, name));
  } catch (error) {
    removeCreated([temporary], directory);
    throw error;
  }
}

/**
 * Refuse the manifest at `file` unless it is absent or this installer's own: a trusted file
 * (src/shared/manifest-file.ts) that names `wrapper`. With --force, anything else is replaced, except another
 * user's entry in a sticky directory that is not this user's, which only they or root can remove. `manifestPath`
 * is the path the user gave.
 */
function refuseExisting(file: string, wrapper: string, manifestPath = file) {
  const existing = existingManifest(file);
  if (existing.kind === "absent") return;
  const previous = namedHost(existing.text);
  if (existing.trusted && previous === wrapper) return;
  if (!force && !existing.trusted) {
    throw new InstallError(`A native messaging manifest for ${hostName} is already there, but it is not a regular file owned by you that only you can write to, so another user could change it.\n`
      + `Pass --force to replace it: ${manifestPath}`);
  }
  if (!force) {
    throw new InstallError(`A native messaging manifest for ${hostName} already points at another host:\n  ${previous ?? "(unreadable)"}\n`
      + `Pass --force to replace it: ${manifestPath}`);
  }
  if (!existing.replaceable) {
    throw new InstallError(`Refusing to replace the native messaging manifest ${manifestPath}: another user owns it, in a directory with the sticky bit that is not yours, so only that user or root can remove it.`);
  }
}

function install(extensionId: string, manifestPath: string, socketPath: string | null) {
  // process.execPath has its symlinks resolved.
  const node = nodeExecutable();
  // Real paths, checked from / down: the wrapper, the host copy it execs and the manifest's path are all under them.
  const hosts = privateChild(stateDirectory(stateRoot()), "hosts");
  const files = hostFiles();
  const copyName = `skill-${digest(files).slice(0, 12)}`;
  const copyDir = path.join(hosts.path, copyName);
  const wrapper = path.join(hosts.path, "skill", wrapperName);
  // The host checks its socket's directory again when it starts; the wrapper names the socket by its canonical path.
  const socket = socketPath && process.platform !== "win32" ? canonicalSocketPath(socketPath) : socketPath;
  const text = launcher(node, path.join(copyDir, ...hostEntry.split("/")), socket);
  const given = path.dirname(manifestPath);
  const name = path.basename(manifestPath);
  // The unlocked check, like every later step, reads only the manifest directory's canonical path. A missing
  // directory was checked only up to its first missing part, so nothing is read through it.
  const directory = trustedPath(given, { missing: true });
  if ("unsafe" in directory) throw new InstallLockUnsafe(manifestLockPath(manifestPath), directory.unsafe, "directory");
  if (!("missing" in directory)) refuseExisting(path.join(directory.path, name), wrapper, manifestPath);
  publishTree(hosts, copyName, files);
  const wrapperDir = privateChild(hosts, "skill");
  // The wrapper names the copy only after that copy is verified in place.
  replaceFile(wrapperDir, wrapperName, text, 0o700, () => unchangedAt(wrapperDir.path, wrapperDir),
    `${wrapperDir.path} was replaced while this installer used it, so the wrapper was not written.`);
  const manifest = {
    name: hostName,
    description: "Browser Control native messaging host",
    type: "stdio",
    path: wrapper,
    allowed_origins: [`chrome-extension://${extensionId}/`]
  };
  // 0755 whatever the umask: the lock refuses a directory that group or others can write to.
  const made = trustedPath(directory.path, { create: 0o755 });
  if ("unsafe" in made) throw new InstallLockUnsafe(manifestLockPath(manifestPath), made.unsafe, "directory");
  const moved = `The native messaging manifest directory ${given} no longer resolves to ${made.path}, so no manifest was written. Make sure nothing else is changing it, then try again.`;
  // `browser-control install` takes the same lock, so the manifest is classified again and replaced as one step.
  const lock = acquireInstallLockSync(manifestLockPath(path.join(made.path, name)));
  try {
    // Classify and write only in the directory the lock checked, never through the path given.
    if (!sameDirectory(lock.directory, made)) throw new InstallError(moved);
    refuseExisting(path.join(lock.directory.path, name), wrapper, manifestPath);
    replaceFile(lock.directory, name, `${JSON.stringify(manifest, null, 2)}\n`, 0o644, () => stillResolves(given, lock.directory), moved);
  } finally {
    lock.release();
  }
  return { wrapper, copyDir };
}

runScript(Effect.gen(function* () {
  const io = yield* ScriptIo;
  const extensionId = argValue("extension-id", process.env.BROWSER_CONTROL_EXTENSION_ID);
  if (!extensionId) {
    yield* io.stderr("Missing extension ID. Pass --extension-id <id> after loading extension/ unpacked in Chrome.\n");
    process.exitCode = 1;
    return;
  }
  const manifestPath = argValue("manifest-path", chromeManifestPath()) as string;
  const socketPath = argValue("socket-path", process.env.BROWSER_CONTROL_HOST_SOCKET);
  const installed = yield* Effect.either(Effect.try({
    try: () => install(extensionId, manifestPath, socketPath),
    catch: (error) => (error instanceof Error ? error : new Error(String(error)))
  }));
  if (installed._tag === "Left") {
    yield* io.stderr(`${installed.left.message}\n`);
    process.exitCode = 1;
    return;
  }
  yield* registerWindowsManifest(manifestPath);

  yield* io.stdout(`Installed native messaging manifest:\n${manifestPath}\n`);
  yield* io.stdout(`Allowed extension origin: chrome-extension://${extensionId}/\n`);
  yield* io.stdout(`Host executable: ${installed.right.wrapper}\n`);
  yield* io.stdout(`Host copy: ${installed.right.copyDir}\n`);
}));
