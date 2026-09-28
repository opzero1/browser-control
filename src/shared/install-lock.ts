// The cross-process lock the two native-host installers share: `browser-control install` (Node 24) and the
// release zip's scripts/install-native-host.js, which runs on Node 18 and so cannot use the server's node:sqlite
// locks (src/server/lock.ts). A lock is a directory that holds one entry named <pid>-<uuid>. It is taken by
// renaming a directory that already holds the entry into place, so a held lock is never empty and an empty one
// is never held. A waiter removes an entry only when the process that made it no longer exists; entry names are
// unique, so removing one can never release another installer's lock.
//
// No other user may be able to change the lock: it must be a real directory owned by this user that group and
// others cannot write to, in a parent directory owned by this user that they cannot write to either unless it
// has the sticky bit. Node has no
// unlinkat, so, as in src/server/fs-private.ts, the lock directory is a path plus the (dev, ino) it had when it
// was checked, and nothing is removed through that path until it is checked again.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface InstallLock {
  readonly path: string;
  release(): void;
}

/** The lock stayed held until the deadline; `holder` is its live process, or null when that is unknown. */
export class InstallLockBusy extends Error {
  constructor(readonly lockPath: string, readonly holder: number | null) {
    super(`Another installer is using ${lockPath}${holder === null ? "" : ` (process ${holder})`}. If no installer is running, remove that directory and try again.`);
    this.name = "InstallLockBusy";
  }
}

/**
 * Another user could change the lock, so it was not used: `path` is the lock or its parent directory at fault.
 * With `replaced`, the lock directory this installer held is no longer at its path, and nothing was removed.
 */
export class InstallLockUnsafe extends Error {
  readonly code = "browser-controller-unsafe-install-lock";
  readonly path: string;
  constructor(readonly lockPath: string, at: string, replaced = false) {
    super(replaced
      ? `The installer lock ${lockPath} was replaced while this installer held it, so nothing was removed. Make sure no other installer is running, then try again.`
      : `Refusing the installer lock ${lockPath}: ${at} must be a real directory owned by you that no other user can write to.`);
    this.name = "InstallLockUnsafe";
    this.path = at;
  }
}

/** The file system reads the lock's checks make; tests replace them to simulate another owner or a race. */
export interface InstallLockFs {
  lstat(file: string): fs.Stats;
  stat(file: string): fs.Stats;
  readdir(directory: string): string[];
}

const nodeFs: InstallLockFs = {
  lstat: (file) => fs.lstatSync(file),
  stat: (file) => fs.statSync(file),
  readdir: (directory) => fs.readdirSync(directory)
};

/** The lock that serializes every installer's check and replacement of one native messaging manifest. */
export function manifestLockPath(manifestFile: string): string {
  return path.join(path.dirname(manifestFile), `.${path.basename(manifestFile)}.lock`);
}

const ENTRY = /^([1-9][0-9]{0,9})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Entries this process holds, so an entry left by a dead process that had this pid is still found stale. */
const held = new Set<string>();
const WRITABLE_BY_OTHERS = 0o022;
const STICKY = 0o1000;

interface Identity {
  readonly dev: number;
  readonly ino: number;
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/** Windows has no POSIX owners or modes, so there only the kind and identity of the lock are checked. */
function ownerId(): number | undefined {
  return process.getuid?.();
}

/**
 * The parent (followed if it is a symlink) must be a directory owned by this user. If group or others can write
 * to it, it needs the sticky bit, so that they cannot rename or remove the lock, which must then be ours.
 */
function checkParent(lockPath: string, io: InstallLockFs): void {
  const parent = path.dirname(lockPath);
  const stats = io.stat(parent);
  const uid = ownerId();
  const shared = (stats.mode & WRITABLE_BY_OTHERS) !== 0 && (stats.mode & STICKY) === 0;
  if (!stats.isDirectory() || (uid !== undefined && (stats.uid !== uid || shared))) throw new InstallLockUnsafe(lockPath, parent);
}

/** The identity of the lock directory, or null when nothing is at its path; anything unsafe there is refused. */
function inspect(lockPath: string, io: InstallLockFs): Identity | null {
  let stats: fs.Stats;
  try {
    stats = io.lstat(lockPath);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
  const uid = ownerId();
  if (stats.isSymbolicLink() || !stats.isDirectory() || (uid !== undefined && (stats.uid !== uid || stats.mode & WRITABLE_BY_OTHERS))) {
    throw new InstallLockUnsafe(lockPath, lockPath);
  }
  return { dev: stats.dev, ino: stats.ino };
}

/** The lock path still names the directory `expected` identifies (and is still safe). */
function unchanged(lockPath: string, expected: Identity, io: InstallLockFs): boolean {
  const current = inspect(lockPath, io);
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
 * only an empty directory). Only regular files named like an entry are removed, and only while the lock path
 * still names the directory that was listed; if another process replaced it, the next attempt checks the new
 * one. Returns a live holder's pid, or null when none is known.
 */
function clearStale(lockPath: string, io: InstallLockFs): number | null {
  const listed = inspect(lockPath, io);
  if (!listed) return null;
  let names: string[];
  try {
    names = io.readdir(lockPath);
  } catch (error) {
    if (codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR") return null;
    throw error;
  }
  let holder: number | null = null;
  for (const name of names) {
    const match = ENTRY.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    const stale = pid === process.pid ? !held.has(`${lockPath}\0${name}`) : !running(pid);
    if (!stale) {
      holder = pid;
      continue;
    }
    if (!unchanged(lockPath, listed, io)) return null;
    const file = path.join(lockPath, name);
    try {
      if (io.lstat(file).isFile()) fs.unlinkSync(file);
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error;
    }
  }
  if (!unchanged(lockPath, listed, io)) return null;
  try {
    fs.rmdirSync(lockPath);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST", "ENOTDIR"].includes(codeOf(error) ?? "")) throw error;
  }
  return holder;
}

/** One attempt: the lock, or the pid of a live holder (null when unknown). */
function attempt(lockPath: string, io: InstallLockFs): InstallLock | { holder: number | null } {
  // Refuse an unsafe parent or lock before anything is created beside it or removed from it.
  checkParent(lockPath, io);
  inspect(lockPath, io);
  const entry = `${process.pid}-${crypto.randomUUID()}`;
  const staging = `${lockPath}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(staging, { mode: 0o700 });
  let created: fs.Stats;
  try {
    created = io.lstat(staging);
    fs.closeSync(fs.openSync(path.join(staging, entry), "wx", 0o600));
    try {
      // Replaces a missing or empty lock directory; fails while another installer's entry is in it.
      fs.renameSync(staging, lockPath);
    } catch (error) {
      const code = codeOf(error) ?? "";
      const contended = ["EEXIST", "ENOTEMPTY", "ENOTDIR"].includes(code) || (["EPERM", "EACCES"].includes(code) && inspect(lockPath, io) !== null);
      if (!contended) throw error;
      return { holder: clearStale(lockPath, io) };
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  // A rename keeps the inode, so the lock is the directory made above.
  const identity: Identity = { dev: created.dev, ino: created.ino };
  if (!unchanged(lockPath, identity, io)) throw new InstallLockUnsafe(lockPath, lockPath, true);
  const key = `${lockPath}\0${entry}`;
  held.add(key);
  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      held.delete(key);
      if (!unchanged(lockPath, identity, io)) throw new InstallLockUnsafe(lockPath, lockPath, true);
      try {
        fs.unlinkSync(path.join(lockPath, entry));
      } catch (error) {
        if (codeOf(error) !== "ENOENT") throw error;
      }
      if (!unchanged(lockPath, identity, io)) return;
      try {
        fs.rmdirSync(lockPath);
      } catch {
        // Another installer already took the emptied lock, or it is gone.
      }
    }
  };
}

const POLL_MS = 20;

/** Take the lock at `lockPath` (its parent must exist), polling without blocking the event loop. */
export async function acquireInstallLock(lockPath: string, timeoutMs = 10000, calls: Partial<InstallLockFs> = {}): Promise<InstallLock> {
  const io = { ...nodeFs, ...calls };
  const deadline = performance.now() + timeoutMs;
  while (true) {
    const result = attempt(lockPath, io);
    if ("release" in result) return result;
    if (performance.now() >= deadline) throw new InstallLockBusy(lockPath, result.holder);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** The same, for the zip's synchronous installer, which has nothing else to run while it waits. */
export function acquireInstallLockSync(lockPath: string, timeoutMs = 10000, calls: Partial<InstallLockFs> = {}): InstallLock {
  const io = { ...nodeFs, ...calls };
  const deadline = performance.now() + timeoutMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    const result = attempt(lockPath, io);
    if ("release" in result) return result;
    if (performance.now() >= deadline) throw new InstallLockBusy(lockPath, result.holder);
    Atomics.wait(pause, 0, 0, POLL_MS);
  }
}
