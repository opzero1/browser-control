// Crash-safe cross-process locks in place of fcntl.flock (design 4.4). Each lock is a zero-byte SQLite
// database under the Python lock file's name. A shared lock is an open read transaction (SQLite SHARED); an
// exclusive lock is BEGIN EXCLUSIVE. SQLite's POSIX advisory locks are released when the process exits, even
// on SIGKILL, and its unix VFS tracks locks per inode, so two holders in one process conflict as flock does.
// The databases are never written; the journal lives in memory, so no -journal file appears.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as Database } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { checkFileStats, entryStats, FsError, io, verified, type PrivateDir } from "./fs-private";
import { Gate } from "./gate";
import { monotonic, sleep } from "./time";

export interface HeldLock { readonly name: string; release(): void }

let sqlite: typeof import("node:sqlite") | undefined;

function databaseModule(): typeof import("node:sqlite") {
  if (sqlite) return sqlite;
  // Keep stderr clean if this Node still marks node:sqlite experimental.
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning?.message;
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if (type === "ExperimentalWarning" && /SQLite/i.test(String(text))) return;
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  } finally {
    process.emitWarning = emit;
  }
  return sqlite;
}

class Busy extends Error {}

const SQLITE_CANTOPEN = 14;

function isBusy(error: unknown): boolean {
  const record = error as { errcode?: number } | null;
  return typeof record?.errcode === "number" && (record.errcode & 0xff) === 5;
}

const { O_RDWR, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;

/**
 * check_file for a lock file, creating a missing one 0600 like browser_pool.open_lock. An existing lock file is
 * only lstat'ed, never opened: closing any descriptor of a file drops every POSIX lock this process holds on
 * it, which would silently release SQLite's locks for other holders in this process while SQLite still counts
 * them as held. A new file is created with O_EXCL, so the descriptor closed here is on an inode nobody locks.
 */
function lockFileStats(dir: PrivateDir, name: string): fs.Stats {
  let attempts = 3;
  while (true) {
    const existing = entryStats(dir, name);
    if (existing) {
      // What os.open(name, O_RDWR | O_NOFOLLOW) would have refused.
      if (existing.isSymbolicLink()) throw new FsError("ELOOP");
      if (existing.isDirectory()) throw new FsError("EISDIR");
      if (existing.isSocket()) throw new FsError("ENXIO");
      checkFileStats(existing);
      return existing;
    }
    let fd: number;
    try {
      fd = fs.openSync(path.join(verified(dir), name), O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // EEXIST: another process created it meanwhile. ENOENT: macOS can fail an O_CREAT open while another
      // process creates the same name.
      if ((code === "EEXIST" || code === "ENOENT") && --attempts) continue;
      return io(() => { throw error; });
    }
    try {
      const stats = io(() => fs.fstatSync(fd));
      checkFileStats(stats);
      return stats;
    } finally {
      fs.closeSync(fd);
    }
  }
}

/** One attempt; throws Busy when another holder conflicts. */
function attempt(dir: PrivateDir, name: string, exclusive: boolean): HeldLock {
  const before = lockFileStats(dir, name);
  // mode=rw: SQLite must never create the file itself (with its default 0644) if it vanished meanwhile.
  const file = pathToFileURL(path.join(verified(dir), name));
  file.searchParams.set("mode", "rw");
  let database: Database;
  try {
    database = new (databaseModule().DatabaseSync)(file, { timeout: 0 });
  } catch (error) {
    if ((error as { errcode?: number } | null)?.errcode === SQLITE_CANTOPEN) throw new FsError("ENOENT");
    return io(() => { throw error; });
  }
  let held = false;
  try {
    database.exec("PRAGMA busy_timeout=0");
    try {
      // Setting the journal mode reads the file, so it can itself find the lock busy.
      database.prepare("PRAGMA journal_mode=MEMORY").get();
      if (exclusive) {
        database.exec("BEGIN EXCLUSIVE");
      } else {
        database.exec("BEGIN DEFERRED");
        database.prepare("SELECT count(*) FROM sqlite_schema").get();
      }
    } catch (error) {
      if (isBusy(error)) throw new Busy();
      throw error;
    }
    held = true;
    const current = entryStats(dir, name);
    if (!current || current.dev !== before.dev || current.ino !== before.ino) throw new Gate("browser-controller-unsafe-registry");
    let released = false;
    return {
      name,
      release() {
        if (released) return;
        released = true;
        try {
          database.exec("ROLLBACK");
        } finally {
          database.close();
        }
      }
    };
  } catch (error) {
    try {
      if (held) database.exec("ROLLBACK");
    } catch {
      // The close below releases the lock either way.
    }
    database.close();
    if (error instanceof Busy || error instanceof Gate) throw error;
    return io(() => { throw error; });
  }
}

/** A non-blocking lock; a conflicting holder is `browser-controller-pinned`. */
export function lockNow(dir: PrivateDir, name: string, exclusive: boolean): HeldLock {
  try {
    return attempt(dir, name, exclusive);
  } catch (error) {
    if (error instanceof Busy) throw new Gate("browser-controller-pinned");
    throw error;
  }
}

/** Python's blocking flock: wait (polling, never blocking the event loop) until the lock is free. */
export async function lockWait(dir: PrivateDir, name: string, exclusive: boolean): Promise<HeldLock> {
  while (true) {
    try {
      return attempt(dir, name, exclusive);
    } catch (error) {
      if (!(error instanceof Busy)) throw error;
    }
    await sleep(10);
  }
}

/** browser_pool.lock_until: an exclusive lock by a monotonic deadline, else `code`. */
export async function lockUntil(dir: PrivateDir, name: string, deadline: number, code = "browser-controller-startup-timeout"): Promise<HeldLock> {
  while (true) {
    try {
      return attempt(dir, name, true);
    } catch (error) {
      if (!(error instanceof Busy)) throw error;
    }
    const remaining = deadline - monotonic();
    if (remaining <= 0) throw new Gate(code);
    await sleep(Math.min(0.05, remaining) * 1000);
  }
}
