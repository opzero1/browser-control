#!/usr/bin/env node
// Installs the com.opzero.chrome manifest for this skill's native host. Chrome never depends on this skill's own
// directory, which may be an extracted zip, a checkout, a package cache or a stable copy: the host is published as
// a content-addressed copy under the Browser Control state root, and the wrapper there execs this exact Node.
// Nothing is written into the skill's directory; scripts/extension-id.json is the build's default ID.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Effect } from "effect";
import { acquireInstallLockSync, manifestLockPath } from "../shared/install-lock";
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

/** Create `dir` (mode 0700) if needed, and refuse a symlink or a directory another user could change. */
function privateDirectory(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(dir);
  if (!stats.isDirectory() || !isPrivate(stats)) throw new InstallError(`Refusing a directory that is not private to you: ${dir}`);
  return dir;
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

function writeNew(file: string, data: string | Buffer, mode: number) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
  try {
    fs.writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, mode);
}

/**
 * Publish `files` as <parent>/<name>/. Publications are serialized by a lock in <parent>, and the target is
 * checked again under it, so a matching copy that another installer published (and Chrome may be running) is
 * never moved or deleted. Returns the published directory.
 */
function publishTree(parent: string, name: string, files: ReadonlyMap<string, Buffer>) {
  const target = path.join(parent, name);
  let current: TreeState | null = null;
  try {
    current = treeState(target, files);
  } catch {
    // Read again under the lock.
  }
  if (current !== "matches") {
    const lock = acquireInstallLockSync(path.join(parent, publishLock));
    try {
      const state = treeState(target, files);
      if (state !== "matches") replaceTree(parent, target, files, state === "differs");
    } finally {
      lock.release();
    }
  }
  if (treeState(target, files) !== "matches") throw new InstallError(`Could not verify the native host copy: ${target}`);
  return target;
}

/**
 * Under the publish lock: stage a private directory beside `target`, then rename it into place. A copy that
 * differs is moved aside first and deleted only once the new copy is in place; if the new copy cannot be
 * renamed in, the old one is put back.
 */
function replaceTree(parent: string, target: string, files: ReadonlyMap<string, Buffer>, moveAside: boolean) {
  const staging = path.join(parent, `.tmp-${crypto.randomUUID()}`);
  const displaced = path.join(parent, `.old-${crypto.randomUUID()}`);
  let moved = false;
  try {
    fs.mkdirSync(staging, { mode: 0o700 });
    for (const [relative, data] of files) {
      const file = path.join(staging, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeNew(file, data, 0o600);
    }
    if (moveAside) {
      fs.renameSync(target, displaced);
      moved = true;
    }
    try {
      fs.renameSync(staging, target);
    } catch (error) {
      const restore = moved;
      moved = false;
      if (restore) {
        try {
          fs.renameSync(displaced, target);
        } catch {
          // The old copy stays beside the target; nothing deletes it.
        }
      }
      throw error;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    if (moved) fs.rmSync(displaced, { recursive: true, force: true });
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

/** Replace `file` atomically with `text`: a temporary file beside it, then a rename. */
function replaceFile(file: string, text: string, mode: number) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    writeNew(temporary, text, mode);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** The host an existing manifest names: undefined when there is none, null when it names none readably. */
function existingHost(manifestPath: string): string | null | undefined {
  let text: string;
  try {
    text = fs.readFileSync(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed.path === "string" ? parsed.path : null;
  } catch {
    return null;
  }
}

function refuseForeign(manifestPath: string, wrapper: string) {
  const previous = existingHost(manifestPath);
  if (previous !== undefined && previous !== wrapper && !force) {
    throw new InstallError(`A native messaging manifest for ${hostName} already points at another host:\n  ${previous ?? "(unreadable)"}\n`
      + `Pass --force to replace it: ${manifestPath}`);
  }
}

function install(extensionId: string, manifestPath: string, socketPath: string | null) {
  const node = nodeExecutable();
  const hosts = privateDirectory(path.join(privateDirectory(stateRoot()), "hosts"));
  const files = hostFiles();
  const wrapperDir = path.join(hosts, "skill");
  const wrapper = path.join(wrapperDir, wrapperName);
  const copyDir = path.join(hosts, `skill-${digest(files).slice(0, 12)}`);
  const text = launcher(node, path.join(copyDir, ...hostEntry.split("/")), socketPath);
  refuseForeign(manifestPath, wrapper);
  publishTree(hosts, path.basename(copyDir), files);
  privateDirectory(wrapperDir);
  // The wrapper names the copy only after that copy is verified in place.
  replaceFile(wrapper, text, 0o700);
  const manifest = {
    name: hostName,
    description: "Browser Control native messaging host",
    type: "stdio",
    path: wrapper,
    allowed_origins: [`chrome-extension://${extensionId}/`]
  };
  // 0755 whatever the umask: the lock refuses a directory that group or others can write to.
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o755 });
  // `browser-control install` takes the same lock, so the manifest is classified again and replaced as one step.
  const lock = acquireInstallLockSync(manifestLockPath(manifestPath));
  try {
    refuseForeign(manifestPath, wrapper);
    replaceFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o644);
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
