// Private registry files. Python holds directory file descriptors and uses dir_fd calls; Node has no openat,
// so a PrivateDir is a path plus the (dev, ino) it had when verified, and every use re-verifies it first.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Gate, isGate } from "./gate";
import { parsePythonJson, pyDumps, type JsonValue } from "./pyjson";

export interface PrivateDir { readonly path: string; readonly dev: number; readonly ino: number }

/** An OSError: what fixedErrors maps to a fixed gate. */
export class FsError extends Error {
  readonly errno: string;
  constructor(errno: string) {
    super(errno);
    this.errno = errno;
    this.name = "FsError";
  }
}

const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
const O_DIRECTORY = fs.constants.O_DIRECTORY ?? 0;

function uid(): number {
  return process.getuid?.() ?? -1;
}

/** Run a Node fs call, turning its errors into FsError. */
export function io<T>(body: () => T): T {
  try {
    return body();
  } catch (error) {
    if (error instanceof Gate || error instanceof FsError) throw error;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (typeof code === "string") throw new FsError(code);
    throw error;
  }
}

function checkDirectoryStats(stats: fs.Stats) {
  if (stats.uid !== uid() || stats.mode & 0o077) throw new Gate("browser-controller-unsafe-registry");
}

/** One path component opened like os.open(part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW, dir_fd=...). */
function component(file: string): fs.Stats {
  const stats = io(() => fs.lstatSync(file));
  if (stats.isSymbolicLink()) throw new FsError("ELOOP");
  if (!stats.isDirectory()) throw new FsError("ENOTDIR");
  return stats;
}

function mkdirQuiet(file: string) {
  try {
    fs.mkdirSync(file, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") io(() => { throw error; });
  }
}

function walk(target: string, create: boolean): PrivateDir | null {
  const absolute = path.resolve(target);
  const parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  let stats = component(current);
  for (const part of parts) {
    current = path.join(current, part);
    if (create) mkdirQuiet(current);
    try {
      stats = component(current);
    } catch (error) {
      if (!create && error instanceof FsError && error.errno === "ENOENT") return null;
      throw error;
    }
  }
  checkDirectoryStats(stats);
  return { path: current, dev: stats.dev, ino: stats.ino };
}

/** open_directory: create each missing component 0700, refuse symlinks, and require an owner-only final directory. */
export function openDirectory(target: string): PrivateDir {
  return walk(target, true) as PrivateDir;
}

/** existing_directory: like openDirectory without creating anything; null when a component is missing. */
export function existingDirectory(target: string): PrivateDir | null {
  return walk(target, false);
}

/** The directory is still the one verified: same dev and ino, still a real directory. */
export function verified(dir: PrivateDir): string {
  const stats = component(dir.path);
  if (stats.dev !== dir.dev || stats.ino !== dir.ino) throw new Gate("browser-controller-unsafe-registry");
  return dir.path;
}

function child(dir: PrivateDir, name: string): string {
  if (!name || name.includes("/") || name === "." || name === "..") throw new FsError("EINVAL");
  return path.join(verified(dir), name);
}

export function childDirectory(dir: PrivateDir, name: string): PrivateDir {
  const file = child(dir, name);
  mkdirQuiet(file);
  const stats = component(file);
  checkDirectoryStats(stats);
  return { path: file, dev: stats.dev, ino: stats.ino };
}

/** check_file: a regular, owner-only file with one link. */
export function checkFileStats(stats: fs.Stats): void {
  if (!stats.isFile() || stats.uid !== uid() || stats.mode & 0o077 || stats.nlink !== 1) {
    throw new Gate("browser-controller-unsafe-registry");
  }
}

/** fsync a verified directory after entries in it changed. */
export function syncDirectory(dir: PrivateDir): void {
  fsyncDirectory(dir);
}

function fsyncDirectory(dir: PrivateDir) {
  const fd = io(() => fs.openSync(verified(dir), O_RDONLY | O_DIRECTORY));
  try {
    io(() => fs.fsyncSync(fd));
  } finally {
    fs.closeSync(fd);
  }
}

/** Open an existing file without following a final symlink; null when missing. */
function openExisting(dir: PrivateDir, name: string, flags: number): number | null {
  try {
    return fs.openSync(child(dir, name), flags | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return io(() => { throw error; });
  }
}

function readAll(fd: number, size: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(Math.max(65536, size - total + 1));
    const count = io(() => fs.readSync(fd, chunk, 0, chunk.length, null));
    if (!count) break;
    chunks.push(chunk.subarray(0, count));
    total += count;
  }
  return Buffer.concat(chunks, total);
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** read_json: None when missing; an unsafe file is refused; a file over `limit` is invalid state. */
export function readJson(dir: PrivateDir, name: string, limit = 32768): JsonValue | null {
  const fd = openExisting(dir, name, O_RDONLY);
  if (fd === null) return null;
  try {
    const stats = io(() => fs.fstatSync(fd));
    checkFileStats(stats);
    if (stats.size > limit) throw new Gate("browser-controller-invalid-state");
    return parsePythonJson(decoder.decode(readAll(fd, stats.size)));
  } finally {
    fs.closeSync(fd);
  }
}

function replaceFile(dir: PrivateDir, name: string, data: Uint8Array, mode: number, prefix: string) {
  const temporary = `${prefix}${randomUUID()}`;
  const fd = io(() => fs.openSync(child(dir, temporary), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode));
  try {
    try {
      io(() => fs.fchmodSync(fd, mode));
      io(() => fs.writeSync(fd, data));
      io(() => fs.fsyncSync(fd));
    } finally {
      fs.closeSync(fd);
    }
    io(() => fs.renameSync(child(dir, temporary), child(dir, name)));
    fsyncDirectory(dir);
  } finally {
    try {
      fs.unlinkSync(child(dir, temporary));
    } catch (error) {
      if (!(isGate(error) || (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    }
  }
}

/** write_json: `.write-<uuid>` beside the target, fsync, rename, fsync the directory. */
export function writeJson(dir: PrivateDir, name: string, value: unknown): void {
  replaceFile(dir, name, Buffer.from(`${pyDumps(value)}\n`, "utf8"), 0o600, ".write-");
}

/** remove_file: missing is fine; otherwise unlink and fsync the directory. */
export function removeFile(dir: PrivateDir, name: string): void {
  try {
    fs.unlinkSync(child(dir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    io(() => { throw error; });
  }
  fsyncDirectory(dir);
}

/** browser_start.read_private: null when missing; anything but a small owner-only regular file is `code`. */
export function readPrivate(dir: PrivateDir, name: string, limit = 65536, code = "browser-controller-unsafe-host-manifest"): Buffer | null {
  const fd = openExisting(dir, name, O_RDONLY);
  if (fd === null) return null;
  try {
    const stats = io(() => fs.fstatSync(fd));
    if (!stats.isFile() || stats.uid !== uid() || stats.nlink !== 1 || stats.mode & 0o077 || stats.size > limit) {
      throw new Gate(code);
    }
    return readAll(fd, stats.size);
  } finally {
    fs.closeSync(fd);
  }
}

/** browser_start.write_private: an atomic replace with `mode`. */
export function writePrivate(dir: PrivateDir, name: string, data: Uint8Array, mode: number, prefix = ".provision-"): void {
  replaceFile(dir, name, data, mode, prefix);
}

/** Open or create a lock file like browser_pool.open_lock (O_RDWR | O_CREAT | O_NOFOLLOW, 0600). */
export function openLockFile(dir: PrivateDir, name: string): number {
  let attempts = 3;
  while (true) {
    try {
      return fs.openSync(child(dir, name), O_RDWR | O_CREAT | O_NOFOLLOW, 0o600);
    } catch (error) {
      // macOS can fail an O_CREAT open with ENOENT while another process creates the same name.
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && --attempts) continue;
      return io(() => { throw error; });
    }
  }
}

/** lstat of a directory entry, like os.stat(name, dir_fd=..., follow_symlinks=False). */
export function entryStats(dir: PrivateDir, name: string): fs.Stats | null {
  try {
    return fs.lstatSync(child(dir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return io(() => { throw error; });
  }
}

/** os.listdir of a verified directory. */
export function listDirectory(dir: PrivateDir): string[] {
  return io(() => fs.readdirSync(verified(dir)));
}

function mapped(error: unknown, code: string): unknown {
  if (error instanceof FsError || error instanceof TypeError || error instanceof SyntaxError) return new Gate(code);
  return error;
}

/** browser_pool.fixed_errors: OSError, ValueError and TypeError become one fixed gate. */
export function fixedErrors<T>(body: () => T, code = "browser-controller-invalid-registry"): T {
  try {
    return body();
  } catch (error) {
    throw mapped(error, code);
  }
}

export async function fixedErrorsAsync<T>(body: () => Promise<T>, code = "browser-controller-invalid-registry"): Promise<T> {
  try {
    return await body();
  } catch (error) {
    throw mapped(error, code);
  }
}
