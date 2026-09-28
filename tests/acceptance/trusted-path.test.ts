// The trusted-path rule (src/shared/trusted-path.ts) that both installers, the native host and the server apply.
// Every directory is a temporary one; the real home and temporary directories are only read.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSocketPath, MAX_SYMLINKS, trustedPath } from "../../src/shared/trusted-path";
import { privateTemp, removeTempRoots } from "../server/support/temp";

afterEach(() => {
  removeTempRoots();
});

/** lstat that reports `owner` as the uid of `file`; tests cannot chown. */
function ownedBy(file: string, owner: number) {
  return (target: string) => (target === file ? Object.assign(fs.lstatSync(target), { uid: owner }) : fs.lstatSync(target));
}

function identity(directory: string) {
  const stats = fs.lstatSync(directory);
  return { path: directory, dev: stats.dev, ino: stats.ino };
}

describe("the trusted-path rule", () => {
  it.each([["0770", 0o770], ["0707", 0o707], ["0777", 0o777]])("refuses a symlink in a directory with mode %s and no sticky bit, naming that directory", (_mode, mode) => {
    const root = privateTemp("tp-");
    const real = path.join(root, "real");
    fs.mkdirSync(real, { mode: 0o700 });
    const shared = path.join(root, "shared");
    fs.mkdirSync(shared);
    fs.chmodSync(shared, mode);
    fs.symlinkSync(real, path.join(shared, "link"));
    expect(trustedPath(path.join(shared, "link"))).toEqual({ unsafe: shared });
    expect(trustedPath(path.join(shared, "link/missing"), { missing: true })).toEqual({ unsafe: shared });
    expect(trustedPath(path.join(shared, "link/made"), { create: 0o700 })).toEqual({ unsafe: shared });
    expect(fs.readdirSync(real)).toEqual([]);
  });

  it("follows a symlink in a sticky directory only when it is yours or root's", () => {
    const root = privateTemp("tp-");
    const real = path.join(root, "real");
    fs.mkdirSync(real, { mode: 0o700 });
    const sticky = path.join(root, "sticky");
    fs.mkdirSync(sticky);
    fs.chmodSync(sticky, 0o1777);
    const link = path.join(sticky, "link");
    fs.symlinkSync(real, link);
    expect(trustedPath(link)).toEqual(identity(real));
    expect(trustedPath(link, { calls: { lstat: ownedBy(link, 0) } })).toEqual(identity(real));
    // Another user's symlink in a sticky directory is theirs to replace.
    expect(trustedPath(link, { calls: { lstat: ownedBy(link, fs.lstatSync(link).uid + 1) } })).toEqual({ unsafe: link });
  });

  it("refuses a directory on the path, or at its end, that another user owns or others can write to, and accepts root's", () => {
    const root = privateTemp("tp-");
    const middle = path.join(root, "middle");
    const end = path.join(middle, "end");
    fs.mkdirSync(end, { recursive: true, mode: 0o755 });
    const other = fs.lstatSync(root).uid + 1;
    expect(trustedPath(end, { calls: { lstat: ownedBy(middle, other) } })).toEqual({ unsafe: middle });
    expect(trustedPath(end, { calls: { lstat: ownedBy(end, other) } })).toEqual({ unsafe: end });
    expect(trustedPath(end, { calls: { lstat: ownedBy(middle, 0) } })).toEqual(identity(end));
    fs.chmodSync(end, 0o775);
    expect(trustedPath(end)).toEqual({ unsafe: end });
    fs.chmodSync(end, 0o1775);
    expect(trustedPath(end)).toEqual(identity(end));
    fs.writeFileSync(path.join(root, "file"), "");
    expect(trustedPath(path.join(root, "file"))).toEqual({ unsafe: path.join(root, "file") });
    expect(trustedPath(path.join(root, "file/below"))).toEqual({ unsafe: path.join(root, "file") });
  });

  it("canonicalizes a lexical chain through symlinks in trusted directories: absolute, relative, chained and with ..", () => {
    const root = privateTemp("tp-");
    const real = path.join(root, "a/b/real");
    fs.mkdirSync(real, { recursive: true, mode: 0o700 });
    fs.symlinkSync(real, path.join(root, "absolute"));
    fs.symlinkSync("a/b/real", path.join(root, "relative"));
    fs.symlinkSync("../absolute", path.join(root, "a/up"));
    fs.symlinkSync("up", path.join(root, "a/chained"));
    // Joined as text: path.join would resolve each `..` lexically first.
    for (const given of ["absolute", "relative", "a/up", "a/chained", "a/chained/../real", "absolute/../../b/./real"]) {
      expect(trustedPath(`${root}/${given}`), given).toEqual(identity(real));
    }
    // `..` after a symlink leaves the directory it resolved to, as the kernel does.
    expect(trustedPath(`${path.join(root, "absolute")}/..`)).toEqual(identity(path.join(root, "a/b")));
  });

  it(`refuses more than ${MAX_SYMLINKS} symlinks on one path, and a loop`, () => {
    const root = privateTemp("tp-");
    fs.mkdirSync(path.join(root, "real"), { mode: 0o700 });
    let previous = path.join(root, "real");
    for (let index = 0; index <= MAX_SYMLINKS; index += 1) {
      const link = path.join(root, `l${index}`);
      fs.symlinkSync(previous, link);
      previous = link;
    }
    expect(trustedPath(path.join(root, `l${MAX_SYMLINKS - 1}`))).toEqual(identity(path.join(root, "real")));
    expect(trustedPath(path.join(root, `l${MAX_SYMLINKS}`))).toMatchObject({ unsafe: expect.stringMatching(/\/l0$/) });
    fs.symlinkSync("loop-b", path.join(root, "loop-a"));
    fs.symlinkSync("loop-a", path.join(root, "loop-b"));
    expect(trustedPath(path.join(root, "loop-a"))).toHaveProperty("unsafe");
  });

  it("reports or makes a missing directory only inside directories that passed", () => {
    const root = privateTemp("tp-");
    fs.mkdirSync(path.join(root, "real"), { mode: 0o700 });
    fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));
    const given = path.join(root, "link/x/y");
    expect(() => trustedPath(given)).toThrowError(/^ENOENT: /);
    expect(trustedPath(given, { missing: true })).toEqual({ path: path.join(root, "real/x/y"), missing: path.join(root, "real/x") });
    expect(fs.readdirSync(path.join(root, "real"))).toEqual([]);
    const made = trustedPath(given, { create: 0o700 });
    expect(made).toEqual(identity(path.join(root, "real/x/y")));
    for (const directory of ["real/x", "real/x/y"]) expect(fs.lstatSync(path.join(root, directory)).mode & 0o777).toBe(0o700);
  });

  it("never reports a path whose `..` follows a missing directory as missing, since the walk never checked where it leads", () => {
    const root = privateTemp("tp-");
    // `attacker` is another user's to change: others can write to it, and `hosts` in it is a symlink.
    const attacker = path.join(root, "attacker");
    fs.mkdirSync(attacker);
    fs.chmodSync(attacker, 0o777);
    fs.mkdirSync(path.join(root, "real"), { mode: 0o700 });
    fs.symlinkSync(path.join(root, "real"), path.join(attacker, "hosts"));
    // Joined as text: path.join would resolve each `..` lexically first.
    const given = `${root}/gap/../attacker/hosts`;
    fs.symlinkSync(given, path.join(root, "link"));
    for (const through of [given, path.join(root, "link"), `${root}/gap/x/../y`, `${path.join(root, "link")}/sub`]) {
      expect(() => trustedPath(through, { missing: true }), through).toThrowError(/^ENOENT: /);
    }
    expect(canonicalSocketPath(`${given}/s.sock`)).toBe(`${given}/s.sock`);
    expect(fs.existsSync(path.join(root, "gap"))).toBe(false);
    // A missing tail without `..` is still reported, by the path the walk would make.
    expect(trustedPath(`${root}/gap/./x`, { missing: true })).toEqual({ path: path.join(root, "gap/x"), missing: path.join(root, "gap") });
  });

  it.runIf(process.platform === "darwin")("accepts macOS /var and /tmp, root's symlinks in root's /, and resolves them", () => {
    expect(trustedPath("/var")).toMatchObject({ path: "/private/var" });
    expect(trustedPath("/tmp")).toMatchObject({ path: "/private/tmp" });
  });

  it("accepts the normal locations (read only): the home chain, the temporary directory, ~/.opzero-chrome and a state root's sockets", () => {
    const home = os.userInfo().homedir;
    expect(trustedPath(home)).toMatchObject({ path: fs.realpathSync(home) });
    // os.tmpdir() is /var/folders/... on macOS, reached through /var.
    expect(trustedPath(os.tmpdir())).toMatchObject({ path: fs.realpathSync(os.tmpdir()) });
    const opzero = trustedPath(path.join(home, ".opzero-chrome"), { missing: true });
    expect(opzero).not.toHaveProperty("unsafe");
    expect(opzero.path).toBe(path.join(fs.realpathSync(home), ".opzero-chrome"));
    const state = path.join(privateTemp("tp-"), "state");
    expect(trustedPath(path.join(state, "sockets"), { create: 0o700 })).toEqual(identity(path.join(state, "sockets")));
    expect(canonicalSocketPath(path.join(state, "sockets/user.sock"))).toBe(path.join(state, "sockets/user.sock"));
  });
});

describe("the canonical socket path", () => {
  it("is the socket's directory's canonical path and its name, with a missing part kept, or the path given when it cannot be trusted", () => {
    const root = privateTemp("tp-");
    fs.mkdirSync(path.join(root, "real"), { mode: 0o700 });
    fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));
    expect(canonicalSocketPath(path.join(root, "link/s.sock"))).toBe(path.join(root, "real/s.sock"));
    expect(canonicalSocketPath(path.join(root, "link/missing/s.sock"))).toBe(path.join(root, "real/missing/s.sock"));
    const shared = path.join(root, "shared");
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o777);
    fs.symlinkSync(path.join(root, "real"), path.join(shared, "link"));
    for (const given of [path.join(shared, "link/s.sock"), "relative/s.sock", `${root}/link/..`]) expect(canonicalSocketPath(given)).toBe(given);
  });
});
