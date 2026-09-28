// The cross-process lock the two native-host installers share: `browser-control install` (Node 24) and the
// release zip's scripts/install-native-host.js, which runs on Node 18 and so cannot use the server's node:sqlite
// locks (src/server/lock.ts). A lock is a directory that holds one entry named <pid>-<uuid>. It is taken by
// renaming a directory that already holds the entry into place, so a held lock is never empty and an empty one
// is never held. A waiter removes an entry only when the process that made it no longer exists; entry names are
// unique, so removing one can never release another installer's lock.
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

/** The lock that serializes every installer's check and replacement of one native messaging manifest. */
export function manifestLockPath(manifestFile: string): string {
  return path.join(path.dirname(manifestFile), `.${path.basename(manifestFile)}.lock`);
}

const ENTRY = /^([1-9][0-9]{0,9})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Entries this process holds, so an entry left by a dead process that had this pid is still found stale. */
const held = new Set<string>();

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function exists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
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
 * only an empty directory). Returns a live holder's pid, or null when none is known.
 */
function clearStale(lockPath: string): number | null {
  let names: string[];
  try {
    names = fs.readdirSync(lockPath);
  } catch (error) {
    if (codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR") return null;
    throw error;
  }
  let holder: number | null = null;
  for (const name of names) {
    const match = ENTRY.exec(name);
    const pid = match ? Number(match[1]) : null;
    const stale = pid !== null && (pid === process.pid ? !held.has(`${lockPath}\0${name}`) : !running(pid));
    if (stale) fs.rmSync(path.join(lockPath, name), { force: true });
    else if (pid !== null) holder = pid;
  }
  try {
    fs.rmdirSync(lockPath);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST", "ENOTDIR"].includes(codeOf(error) ?? "")) throw error;
  }
  return holder;
}

/** One attempt: the lock, or the pid of a live holder (null when unknown). */
function attempt(lockPath: string): InstallLock | { holder: number | null } {
  const entry = `${process.pid}-${crypto.randomUUID()}`;
  const staging = `${lockPath}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    fs.closeSync(fs.openSync(path.join(staging, entry), "wx", 0o600));
    try {
      // Replaces a missing or empty lock directory; fails while another installer's entry is in it.
      fs.renameSync(staging, lockPath);
    } catch (error) {
      const code = codeOf(error) ?? "";
      const contended = ["EEXIST", "ENOTEMPTY", "ENOTDIR"].includes(code) || (["EPERM", "EACCES"].includes(code) && exists(lockPath));
      if (!contended) throw error;
      return { holder: clearStale(lockPath) };
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  const key = `${lockPath}\0${entry}`;
  held.add(key);
  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      held.delete(key);
      fs.rmSync(path.join(lockPath, entry), { force: true });
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
export async function acquireInstallLock(lockPath: string, timeoutMs = 10000): Promise<InstallLock> {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    const result = attempt(lockPath);
    if ("release" in result) return result;
    if (performance.now() >= deadline) throw new InstallLockBusy(lockPath, result.holder);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** The same, for the zip's synchronous installer, which has nothing else to run while it waits. */
export function acquireInstallLockSync(lockPath: string, timeoutMs = 10000): InstallLock {
  const deadline = performance.now() + timeoutMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    const result = attempt(lockPath);
    if ("release" in result) return result;
    if (performance.now() >= deadline) throw new InstallLockBusy(lockPath, result.holder);
    Atomics.wait(pause, 0, 0, POLL_MS);
  }
}
