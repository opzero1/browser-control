// Persistent controller leases, shared-site gates and crash-retained tab cleanup receipts (browser_pool.py).
//
// Each Python fd is a verified PrivateDir and each fcntl.flock is a SQLite lock (lock.ts). A blocking flock is
// lockWait, a LOCK_NB flock is lockNow, so no call ever blocks the event loop on another process.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { privateSocket, type PrivateSocket } from "../../shared/trusted-path";
import type { PackageAssets } from "../assets";
import { envLimit, HOST_WRAPPER_NAME, nodeExecutable, SERVER_NAME, statePaths, unsharedSites, type Env } from "../config";
import {
  childDirectory, entryStats, existingDirectory, fixedErrors, fixedErrorsAsync, FsError, io, listDirectory, openDirectory, readJson,
  removeFile, syncDirectory, verified, writeJson, type PrivateDir
} from "../fs-private";
import { Gate } from "../gate";
import { Connection } from "../host-connection";
import { lockNow, lockWait, type HeldLock } from "../lock";
import { isPyInt, type JsonValue } from "../pyjson";
import { pyLen } from "../pystr";
import { cookieSite } from "../sites";
import { monotonic, sleep, utcStamp } from "../time";
import { hasProfile, psProcesses } from "./cua-cli";
import { provision, provisionDeps } from "./provision";

export const CONTROLLERS = ["isolated-1", "isolated-2", "isolated-3"] as const;
export const HARD_CAP = 8;
export const MAX_LEASE_SITES = 16;
export const MAX_SEEN_SITES = 256;
const LEASE_KEYS = ["created", "lease_id", "mode", "owner", "sites"] as const;

/**
 * Where the pool lives: `registry` holds claims, leases, markers and locks (Python DEFAULT_ROOT); `controllers`
 * holds each controller's profile, downloads, artifacts and host wrapper (BASE_ROOT); `sockets` holds their
 * endpoints (SOCKET_ROOT, D1). `assets` overrides the packaged files for provisioning and startup.
 */
export interface PoolContext { registry: string; controllers: string; sockets: string; env: Env; assets?: PackageAssets }

export function poolContext(env: Env = process.env): PoolContext {
  const paths = statePaths(env);
  return { registry: paths.registry, controllers: paths.controllers, sockets: paths.sockets, env };
}

export interface ControllerMetadata { controller_id: string; server: string; socket: string; profile: string; downloads: string; artifacts: string; host: string }
export type LeaseMode = "shared" | "exclusive";
export type SiteState = "fresh" | "previously-used";
export interface Lease { owner: string; lease_id: string; mode: LeaseMode; sites: string[]; created: string | null }
export interface Grant extends ControllerMetadata { owner: string; lease_id: string; mode: LeaseMode; sites: string[]; site_state: SiteState | null }
export interface LeaseRoute extends ControllerMetadata { owner: string; lease_id: string; mode: LeaseMode; sites: string[] }
export interface OwnerRecord { owner: string; lease_id: string }
export interface Marker { owner: string; lease_id: string; pid: number }
interface ReapRecord { pid: number; started: string }
interface ControllerState { leases: Lease[]; claim: OwnerRecord | null; markers: Marker[]; startup: OwnerRecord | null; reap: ReapRecord | null }
interface Seen { complete: boolean; sites: Record<string, string | null> }

type JsonRecord = Record<string, JsonValue>;

function isRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function has(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function keysAre(record: JsonRecord, keys: readonly string[]): boolean {
  const present = Object.keys(record);
  return present.length === keys.length && keys.every((key) => has(record, key));
}

/** sorted() of str: code point order, not UTF-16 order. */
function codePointOrder(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const difference = (left[i].codePointAt(0) as number) - (right[i].codePointAt(0) as number);
    if (difference) return difference;
  }
  return left.length - right.length;
}

/** isolated-1 .. isolated-8. Python's `isolated-([1-9]\d?)` also admits two digits, which are all above the cap. */
export function controllerNumber(controller: unknown): number {
  const match = typeof controller === "string" ? /^isolated-([1-9])(\p{Nd})?$/u.exec(controller) : null;
  if (!match || match[2] !== undefined || Number(match[1]) > HARD_CAP) throw new Gate("browser-controller-unknown");
  return Number(match[1]);
}

export function metadata(controller: unknown, ctx: PoolContext = poolContext()): ControllerMetadata {
  controllerNumber(controller);
  const id = controller as string;
  const base = path.join(ctx.controllers, id);
  return {
    controller_id: id,
    server: SERVER_NAME,
    socket: path.join(ctx.sockets, `${id}.sock`),
    profile: path.join(base, "profile"),
    downloads: path.join(base, "downloads"),
    artifacts: path.join(base, "artifacts"),
    host: path.join(base, HOST_WRAPPER_NAME)
  };
}

export function maxControllers(env: Env = process.env): number {
  return envLimit("FAST_CHROME_MAX_CONTROLLERS", 3, HARD_CAP, env);
}

export function maxTenants(env: Env = process.env): number {
  return envLimit("FAST_CHROME_MAX_TENANTS", 3, 16, env);
}

export function validOwner(owner: unknown): asserts owner is string {
  if (typeof owner !== "string" || !/^ses_[A-Za-z0-9_-]{1,160}$/.test(owner)) throw new Gate("browser-controller-invalid-owner");
}

/** str(UUID(value)) == value: only the canonical lowercase 8-4-4-4-12 form. */
export function validUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

export function siteKey(site: unknown): string | null {
  if (site === null || site === undefined) return null;
  return cookieSite(site);
}

async function withLock<T>(dir: PrivateDir, name: string, exclusive: boolean, body: () => T | Promise<T>): Promise<T> {
  const lock = await lockWait(dir, name, exclusive);
  try {
    return await body();
  } finally {
    lock.release();
  }
}

/** registry.lock: every read-modify-write of one controller's records. */
function registry<T>(dir: PrivateDir, body: () => T | Promise<T>): Promise<T> {
  return withLock(dir, "registry.lock", true, body);
}

function existingControllers(dir: PrivateDir): string[] {
  const names = listDirectory(dir).filter((name) => /^isolated-[1-8]$/.test(name) && entryStats(dir, name)?.isDirectory());
  return names.sort((a, b) => controllerNumber(a) - controllerNumber(b));
}

/** Registry controllers in numeric order; the default set is always included. */
function discover(ctx: PoolContext): string[] {
  const dir = openDirectory(ctx.registry);
  const names = new Set<string>([...existingControllers(dir), ...CONTROLLERS]);
  return [...names].sort((a, b) => controllerNumber(a) - controllerNumber(b));
}

export function readOwnerRecord(dir: PrivateDir, name: string): OwnerRecord | null {
  const value = readJson(dir, name);
  if (value === null) return null;
  if (!isRecord(value) || !keysAre(value, ["owner", "lease_id"])) throw new Gate("browser-controller-invalid-state");
  validOwner(value.owner);
  if (!validUuid(value.lease_id)) throw new Gate("browser-controller-invalid-state");
  return value as unknown as OwnerRecord;
}

export function readClaim(dir: PrivateDir): OwnerRecord | null {
  return readOwnerRecord(dir, "claim.json");
}

export function markers(dir: PrivateDir): Marker[] {
  const result: Marker[] = [];
  for (const name of listDirectory(dir)) {
    if (!name.startsWith("tab-")) continue;
    const value = readJson(dir, name);
    if (value === null) continue;
    if (!isRecord(value) || !keysAre(value, ["owner", "lease_id", "pid"]) || !validUuid(value.lease_id) || !isPyInt(value, "pid")) {
      throw new Gate("browser-controller-invalid-state");
    }
    validOwner(value.owner);
    result.push(value as unknown as Marker);
  }
  return result;
}

export function pendingTabs(dir: PrivateDir): number {
  return markers(dir).length;
}

function validLease(value: JsonValue, leaseId: string): boolean {
  if (!isRecord(value) || !keysAre(value, LEASE_KEYS) || value.lease_id !== leaseId || !validUuid(leaseId)) return false;
  if (value.mode !== "shared" && value.mode !== "exclusive") return false;
  const sites = value.sites;
  if (!Array.isArray(sites) || sites.length > MAX_LEASE_SITES) return false;
  if (!sites.every((site) => typeof site === "string" && /^[a-z0-9_.:-]{1,253}$/.test(site))) return false;
  if (new Set(sites).size !== sites.length) return false;
  return typeof value.created === "string" && pyLen(value.created) <= 64;
}

/** Every lease on one controller. A claim.json without a lease file is a legacy exclusive lease. */
function readLeases(dir: PrivateDir): Lease[] {
  const leases: Lease[] = [];
  const folder = childDirectory(dir, "leases");
  for (const name of listDirectory(folder).sort(codePointOrder)) {
    // Python's `.` matches everything except a newline.
    const match = /^lease-([^\n]+)\.json$/.exec(name);
    if (!match) continue;
    const value = readJson(folder, name);
    if (value === null) continue;
    if (!validLease(value, match[1])) throw new Gate("browser-controller-invalid-state");
    validOwner((value as JsonRecord).owner);
    leases.push(value as unknown as Lease);
  }
  const claimed = readClaim(dir);
  if (claimed !== null) {
    const mirrored = leases.find((lease) => lease.lease_id === claimed.lease_id);
    if (!mirrored) leases.push({ ...claimed, mode: "exclusive", sites: [], created: null });
    else if (mirrored.owner !== claimed.owner || mirrored.mode !== "exclusive") throw new Gate("browser-controller-invalid-state");
  }
  return leases;
}

function findLease(leases: Lease[], leaseId: unknown): Lease | null {
  return leases.find((lease) => lease.lease_id === leaseId) ?? null;
}

async function writeLease(dir: PrivateDir, lease: Lease): Promise<Lease> {
  const written: Lease = { ...lease, created: lease.created || utcStamp() };
  const folder = childDirectory(dir, "leases");
  (await lockWait(folder, `lease-${written.lease_id}.lock`, false)).release();
  const record: Record<string, unknown> = {};
  for (const key of LEASE_KEYS) record[key] = written[key];
  writeJson(folder, `lease-${written.lease_id}.json`, record);
  return written;
}

/** Non-blocking lock on a lease file's own lock; null for a legacy lease without a file. */
function lockLease(dir: PrivateDir, leaseId: string, exclusive = false): HeldLock | null {
  const folder = childDirectory(dir, "leases");
  if (entryStats(folder, `lease-${leaseId}.json`) === null) return null;
  return lockNow(folder, `lease-${leaseId}.lock`, exclusive);
}

function readReap(dir: PrivateDir): ReapRecord | null {
  const value = readJson(dir, "reap.json");
  if (value !== null && (!isRecord(value) || !keysAre(value, ["pid", "started"]) || !isPyInt(value, "pid") || typeof value.started !== "string")) {
    throw new Gate("browser-controller-invalid-state");
  }
  return value as ReapRecord | null;
}

/** True until Chrome has written into the profile; provisioning adds only NativeMessagingHosts. */
function freshProfile(controller: string, ctx: PoolContext): boolean {
  const profile = metadata(controller, ctx).profile;
  try {
    return fs.readdirSync(profile).every((name) => name === "NativeMessagingHosts");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Sites ever opened in the profile, each mapped to the lease that first opened it (null when unknown). */
function readSeen(dir: PrivateDir, controller: string, ctx: PoolContext): Seen {
  const value = readJson(dir, "sites-seen.json", 131072);
  if (value === null) return { complete: freshProfile(controller, ctx), sites: {} };
  if (!isRecord(value) || !keysAre(value, ["complete", "sites"]) || typeof value.complete !== "boolean" || !isRecord(value.sites)
      || Object.keys(value.sites).length > MAX_SEEN_SITES
      || !Object.values(value.sites).every((item) => item === null || validUuid(item))) {
    throw new Gate("browser-controller-invalid-state");
  }
  return value as unknown as Seen;
}

/** Start the history before a first launch; an existing profile without one has unknown history. */
export function initSeen(dir: PrivateDir, controller: string, ctx: PoolContext = poolContext()): Promise<void> {
  return registry(dir, () => {
    if (readJson(dir, "sites-seen.json", 131072) === null) writeJson(dir, "sites-seen.json", readSeen(dir, controller, ctx));
  });
}

function siteState(seen: Seen, site: string, leaseId: string): SiteState {
  if (has(seen.sites, site)) return seen.sites[site] === leaseId ? "fresh" : "previously-used";
  return seen.complete ? "fresh" : "previously-used";
}

function recordSeen(dir: PrivateDir, controller: string, site: string, leaseId: string, ctx: PoolContext): SiteState {
  const seen = readSeen(dir, controller, ctx);
  if (!has(seen.sites, site)) {
    if (Object.keys(seen.sites).length >= MAX_SEEN_SITES) seen.complete = false;
    else Object.defineProperty(seen.sites, site, { value: seen.complete ? leaseId : null, writable: true, enumerable: true, configurable: true });
    writeJson(dir, "sites-seen.json", seen);
  }
  return siteState(seen, site, leaseId);
}

function leaseSiteState(dir: PrivateDir, controller: string, lease: Lease, ctx: PoolContext): SiteState | null {
  if (!lease.sites.length) return null;
  const seen = readSeen(dir, controller, ctx);
  const states = new Set(lease.sites.map((site) => siteState(seen, site, lease.lease_id)));
  return states.has("previously-used") ? "previously-used" : "fresh";
}

function overlaps(held: ReadonlySet<string>, unshared: ReadonlySet<string>): boolean {
  for (const site of held) if (unshared.has(site)) return true;
  return false;
}

/** Site gate. Call under registry.lock; the caller persists the returned lease (the same object when unchanged). */
function addSite(dir: PrivateDir, controller: string, lease: Lease, site: string, ctx: PoolContext): [Lease, SiteState] {
  const unshared = unsharedSites(ctx.env);
  const others = readLeases(dir).filter((item) => item.lease_id !== lease.lease_id);
  const held = new Set(others.flatMap((item) => item.sites));
  if (lease.mode === "shared" && others.length && (held.has(site) || unshared.has(site) || overlaps(held, unshared))) {
    throw new Gate("browser-controller-site-conflict");
  }
  if (!lease.sites.includes(site) && lease.sites.length >= MAX_LEASE_SITES) throw new Gate("browser-controller-site-limit");
  const state = recordSeen(dir, controller, site, lease.lease_id, ctx);
  return [lease.sites.includes(site) ? lease : { ...lease, sites: [...lease.sites, site] }, state];
}

function controllerState(dir: PrivateDir): ControllerState {
  return { leases: readLeases(dir), claim: readClaim(dir), markers: markers(dir), startup: readOwnerRecord(dir, "startup.json"), reap: readReap(dir) };
}

function refusal(state: ControllerState): string | null {
  if (state.leases.length || state.claim !== null) return "browser-controller-busy";
  if (state.markers.length) return "browser-controller-cleanup-unconfirmed";
  if (state.startup !== null) return "browser-controller-startup-unconfirmed";
  if (state.reap !== null) return "browser-controller-reap-pending";
  return null;
}

function joinable(state: ControllerState, site: string | null, tenants: number, unshared: ReadonlySet<string>): boolean {
  const leases = state.leases;
  const held = new Set(leases.flatMap((lease) => lease.sites));
  return leases.length > 0 && leases.length < tenants && state.claim === null && state.reap === null
    && leases.every((lease) => lease.mode === "shared") && !overlaps(held, unshared)
    && (site === null || (!unshared.has(site) && !held.has(site)));
}

function socketPresent(controller: string, ctx: PoolContext): boolean {
  const socket = metadata(controller, ctx).socket;
  try {
    return fs.lstatSync(socket).isSocket();
  } catch {
    return false;
  }
}

/** lease.lock on one controller: shared waits, exclusive refuses at once with browser-controller-pinned. */
export async function slot<T>(controller: string, ctx: PoolContext, exclusive: boolean, body: (dir: PrivateDir) => T | Promise<T>): Promise<T> {
  metadata(controller, ctx);
  const dir = openDirectory(path.join(ctx.registry, controller));
  const lock = exclusive ? lockNow(dir, "lease.lock", true) : await lockWait(dir, "lease.lock", false);
  try {
    return await body(dir);
  } finally {
    lock.release();
  }
}

export function locked<T>(controller: string, ctx: PoolContext, exclusive: boolean, body: (dir: PrivateDir) => T | Promise<T>): Promise<T> {
  return slot(controller, ctx, exclusive, (dir) => registry(dir, () => body(dir)));
}

async function granted(controller: string, dir: PrivateDir, lease: Lease, site: string | null, persist: boolean, ctx: PoolContext): Promise<Grant> {
  let state: SiteState | null = null;
  if (site !== null) {
    const [updated, added] = addSite(dir, controller, lease, site, ctx);
    state = added;
    persist = persist || updated !== lease;
    lease = updated;
  }
  if (persist) {
    if (lease.mode === "exclusive" && readClaim(dir) === null) writeJson(dir, "claim.json", { owner: lease.owner, lease_id: lease.lease_id });
    lease = await writeLease(dir, lease);
  }
  if (site === null) state = leaseSiteState(dir, controller, lease, ctx);
  return { ...metadata(controller, ctx), owner: lease.owner, lease_id: lease.lease_id, mode: lease.mode, sites: lease.sites, site_state: state };
}

/** Return the owner's lease or allocate one. Runs under allocation.lock and does no Chrome work. */
export async function claim(owner: string, options: { site?: string | null; exclusive?: boolean; controller?: string | null; ctx?: PoolContext } = {}): Promise<Grant> {
  const { controller = null, ctx = poolContext() } = options;
  const exclusive = options.exclusive ?? false;
  validOwner(owner);
  if (controller !== null) controllerNumber(controller);
  if (typeof exclusive !== "boolean") throw new Gate("browser-controller-invalid-mode");
  const site = siteKey(options.site);
  const unshared = unsharedSites(ctx.env);
  const mode: LeaseMode = exclusive ? "exclusive" : "shared";
  return fixedErrorsAsync(async () => {
    const directory = openDirectory(ctx.registry);
    const allocation = await lockWait(directory, "allocation.lock", true);
    try {
      const existing = existingControllers(directory);
      for (const item of existing.filter((name) => controller === null || controller === name)) {
        const found = await locked(item, ctx, false, async (current) => {
          const lease = readLeases(current).find((value) => value.owner === owner);
          if (!lease) return null;
          if (lease.mode !== mode) throw new Gate("browser-controller-lease-mode-mismatch");
          return granted(item, current, lease, site, false, ctx);
        });
        if (found) return found;
      }
      const ceiling = maxControllers(ctx.env);
      if (controller !== null && controllerNumber(controller) > ceiling) throw new Gate("browser-controller-over-limit");
      const candidates = controller !== null ? [controller] : Array.from({ length: ceiling }, (_, i) => `isolated-${i + 1}`);
      const states = new Map<string, ControllerState>();
      for (const item of candidates) {
        if (existing.includes(item)) states.set(item, await locked(item, ctx, false, (current) => controllerState(current)));
      }
      // Own Chrome first: an idle controller (running ones first), then a new one, then a shared join.
      const idle = [...states.keys()].filter((item) => refusal(states.get(item) as ControllerState) === null);
      const rank = new Map(idle.map((item) => [item, [socketPresent(item, ctx) ? 0 : 1, controllerNumber(item)]]));
      const order = idle.sort((a, b) => {
        const [x, y] = [rank.get(a) as number[], rank.get(b) as number[]];
        return x[0] - y[0] || x[1] - y[1];
      });
      order.push(...candidates.filter((item) => !states.has(item)));
      const fresh: Lease = { owner, lease_id: randomUUID(), mode, sites: [], created: utcStamp() };
      for (const item of order) {
        try {
          const result = await locked(item, ctx, exclusive, async (current) => {
            const state = controllerState(current);
            if (refusal(state) === null) return granted(item, current, fresh, site, true, ctx);
            states.set(item, state);
            return null;
          });
          if (result) return result;
        } catch (error) {
          if (!(error instanceof Gate) || error.code !== "browser-controller-pinned" || controller !== null) throw error;
        }
      }
      const tenants = maxTenants(ctx.env);
      if (!exclusive) {
        for (const item of [...states.keys()].sort((a, b) => controllerNumber(a) - controllerNumber(b))) {
          if (!joinable(states.get(item) as ControllerState, site, tenants, unshared) || !(controller !== null || socketPresent(item, ctx))) continue;
          const result = await locked(item, ctx, false, async (current) => {
            const state = controllerState(current);
            return joinable(state, site, tenants, unshared) ? granted(item, current, fresh, site, true, ctx) : null;
          });
          if (result) return result;
        }
      }
      if (controller !== null && states.has(controller)) {
        const state = states.get(controller) as ControllerState;
        if (!exclusive && joinable(state, null, tenants, unshared) && !joinable(state, site, tenants, unshared)) {
          throw new Gate("browser-controller-site-conflict");
        }
        throw new Gate(refusal(state) ?? "browser-controller-busy");
      }
      throw new Gate("browser-controller-busy");
    } finally {
      allocation.release();
    }
  });
}

/** The owner's single lease with its controller paths, or null. Artifacts are per lease. */
export async function leaseFor(owner: string, ctx: PoolContext = poolContext()): Promise<LeaseRoute | null> {
  validOwner(owner);
  const found: LeaseRoute[] = [];
  await fixedErrorsAsync(async () => {
    for (const item of discover(ctx)) {
      await locked(item, ctx, false, (current) => {
        for (const lease of readLeases(current)) {
          if (lease.owner !== owner) continue;
          const info = metadata(item, ctx);
          found.push({ ...info, owner, lease_id: lease.lease_id, mode: lease.mode, sites: lease.sites, artifacts: path.join(info.artifacts, lease.lease_id) });
        }
      });
    }
  });
  if (found.length > 1) throw new Gate("browser-controller-lease-ambiguous");
  return found[0] ?? null;
}

async function dropLease(controller: string, dir: PrivateDir, owner: string, leaseId: string, exclusive: boolean): Promise<{ controller_id: string; released: true; controller_idle: boolean }> {
  const lease = findLease(readLeases(dir), leaseId);
  if (lease === null || lease.owner !== owner) throw new Gate("browser-controller-lease-not-owned");
  const lock = lockLease(dir, leaseId, true);
  try {
    if (markers(dir).some((marker) => exclusive || marker.lease_id === leaseId)) throw new Gate("browser-controller-cleanup-unconfirmed");
    const startup = readOwnerRecord(dir, "startup.json");
    if (startup !== null && (exclusive || startup.lease_id === leaseId)) throw new Gate("browser-controller-startup-unconfirmed");
    const record = readClaim(dir);
    if (record !== null && record.lease_id === leaseId) writeJson(dir, "claim.json", null);
    const folder = childDirectory(dir, "leases");
    removeFile(folder, `lease-${leaseId}.json`);
    removeFile(folder, `lease-${leaseId}.lock`);
  } finally {
    lock?.release();
  }
  return { controller_id: controller, released: true, controller_idle: refusal(controllerState(dir)) === null };
}

/** Release one exact lease. Another tenant's live tabs never block it. */
export async function release(owner: string, leaseId: unknown, ctx: PoolContext = poolContext()): Promise<{ controller_id: string; released: true; controller_idle: boolean }> {
  validOwner(owner);
  if (!validUuid(leaseId)) throw new Gate("browser-controller-lease-not-owned");
  return fixedErrorsAsync(async () => {
    for (const item of discover(ctx)) {
      const lease = await locked(item, ctx, false, (current) => findLease(readLeases(current), leaseId));
      if (lease === null) continue;
      if (lease.owner !== owner) throw new Gate("browser-controller-lease-not-owned");
      const exclusive = lease.mode === "exclusive";
      return locked(item, ctx, exclusive, (current) => dropLease(item, current, owner, leaseId, exclusive));
    }
    throw new Gate("browser-controller-lease-not-owned");
  });
}

function statusRow(controller: string, dir: PrivateDir, ctx: PoolContext) {
  const state = controllerState(dir);
  return {
    ...metadata(controller, ctx), claim: state.claim, pending_tabs: state.markers.length, pending_startup: state.startup !== null,
    reaping: state.reap !== null, socket_present: socketPresent(controller, ctx),
    leases: state.leases.map((lease) => ({ owner: lease.owner, lease_id: lease.lease_id, mode: lease.mode, sites: lease.sites, created: lease.created }))
  };
}

export async function operate(command: string, args: { controller?: string | null; owner?: unknown; lease?: unknown; ctx?: PoolContext } = {}): Promise<unknown> {
  const ctx = args.ctx ?? poolContext();
  return fixedErrorsAsync(async () => {
    if (command === "status") {
      const result = [];
      for (const item of discover(ctx)) result.push(await locked(item, ctx, false, (dir) => statusRow(item, dir, ctx)));
      return { controllers: result, max_controllers: maxControllers(ctx.env), max_tenants: maxTenants(ctx.env) };
    }
    validOwner(args.owner);
    if (command === "claim") return claim(args.owner, { exclusive: true, controller: args.controller ?? null, ctx });
    if (command === "release") return release(args.owner, args.lease, ctx);
    throw new Gate("browser-controller-invalid-command");
  });
}

/** Hold a lease for one call or tab. Without leaseId, only the exclusive claim.json lease counts. */
export class Pin {
  readonly controller: string;
  readonly directory: PrivateDir;
  readonly claim: OwnerRecord;
  readonly mode: LeaseMode;
  private readonly ctx: PoolContext;
  private held: HeldLock | null;
  private leaseHeld: HeldLock | null;
  private tabMarker: string | null = null;

  private constructor(controller: string, directory: PrivateDir, claimed: OwnerRecord, mode: LeaseMode, held: HeldLock, leaseHeld: HeldLock | null, ctx: PoolContext) {
    this.controller = controller;
    this.directory = directory;
    this.claim = claimed;
    this.mode = mode;
    this.held = held;
    this.leaseHeld = leaseHeld;
    this.ctx = ctx;
  }

  static async open(controller: string, owner: string, leaseId: unknown = null, ctx: PoolContext = poolContext()): Promise<Pin> {
    metadata(controller, ctx);
    validOwner(owner);
    let held: HeldLock | null = null;
    let leaseHeld: HeldLock | null = null;
    try {
      return await fixedErrorsAsync(async () => {
        const directory = openDirectory(path.join(ctx.registry, controller));
        held = await lockWait(directory, "lease.lock", false);
        if (leaseId === null || leaseId === undefined) {
          const claimed = readClaim(directory);
          if (!claimed || claimed.owner !== owner) throw new Gate("browser-controller-not-owned");
          return new Pin(controller, directory, claimed, "exclusive", held, null, ctx);
        }
        const mode = await registry(directory, () => {
          const lease = validUuid(leaseId) ? findLease(readLeases(directory), leaseId) : null;
          if (lease === null || lease.owner !== owner) throw new Gate("browser-controller-not-owned");
          leaseHeld = lockLease(directory, leaseId as string);
          return lease.mode;
        });
        return new Pin(controller, directory, { owner, lease_id: leaseId as string }, mode, held, leaseHeld, ctx);
      });
    } catch (error) {
      (leaseHeld as HeldLock | null)?.release();
      (held as HeldLock | null)?.release();
      throw error;
    }
  }

  get leaseId(): string {
    return this.claim.lease_id;
  }

  /** The pending cleanup marker's file name, or null. */
  get marker(): string | null {
    return this.tabMarker;
  }

  /** Write the cleanup marker; with a site, first pass the site gate in the same critical section. */
  async beginTab(site: string | null = null): Promise<{ site: string; site_state: SiteState } | null> {
    if (this.tabMarker !== null) throw new Gate("browser-controller-tab-already-pinned");
    const key = siteKey(site);
    return fixedErrorsAsync(() => registry(this.directory, async () => {
      let state: SiteState | null = null;
      if (key !== null) {
        const lease = findLease(readLeases(this.directory), this.leaseId);
        if (lease === null || lease.owner !== this.claim.owner) throw new Gate("browser-controller-not-owned");
        const [updated, added] = addSite(this.directory, this.controller, lease, key, this.ctx);
        state = added;
        if (updated !== lease) await writeLease(this.directory, updated);
      }
      this.tabMarker = `tab-${randomUUID()}.json`;
      writeJson(this.directory, this.tabMarker, { ...this.claim, pid: process.pid });
      return key === null ? null : { site: key, site_state: state as SiteState };
    }));
  }

  /** Only a confirmed finalization removes the marker; then the pin closes. */
  confirmed(): void {
    fixedErrors(() => {
      if (this.tabMarker !== null) {
        const file = path.join(verified(this.directory), this.tabMarker);
        io(() => fs.unlinkSync(file));
        syncDirectory(this.directory);
        this.tabMarker = null;
      }
    });
    this.close();
  }

  close(): void {
    for (const lock of [this.leaseHeld, this.held]) lock?.release();
    this.leaseHeld = null;
    this.held = null;
  }
}

export type EndpointState = "absent" | "stale" | "live";

function uid(): number {
  return process.getuid?.() ?? -1;
}

/**
 * The controller's endpoint by its canonical path, with the identities privateSocket
 * (src/shared/trusted-path.ts) checked, or null when there is no socket file. A socket or directory that fails the
 * rule is browser-controller-unsafe-socket; nothing is connected to or removed through it.
 */
function checkedEndpoint(info: ControllerMetadata): PrivateSocket | null {
  try {
    return privateSocket(info.socket);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return null;
    if (typeof code === "string") return io(() => { throw error; });
    throw new Gate("browser-controller-unsafe-socket");
  }
}

/** "absent", "stale" (a socket file with no listener) or "live". */
export async function endpointState(info: ControllerMetadata): Promise<EndpointState> {
  return (await probeEndpoint(info)).state;
}

/** endpointState, with the endpoint that was probed. */
async function probeEndpoint(info: ControllerMetadata): Promise<{ state: EndpointState; endpoint: PrivateSocket | null }> {
  const endpoint = checkedEndpoint(info);
  if (endpoint === null) return { state: "absent", endpoint };
  const state = await new Promise<EndpointState>((resolve, reject) => {
    // The canonical path: only this user or root can change what it leads to.
    const probe = net.createConnection(endpoint.path);
    const timer = setTimeout(() => settle(() => reject(new Gate("browser-controller-endpoint-unconfirmed"))), 1000);
    function settle(done: () => void) {
      clearTimeout(timer);
      probe.removeAllListeners();
      probe.on("error", () => undefined);
      probe.destroy();
      done();
    }
    probe.once("connect", () => settle(() => resolve("live")));
    probe.once("error", (error: NodeJS.ErrnoException) => settle(() => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve("stale");
      else reject(new Gate("browser-controller-endpoint-unconfirmed"));
    }));
  });
  return { state, endpoint };
}

/** Whether `file`, not followed, still has the identity recorded for it. */
function stillAt(file: string, expected: { dev: number; ino: number }): boolean {
  const stats = io(() => fs.lstatSync(file));
  return stats.dev === expected.dev && stats.ino === expected.ino;
}

/**
 * Remove a stale endpoint: only the socket that was probed, at its canonical path in its private directory, once
 * both still have the identities privateSocket recorded. A socket that was replaced meanwhile is left in place and
 * reported as browser-controller-endpoint-unconfirmed.
 */
export async function clearStaleEndpoint(info: ControllerMetadata): Promise<"absent" | "removed" | "live"> {
  const probed = await probeEndpoint(info);
  if (probed.state !== "stale") return probed.state;
  // Only an endpoint that exists can be stale.
  const endpoint = probed.endpoint as PrivateSocket;
  let current: boolean;
  try {
    current = stillAt(endpoint.directory.path, endpoint.directory) && stillAt(endpoint.path, endpoint);
  } catch (error) {
    if (error instanceof FsError && error.errno === "ENOENT") return "absent";
    throw error;
  }
  if (!current) throw new Gate("browser-controller-endpoint-unconfirmed");
  io(() => fs.unlinkSync(endpoint.path));
  return "removed";
}

/** Process and endpoint access for reap and reset. */
export interface ReapHost {
  processes(info: ControllerMetadata): Promise<number[]>;
  userTabs(info: ControllerMetadata): Promise<unknown>;
  terminate(pid: number): void;
  alive(pid: number): boolean;
}

export const systemHost: ReapHost = {
  async processes(info) {
    const lines = await psProcesses();
    const pids: number[] = [];
    for (const line of lines) {
      const [pid, command] = line;
      if (hasProfile(command, info.profile)) pids.push(pid);
    }
    return pids.sort((a, b) => a - b);
  },
  async userTabs(info) {
    let connection: Connection;
    try {
      connection = await Connection.open(info.socket, 5);
    } catch (error) {
      if (error instanceof Gate) return null;
      throw error;
    }
    try {
      return await connection.call("getUserTabs");
    } finally {
      connection.close();
    }
  },
  terminate(pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") io(() => { throw error; });
    }
  },
  alive(pid) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      if (code === "EPERM") return true;
      return io(() => { throw error; });
    }
    return true;
  }
};

/** Python truthiness of a JSON value. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/**
 * One reap at a time per controller. lease.lock stays exclusive from the idle check through the process and
 * endpoint confirmation and the intent cleanup: another reap, dry run, claim, ensure, pin or legacy claim waits
 * for or is refused by it, so no Chrome started after the inspection can be signalled.
 */
async function reapController(controller: string, ctx: PoolContext, host: ReapHost, dryRun: boolean, wait: number): Promise<Record<string, unknown>> {
  const info = metadata(controller, ctx);
  let held: HeldLock | null = null;
  try {
    const [current, pending] = await fixedErrorsAsync(async () => {
      const directory = openDirectory(ctx.registry);
      const allocation = await lockWait(directory, "allocation.lock", true);
      try {
        const dir = openDirectory(path.join(ctx.registry, controller));
        held = lockNow(dir, "lease.lock", true);
        const state = await registry(dir, () => {
          const found = controllerState(dir);
          const code = refusal({ ...found, reap: null });
          if (code) throw new Gate(code);
          if (!dryRun) writeJson(dir, "reap.json", { pid: process.pid, started: utcStamp() });
          return found;
        });
        return [dir, state.reap !== null] as const;
      } finally {
        allocation.release();
      }
    });
    // Only lease.lock stays held. A claim still waits here, because it reads every controller's leases.
    return await stopController(controller, current, info, host, dryRun, wait, pending);
  } finally {
    (held as HeldLock | null)?.release();
  }
}

/**
 * Inspect and stop one idle controller while its reap holds lease.lock. The intent is removed only after the
 * process is gone and the endpoint is absent. A refusal before any signal restores the earlier state: no
 * intent, or the pending intent of an earlier unconfirmed reap.
 */
async function stopController(controller: string, dir: PrivateDir, info: ControllerMetadata, host: ReapHost, dryRun: boolean, wait: number, pending: boolean): Promise<Record<string, unknown>> {
  let terminated = false;
  let unresolved = pending;
  try {
    return await fixedErrorsAsync(async () => {
      const tabs = await host.userTabs(info);
      const pids = await host.processes(info);
      if (tabs === null && pids.length) throw new Gate("browser-controller-tabs-unconfirmed");
      const listed = truthy(tabs) ? tabs : [];
      if (!Array.isArray(listed) || !listed.every((tab) => isRecord(tab) && typeof tab.url === "string")) {
        throw new Gate("browser-controller-tabs-unconfirmed");
      }
      if (listed.some((tab) => /^https?:\/\//iu.test((tab as JsonRecord).url as string))) throw new Gate("browser-controller-has-tabs");
      if (pids.length > 1) throw new Gate("browser-controller-process-ambiguous");
      if (dryRun) return { controller_id: controller, dry_run: true, running: pids.length > 0, pid: pids.length ? pids[0] : null };
      if (pids.length) {
        terminated = unresolved = true;
        host.terminate(pids[0]);
        const deadline = monotonic() + wait;
        while (host.alive(pids[0]) || await clearStaleEndpoint(info) === "live") {
          if (monotonic() >= deadline) throw new Gate("browser-controller-reap-unconfirmed");
          await sleep(100);
        }
      }
      if (await clearStaleEndpoint(info) === "live") {
        // No matching process, yet the socket still has a listener: the exit is not confirmed.
        unresolved = true;
        throw new Gate("browser-controller-reap-unconfirmed");
      }
      await registry(dir, () => removeFile(dir, "reap.json"));
      return { controller_id: controller, reaped: pids.length > 0, pid: pids.length ? pids[0] : null, profile: info.profile };
    });
  } catch (error) {
    if (!(error instanceof Gate) || dryRun) throw error;
    // A kept intent makes claims skip this controller until a later reap confirms the exit.
    if (terminated && error.code !== "browser-controller-reap-unconfirmed") throw new Gate("browser-controller-reap-unconfirmed");
    if (!unresolved) await fixedErrorsAsync(() => registry(dir, () => removeFile(dir, "reap.json")));
    throw error;
  }
}

/** Explicit only: stop the Chrome of verified idle controllers. Profiles stay on disk. */
export async function reap(controller: string | null = null, options: { dryRun?: boolean; ctx?: PoolContext; host?: ReapHost; waitSeconds?: number } = {}): Promise<Record<string, unknown>> {
  const { dryRun = false, ctx = poolContext(), host = systemHost, waitSeconds = 10 } = options;
  if (controller !== null) return reapController(controller, ctx, host, dryRun, waitSeconds);
  const targets = fixedErrors(() => discover(ctx));
  const results: Record<string, unknown>[] = [];
  for (const item of targets) {
    try {
      results.push(await reapController(item, ctx, host, dryRun, waitSeconds));
    } catch (error) {
      if (!(error instanceof Gate)) throw error;
      results.push({ controller_id: item, error: error.code });
    }
  }
  return { controllers: results };
}

/** Delete and re-provision an idle, stopped controller's profile. Downloads and artifacts stay. */
export async function reset(controller: string, options: { confirm: unknown; ctx?: PoolContext; host?: ReapHost }): Promise<Record<string, unknown>> {
  const { ctx = poolContext(), host = systemHost } = options;
  const info = metadata(controller, ctx);
  if (options.confirm !== true) throw new Gate("browser-controller-confirmation-required");
  nodeExecutable();
  // The stable host copy is prepared before the locks, so the critical section awaits only locks.
  const deps = await fixedErrorsAsync(() => provisionDeps(ctx.env, ctx.assets));
  const provisioned = await fixedErrorsAsync(async () => {
    const directory = openDirectory(ctx.registry);
    const allocation = await lockWait(directory, "allocation.lock", true);
    try {
      return await slot(controller, ctx, true, async (current) => {
        const startup = lockNow(current, "startup.lock", true);
        try {
          const result = await registry(current, async () => {
            const code = refusal(controllerState(current));
            if (code) throw new Gate(code);
            if ((await host.processes(info)).length || await endpointState(info) === "live") throw new Gate("browser-controller-running");
            // Only inside the controller's own private directory, checked from / down, and only while the profile
            // is still the directory that was checked: nothing another user can change is on the path removed.
            const base = existingDirectory(path.dirname(info.profile));
            const entry = base && entryStats(base, path.basename(info.profile));
            if (base && entry) {
              if (!entry.isDirectory() || entry.uid !== uid()) throw new Gate("browser-controller-unsafe-directory");
              const profile = path.join(verified(base), path.basename(info.profile));
              if (!stillAt(profile, entry)) throw new Gate("browser-controller-unsafe-directory");
              io(() => fs.rmSync(profile, { recursive: true }));
            }
            removeFile(current, "sites-seen.json");
            return provision(info, deps);
          });
          await initSeen(current, controller, ctx);
          return result;
        } finally {
          startup.release();
        }
      });
    } finally {
      allocation.release();
    }
  });
  return { controller_id: controller, reset: true, profile: info.profile, ...provisioned };
}
