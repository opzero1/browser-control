// Fixtures for the packaging tests: a synthetic package root, injectable command deps, a temp-tree snapshot, and a
// guard that the real home directory's default install paths are never touched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PackageAssets } from "../../../src/server/assets";
import type { Env } from "../../../src/server/config";
import type { DoctorDeps } from "../../../src/server/commands/doctor";
import type { CommandDeps } from "../../../src/server/commands/install";
import { clipboardGuardBinary } from "../../../src/server/stable-copy";

/** The first bytes of a 64-bit little-endian Mach-O file. */
export const MACH_O = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);

export function writeFile(file: string, data: string | Uint8Array, mode = 0o644): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, { mode });
  fs.chmodSync(file, mode);
  return file;
}

/** A package root laid out like the published tarball, with one bundled skill. */
export function fakePackage(root: string, version = "1.2.3"): PackageAssets {
  const packageRoot = path.join(root, "package");
  writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@op1/browser-control", version,
    files: ["dist/server/", "dist/extension/", "native/clipboard-guard/", "skills/browser-control/", "README.md"]
  }));
  const extensionDir = path.join(packageRoot, "dist/extension");
  writeFile(path.join(extensionDir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Browser Control", version }));
  const nativeHost = writeFile(path.join(packageRoot, "dist/server/native-host.js"), `// native host ${version}\nprocess.exit(0);\n`);
  const clipboardGuardSource = writeFile(path.join(packageRoot, "native/clipboard-guard/clipboard_guard.swift"), "// synthetic guard\n");
  writeFile(path.join(packageRoot, "skills/browser-control/SKILL.md"), "---\nname: browser-control\ndescription: synthetic\n---\n");
  writeFile(path.join(packageRoot, "skills/browser-control/references/setup.md"), "# Setup\n");
  return { root: packageRoot, extensionDir, nativeHost, publicSuffixList: path.join(packageRoot, "data/psl.dat"), clipboardGuardSource, version };
}

/** A registered Chrome for Testing app with its executable. */
export function fakeChromeForTesting(root: string): string {
  const app = path.join(root, "apps/Google Chrome for Testing.app");
  writeFile(path.join(app, "Contents/MacOS/Google Chrome for Testing"), "#!/bin/sh\nexit 0\n", 0o755);
  return app;
}

export interface FakeDeps extends DoctorDeps {
  builds: number;
  located: string[];
}

/**
 * Deps for macOS without real system calls: LaunchServices resolves `app`, the command line tools are present,
 * and the builder writes a synthetic Mach-O guard with `mode`.
 */
export function fakeDeps(assets: PackageAssets, overrides: Partial<CommandDeps & { app: string | null; guardMode: number; guardData: Uint8Array }> = {}): FakeDeps {
  const deps: FakeDeps = {
    builds: 0,
    located: [],
    assets,
    platform: overrides.platform ?? "darwin",
    locateApp: overrides.locateApp ?? (async (bundleId) => {
      deps.located.push(bundleId);
      return overrides.app === undefined ? null : overrides.app;
    }),
    xcodeTools: overrides.xcodeTools ?? (async () => true),
    buildClipboardGuard: overrides.buildClipboardGuard ?? (async (env: Env, packaged: PackageAssets) => {
      deps.builds += 1;
      const binary = clipboardGuardBinary(env, packaged);
      writeFile(binary, overrides.guardData ?? MACH_O, overrides.guardMode ?? 0o700);
      return { path: binary, built: true };
    }),
    connect: async () => {
      const { Gate } = await import("../../../src/server/gate");
      throw new Gate("browser-control-unavailable");
    },
    smoke: {
      server: () => ({ command: process.execPath, args: ["-e", "process.exit(3)"] }),
      reap: async () => true,
      tempBase: () => os.tmpdir()
    }
  };
  return deps;
}

export type Tree = Record<string, string>;

/** Every entry under `root` with its type, mode, size, inode and mtime, for "nothing changed" assertions. */
export function snapshotTree(root: string): Tree {
  const result: Tree = {};
  const walk = (directory: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      const stats = fs.lstatSync(file);
      const kind = stats.isSymbolicLink() ? `link:${fs.readlinkSync(file)}` : stats.isDirectory() ? "dir" : "file";
      result[path.relative(root, file)] = `${kind} ${(stats.mode & 0o7777).toString(8)} ${stats.size} ${stats.ino} ${stats.mtimeMs}`;
      if (entry.isDirectory()) walk(file);
    }
  };
  walk(root);
  return result;
}

/**
 * The real home directory's default install locations (from the password database, so a HOME override cannot
 * hide them), with an lstat fingerprint of each. Only metadata is read.
 */
export function realDefaultPaths(): Record<string, string> {
  const home = os.userInfo().homedir;
  const candidates = [
    ".local/state/browser-control",
    "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.opzero.chrome.json",
    "Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts/com.opzero.chrome.json",
    ".config/google-chrome/NativeMessagingHosts/com.opzero.chrome.json",
    ".config/opencode/skills/browser-control",
    ".claude/skills/browser-control",
    ".agents/skills/browser-control"
  ];
  return Object.fromEntries(candidates.map((relative) => {
    const file = path.join(home, relative);
    try {
      const stats = fs.lstatSync(file);
      return [file, `${stats.mode} ${stats.size} ${stats.ino} ${stats.mtimeMs}`];
    } catch {
      return [file, "absent"];
    }
  }));
}

export function readText(file: string): string {
  return fs.readFileSync(file, "utf8");
}
