// The 18 session-owned tools over the typed page protocol (native_server.py). One BrowserControl instance holds
// the process's tab registry, shutdown and dependencies; there are no module globals.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { PageExpectation, Step, TOOL_NAMES, ValidationError, validateArguments } from "./args";
import { packageAssets } from "./assets";
import { captureDirectory, defaultRecordingDeps, jpeg, Recording, saveExclusive, type RecordingDeps } from "./captures";
import { allowLoopback, BACKEND_NAME, SERVER_NAME, type Env } from "./config";
import { fixedErrorsAsync, openDirectory } from "./fs-private";
import { Gate } from "./gate";
import { Connection, type Connect, type HostConnection } from "./host-connection";
import {
  get, isDict, isInt, match, origin, pyIter, stepAction, tabInfo, validatedGroupTitle, validatedPdf, type Action, type Dict,
  type Expectation, type Page, type TabRow
} from "./page";
import { ensure, type StartRuntime } from "./pool/start";
import { locked, markers, Pin, poolContext, release as releaseLease, type PoolContext } from "./pool/registry";
import { createReadField, VaultError, type ReadField, type VaultField } from "./private/onepassword";
import { paste, type PasteRequest, type PasteResult, type PrivateSource, type PrivateTab } from "./private/private-input";
import { pydanticDumps } from "./pyjson";
import { pyLen, pySlice } from "./pystr";
import { chromeId, resolveRoute, routeLists, routePrefix, type Route } from "./route";
import type { Shutdown } from "./runtime/shutdown";
import { sessionFromMeta } from "./session";
import { Tab, TabRegistry } from "./tabs";
import { monotonic, pyRound, sleep } from "./time";
import { INSTRUCTIONS, TOOLS } from "./tool-definitions";

export type { ReadField, VaultField } from "./private/onepassword";

export type Paste = (tab: PrivateTab, request: PasteRequest, source: PrivateSource, refuseInput: () => void, env?: Env) => Promise<PasteResult>;

export interface AppOptions {
  env: Env;
  shutdown: Shutdown;
  connect?: Connect;
  readField?: ReadField;
  /** The private transfer; tests replace it as Python's tests patched private_input.paste. */
  paste?: Paste;
  /** A startup runtime for claim_browser in place of the real cua-driver runtime. */
  startRuntime?: () => StartRuntime;
  recordingDeps?: RecordingDeps;
  /** The pool's registry, controller and socket roots; default poolContext(env). */
  pool?: PoolContext;
  /** serverInfo.version; default the package version. */
  version?: string;
}

export interface App {
  readonly serverInfo: { name: string; version: string };
  readonly instructions: string;
  listTools(): Tool[];
  callTool(name: string, args: unknown, meta: unknown): Promise<CallToolResult>;
  /** Finalize every managed tab by a monotonic deadline (seconds). */
  cleanup(deadline: number): Promise<void>;
}

export function createApp(options: AppOptions): App {
  return new BrowserControl(options);
}

const OBSERVE_AGAIN = "inspect the gate; wait only for page-not-ready; do not repeat the preceding operation";
const BEFORE_INPUT = "choose from final.actions; do not replay completed steps";
const AFTER_INPUT = "observe; do not replay";
const UNTIL_ENABLED = "wait for it to enable, e.g. wait_for expect {action_label: label}; do not replay completed steps";
const GRACE_SECONDS = 0.2;
const RELEASE_READBACK_SECONDS = 2;
const POLL_MS = 50;

/** A ValueError, KeyError or TypeError while checking an observation; it becomes observation-unavailable. */
class Invalid extends Error {}

function need(record: Dict, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(record, key)) throw new Invalid();
  return record[key];
}

function hashable(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

/** A read is full when forced or when its expectation checks text; otherwise it uses the preferred mode. */
function readControlsOnly(tab: Tab, expect: Expectation | null = null, full = false): boolean {
  return tab.controlsOnly && !full && (expect === null || expect.text === null);
}

/** Payloads follow the preferred mode. A full read keeps its text in tab.page for matching only. */
function publicPage(tab: Tab): Dict {
  let page = tab.page as Page;
  if (tab.controlsOnly && page.mode === "full") {
    page = { ...page, text: "", mode: "controls-only", truncation: { ...page.truncation, text: false } };
  }
  return { ...page, snapshot_id: (tab.snapshot as [string, string])[0] };
}

function boundExpectation(tab: Tab, expect: PageExpectation): PageExpectation {
  if (expect.url !== null && expect.url.startsWith("/")) return expect.withUrl(tab.origin + expect.url);
  return expect;
}

/** Compact current snapshot. include_text overrides a controls-only preference for this view only. */
function finalPage(tab: Tab, includeText: unknown): Dict {
  const text = Boolean(includeText) && (tab.page as Page).mode === "full";
  const page = (text ? tab.page : publicPage(tab)) as Page;
  const final: Dict = {
    url: page.url, title: page.title, mode: page.mode, partial: page.partial,
    truncated: Object.entries(page.truncation).filter(([key, value]) => value && (text || key !== "text")).map(([key]) => key),
    snapshot_id: (tab.snapshot as [string, string])[0],
    actions: page.actions.filter((action) => !action.disabled).map((action) => `${action.id}:${action.label}`)
  };
  return text ? { ...final, text: page.text } : final;
}

/** A tabs() row under its adapter handle, so every listed ID names exactly one tab in this process. */
function listed(info: TabRow, prefix: string, managed: boolean): Dict {
  return { ...info, tab_id: prefix + info.tab_id, managed_by_session: managed };
}

async function confirmGroupTitle(connection: HostConnection, session: string, label: unknown = null): Promise<string> {
  const title = validatedGroupTitle(session, label);
  const result = await connection.call("nameSession", { name: title });
  if (!isDict(result) || get(result, "name") !== title || get(result, "confirmed") !== true) throw new Gate("fast-chrome-group-title-unconfirmed");
  return title;
}

function sleepUntil(deadline: number): Promise<void> {
  return sleep(Math.max(0, (deadline - monotonic()) * 1000));
}

type Waited = { outcome: string; elapsed_ms?: number; snapshot?: Dict; error?: string };
type Sent = { outcome: string; error?: string };

export interface ClaimBrowserArgs { site?: string | null; exclusive?: unknown; timeout_seconds?: unknown }
export interface OpenTabArgs { url: unknown; group_title?: unknown }
export interface TabArgs { tab_id: unknown }
export interface ActArgs extends TabArgs { snapshot_id: unknown; action_id: unknown; text?: unknown; expect?: PageExpectation | null; timeout_ms?: unknown }
export interface ActStepsArgs extends TabArgs { steps: unknown; snapshot_id?: unknown; include_text?: unknown; timeout_ms?: unknown }
export interface PasteArgs extends TabArgs {
  expected_url: unknown; expected_email: unknown; field: unknown; selector: unknown; username_selector?: unknown; snapshot_id?: unknown;
  submit_action_id?: unknown; allow_foreground_search?: unknown
}

export class BrowserControl implements App {
  readonly serverInfo: { name: string; version: string };
  readonly instructions = INSTRUCTIONS;
  readonly env: Env;
  readonly shutdown: Shutdown;
  readonly registry: TabRegistry;
  readonly connect: Connect;
  readField: ReadField;
  paste: Paste;
  /** validated_pdf; replaceable as Python's tests patched it. */
  validatedPdf: (value: unknown) => { path: string; name: string; size: number } = (value) => validatedPdf(value);
  private readonly startRuntime: (() => StartRuntime) | undefined;
  private readonly recordingDeps: RecordingDeps;
  private readonly poolOverride: PoolContext | undefined;
  private readonly handlers: Readonly<Record<string, (values: Record<string, unknown>, meta: unknown) => Promise<unknown>>>;

  constructor(options: AppOptions) {
    this.env = options.env;
    this.shutdown = options.shutdown;
    this.serverInfo = { name: SERVER_NAME, version: options.version ?? packageAssets().version };
    this.registry = new TabRegistry(() => this.refuseInput());
    this.connect = options.connect ?? ((socket, timeout) => Connection.open(socket, timeout));
    this.readField = options.readField ?? createReadField(this.env);
    this.paste = options.paste ?? paste;
    this.startRuntime = options.startRuntime;
    this.recordingDeps = options.recordingDeps ?? defaultRecordingDeps;
    this.poolOverride = options.pool;
    const v = (values: Record<string, unknown>) => values as never;
    this.handlers = {
      status: (values, meta) => this.status(v(values), meta),
      tabs: (values, meta) => this.tabs(v(values), meta),
      claim_browser: (values, meta) => this.claimBrowser(v(values), meta),
      release_browser: (values, meta) => this.releaseBrowser(v(values), meta),
      open_tab: (values, meta) => this.openTab(v(values), meta),
      claim_tab: (values, meta) => this.claimTab(v(values), meta),
      name_group: (values, meta) => this.nameGroup(v(values), meta),
      observe: (values, meta) => this.observe(v(values), meta),
      wait_for: (values, meta) => this.waitFor(v(values), meta),
      navigate: (values, meta) => this.navigate(v(values), meta),
      act: (values, meta) => this.act(v(values), meta),
      act_steps: (values, meta) => this.actSteps(v(values), meta),
      upload_file: (values, meta) => this.uploadFile(v(values), meta),
      paste_1password_field: (values, meta) => this.paste1PasswordField(v(values), meta),
      screenshot: (values, meta) => this.screenshot(v(values), meta),
      start_recording: (values, meta) => this.startRecording(v(values), meta),
      stop_recording: (values, meta) => this.stopRecording(v(values), meta),
      release: (values, meta) => this.release(v(values), meta)
    };
  }

  // ------------------------------------------------------------------------------------------- MCP surface

  listTools(): Tool[] {
    return TOOLS.map((tool) => structuredClone(tool));
  }

  /**
   * FastMCP's call path: an unknown tool, then argument validation (nothing runs on a refusal), then the
   * shutdown refusal, then the body. A dict result is pydantic JSON text; screenshot returns its content list.
   */
  async callTool(name: string, args: unknown, meta: unknown): Promise<CallToolResult> {
    if (!TOOL_NAMES.has(name)) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    let values: Record<string, unknown>;
    try {
      values = validateArguments(name, args, this.env);
    } catch (error) {
      return failure(name, error);
    }
    if (this.shutdown.isSet) return failure(name, new Gate("fast-chrome-shutting-down"));
    try {
      const result = await this.handlers[name](values, meta);
      if (Array.isArray(result)) return { content: result as CallToolResult["content"], isError: false };
      return { content: [{ type: "text", text: pydanticDumps(result, { indent: 2 }) }], isError: false };
    } catch (error) {
      return failure(name, error);
    }
  }

  cleanup(deadline: number): Promise<void> {
    return this.releaseAll(deadline);
  }

  // ------------------------------------------------------------------------------------------- plumbing

  /** Once shutdown begins, running bodies send no further input; a call already in flight settles. */
  readonly refuseInput = (): void => {
    this.shutdown.refuseInput();
  };

  pool(): PoolContext {
    return this.poolOverride ?? poolContext(this.env);
  }

  route(session: string): Promise<Route> {
    return resolveRoute(session, this.env, () => this.pool());
  }

  /** A new Tab of this server, refusing input once shutdown begins. */
  newTab(owner: string, connection: HostConnection, id: number, tabOrigin: string, created: boolean, binding: ConstructorParameters<typeof Tab>[6] = {}): Tab {
    return new Tab(owner, connection, id, tabOrigin, created, this.refuseInput, binding);
  }

  /** Hold the tab's own (controller, owner, lease) for one call. */
  private tabPin(tab: Tab): Promise<Pin | null> {
    if (tab.controllerId === null) return Promise.resolve(null);
    return Pin.open(tab.controllerId, tab.owner, tab.leaseId, this.pool());
  }

  /**
   * Refuse a foreign or unknown tab in memory before any socket call, registry write or vault call; then pin
   * the tab's own lease and run the body on the exact tab this call locked.
   */
  private async tabOperation<T>(tabId: unknown, meta: unknown, body: (tab: Tab, session: string) => Promise<T>): Promise<T> {
    const session = sessionFromMeta(meta);
    const tab = this.registry.hold(tabId, session) as Tab;
    try {
      const pin = await this.tabPin(tab);
      try {
        if (tab.key !== tabId || tab.owner !== session) throw new Gate("fast-chrome-tab-not-owned");
        if (tab.releaseAttempted || !tab.connection.alive) throw new Gate("fast-chrome-tab-terminal");
        return await body(tab, session);
      } finally {
        pin?.close();
      }
    } finally {
      tab.operation.release();
    }
  }

  /** A capture root: the tab's artifact root, and the default user root created 0700 on first use (D2). */
  private artifactRoot(tab: Tab): string {
    if (tab.artifactRoot === null) return "";
    if (tab.createArtifactRoot) {
      try {
        openDirectory(tab.artifactRoot);
      } catch {
        return "";
      }
    }
    return tab.artifactRoot;
  }

  // ------------------------------------------------------------------------------------------- observation

  async snapshot(tab: Tab, controlsOnly: unknown = null): Promise<Dict> {
    tab.page = null;
    tab.snapshot = null;
    const mode = controlsOnly === null || controlsOnly === undefined ? tab.controlsOnly : controlsOnly;
    if (typeof mode !== "boolean") throw new Gate("fast-chrome-invalid-observation-mode");
    const raw = await tab.call("observePage", { controlsOnly: mode });
    let page: Page;
    try {
      page = this.checkedPage(tab, raw, mode);
    } catch (error) {
      if (error instanceof Gate) throw error;
      throw new Gate("fast-chrome-observation-unavailable");
    }
    tab.page = page;
    tab.snapshot = [randomUUID().replaceAll("-", ""), (raw as Dict).snapshot as string];
    return publicPage(tab);
  }

  /** snapshot's checks in Python's order. Any failure other than a Gate is observation-unavailable. */
  private checkedPage(tab: Tab, raw: unknown, controlsOnly: boolean): Page {
    if (!isDict(raw)) throw new Invalid();
    const version = get(raw, "pageProtocolVersion");
    if (need(raw, "status") !== "observed" || !isInt(version) || version !== 2 || get(raw, "mode") !== (controlsOnly ? "controls-only" : "full")) {
      throw new Invalid();
    }
    if (origin(need(raw, "url"), this.env) !== tab.origin) throw new Gate("fast-chrome-origin-changed");
    for (const key of ["snapshot", "url", "title", "text"]) if (typeof need(raw, key) !== "string") throw new Invalid();
    const { snapshot, url, title, text } = raw as { snapshot: string; url: string; title: string; text: string };
    const rawActions = need(raw, "actions");
    if (!snapshot || pyLen(snapshot) > 200 || !Array.isArray(rawActions) || rawActions.length > 100 || pyLen(url) > 8192
      || pyLen(title) > 200 || pyLen(text) > 12000) {
      throw new Invalid();
    }
    const actions: Action[] = [];
    for (const item of rawActions) {
      if (!isDict(item)) throw new Invalid();
      const kind = need(item, "kind");
      if (!hashable(kind)) throw new Invalid();
      if (!["fill", "click", "upload"].includes(kind as string) || !["id", "label", "role"].every((key) => typeof need(item, key) === "string")) throw new Invalid();
      if (typeof get(item, "disabled") !== "boolean") throw new Invalid();
      const { id, label, role, disabled } = item as { id: string; label: string; role: string; disabled: boolean };
      if (!id || pyLen(id) > 100 || pyLen(label) > 160 || pyLen(role) > 80) throw new Invalid();
      actions.push({ id, kind: kind as string, label, role, disabled });
    }
    if (new Set(actions.map((action) => action.id)).size !== actions.length) throw new Invalid();
    const partial = get(raw, "partial");
    const surfaces = get(raw, "opaqueSurfaces");
    if (typeof partial !== "boolean" || !Array.isArray(surfaces) || surfaces.length > 100) throw new Invalid();
    const opaque: Array<{ id: string; kind: string }> = [];
    surfaces.forEach((item, i) => {
      if (!isDict(item)) throw new Invalid();
      const keys = Object.keys(item);
      if (keys.length !== 2 || !keys.includes("id") || !keys.includes("kind") || item.id !== `opaque-${i}` || !hashable(item.kind)
        || !["iframe", "frame", "object", "embed", "closed-shadow-root"].includes(item.kind as string)) {
        throw new Invalid();
      }
      opaque.push({ ...item } as { id: string; kind: string });
    });
    const truncation = need(raw, "truncation");
    if (!isDict(truncation)) throw new Invalid();
    const flags: Record<string, unknown> = {};
    for (const key of ["text", "actions", "opaqueSurfaces", "labels", "title"]) flags[key] = need(truncation, key);
    if (Object.values(flags).some((value) => typeof value !== "boolean") || partial !== (opaque.length > 0)
      || (flags.opaqueSurfaces && opaque.length !== 100) || (controlsOnly && (text || flags.text))) {
      throw new Invalid();
    }
    return {
      tab_id: tab.key, url, title: pySlice(title, 200), text: pySlice(text, 12000), actions, page_protocol: 2,
      mode: raw.mode as Page["mode"], partial, opaqueSurfaces: opaque, truncation: flags as Page["truncation"]
    };
  }

  async observeAfter(tab: Tab, outcome: string): Promise<Dict> {
    try {
      return { outcome, ...(await this.snapshot(tab)) };
    } catch (error) {
      if (!(error instanceof Gate)) throw error;
      return { outcome, tab_id: tab.key, observation_error: error.code, next: OBSERVE_AGAIN };
    }
  }

  /** Release once with readback. A monotonic deadline bounds the readback during shutdown. */
  async finalize(tab: Tab, keepOpen: boolean, deadline: number | null = null): Promise<Dict> {
    tab.releaseAttempted = true;
    tab.snapshot = null;
    tab.page = null;
    const keep = keepOpen ? [{ tabId: tab.id, status: "deliverable" }] : [];
    try {
      const result = await tab.connection.call("finalizeTabs", { keep });
      if (!isDict(result) || get(result, "closedOrReleased") !== true) throw new Gate("fast-chrome-release-unconfirmed");
      const expectedClosed = tab.created && !keepOpen;
      const end = Math.min(monotonic() + RELEASE_READBACK_SECONDS, deadline || Infinity);
      while (true) {
        const owned = await tab.connection.call("getTabs");
        const available = await tab.connection.call("getUserTabs");
        const own = new Set(pyIter(owned).map((row) => tabInfo(row).tab_id));
        const free = new Set(pyIter(available).map((row) => tabInfo(row).tab_id));
        const key = String(tab.id);
        if (!own.has(key) && (expectedClosed ? !free.has(key) : free.has(key))) {
          if (tab.controllerPin) {
            tab.controllerPin.confirmed();
            tab.controllerPin = null;
          }
          return { tab_id: tab.key, closed: expectedClosed, release_confirmed: true };
        }
        if (monotonic() >= end) throw new Gate("fast-chrome-release-unconfirmed");
        await sleep(POLL_MS);
      }
    } finally {
      tab.connection.close();
    }
  }

  /**
   * Finalize every managed tab in parallel by a monotonic deadline. Each tab first waits for a running body to
   * settle. At the deadline every connection closes; a tab without confirmed finalization keeps its cleanup
   * marker, and nothing is replayed.
   */
  async releaseAll(deadline: number): Promise<void> {
    const tabs = this.registry.drain();
    const settled = tabs.map(() => false);
    const finish = async (tab: Tab) => {
      if (!await tab.operation.acquireBy(deadline)) return;
      try {
        if (tab.recording) await tab.recording.stop({ encode: false });
        if (!tab.releaseAttempted && tab.connection.alive) await this.finalize(tab, !tab.created, deadline);
      } catch {
        // Unconfirmed cleanup keeps the marker.
      } finally {
        tab.operation.release();
      }
    };
    const workers = Promise.all(tabs.map((tab, i) => finish(tab).finally(() => { settled[i] = true; })));
    await Promise.race([workers, sleepUntil(deadline)]);
    for (const tab of tabs) tab.connection.close();
    await Promise.race([workers, sleepUntil(monotonic() + GRACE_SECONDS)]);
    tabs.forEach((tab, i) => {
      if (settled[i] && tab.controllerPin) tab.controllerPin.close();
    });
  }

  // ------------------------------------------------------------------------------------------- routes

  /** Cleanup markers of this lease only; other tenants' markers stay private. */
  private leasePendingTabs(target: Route): Promise<number> {
    return fixedErrorsAsync(() => locked(target.controllerId as string, this.pool(), false,
      (directory) => markers(directory).filter((marker) => marker.lease_id === target.leaseId).length));
  }

  /**
   * Pin the route's lease and write the tab's cleanup marker. On a lease route the site gate runs in the same
   * registry critical section, so a conflict refuses before any tab exists. Callers dispatch createTab or
   * claimUserTab as soon as this returns. The pin and marker writes can wait on registry locks, so shutdown is
   * checked again after them; nothing has been sent then, so that refusal removes the new marker.
   */
  async beginRouteTab(target: Route, session: string, url: string): Promise<[Pin | null, Dict]> {
    this.refuseInput();
    if (target.kind === "user") return [null, {}];
    const pin = await Pin.open(target.controllerId as string, session, target.leaseId, this.pool());
    let gated: Dict;
    try {
      gated = (await pin.beginTab(url)) ?? {};
    } catch (error) {
      pin.close();
      throw error;
    }
    try {
      this.refuseInput();
    } catch (error) {
      try {
        pin.confirmed();
      } finally {
        pin.close();
      }
      throw error;
    }
    return [pin, gated];
  }

  /**
   * A new tab bound to its route. It is busy from the start, so no call can use it once register() publishes
   * it until its setup ends; the setup releases it.
   */
  private boundTab(target: Route, pin: Pin | null, gated: Dict, session: string, connection: HostConnection, id: number, tabOrigin: string, created: boolean): Tab {
    const tab = this.newTab(session, connection, id, tabOrigin, created, {
      controllerId: target.controllerId, leaseId: pin ? pin.leaseId : null, mode: target.mode, site: (get(gated, "site") as string | null),
      artifactRoot: target.artifactRoot, createArtifactRoot: target.createArtifactRoot, prefix: routePrefix(target)
    });
    tab.controllerPin = pin;
    tab.operation.tryAcquire();
    return tab;
  }

  /**
   * Publish a new tab under its handle. Refused once shutdown begins, because cleanup takes its list of tabs
   * then; the setup's own cleanup handles the refused tab.
   */
  async register(tab: Tab): Promise<Tab> {
    this.registry.checkFree(tab);
    await tab.call("attach");
    const bound = await tab.call("bindPage", { expectedOrigin: tab.origin, allowInsecureLoopback: allowLoopback(this.env) });
    if (!isDict(bound) || get(bound, "bound") !== true) throw new Gate("fast-chrome-origin-binding-unconfirmed");
    this.registry.publish(tab);
    return tab;
  }

  async failedSetup(tab: Tab | null, connection: HostConnection, error: unknown): Promise<Dict> {
    const code = error instanceof Gate ? error.code : "fast-chrome-setup-unconfirmed";
    let cleanup = "unconfirmed";
    if (tab !== null) {
      try {
        if (connection.alive) {
          await this.finalize(tab, !tab.created);
          cleanup = "confirmed";
        }
      } catch {
        // The tab stays listed as terminal with unconfirmed cleanup.
      }
      if (cleanup === "confirmed") this.registry.remove(tab);
      else this.registry.retain(tab);
    }
    connection.close();
    return { outcome: "incomplete", error: code, tab_id: tab ? tab.key : null, cleanup, next: "inspect; do not repeat the preceding operation" };
  }

  // ------------------------------------------------------------------------------------------- tools

  /**
   * Check this session's route and its Browser Control endpoint without launching a browser or reading page
   * content. Shows only this session's own lease, never other owners, leases or sites.
   */
  async status(_args: Dict, meta: unknown): Promise<Dict> {
    const session = sessionFromMeta(meta);
    const target = await this.route(session);
    const details: Dict = { route: target.kind };
    if (target.kind === "lease") {
      Object.assign(details, {
        controller_id: target.controllerId, lease_id: target.leaseId, mode: target.mode, sites: [...target.sites],
        pending_tabs: await this.leasePendingTabs(target)
      });
    }
    let connection: HostConnection | null = null;
    let info: unknown;
    try {
      connection = await this.connect(target.socket);
      info = await connection.call("getInfo");
    } catch (error) {
      // A leased Chrome that is not running is reported, so claim_browser can start it again.
      if (!(error instanceof Gate) || target.kind !== "lease") throw error;
      return { backend: BACKEND_NAME, ready: false, error: error.code, ...details };
    } finally {
      connection?.close();
    }
    if (!isDict(info)) throw new TypeError("the getInfo result has no attribute 'get'");
    return { backend: BACKEND_NAME, ready: true, protocol: 2, page_protocol: 2, extension_version: get(info, "version"), ...details };
  }

  /**
   * List unclaimed tabs on this session's route and this session's managed tabs. With a browser lease, only
   * tabs on the lease's sites are listed.
   */
  async tabs(_args: Dict, meta: unknown): Promise<Dict> {
    const session = sessionFromMeta(meta);
    const target = await this.route(session);
    const connection = await this.connect(target.socket);
    const rows: Dict[] = [];
    try {
      for (const row of pyIter(await connection.call("getUserTabs"))) {
        const info = tabInfo(row);
        if (routeLists(target, info.url)) rows.push(listed(info, routePrefix(target), false));
      }
    } finally {
      connection.close();
    }
    for (const tab of this.registry.values()) {
      if (tab.owner === session && tab.connection.alive && !tab.releaseAttempted) {
        for (const row of pyIter(await tab.connection.call("getTabs"))) rows.push(listed(tabInfo(row), tab.prefix, true));
      } else if (tab.owner === session) {
        rows.push({ tab_id: tab.key, origin: tab.origin, terminal: true, cleanup: "unconfirmed", managed_by_session: true });
      }
    }
    return { tabs: rows };
  }

  /** Lease an isolated Chrome for Testing profile for this session and wait until it is ready. */
  async claimBrowser(args: ClaimBrowserArgs, meta: unknown): Promise<Dict> {
    const session = sessionFromMeta(meta);
    return ensure(null, session, {
      timeout: args.timeout_seconds, site: args.site ?? null, exclusive: (args.exclusive === undefined ? false : args.exclusive) as boolean,
      ctx: this.pool(), runtime: this.startRuntime?.()
    });
  }

  /** Release this session's browser lease once its tabs are released. Chrome and the profile stay for reuse. */
  async releaseBrowser(args: { lease_id: unknown }, meta: unknown): Promise<Dict> {
    const session = sessionFromMeta(meta);
    if (this.registry.values().some((tab) => tab.owner === session && tab.leaseId === args.lease_id)) {
      throw new Gate("fast-chrome-release-tabs-first");
    }
    return releaseLease(session, args.lease_id, this.pool());
  }

  /**
   * Create one inactive owned tab bound to an exact HTTPS origin, in this session's leased browser or else the
   * user's Chrome. Group-title confirmation is required; setup failure cleans the new tab.
   */
  async openTab(args: OpenTabArgs, meta: unknown): Promise<Dict> {
    const session = sessionFromMeta(meta);
    const expectedOrigin = origin(args.url, this.env);
    const url = args.url as string;
    const title = validatedGroupTitle(session, args.group_title ?? null);
    const target = await this.route(session);
    const connection = await this.connect(target.socket);
    let tab: Tab | null = null;
    let pin: Pin | null = null;
    let gated: Dict = {};
    try {
      [pin, gated] = await this.beginRouteTab(target, session, url);
    } catch (error) {
      connection.close();
      throw error;
    }
    try {
      const raw = await connection.call("createTab");
      if (!isDict(raw) || get(raw, "active") !== false) throw new Gate("fast-chrome-background-tab-unconfirmed");
      tab = this.boundTab(target, pin, gated, session, connection, Number(tabInfo(raw).tab_id), expectedOrigin, true);
      await confirmGroupTitle(connection, session, title);
      tab.groupTitle = title;
      await this.register(tab);
      this.refuseInput();
      await tab.call("navigatePage", { url });
      return { ...(await this.observeAfter(tab, "opened")), group_title: title, group_title_confirmed: true, ...gated };
    } catch (error) {
      return await this.failedSetup(tab, connection, error);
    } finally {
      if (tab === null && pin !== null) pin.close();
      if (tab !== null) tab.operation.release();
    }
  }

  /** Claim an observed task-relevant user tab without navigating. Claimed user tabs are preserved. */
  async claimTab(args: { tab_id: unknown; group_title?: unknown }, meta: unknown): Promise<Dict> {
    const session = sessionFromMeta(meta);
    const tab = this.registry.hold(args.tab_id, session, true);
    try {
      if (tab === null) return await this.claimRouteTab(args.tab_id, session, await this.route(session), args.group_title ?? null);
      const pin = await this.tabPin(tab);
      try {
        let title = tab.groupTitle;
        let confirmed = false;
        if (args.group_title !== null && args.group_title !== undefined) {
          title = await confirmGroupTitle(tab.connection, session, args.group_title);
          tab.groupTitle = title;
          confirmed = true;
        }
        return { ...(await this.snapshot(tab)), group_title: title, group_title_confirmed: confirmed };
      } finally {
        pin?.close();
      }
    } finally {
      tab?.operation.release();
    }
  }

  /** Claim an unmanaged tab listed on this route. Another route's handle is unavailable here. */
  private async claimRouteTab(tabId: unknown, session: string, target: Route, groupTitle: unknown): Promise<Dict> {
    const chrome = chromeId(target, tabId);
    if (chrome === null) throw new Gate("fast-chrome-tab-unavailable");
    const connection = await this.connect(target.socket);
    let tab: Tab | null = null;
    let pin: Pin | null = null;
    try {
      const title = validatedGroupTitle(session, groupTitle);
      let found: Dict | null = null;
      for (const row of pyIter(await connection.call("getUserTabs"))) {
        if (tabInfo(row).tab_id === chrome) {
          found = row as Dict;
          break;
        }
      }
      if (found === null || !routeLists(target, found.url)) throw new Gate("fast-chrome-tab-unavailable");
      const url = found.url as string;
      const expectedOrigin = origin(url, this.env);
      let gated: Dict;
      [pin, gated] = await this.beginRouteTab(target, session, url);
      const raw = await connection.call("claimUserTab", { tabId: Number(chrome) });
      tab = this.boundTab(target, pin, gated, session, connection, Number(chrome), expectedOrigin, false);
      if (tabInfo(raw).tab_id !== chrome || origin((raw as Dict).url, this.env) !== expectedOrigin) throw new Gate("fast-chrome-claim-changed");
      await confirmGroupTitle(connection, session, title);
      tab.groupTitle = title;
      await this.register(tab);
      return { ...(await this.observeAfter(tab, "claimed")), group_title: title, group_title_confirmed: true, ...gated };
    } catch (error) {
      if (tab === null) {
        connection.close();
        throw error;
      }
      return await this.failedSetup(tab, connection, error);
    } finally {
      if (tab === null && pin !== null) pin.close();
      if (tab !== null) tab.operation.release();
    }
  }

  /** Rename this owned tab's Chrome group. Display metadata only; ownership is unchanged. */
  nameGroup(args: TabArgs & { title: unknown }, meta: unknown): Promise<Dict> {
    return this.tabOperation(args.tab_id, meta, async (tab) => {
      const confirmed = await confirmGroupTitle(tab.connection, tab.owner, args.title);
      tab.groupTitle = confirmed;
      return { tab_id: tab.key, group_title: confirmed, group_title_confirmed: true };
    });
  }

  /** Read scoped text and actions. Controls-only omits body text, not sensitive labels. */
  observe(args: TabArgs & { controls_only?: unknown }, meta: unknown): Promise<Dict> {
    return this.tabOperation(args.tab_id, meta, async (tab) => {
      const controlsOnly = args.controls_only === undefined ? false : args.controls_only;
      if (typeof controlsOnly === "boolean") tab.controlsOnly = controlsOnly;
      return this.snapshot(tab, controlsOnly);
    });
  }

  /** Poll until the expectation matches, it is ambiguous, a read fails, the time is up, or shutdown begins. */
  async waitForTab(tab: Tab, expect: Expectation, timeoutMs: number, full = false): Promise<Waited> {
    const controlsOnly = readControlsOnly(tab, expect, full);
    const start = monotonic();
    const deadline = start + timeoutMs / 1000;
    const elapsed = () => pyRound((monotonic() - start) * 1000);
    while (true) {
      if (this.shutdown.isSet) return { outcome: "shutdown", elapsed_ms: elapsed() };
      let page: Dict | null = null;
      let outcome: string;
      try {
        page = await this.snapshot(tab, controlsOnly);
        outcome = match(tab.page as Page, expect);
      } catch (error) {
        if (!(error instanceof Gate)) throw error;
        if (error.code !== "browser-control-page-not-ready" || monotonic() >= deadline) return { outcome: "read_failed", error: error.code };
        outcome = "no_match";
      }
      const spent = elapsed();
      if (outcome === "match") return { outcome: "matched", snapshot: page as Dict, elapsed_ms: spent };
      tab.page = null;
      tab.snapshot = null;
      if (outcome === "ambiguous" || monotonic() >= deadline) return { outcome: outcome === "ambiguous" ? "ambiguous" : "timeout", elapsed_ms: spent };
      await this.shutdown.wait(Math.min(POLL_MS, Math.max(0, (deadline - monotonic()) * 1000)));
      if (monotonic() >= deadline) return { outcome: "timeout", elapsed_ms: elapsed() };
    }
  }

  /** Poll public expectations without input. URL, text and a unique enabled action must match in one observation. */
  waitFor(args: TabArgs & { expect: PageExpectation; timeout_ms?: unknown }, meta: unknown): Promise<Dict> {
    return this.tabOperation(args.tab_id, meta, async (tab) => {
      const timeout = args.timeout_ms === undefined ? 10000 : args.timeout_ms;
      if (!isInt(timeout) || timeout < 1 || timeout > 15000) throw new Gate("fast-chrome-wait-bounds");
      return this.waitForTab(tab, boundExpectation(tab, args.expect), timeout);
    });
  }

  /** Navigate once within the tab's bound origin. Use a new tab for another origin. */
  navigate(args: TabArgs & { url: unknown }, meta: unknown): Promise<Dict> {
    return this.tabOperation(args.tab_id, meta, async (tab) => {
      if (origin(args.url, this.env) !== tab.origin) throw new Gate("fast-chrome-origin-change-refused");
      tab.page = null;
      tab.snapshot = null;
      await tab.call("navigatePage", { url: args.url as string });
      return this.observeAfter(tab, "navigated");
    });
  }

  /** Dispatch one validated action with the current token. Consumes the token and never retries. */
  async actOnce(tab: Tab, action: Action, text: string | null = null): Promise<Sent> {
    this.refuseInput();
    const token = (tab.snapshot as [string, string])[1];
    tab.snapshot = null;
    tab.page = null;
    let outcome: unknown;
    try {
      const raw = await tab.call("actPage", { snapshot: token, actionId: action.id, ...(text !== null ? { text } : {}) });
      if (!isDict(raw)) throw new TypeError("the actPage result has no attribute 'get'");
      outcome = get(raw, "status");
      if (!hashable(outcome)) throw new TypeError("unhashable status");
      if (!["executed", "not-executed", "unknown"].includes(outcome as string)) throw new Gate("fast-chrome-invalid-action-result");
    } catch (error) {
      return { outcome: "unknown", error: error instanceof Gate ? error.code : "fast-chrome-action-unconfirmed" };
    }
    return { outcome: (outcome as string).replaceAll("-", "_") };
  }

  /** Execute one observed action. Optionally wait for a public postcondition; never supply credentials. */
  act(args: ActArgs, meta: unknown): Promise<Dict> {
    return this.tabOperation(args.tab_id, meta, async (tab) => {
      const timeout = args.timeout_ms === undefined ? 10000 : args.timeout_ms;
      const text = args.text ?? null;
      if (!isInt(timeout) || timeout < 1 || timeout > 15000) throw new Gate("fast-chrome-wait-bounds");
      const expect = args.expect ? boundExpectation(tab, args.expect) : null;
      if (tab.snapshot === null || args.snapshot_id !== tab.snapshot[0]) throw new Gate("fast-chrome-snapshot-consumed-or-expired");
      const action = (tab.page as Page).actions.find((item) => item.id === args.action_id);
      if (action === undefined || action.disabled) throw new Gate("fast-chrome-action-unavailable");
      if (action.kind === "upload") throw new Gate("fast-chrome-file-action-requires-upload");
      if ((action.kind === "fill" && (typeof text !== "string" || pyLen(text) > 2000)) || (action.kind !== "fill" && text !== null)) {
        throw new Gate("fast-chrome-invalid-public-input");
      }
      const dispatched = await this.actOnce(tab, action, text as string | null);
      if (dispatched.error !== undefined) return { outcome: "unknown", tab_id: args.tab_id, error: dispatched.error, next: "inspect; do not replay" };
      if (dispatched.outcome !== "executed") return { outcome: dispatched.outcome, tab_id: args.tab_id, next: AFTER_INPUT };
      if (expect !== null) {
        const waited = await this.waitForTab(tab, expect, timeout);
        if (waited.outcome === "matched") return { outcome: "executed", wait: "matched", elapsed_ms: waited.elapsed_ms, ...waited.snapshot };
        return {
          outcome: "executed", wait: waited.outcome, tab_id: args.tab_id, ...(waited.error !== undefined ? { error: waited.error } : {}),
          next: AFTER_INPUT
        };
      }
      return this.observeAfter(tab, "executed");
    });
  }

  /**
   * Run 1-10 public steps in order, each on exactly one enabled action with that exact label. Stops before input
   * on a missing, disabled, ambiguous, upload or text-mismatched control or a spent budget; stops after input on
   * an unexecuted or unknown outcome, failed wait, spent budget or failed observation. Never replays a step.
   */
  actSteps(args: ActStepsArgs, meta: unknown): Promise<Dict> {
    return this.tabOperation(args.tab_id, meta, async (tab) => {
      const timeout = args.timeout_ms === undefined ? 30000 : args.timeout_ms;
      const snapshotId = args.snapshot_id ?? null;
      const includeText = args.include_text === undefined ? false : args.include_text;
      const steps = args.steps as Step[];
      if (!isInt(timeout) || timeout < 1 || timeout > 60000 || !Array.isArray(steps) || steps.length < 1 || steps.length > 10
        || !steps.every((item) => item instanceof Step)) {
        throw new Gate("fast-chrome-steps-bounds");
      }
      if (steps.some((item) => (item.kind === "click" && item.text !== null) || (item.kind === "fill" && item.text === null))) {
        throw new Gate("fast-chrome-invalid-public-input");
      }
      const expects = steps.map((item) => (item.expect === null ? null : boundExpectation(tab, item.expect)));
      if (snapshotId !== null && (tab.snapshot === null || snapshotId !== tab.snapshot[0])) throw new Gate("fast-chrome-snapshot-consumed-or-expired");
      const start = monotonic();
      const deadline = start + timeout / 1000;
      if (tab.snapshot === null) await this.snapshot(tab);
      const completed: Dict[] = [];
      const result = (stopped: Dict | null = null): Dict => ({
        tab_id: args.tab_id, completed, stopped, final: stopped && stopped.dispatched ? null : finalPage(tab, includeText),
        elapsed_ms: pyRound((monotonic() - start) * 1000)
      });
      const stop = (i: number, reason: string, dispatched = false, details: Dict = {}): Dict => {
        const hint = dispatched ? AFTER_INPUT : reason === "disabled" ? UNTIL_ENABLED : BEFORE_INPUT;
        return result({ i, label: steps[i].label, reason, dispatched, ...details, next: hint });
      };
      for (let i = 0; i < steps.length; i += 1) {
        const item = steps[i];
        if (this.shutdown.isSet) return stop(i, "shutdown");
        if (monotonic() >= deadline) return stop(i, "budget_exhausted");
        const [action, reason, count] = stepAction(tab.page as Page, item);
        if (reason !== null || action === null) return stop(i, reason as string, false, reason === "ambiguous" || reason === "disabled" ? { count } : {});
        const began = monotonic();
        const sent = await this.actOnce(tab, action, item.text);
        if (sent.outcome !== "executed") return stop(i, sent.outcome, true, { action_id: action.id, ...sent });
        const full = Boolean(includeText) && i === steps.length - 1;
        const expected = expects[i];
        if (expected !== null) {
          const remainingMs = (deadline - monotonic()) * 1000;
          if (remainingMs <= 0) return stop(i, "budget_exhausted", true, { action_id: action.id, outcome: "executed" });
          const limit = item.timeout_ms === null ? 10000 : item.timeout_ms;
          const waited = await this.waitForTab(tab, expected, Math.min(limit, remainingMs), full);
          if (waited.outcome !== "matched") {
            return stop(i, waited.outcome === "shutdown" ? "shutdown" : `wait_${waited.outcome}`, true, {
              action_id: action.id, outcome: "executed", ...(waited.error !== undefined ? { error: waited.error } : {})
            });
          }
        } else {
          try {
            await this.snapshot(tab, readControlsOnly(tab, null, full));
          } catch (error) {
            if (!(error instanceof Gate)) throw error;
            return stop(i, "observation_failed", true, { action_id: action.id, outcome: "executed", error: error.code });
          }
        }
        completed.push({
          i, label: item.label, action_id: action.id, outcome: "executed", ...(expected !== null ? { wait: "matched" } : {}),
          ms: pyRound((monotonic() - began) * 1000)
        });
      }
      return result();
    });
  }

  /** Attach one current-user-owned local PDF to an observed public file input. Never retries. */
  uploadFile(args: TabArgs & { snapshot_id: unknown; action_id: unknown; path: unknown }, meta: unknown): Promise<Dict> {
    return this.tabOperation(args.tab_id, meta, async (tab) => {
      if (tab.snapshot === null || args.snapshot_id !== tab.snapshot[0]) throw new Gate("fast-chrome-snapshot-consumed-or-expired");
      const matches = (tab.page as Page).actions.filter((action) => action.id === args.action_id);
      const token = tab.snapshot[1];
      tab.snapshot = null;
      tab.page = null;
      if (matches.length !== 1 || matches[0].kind !== "upload" || matches[0].disabled) throw new Gate("fast-chrome-file-action-unavailable");
      if (tab.recording) throw new Gate("fast-chrome-stop-recording-first");
      const local = this.validatedPdf(args.path);
      this.refuseInput(); // before the unknown-receipt mapping: a shutdown refusal sends nothing
      let status: unknown;
      try {
        const raw = await tab.call("uploadFile", { snapshot: token, actionId: args.action_id as string, path: local.path, name: local.name, size: local.size });
        status = isDict(raw) ? get(raw, "status") : null;
        if (!hashable(status) || !["attached", "not-executed", "unknown"].includes(status as string)) throw new Gate("fast-chrome-invalid-upload-result");
      } catch {
        return { status: "unknown", retry: false };
      }
      if (status !== "attached") return { status, retry: false };
      return { status: "attached", name: local.name, mime: "application/pdf", size: local.size, retry: false };
    });
  }

  /**
   * Privately copy from the unlocked desktop Login into the exact owned URL. Returns status only. The Direct
   * account-pool lease is gone (C6, Q2); tab ownership and every other guard stay.
   */
  paste1PasswordField(args: PasteArgs, meta: unknown): Promise<Dict> {
    return this.tabOperation(args.tab_id, meta, async (tab, session) => {
      if (origin(args.expected_url, this.env) !== tab.origin) throw new Gate("fast-chrome-origin-change-refused");
      const allow = Boolean(args.allow_foreground_search ?? false);
      const source: PrivateSource = (email: string, field: VaultField) => {
        this.refuseInput(); // no vault read, and so no private input, once shutdown begins
        return allow ? this.readField(email, field, { allow_foreground_search: true }) : this.readField(email, field);
      };
      try {
        const result = await this.paste(tab, {
          session, expectedUrl: args.expected_url as string, email: args.expected_email, field: args.field, selector: args.selector,
          usernameSelector: args.username_selector ?? null, snapshotId: args.snapshot_id ?? null, submitActionId: args.submit_action_id ?? null
        }, source, this.refuseInput, this.env);
        return { ...result, tab_id: args.tab_id };
      } catch (error) {
        if (error instanceof Gate || error instanceof VaultError) return { outcome: "blocked", tab_id: args.tab_id, reason: error.code, retry: false };
        return { outcome: "unknown", tab_id: args.tab_id, reason: "private-transfer-unconfirmed", retry: false };
      }
    });
  }

  /** Save and return a guarded tab JPEG. */
  screenshot(args: TabArgs, meta: unknown): Promise<CallToolResult["content"]> {
    return this.tabOperation(args.tab_id, meta, async (tab) => {
      const data = await jpeg(tab);
      const file = path.join(captureDirectory(this.artifactRoot(tab)), "screenshot.jpg");
      saveExclusive(file, data);
      return [{ type: "image", data: data.toString("base64"), mimeType: "image/jpeg" }, { type: "text", text: `Saved screenshot: ${file}` }];
    });
  }

  /** Start authorized timestamped JPEG sampling, not continuous video. Stop before any private input. */
  startRecording(args: TabArgs & { fps?: unknown; max_seconds?: unknown }, meta: unknown): Promise<Dict> {
    return this.tabOperation(args.tab_id, meta, async (tab) => {
      const fps = args.fps === undefined ? 5 : args.fps;
      const maxSeconds = args.max_seconds === undefined ? 30 : args.max_seconds;
      if (tab.recording) throw new Gate("fast-chrome-recording-already-exists");
      tab.recording = await Recording.start(tab, fps, maxSeconds, this.artifactRoot(tab), this.recordingDeps);
      return { directory: tab.recording.directory, fps, max_seconds: maxSeconds, kind: "timestamped-jpeg-sampled-video" };
    });
  }

  /** Confirm sampling stopped and encode and decode the MP4. Reports incomplete capture explicitly. */
  stopRecording(args: TabArgs, meta: unknown): Promise<Dict> {
    return this.tabOperation(args.tab_id, meta, async (tab) => {
      if (!tab.recording) throw new Gate("fast-chrome-no-recording");
      const result = await tab.recording.stop();
      tab.recording = null;
      return result as unknown as Dict;
    });
  }

  /** Release once with readback. Close task-created tabs by default; always preserve claimed user tabs. */
  release(args: TabArgs & { keep_open?: unknown }, meta: unknown): Promise<Dict> {
    return this.tabOperation(args.tab_id, meta, async (tab) => {
      if (tab.recording) throw new Gate("fast-chrome-stop-recording-first");
      const result = await this.finalize(tab, Boolean(args.keep_open ?? false));
      this.registry.remove(tab);
      return result;
    });
  }
}

/** FastMCP's refusal text: the Gate code, pydantic's validation text (D10), or the exception text. */
function failure(tool: string, error: unknown): CallToolResult {
  const detail = error instanceof Gate ? error.code : error instanceof ValidationError ? error.message
    : error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `Error executing tool ${tool}: ${detail}` }], isError: true };
}

export { PageExpectation, Step } from "./args";
