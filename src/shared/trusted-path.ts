// The one rule for a directory that the installers, the native host or the server create, write, delete, bind or
// connect through: no other user may be able to change what its path leads to. The release zip's installer, the
// native host and its client.js and transport.js run on Node 18, so this uses only node:fs and node:path.
//
// The path is walked as given, one component at a time from /, the way the kernel resolves it. Every directory on
// the way, and the one at the end, must be owned by this user or root and writable only by its owner unless it
// has the sticky bit (OpenSSH's safe_path rule). A symlink is followed only when the directory that holds it
// passed and the symlink is owned by this user or root, since in a sticky directory the owner of an entry can
// replace it; its target is then walked the same way, through at most MAX_SYMLINKS symlinks in all. macOS /var
// and /tmp are root's symlinks in root's /, so they pass.
//
// The result is the canonical path, which holds no symlink, and the identity of the directory it names. Only this
// user or root can rename, replace or repoint anything on it, so callers work through that path from then on and
// use the path they were given only in messages.
import fs from "node:fs";
import path from "node:path";

export interface Identity {
  readonly dev: number;
  readonly ino: number;
}

/** A directory whose path passed the rule, by its canonical path, with the identity it had then. */
export interface TrustedDirectory extends Identity {
  readonly path: string;
}

/**
 * A missing directory whose existing part passed the rule: `path` is where it would be, `missing` its first missing
 * directory. Nothing past `missing` was checked, and in a sticky directory another user may create it at any
 * time, so nothing may be read through `path`; make it with the `create` option instead.
 */
export interface MissingDirectory {
  readonly path: string;
  readonly missing: string;
}

/** The first directory or symlink, by canonical path, that another user could change. */
export interface UntrustedPath {
  readonly unsafe: string;
}

/** The file system calls the walk makes; tests replace them to simulate another owner or a race. */
export interface TrustedPathFs {
  lstat(file: string): fs.Stats;
  readlink(file: string): string;
  mkdir(directory: string, mode: number): void;
}

export interface TrustedPathOptions {
  /** Make each missing directory with this mode, inside its checked parent, instead of failing with ENOENT. */
  readonly create?: number;
  /**
   * Report where a missing directory would be instead of failing with ENOENT. A `..` after the missing directory
   * still fails with ENOENT, as the kernel fails there: the directory it would lead to was never walked.
   */
  readonly missing?: boolean;
  readonly calls?: Partial<TrustedPathFs>;
}

/** More symlinks than this on one path are refused. */
export const MAX_SYMLINKS = 16;

const WRITABLE_BY_OTHERS = 0o022;
const STICKY = 0o1000;

const nodeFs: TrustedPathFs = {
  lstat: (file) => fs.lstatSync(file),
  readlink: (file) => fs.readlinkSync(file),
  mkdir: (directory, mode) => fs.mkdirSync(directory, { mode })
};

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/** Windows has no POSIX owners or modes, so there only the kind of each entry is checked. */
function ownerId(): number | undefined {
  return process.getuid?.();
}

function ownedByUs(stats: fs.Stats): boolean {
  const uid = ownerId();
  return uid === undefined || stats.uid === uid || stats.uid === 0;
}

/** A directory that only its owner, this user or root, can change: others may write to it only if it is sticky. */
function trustedDirectory(stats: fs.Stats): boolean {
  if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
  if (ownerId() === undefined) return true;
  const shared = (stats.mode & WRITABLE_BY_OTHERS) !== 0 && (stats.mode & STICKY) === 0;
  return ownedByUs(stats) && !shared;
}

function components(text: string): string[] {
  return text.split(process.platform === "win32" ? /[\\/]+/ : /\/+/).filter((part) => part && part !== ".");
}

export function trustedPath(given: string, options: TrustedPathOptions & { readonly missing: true }): TrustedDirectory | MissingDirectory | UntrustedPath;
export function trustedPath(given: string, options?: TrustedPathOptions): TrustedDirectory | UntrustedPath;
/**
 * The canonical path of the directory `given` and its identity, once the whole walk passed the rule above; else
 * the first directory or symlink at fault. A relative path is taken from the working directory. Errors other than
 * a missing directory (EACCES, ENOTDIR) are thrown.
 */
export function trustedPath(given: string, options: TrustedPathOptions = {}): TrustedDirectory | MissingDirectory | UntrustedPath {
  const io = { ...nodeFs, ...options.calls };
  const absolute = path.isAbsolute(given) ? given : `${process.cwd()}${path.sep}${given}`;
  const root = path.parse(absolute).root;
  const pending = components(absolute.slice(root.length));
  let current = root;
  let stats = io.lstat(current);
  if (!trustedDirectory(stats)) return { unsafe: current };
  let links = 0;
  while (pending.length) {
    const name = pending.shift() as string;
    if (name === "..") {
      // `current` holds no symlink, so this is its real parent, which the walk already passed through.
      current = path.dirname(current);
      stats = io.lstat(current);
      if (!trustedDirectory(stats)) return { unsafe: current };
      continue;
    }
    const next = path.join(current, name);
    let entry: fs.Stats;
    try {
      entry = io.lstat(next);
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error;
      if (options.create === undefined) {
        // Joining a `..` as text would name a directory the walk never checked.
        if (options.missing && !pending.includes("..")) return { path: path.join(next, ...pending), missing: next };
        throw error;
      }
      // Made inside `current`, which passed. In a sticky directory another user can make an entry here first, so
      // whatever is at `next` afterwards is checked below like any other entry.
      try {
        io.mkdir(next, options.create);
      } catch (made) {
        if (codeOf(made) !== "EEXIST") throw made;
      }
      entry = io.lstat(next);
    }
    if (entry.isSymbolicLink()) {
      links += 1;
      if (!ownedByUs(entry) || links > MAX_SYMLINKS) return { unsafe: next };
      const target = io.readlink(next);
      pending.unshift(...components(path.isAbsolute(target) ? target.slice(path.parse(target).root.length) : target));
      if (path.isAbsolute(target)) {
        current = path.parse(target).root;
        stats = io.lstat(current);
        if (!trustedDirectory(stats)) return { unsafe: current };
      }
      continue;
    }
    if (!trustedDirectory(entry)) return { unsafe: next };
    current = next;
    stats = entry;
  }
  return { path: current, dev: stats.dev, ino: stats.ino };
}

/** Owned by this user, with no group or other bits, and still the directory the walk saw. */
function privateAt(stats: fs.Stats, directory: TrustedDirectory): boolean {
  return stats.isDirectory() && stats.dev === directory.dev && stats.ino === directory.ino && stats.uid === ownerId() && (stats.mode & 0o077) === 0;
}

/**
 * The canonical path of the directory `given` once it passed the rule and is private: owned by this user, with
 * no group or other bits, and still the directory the walk saw. Else the directory or symlink at fault, which is
 * the canonical directory itself when only its owner or mode fails. With `create`, missing directories are made
 * as in trustedPath. Nothing below a private directory can be changed by another user, so a caller creates and
 * writes only there, through the path returned. On Windows, which has no owners, no directory is private.
 */
export function privateDirectory(given: string, options: Pick<TrustedPathOptions, "create" | "calls"> = {}): TrustedDirectory | UntrustedPath {
  const directory = trustedPath(given, options);
  if ("unsafe" in directory) return directory;
  const stats = (options.calls?.lstat ?? nodeFs.lstat)(directory.path);
  return privateAt(stats, directory) ? directory : { unsafe: directory.path };
}

/**
 * The path to export for a Unix socket: its directory's canonical path, where a missing part is kept as given,
 * and its name; or, when its directory fails the rule, the directory or symlink at fault. A path that is
 * relative or has no plain name, and one whose `..` follows a missing directory, is returned as given; the host
 * and the server refuse it when they use it.
 */
export function checkedSocketPath(file: string, calls: Partial<TrustedPathFs> = {}): string | UntrustedPath {
  const name = path.basename(file);
  if (!path.isAbsolute(file) || !name || name === "." || name === "..") return file;
  try {
    const directory = trustedPath(path.dirname(file), { missing: true, calls });
    return "unsafe" in directory ? directory : path.join(directory.path, name);
  } catch (error) {
    if (codeOf(error) === undefined) throw error;
    return file;
  }
}

/** checkedSocketPath, with a socket whose directory fails the rule returned as given. */
export function canonicalSocketPath(file: string, calls: Partial<TrustedPathFs> = {}): string {
  const checked = checkedSocketPath(file, calls);
  return typeof checked === "string" ? checked : file;
}

/** A socket endpoint that privateSocket checked: its canonical path and identity, and its private directory. */
export interface PrivateSocket extends Identity {
  readonly path: string;
  readonly directory: TrustedDirectory;
}

/**
 * The Unix socket `file` for a client to connect to or probe: its directory passed the rule, is private (owned by
 * this user, no group or other bits) and still has the identity the rule saw, and the endpoint there is a socket
 * owned by this user that group and others cannot use. Only this user or root can change anything on its
 * canonical path, so connecting through it reaches the endpoint that was checked, and an unlink there, once the
 * identities are checked again, removes only that endpoint. Anything else throws: a file system error such as
 * ENOENT as it is, and an unsafe path as an Error without a code. On Windows, which has no owners, every path
 * throws.
 */
export function privateSocket(file: string, calls: Partial<TrustedPathFs> = {}): PrivateSocket {
  const name = path.basename(file);
  if (!name || name === "." || name === "..") throw new Error("socket name required");
  const directory = trustedPath(path.dirname(file), { calls });
  if ("unsafe" in directory) throw new Error("trusted socket directory required");
  const lstat = calls.lstat ?? nodeFs.lstat;
  const canonical = path.join(directory.path, name);
  const uid = ownerId();
  const parent = lstat(directory.path);
  const endpoint = lstat(canonical);
  if (!privateAt(parent, directory) || !endpoint.isSocket() || endpoint.uid !== uid || endpoint.mode & 0o077) {
    throw new Error("private owned socket required");
  }
  return { path: canonical, dev: endpoint.dev, ino: endpoint.ino, directory };
}

/**
 * The canonical path of the Unix socket `file` (privateSocket). The server, client.js, transport.js, the host's
 * stale-socket probe and the pool's endpoint probe all connect this way.
 */
export function privateSocketEndpoint(file: string, calls: Partial<TrustedPathFs> = {}): string {
  return privateSocket(file, calls).path;
}
