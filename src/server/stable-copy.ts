// Stable, versioned copies under the state root (C3). Chrome manifests and wrappers point here, never into the
// npx cache, so an upgrade or cache eviction cannot leave Chrome launching a missing or changed host.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { packageAssets, type PackageAssets } from "./assets";
import { HOST_SOCKET_ENV, ISOLATED_EXTENSION_ID, ISOLATED_EXTENSION_KEY, statePaths, type Env } from "./config";
import { childDirectory, existingDirectory, io, openDirectory, readPrivate, syncDirectory, verified, writePrivate, type PrivateDir } from "./fs-private";
import { Gate } from "./gate";

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Chrome's ID alphabet: the first 32 hex digits of a SHA-256, with 0-f mapped to a-p. */
function chromeId(digest: string): string {
  return [...digest.slice(0, 32)].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
}

/** The ID Chrome gives an unpacked extension without a manifest key: a hash of its absolute path. */
export function unpackedExtensionId(absolutePath: string): string {
  return chromeId(sha256(Buffer.from(absolutePath, "utf8")));
}

/** The ID Chrome gives an extension whose manifest carries `key` (base64 DER SubjectPublicKeyInfo). */
export function extensionIdFromKey(key: string): string {
  return chromeId(sha256(Buffer.from(key, "base64")));
}

/**
 * Publish `files` as <parent>/<name>/ atomically: build a private temporary directory beside it, fsync, then
 * rename. An existing copy whose files differ is replaced the same way.
 */
export function publishTree(parent: PrivateDir, name: string, files: ReadonlyMap<string, Uint8Array>): string {
  const target = path.join(verified(parent), name);
  if (treeMatches(target, files)) return target;
  const temporary = `.tmp-${randomUUID()}`;
  const staging = childDirectory(parent, temporary);
  try {
    for (const [relative, data] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      let directory = staging;
      const parts = relative.split("/");
      for (const part of parts.slice(0, -1)) directory = childDirectory(directory, part);
      writePrivate(directory, parts[parts.length - 1], data, 0o600, ".write-");
    }
    if (fs.existsSync(target)) io(() => fs.rmSync(target, { recursive: true, force: true }));
    try {
      io(() => fs.renameSync(staging.path, target));
    } catch (error) {
      // Another process published the same name first.
      if (!treeMatches(target, files)) throw error;
    }
    syncDirectory(parent);
  } finally {
    fs.rmSync(path.join(parent.path, temporary), { recursive: true, force: true });
  }
  if (!treeMatches(target, files)) throw new Gate("browser-controller-unsafe-directory");
  return target;
}

/** Read-only: `target` is a private directory holding exactly `files`, each an owner-only regular file. */
export function treeMatches(target: string, files: ReadonlyMap<string, Uint8Array>): boolean {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(target);
  } catch {
    return false;
  }
  if (!stats.isDirectory() || stats.uid !== process.getuid?.() || stats.mode & 0o077) return false;
  let present: string[];
  try {
    present = listFiles(target);
  } catch {
    return false;
  }
  if (present.length !== files.size) return false;
  for (const relative of present) {
    const expected = files.get(relative);
    if (!expected) return false;
    try {
      const directory = existingDirectory(path.dirname(path.join(target, relative)));
      const data = directory && readPrivate(directory, path.basename(relative), 256 * 1024 * 1024, "browser-controller-unsafe-directory");
      if (!data || !data.equals(Buffer.from(expected))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function listFiles(root: string, prefix = ""): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...listFiles(root, relative));
    else result.push(relative);
  }
  return result.sort();
}

/** A digest of relative paths and contents, in path order; stable copies are named by its first 12 digits. */
export function treeDigest(files: ReadonlyMap<string, Uint8Array>): string {
  const hash = createHash("sha256");
  for (const [relative, data] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(`${relative}\0${data.length}\0`);
    hash.update(data);
  }
  return hash.digest("hex");
}

export interface StableHost { dir: string; hostScript: string; version: string; digest: string }

/** Where ensureStableHost puts this package's native host, and its bytes, computed without writing anything. */
export function stableHostPlan(env: Env = process.env, assets: PackageAssets = packageAssets()): StableHost & { data: Buffer } {
  const data = io(() => fs.readFileSync(assets.nativeHost));
  const digest = sha256(data);
  const dir = path.join(statePaths(env).hosts, `${assets.version}-${digest.slice(0, 12)}`);
  return { dir, hostScript: path.join(dir, "native-host.js"), version: assets.version, digest, data };
}

/** <hosts>/<version>-<sha12>/native-host.js: an idempotent, verified copy of the bundled native host. */
export async function ensureStableHost(env: Env = process.env, assets: PackageAssets = packageAssets()): Promise<StableHost> {
  const { dir: planned, version, digest, data } = stableHostPlan(env, assets);
  const hosts = openDirectory(path.dirname(planned));
  const dir = publishTree(hosts, path.basename(planned), new Map([["native-host.js", data]]));
  return { dir, hostScript: path.join(dir, "native-host.js"), version, digest };
}

export interface StableExtension { dir: string; id: string; origin: string }

/**
 * <extensions>/<version>-<sha12>/: the packaged extension with ISOLATED_EXTENSION_KEY injected as "key", so
 * isolated profiles load it under one fixed ID (Q1). The key never enters src/extension or the store package.
 */
export async function ensureStableExtension(env: Env = process.env, assets: PackageAssets = packageAssets()): Promise<StableExtension> {
  const files = new Map<string, Uint8Array>();
  for (const relative of listFiles(assets.extensionDir)) files.set(relative, io(() => fs.readFileSync(path.join(assets.extensionDir, relative))));
  const manifest = files.get("manifest.json");
  if (!manifest) throw new Gate("browser-controller-startup-not-installed");
  const parsed = JSON.parse(Buffer.from(manifest).toString("utf8")) as Record<string, unknown>;
  files.set("manifest.json", Buffer.from(`${JSON.stringify({ ...parsed, key: ISOLATED_EXTENSION_KEY }, null, 2)}\n`));
  const extensions = openDirectory(statePaths(env).extensions);
  const dir = publishTree(extensions, `${assets.version}-${treeDigest(files).slice(0, 12)}`, files);
  const id = extensionIdFromKey(ISOLATED_EXTENSION_KEY);
  if (id !== ISOLATED_EXTENSION_ID) throw new Error("isolated extension key and ID disagree");
  return { dir, id, origin: `chrome-extension://${id}/` };
}

/** browser_start.host_wrapper: a /bin/sh wrapper that pins the socket and execs Node on the stable host. */
export function hostWrapper(socket: string, hostScript: string, node: string): string {
  const values = [socket, node, hostScript];
  if (values.some((value) => value.includes("'") || /[\x00-\x1f\x7f]/.test(value))) throw new Gate("browser-controller-unsafe-path");
  return `#!/bin/sh\nexport ${HOST_SOCKET_ENV}='${values[0]}'\nexec '${values[1]}' '${values[2]}'\n`;
}

/** <bin>/clipboard-guard-<sha12 of the Swift source> (D16). */
export function clipboardGuardBinary(env: Env = process.env, assets: PackageAssets = packageAssets()): string {
  const source = io(() => fs.readFileSync(assets.clipboardGuardSource));
  return path.join(statePaths(env).bin, `clipboard-guard-${sha256(source).slice(0, 12)}`);
}
