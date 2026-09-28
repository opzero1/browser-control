// The cross-process lock the two native-host installers share: `browser-control install` (Node 24) and the
// release zip's scripts/install-native-host.js, which runs on Node 18 and so cannot use the server's node:sqlite
// locks (src/server/lock.ts). A lock is a directory that holds one entry named <pid>-<uuid>. It is taken by
// renaming a directory that already holds the entry into place, so a held lock is never empty and an empty one
// is never held. A waiter removes an entry only when the process that made it no longer exists; entry names are
// unique, so removing one can never release another installer's lock.
//
// No other user may be able to change the lock. Its parent must pass the trusted-path rule
// (src/shared/trusted-path.ts), and the lock works in the parent's canonical path from then on. The lock itself
// must be a real directory owned by this user that group and others cannot write to. Node has no unlinkat, so,
// as in src/server/fs-private.ts, a directory is a path plus the (dev, ino) it had when it was checked, and
// nothing is removed through that path until it is checked again. Nothing here removes recursively: a file is
// unlinked and a directory removed with rmdir, which fails on one that is not empty.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { trustedPath, type Identity, type TrustedDirectory } from "./trusted-path";

export type { Identity, TrustedDirectory } from "./trusted-path";

/** A file or directory this process made, with the identity it had when it was made. */
export interface Created extends Identity {
  readonly path: string;
  readonly directory: boolean;
}

export interface InstallLock {
  readonly path: string;
  /** The lock's parent, by its canonical path: work in `directory.path` rather than through the path given. */
  readonly directory: TrustedDirectory;
  release(): void;
}

/** The lock stayed held until the deadline; `holder` is its live process, or null when that is unknown. */
export class InstallLockBusy extends Error {
  constructor(readonly lockPath: string, readonly holder: number | null) {
    super(`Another installer is using ${lockPath}${holder === null ? "" : ` (process ${holder})`}. If no installer is running, remove that directory and try again.`);
    this.name = "InstallLockBusy";
  }
}

function unsafeMessage(lockPath: string, at: string, fault: "lock" | "directory", replaced: boolean): string {
  if (replaced && fault === "lock") {
    return `The installer lock ${lockPath} was replaced while this installer held it, so nothing was removed. Make sure no other installer is running, then try again.`;
  }
  if (replaced) {
    return `The directory ${at} that holds the installer lock ${lockPath} was replaced while this installer used it, so nothing was removed. Make sure no other installer is running, then try again.`;
  }
  if (fault === "lock") return `Refusing the installer lock ${lockPath}: ${at} must be a real directory owned by you that no other user can write to.`;
  return `Refusing the installer lock ${lockPath}: ${at} must be a directory owned by you or root that only its owner can write to, unless it has the sticky bit.`;
}

/**
 * Another user could change the lock, so it was not used: `path` is the lock, or the directory above it, at
 * fault. With `replaced`, that directory is no longer the one this installer checked, and nothing was removed.
 */
export class InstallLockUnsafe extends Error {
  readonly code = "browser-controller-unsafe-install-lock";
  readonly path: string;
  constructor(readonly lockPath: string, at: string, fault: "lock" | "directory" = "lock", replaced = false) {
    super(unsafeMessage(lockPath, at, fault, replaced));
    this.name = "InstallLockUnsafe";
    this.path = at;
  }
}

/** The file system reads the lock's checks make; tests replace them to simulate another owner or a race. */
export interface InstallLockFs {
  lstat(file: string): fs.Stats;
  readdir(directory: string): string[];
  readlink(file: string): string;
}

const nodeFs: InstallLockFs = {
  lstat: (file) => fs.lstatSync(file),
  readdir: (directory) => fs.readdirSync(directory),
  readlink: (file) => fs.readlinkSync(file)
};

/** The lock that serializes every installer's check and replacement of one native messaging manifest. */
export function manifestLockPath(manifestFile: string): string {
  return path.join(path.dirname(manifestFile), `.${path.basename(manifestFile)}.lock`);
}

const ENTRY = /^([1-9][0-9]{0,9})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Entries this process holds, so an entry left by a dead process that had this pid is still found stale. */
const held = new Set<string>();
const WRITABLE_BY_OTHERS = 0o022;

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/** Windows has no POSIX owners or modes, so there only the kind and identity of each directory are checked. */
function ownerId(): number | undefined {
  return process.getuid?.();
}

/** Whether `file`, not followed, is still what `expected` identifies; a missing file is not. */
export function unchangedAt(file: string, expected: Identity, calls: Partial<InstallLockFs> = {}): boolean {
  let stats: fs.Stats;
  try {
    stats = (calls.lstat ?? nodeFs.lstat)(file);
  } catch (error) {
    if (codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR") return false;
    throw error;
  }
  return !stats.isSymbolicLink() && stats.dev === expected.dev && stats.ino === expected.ino;
}

/**
 * Whether `given` still passes the trusted-path rule and leads to `directory`, which still has the identity it
 * was checked with. An installer checks this just before it renames a file into `directory`: the given path is
 * the one Chrome reads.
 */
export function stillResolves(given: string, directory: TrustedDirectory, calls: Partial<InstallLockFs> = {}): boolean {
  const io = { ...nodeFs, ...calls };
  if (!unchangedAt(directory.path, directory, io)) return false;
  try {
    const again = trustedPath(given, { calls: io });
    return !("unsafe" in again) && again.path === directory.path && again.dev === directory.dev && again.ino === directory.ino;
  } catch (error) {
    if (codeOf(error) === undefined) throw error;
    return false;
  }
}

/** What `stats` says `file` is, as this process made it. */
export function created(file: string, stats: fs.Stats): Created {
  return { path: file, dev: stats.dev, ino: stats.ino, directory: stats.isDirectory() };
}

/**
 * Remove `items` in order, each only while `within` (when given) and the item's own path are still what was
 * recorded: a file is unlinked, and a directory removed with rmdir, which fails unless it is empty. The first
 * mismatch or failure stops the removal and leaves the rest, which is harmless. Returns whether all were removed.
 */
export function removeCreated(items: readonly Created[], within?: TrustedDirectory, calls: Partial<InstallLockFs> = {}): boolean {
  for (const item of items) {
    try {
      if ((within && !unchangedAt(within.path, within, calls)) || !unchangedAt(item.path, item, calls)) return false;
      if (item.directory) fs.rmdirSync(item.path);
      else fs.unlinkSync(item.path);
    } catch (error) {
      if (codeOf(error) === undefined) throw error;
      return false;
    }
  }
  return true;
}

/** The identity of the lock directory, or null when nothing is at its path; anything unsafe there is refused. */
function inspect(lockPath: string, lock: string, io: InstallLockFs): Identity | null {
  let stats: fs.Stats;
  try {
    stats = io.lstat(lock);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
  const uid = ownerId();
  if (stats.isSymbolicLink() || !stats.isDirectory() || (uid !== undefined && (stats.uid !== uid || stats.mode & WRITABLE_BY_OTHERS))) {
    throw new InstallLockUnsafe(lockPath, lock);
  }
  return { dev: stats.dev, ino: stats.ino };
}

/** The parent is still the directory that was checked; otherwise nothing more is done in it. */
function keepParent(lockPath: string, parent: TrustedDirectory, io: InstallLockFs): void {
  if (!unchangedAt(parent.path, parent, io)) throw new InstallLockUnsafe(lockPath, parent.path, "directory", true);
}

/** The parent and the lock path still name the directories `parent` and `expected` identify (and are still safe). */
function unchanged(lockPath: string, lock: string, expected: Identity, parent: TrustedDirectory, io: InstallLockFs): boolean {
  if (!unchangedAt(parent.path, parent, io)) return false;
  const current = inspect(lockPath, lock, io);
  return current !== null && current.dev === expected.dev && current.ino === expected.ino;
}

/** Whether a process may have this id: only ESRCH proves it gone (EPERM means another user's process). */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) !== "ESRCH";
  }
}

/**
 * Remove the entries of processes that are gone, then the lock directory if that left it empty (rmdir removes
 * only an empty directory). Only regular files named like an entry are removed, and only while the parent and
 * the lock path still name the directories that were checked and listed; if another process replaced the lock,
 * the next attempt checks the new one. Returns a live holder's pid, or null when none is known.
 */
function clearStale(lockPath: string, lock: string, parent: TrustedDirectory, io: InstallLockFs): number | null {
  const listed = inspect(lockPath, lock, io);
  if (!listed) return null;
  let names: string[];
  try {
    names = io.readdir(lock);
  } catch (error) {
    if (codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR") return null;
    throw error;
  }
  let holder: number | null = null;
  for (const name of names) {
    const match = ENTRY.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    const stale = pid === process.pid ? !held.has(`${lock}\0${name}`) : !running(pid);
    if (!stale) {
      holder = pid;
      continue;
    }
    const file = path.join(lock, name);
    try {
      if (!io.lstat(file).isFile()) continue;
      if (!unchanged(lockPath, lock, listed, parent, io)) return null;
      fs.unlinkSync(file);
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error;
    }
  }
  if (!unchanged(lockPath, lock, listed, parent, io)) return null;
  try {
    fs.rmdirSync(lock);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST", "ENOTDIR"].includes(codeOf(error) ?? "")) throw error;
  }
  return holder;
}

/** One attempt: the lock, or the pid of a live holder (null when unknown). */
function attempt(lockPath: string, parent: TrustedDirectory, io: InstallLockFs): InstallLock | { holder: number | null } {
  const lock = path.join(parent.path, path.basename(lockPath));
  // Refuse a replaced parent or an unsafe lock before anything is created beside it or removed from it.
  keepParent(lockPath, parent, io);
  inspect(lockPath, lock, io);
  const entry = `${process.pid}-${crypto.randomUUID()}`;
  const staging = `${lock}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(staging, { mode: 0o700 });
  // Until the rename takes it, the staging directory holds only this entry. Each is removed only while it is
  // still what was made here, the entry first, and rmdir leaves the directory if anything else is in it.
  const made: Created[] = [];
  let taken = false;
  let stagingDir: Created;
  let entryFile: Created;
  try {
    stagingDir = created(staging, io.lstat(staging));
    made.push(stagingDir);
    keepParent(lockPath, parent, io);
    const fd = fs.openSync(path.join(staging, entry), "wx", 0o600);
    try {
      entryFile = created(path.join(staging, entry), fs.fstatSync(fd));
      made.unshift(entryFile);
    } finally {
      fs.closeSync(fd);
    }
    keepParent(lockPath, parent, io);
    try {
      // Replaces a missing or empty lock directory; fails while another installer's entry is in it.
      fs.renameSync(staging, lock);
      taken = true;
    } catch (error) {
      const code = codeOf(error) ?? "";
      const contended = ["EEXIST", "ENOTEMPTY", "ENOTDIR"].includes(code) || (["EPERM", "EACCES"].includes(code) && inspect(lockPath, lock, io) !== null);
      if (!contended) throw error;
      const holder = clearStale(lockPath, lock, parent, io);
      keepParent(lockPath, parent, io);
      return { holder };
    }
  } finally {
    if (!taken) removeCreated(made, parent, io);
  }
  // A rename keeps the inode, so the lock is the directory made above, and the entry the file made in it.
  const identity: Identity = { dev: stagingDir.dev, ino: stagingDir.ino };
  const own: Created = { ...entryFile, path: path.join(lock, entry) };
  keepParent(lockPath, parent, io);
  if (!unchanged(lockPath, lock, identity, parent, io)) throw new InstallLockUnsafe(lockPath, lock, "lock", true);
  const key = `${lock}\0${entry}`;
  held.add(key);
  let released = false;
  return {
    path: lockPath,
    directory: parent,
    release() {
      if (released) return;
      released = true;
      held.delete(key);
      keepParent(lockPath, parent, io);
      if (!unchanged(lockPath, lock, identity, parent, io)) throw new InstallLockUnsafe(lockPath, lock, "lock", true);
      // Another installer may take the emptied lock before the rmdir, which then fails and removes nothing.
      removeCreated([own, { path: lock, ...identity, directory: true }], parent, io);
    }
  };
}

/** The lock's parent, by the canonical path the trusted-path rule gives it; an acquisition works only there. */
function trustedParent(lockPath: string, io: InstallLockFs): TrustedDirectory {
  const checked = trustedPath(path.dirname(lockPath), { calls: io });
  if ("unsafe" in checked) throw new InstallLockUnsafe(lockPath, checked.unsafe, "directory");
  return checked;
}

const POLL_MS = 20;

/** Take the lock at `lockPath` (its parent must exist), polling without blocking the event loop. */
export async function acquireInstallLock(lockPath: string, timeoutMs = 10000, calls: Partial<InstallLockFs> = {}): Promise<InstallLock> {
  const io = { ...nodeFs, ...calls };
  const parent = trustedParent(lockPath, io);
  const deadline = performance.now() + timeoutMs;
  while (true) {
    const result = attempt(lockPath, parent, io);
    if ("release" in result) return result;
    if (performance.now() >= deadline) throw new InstallLockBusy(lockPath, result.holder);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** The same, for the zip's synchronous installer, which has nothing else to run while it waits. */
export function acquireInstallLockSync(lockPath: string, timeoutMs = 10000, calls: Partial<InstallLockFs> = {}): InstallLock {
  const io = { ...nodeFs, ...calls };
  const parent = trustedParent(lockPath, io);
  const deadline = performance.now() + timeoutMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    const result = attempt(lockPath, parent, io);
    if ("release" in result) return result;
    if (performance.now() >= deadline) throw new InstallLockBusy(lockPath, result.holder);
    Atomics.wait(pause, 0, 0, POLL_MS);
  }
}
