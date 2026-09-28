// Files that ship inside the package (C3). The bundle runs from dist/server and the tests from src/server;
// both sit two levels below the package root.
import fs from "node:fs";
import path from "node:path";

export interface PackageAssets { root: string; extensionDir: string; nativeHost: string; publicSuffixList: string; clipboardGuardSource: string; version: string }

let cached: PackageAssets | null = null;

export function packageAssets(): PackageAssets {
  if (cached) return cached;
  const root = path.resolve(__dirname, "../..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || !/^[0-9A-Za-z.+-]{1,64}$/.test(manifest.version)) {
    throw new Error("package.json has no usable version");
  }
  cached = {
    root,
    extensionDir: path.join(root, "dist/extension"),
    nativeHost: path.join(root, "dist/server/native-host.js"),
    publicSuffixList: path.join(root, "data/public_suffix_list.dat"),
    clipboardGuardSource: path.join(root, "native/clipboard-guard/clipboard_guard.swift"),
    version: manifest.version
  };
  return cached;
}
