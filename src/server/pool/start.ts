// Deterministic, non-replaying startup for a leased Chrome controller (browser_start.py).
import fs from "node:fs";
import path from "node:path";
import { packageAssets, type PackageAssets } from "../assets";
import { resolveCuaDriver, type Env } from "../config";
import { fixedErrorsAsync, io, openDirectory, writeJson } from "../fs-private";
import { Gate, isGate } from "../gate";
import { Connection, type HostConnection } from "../host-connection";
import { lockUntil } from "../lock";
import { isPyInt, type JsonObject } from "../pyjson";
import { ensureStableExtension, type StableExtension } from "../stable-copy";
import { monotonic, pyRound, sleep } from "../time";
import { cuaCli, hasProfile, psCommand } from "./cua-cli";
import { applyPreferences } from "./preferences";
import { provision, provisionDeps } from "./provision";
import {
  claim, clearStaleEndpoint, initSeen, pendingTabs, Pin, poolContext, readOwnerRecord, type ControllerMetadata, type Grant, type PoolContext
} from "./registry";

export { hasProfile } from "./cua-cli";
export { MANIFEST } from "./provision";

export const BUNDLE = "com.google.chrome.for.testing";
/** Probe gates that mean "not ready yet" rather than a refusal (D19 names). */
const PROBE_MISSES = new Set(["browser-control-unavailable", "browser-control-protocol-mismatch", "browser-control-outcome-unknown"]);

export function launchArguments(info: ControllerMetadata, extensionDir: string): JsonObject {
  return {
    bundle_id: BUNDLE, creates_new_application_instance: true,
    additional_arguments: [`--user-data-dir=${info.profile}`, "--no-first-run", "--no-default-browser-check",
      `--load-extension=${extensionDir}`, `--disable-extensions-except=${extensionDir}`]
  };
}

export function leaseArtifacts(info: Grant): string {
  const file = path.join(info.artifacts, info.lease_id);
  openDirectory(file);
  return file;
}

export interface Window { pid: number; window_id: number; bounds: unknown }

/** What ensure needs from the machine. Every method may return a promise. */
export interface StartRuntime {
  provision(info: Grant): unknown;
  prepare(info: Grant): unknown;
  processes(info: Grant): number[] | Promise<number[]>;
  probe(info: Grant): boolean | Promise<boolean>;
  launch(info: Grant): unknown;
  configure(info: Grant, options: { running: boolean }): Record<string, boolean> | Promise<Record<string, boolean>>;
  windows(pid: number): Window[] | Promise<Window[]>;
}

/** Python's AttributeError: a malformed reply that is not an object escapes the fixed gates, as it did. */
class AttributeError extends Error {
  constructor() {
    super("reply is not an object");
    this.name = "AttributeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** dict.get(key, fallback) */
function get(value: unknown, key: string, fallback: unknown = null): unknown {
  if (!isRecord(value)) throw new AttributeError();
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : fallback;
}

/** `value >= limit` for a JSON value: numbers and booleans compare, anything else is Python's TypeError. */
function atLeast(value: unknown, limit: number): boolean {
  if (typeof value === "number" || typeof value === "boolean") return Number(value) >= limit;
  throw new TypeError("unorderable value");
}

function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** The real machine: cua-driver for apps and windows, /bin/ps for command lines, the extension handshake. */
export class Runtime implements StartRuntime {
  readonly deadline: number;
  readonly env: Env;
  private readonly assets: PackageAssets | undefined;
  private readonly cuaPath: string | null;
  /** The stable extension copy that `prepare` publishes and `launch` loads. */
  extension: Pick<StableExtension, "dir"> | null = null;

  constructor(deadline: number, env: Env = process.env, assets?: PackageAssets) {
    this.deadline = deadline;
    this.env = env;
    this.assets = assets;
    this.cuaPath = resolveCuaDriver(env);
  }

  remaining(): number {
    const value = this.deadline - monotonic();
    if (value <= 0) throw new Gate("browser-controller-startup-timeout");
    return value;
  }

  async cua(name: string, args: JsonObject): Promise<Record<string, unknown>> {
    const remaining = this.remaining();
    if (this.cuaPath === null) throw new Gate("browser-controller-cua-unavailable");
    return cuaCli(this.cuaPath, name, args, remaining * 1000);
  }

  async provision(info: Grant) {
    return provision(info, await provisionDeps(this.env, this.assets ?? packageAssets()));
  }

  async prepare(info: Grant) {
    if (process.platform !== "darwin") throw new Gate("browser-controller-platform-unsupported");
    for (const key of ["profile", "downloads", "artifacts"] as const) {
      const entry = io(() => fs.lstatSync(info[key]));
      if (!entry.isDirectory() || entry.uid !== process.getuid?.() || entry.mode & 0o077) throw new Gate("browser-controller-unsafe-directory");
    }
    const assets = this.assets ?? packageAssets();
    let manifest = false;
    try {
      manifest = fs.statSync(path.join(assets.extensionDir, "manifest.json")).isFile();
    } catch {
      // Not installed.
    }
    if (!manifest || this.cuaPath === null) throw new Gate("browser-controller-startup-not-installed");
    this.extension = await ensureStableExtension(this.env, assets);
  }

  async processes(info: Grant): Promise<number[]> {
    const apps = get(await this.cua("list_apps", {}), "apps");
    if (!Array.isArray(apps)) throw new Gate("browser-controller-process-unconfirmed");
    const pids: number[] = [];
    for (const app of apps) {
      if (get(app, "bundle_id") !== BUNDLE || !truthy(get(app, "running"))) continue;
      const found = get(app, "pid");
      // type(pid) is int: parsePythonJson records 1.0 and 1e0 as floats, which Python refused.
      if (!isPyInt(app, "pid")) throw new Gate("browser-controller-process-unconfirmed");
      const pid = found as number;
      if (pid <= 0) throw new Gate("browser-controller-process-unconfirmed");
      if (hasProfile(await psCommand(pid, this.remaining() * 1000), info.profile)) pids.push(pid);
    }
    return [...new Set(pids)].sort((a, b) => a - b);
  }

  async probe(info: Grant): Promise<boolean> {
    let connection: HostConnection | null = null;
    try {
      connection = await Connection.open(info.socket, Math.min(1, this.remaining() / 3));
      return true;
    } catch (error) {
      if (isGate(error) && PROBE_MISSES.has(error.code)) return false;
      throw error;
    } finally {
      connection?.close();
    }
  }

  async launch(info: Grant): Promise<Record<string, unknown>> {
    if (this.extension === null) throw new Gate("browser-controller-startup-not-installed");
    const result = await this.cua("launch_app", launchArguments(info, this.extension.dir));
    if (get(result, "self_activation_suppressed") !== true) throw new Gate("browser-controller-focus-not-preserved");
    return result;
  }

  configure(info: Grant, options: { running: boolean }): Record<string, boolean> {
    return applyPreferences(info.profile, info.downloads, options);
  }

  async windows(pid: number): Promise<Window[]> {
    const rows = get(await this.cua("list_windows", { pid }), "windows");
    if (!Array.isArray(rows)) throw new Gate("browser-controller-window-unconfirmed");
    const result: Window[] = [];
    for (const row of rows) {
      const found = get(row, "pid");
      if (!((typeof found === "number" || typeof found === "boolean") && Number(found) === pid)) continue;
      if (!isPyInt(row, "window_id") || get(row, "is_on_screen") !== true) continue;
      if (!atLeast(get(get(row, "bounds", {}), "width", 0), 400) || !atLeast(get(get(row, "bounds", {}), "height", 0), 300)) continue;
      result.push({ pid, window_id: get(row, "window_id") as number, bounds: get(row, "bounds") });
    }
    return result;
  }
}

/** Shared receipts omit the Chrome pid, windows and downloads, which cover the whole profile. */
function receipt(info: Grant, fields: Record<string, unknown>): Record<string, unknown> {
  const exclusive = info.mode === "exclusive";
  const result: Record<string, unknown> = {
    controller_id: info.controller_id, server: info.server, lease_id: info.lease_id, mode: info.mode, sites: info.sites,
    site_state: info.site_state, artifacts: path.join(info.artifacts, info.lease_id)
  };
  if (exclusive) Object.assign(result, { socket: info.socket, profile: info.profile, downloads: info.downloads });
  else fields = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "pid" && key !== "windows"));
  return { ...result, ...fields };
}

export async function ensure(controller: string | null, owner: string, options: { timeout?: unknown; site?: string | null; exclusive?: boolean; ctx?: PoolContext; runtime?: StartRuntime } = {}): Promise<Record<string, unknown>> {
  const { site = null, exclusive = true, ctx = poolContext() } = options;
  const timeout = options.timeout === undefined ? 30 : options.timeout;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || !(timeout > 0 && timeout <= 120)) throw new Gate("browser-controller-invalid-timeout");
  const started = monotonic();
  const deadline = started + timeout;
  const runtime = options.runtime ?? new Runtime(deadline, ctx.env, ctx.assets);
  const info = await claim(owner, { site, exclusive, controller, ctx });
  let launched = false;
  const elapsed = () => pyRound(monotonic() - started, 3);
  try {
    return await fixedErrorsAsync(async () => {
      const pin = await Pin.open(info.controller_id, owner, info.lease_id, ctx);
      try {
        const lock = await lockUntil(pin.directory, "startup.lock", deadline);
        try {
          await initSeen(pin.directory, info.controller_id, ctx);
          await runtime.provision(info);
          leaseArtifacts(info);
          await runtime.prepare(info);
          let pids = await runtime.processes(info);
          if (pids.length > 1) throw new Gate("browser-controller-process-ambiguous");
          const ready = await runtime.probe(info);
          const pending = readOwnerRecord(pin.directory, "startup.json");
          if (ready && !pids.length) throw new Gate("browser-controller-process-unconfirmed");
          if (!pids.length && pending !== null) throw new Gate("browser-controller-startup-unconfirmed");
          const preferences = await runtime.configure(info, { running: pids.length > 0 });
          if (!pids.length) {
            if (pendingTabs(pin.directory)) throw new Gate("browser-controller-cleanup-unconfirmed");
            // The host refuses to start over an existing socket file, so a stale one blocks launch.
            if (await clearStaleEndpoint(info) === "live") throw new Gate("browser-controller-endpoint-busy");
            writeJson(pin.directory, "startup.json", pin.claim);
            launched = true;
            await runtime.launch(info);
          }
          while (true) {
            if (!pids.length) pids = await runtime.processes(info);
            if (pids.length > 1) throw new Gate("browser-controller-process-ambiguous");
            if (pids.length && await runtime.probe(info)) {
              const windows = await runtime.windows(pids[0]);
              if (windows.length && await runtime.probe(info)) {
                writeJson(pin.directory, "startup.json", null);
                return receipt(info, { ...preferences, ready: true, launched, pid: pids[0], windows, elapsed_seconds: elapsed() });
              }
            }
            const remaining = timeout - (monotonic() - started);
            if (remaining <= 0) throw new Gate("browser-controller-startup-timeout");
            await sleep(Math.min(0.2, remaining) * 1000);
          }
        } finally {
          lock.release();
        }
      } finally {
        pin.close();
      }
    });
  } catch (error) {
    if (!(error instanceof Gate)) throw error;
    return receipt(info, { ready: false, launched, error: error.code, lease_retained: true, elapsed_seconds: elapsed() });
  }
}
