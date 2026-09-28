// Controller provisioning (browser_start.provision): private directories, the generated host wrapper and the
// per-profile native-messaging manifest. Only the generated wrapper is accepted (D5); the legacy static
// wrappers and `migrate` are not ported (C8).
import fs from "node:fs";
import path from "node:path";
import { packageAssets, type PackageAssets } from "../assets";
import { HOST_WRAPPER_NAME, ISOLATED_EXTENSION_ID, NATIVE_HOST_NAME, type Env } from "../config";
import { openDirectory, readPrivate, writePrivate } from "../fs-private";
import { Gate } from "../gate";
import { JsonDecodeError, parsePythonJson, pyDumps } from "../pyjson";
import { ensureStableHost, hostWrapper, type StableExtension, type StableHost } from "../stable-copy";
import { controllerNumber, type ControllerMetadata } from "./registry";

export const MANIFEST = `${NATIVE_HOST_NAME}.json`;
/** The isolated copy's fixed ID (Q1); isolated-profile manifests allow only this origin. */
export const ISOLATED_EXTENSION_ORIGIN = `chrome-extension://${ISOLATED_EXTENSION_ID}/`;
/** sockaddr_un.sun_path holds 104 bytes on macOS, including the terminating NUL (D1). */
export const SOCKET_PATH_LIMIT = 103;

export interface ProvisionDeps { host: Pick<StableHost, "hostScript">; extension: Pick<StableExtension, "origin">; node: string }

function regularFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The stable host copy (C3) and this process's Node (C2). The node is checked by provision, as Python did. */
export async function provisionDeps(env: Env = process.env, assets: PackageAssets = packageAssets()): Promise<ProvisionDeps> {
  if (!regularFile(assets.nativeHost)) throw new Gate("browser-controller-startup-not-installed");
  return { host: await ensureStableHost(env, assets), extension: { origin: ISOLATED_EXTENSION_ORIGIN }, node: process.execPath };
}

/** browser_start.node_path for the given Node: absolute, a regular file and executable (D3). */
function checkNode(node: string) {
  let executable = false;
  try {
    fs.accessSync(node, fs.constants.X_OK);
    executable = true;
  } catch {
    // Not executable or missing.
  }
  if (!path.isAbsolute(node) || !regularFile(node) || !executable) throw new Gate("browser-controller-node-unavailable");
}

function manifest(info: ControllerMetadata, host: string, origin: string) {
  return {
    name: NATIVE_HOST_NAME, description: `Chrome Control isolated controller ${controllerNumber(info.controller_id)}`,
    type: "stdio", path: host, allowed_origins: [origin]
  };
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  }
  return a === b;
}

/**
 * Idempotently create the controller's private directories, host wrapper and native-host manifest. An existing
 * manifest is only checked: it must name the generated wrapper and the isolated extension's origin.
 */
export function provision(info: ControllerMetadata, deps: ProvisionDeps): { host_manifest: "created" | "generated" } {
  const base = path.dirname(info.host);
  for (const directory of [base, info.profile, info.downloads, info.artifacts]) openDirectory(directory);
  checkNode(deps.node);
  if (Buffer.byteLength(info.socket) > SOCKET_PATH_LIMIT) throw new Gate("browser-controller-unsafe-path");
  const wrapper = Buffer.from(hostWrapper(info.socket, deps.host.hostScript, deps.node), "utf8");
  const hostDirectory = openDirectory(base);
  if (!readPrivate(hostDirectory, HOST_WRAPPER_NAME)?.equals(wrapper)) writePrivate(hostDirectory, HOST_WRAPPER_NAME, wrapper, 0o700);
  const expected = manifest(info, info.host, deps.extension.origin);
  const directory = openDirectory(path.join(info.profile, "NativeMessagingHosts"));
  const existing = readPrivate(directory, MANIFEST);
  if (existing === null) {
    writePrivate(directory, MANIFEST, Buffer.from(`${pyDumps(expected, { indent: 2 })}\n`, "utf8"), 0o600);
    return { host_manifest: "created" };
  }
  let current: unknown;
  try {
    // json.loads(bytes) also detected UTF-16 and UTF-32; such a manifest is refused here (fail closed).
    current = parsePythonJson(utf8.decode(existing));
  } catch (error) {
    if (error instanceof JsonDecodeError || error instanceof TypeError) throw new Gate("browser-controller-host-manifest-mismatch");
    throw error;
  }
  if (typeof current !== "object" || current === null || Array.isArray(current)) throw new Gate("browser-controller-host-manifest-mismatch");
  const record = current as Record<string, unknown>;
  const keys = Object.keys(expected);
  if (Object.keys(record).length !== keys.length || !keys.every((key) => Object.prototype.hasOwnProperty.call(record, key))
      || (["name", "type", "allowed_origins"] as const).some((key) => !sameJson(record[key], expected[key]))) {
    throw new Gate("browser-controller-host-manifest-mismatch");
  }
  // `path not in {host}` hashes the value: a list or object path raised TypeError in Python.
  if (typeof record.path === "object" && record.path !== null) throw new TypeError("unhashable manifest path");
  if (record.path !== info.host) throw new Gate("browser-controller-host-manifest-mismatch");
  return { host_manifest: "generated" };
}
