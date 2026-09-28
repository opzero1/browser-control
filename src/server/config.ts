// Names, environment and state paths shared by every slice.
import fs from "node:fs";
import path from "node:path";
import { Gate } from "./gate";
import { pyStrip } from "./pystr";
import { validSite } from "./sites";
import { homeDirectory, statePaths, type Env } from "./state-paths";

export { HOST_SOCKET_ENV, homeDirectory, statePaths, userSocket, type Env, type StatePaths } from "./state-paths";

export const PACKAGE_NAME = "@op1/browser-control";
export const BIN_NAME = "browser-control";
/** serverInfo.name and the `server` field of controller metadata and receipts (D6). */
export const SERVER_NAME = "browser-control";
/** The `backend` value that status reports. */
export const BACKEND_NAME = "browser-control";
/** The generated native-host wrapper's file name (D19). */
export const HOST_WRAPPER_NAME = "browser-control-host";
/** The native messaging host name the extension connects to; fixed by the published extension. */
export const NATIVE_HOST_NAME = "com.opzero.chrome";
export const STORE_EXTENSION_ID = "dcnjjnecbhipdbngkhjppkckpkellmld";
/**
 * Public half (base64 DER SubjectPublicKeyInfo) of an RSA-2048 key generated once for isolated profiles.
 * Only the isolated copy of the extension under the state root carries it as "key", which fixes its ID
 * independently of paths and versions. The private key was never stored; unpacked loading does not need it.
 */
export const ISOLATED_EXTENSION_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4NxkS5tOQ6mMkdQUsB/7hBLyubdVree67X6CNAYH87O+dbeCNQUHlxyFvdAtldTMrMI2LHqIeNl3SC+2gFmbXDgZo05AW1iF5xAvlq7XeDli9lUGtxlW3sl3A3YPX72O/VxBf5C/S19+IVC6k49+BcdEHX/ENWwAASgagbzoVt43ThmPO2H6ShK9XpgoJUTdr7ysY4sVSwPINEIKSYjhpCOoL8DqruO2bscpo/Xi2gyNa6y5rpynj28AlvuoB8t95wLdEaWQpk1lRxbPp/CxgDUa+ZnsNJ3Tar93hwAg5MWPgy/fgDHVyT6vfBQnZugRGomJWlIS4ncrmVZNwI7zEwIDAQAB";
/** Chrome's ID for ISOLATED_EXTENSION_KEY; a test recomputes it from the key. */
export const ISOLATED_EXTENSION_ID = "mpodnojmjjafgogldgieimgbmfhhknbe";

/** FAST_CHROME_ARTIFACT_ROOT when set (explicit, checked as Python did), else <state>/artifacts/user (D2). */
export function userArtifactRoot(env: Env = process.env): { root: string; explicit: boolean } {
  const configured = env.FAST_CHROME_ARTIFACT_ROOT;
  if (configured !== undefined) return { root: configured, explicit: true };
  return { root: statePaths(env).userArtifacts, explicit: false };
}

export function allowLoopback(env: Env = process.env): boolean {
  return env.FAST_CHROME_ALLOW_LOOPBACK === "1";
}

/**
 * FAST_CHROME_UNSHARED_SITES: comma-separated registrable sites whose leases never share a controller (C5).
 * The default is none. An entry that is not a canonical cookie site fails closed (D8).
 */
export function unsharedSites(env: Env = process.env): ReadonlySet<string> {
  const result = new Set<string>();
  for (const item of (env.FAST_CHROME_UNSHARED_SITES ?? "").split(",")) {
    const site = pyStrip(item);
    if (!site) continue;
    if (!validSite(site)) throw new Gate("browser-controller-invalid-unshared-sites");
    result.add(site);
  }
  return result;
}

/** The decimal value of a Unicode decimal digit (Python int() accepts any Nd digit). */
function digitValue(character: string): number {
  let point = character.codePointAt(0) as number;
  let offset = 0;
  while (point - offset - 1 >= 0 && /\p{Nd}/u.test(String.fromCodePoint(point - offset - 1))) offset += 1;
  return offset % 10;
}

/** browser_pool.limit: blank uses the fallback; `-?\d{1,4}` (Unicode digits, like Python's re) clamps to 1..cap. */
export function envLimit(name: string, fallback: number, cap: number, env: Env = process.env): number {
  const value = pyStrip(env[name] ?? "");
  if (!value) return fallback;
  const match = /^(-?)(\p{Nd}{1,4})$/u.exec(value);
  if (!match) throw new Gate("browser-controller-invalid-limit");
  const magnitude = [...match[2]].reduce((total, character) => total * 10 + digitValue(character), 0);
  const number = match[1] ? -magnitude : magnitude;
  return Math.max(1, Math.min(cap, number));
}

function executableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first executable `name` in an absolute PATH entry, or null. */
export function whichExecutable(name: string, env: Env = process.env): string | null {
  for (const entry of (env.PATH ?? "").split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    const candidate = path.join(entry, name);
    if (executableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * cua-driver: CUA_DRIVER when set (it must be an absolute, executable regular file; otherwise null, with no
 * fallback), then PATH, then ~/.local/bin/cua-driver (C1). Symlinks resolve, as the upstream installer links.
 */
export function resolveCuaDriver(env: Env = process.env): string | null {
  const configured = env.CUA_DRIVER;
  if (configured) return path.isAbsolute(configured) && executableFile(configured) ? configured : null;
  const found = whichExecutable("cua-driver", env);
  if (found) return found;
  const fallback = path.join(homeDirectory(env), ".local/bin/cua-driver");
  return executableFile(fallback) ? fallback : null;
}

/** The Node that runs this server, for native-host wrappers (C2, D3). */
export function nodeExecutable(): string {
  const node = process.execPath;
  if (!path.isAbsolute(node) || !executableFile(node)) throw new Gate("browser-controller-node-unavailable");
  return node;
}
