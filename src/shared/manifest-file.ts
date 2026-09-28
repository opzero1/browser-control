// How both com.opzero.chrome installers read a manifest that is already in its directory. The directory passed the
// trusted-path rule (src/shared/trusted-path.ts), but that rule lets other users add entries to a directory with
// the sticky bit, so the manifest there can be another user's, who can change it at any time. Only a regular
// file, not a symlink, owned by this user and not writable by group or others is taken as what it says; anything
// else is untrusted, whatever its bytes. The release zip's installer runs on Node 18, so this uses only node:fs
// and node:path.
import fs from "node:fs";
import path from "node:path";

/** What is at a manifest's path. `text` is null unless it is a regular file of at most 64 KiB that could be read. */
export type ExistingManifest =
  | { readonly kind: "absent" }
  | {
    readonly kind: "present";
    readonly text: string | null;
    /** A regular file, not a symlink, owned by this user, that group and others cannot write to. */
    readonly trusted: boolean;
    /**
     * Whether this user may rename a new manifest over it. Only the entry's owner, the directory's owner or root
     * may replace an entry in a sticky directory.
     */
    readonly replaceable: boolean;
  };

/** The lstat the rule reads owners and modes from; tests replace it to simulate another owner. */
export interface ManifestFileFs {
  lstat(file: string): fs.Stats;
}

const LIMIT = 65536;
const WRITABLE_BY_OTHERS = 0o022;
const STICKY = 0o1000;

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/** The manifest at `file`, read without following a symlink, by the inode lstat saw. */
export function existingManifest(file: string, calls: Partial<ManifestFileFs> = {}): ExistingManifest {
  const lstat = calls.lstat ?? ((target: string) => fs.lstatSync(target));
  let entry: fs.Stats;
  try {
    entry = lstat(file);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return { kind: "absent" };
    return { kind: "present", text: null, trusted: false, replaceable: false };
  }
  // Windows has no POSIX owners or modes, so there only the kind of the entry is checked.
  const uid = process.getuid?.();
  let replaceable = uid === undefined || uid === 0 || entry.uid === uid;
  if (!replaceable) {
    try {
      const directory = lstat(path.dirname(file));
      replaceable = (directory.mode & STICKY) === 0 || directory.uid === uid;
    } catch {
      // Unknown, so not replaceable.
    }
  }
  let text: string | null = null;
  if (entry.isFile() && entry.size <= LIMIT) {
    try {
      // O_NONBLOCK: an entry swapped for a FIFO since the lstat cannot block the open.
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      try {
        const opened = fs.fstatSync(fd);
        if (opened.isFile() && opened.dev === entry.dev && opened.ino === entry.ino && opened.size <= LIMIT) text = fs.readFileSync(fd, "utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Unreadable: nothing is taken from it.
    }
  }
  const trusted = text !== null && (uid === undefined || (entry.uid === uid && (entry.mode & WRITABLE_BY_OTHERS) === 0));
  return { kind: "present", text, trusted, replaceable };
}

/** The host a manifest's text names in `path`, or null when it names none readably. */
export function namedHost(text: string | null): string | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && typeof (parsed as { path?: unknown }).path === "string" ? (parsed as { path: string }).path : null;
  } catch {
    return null;
  }
}
