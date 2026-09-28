// Fixtures for the native_server.py ports: a scripted host connection (Python's Mock(alive=True)), synthetic
// pages, a fake Browser Control endpoint with user and created tabs, and a server over a private state root.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BrowserControl, type AppOptions } from "../../../src/server/app";
import { mcpServer } from "../../../src/server/entry";
import { Gate } from "../../../src/server/gate";
import type { HostConnection } from "../../../src/server/host-connection";
import type { JsonObject } from "../../../src/server/pyjson";
import { poolContext, type PoolContext } from "../../../src/server/pool/registry";
import { Shutdown } from "../../../src/server/runtime/shutdown";
import type { Tab } from "../../../src/server/tabs";
import { code } from "../support/renames";
import { privateTemp, testEnv } from "../support/temp";

export type Call = [string, any];
export type Effect = unknown[] | Error | ((method: string, params: any) => unknown) | null;

/** Python's Mock(alive=True) for a host connection: a call log, return_value and side_effect. */
export class FakeConnection implements HostConnection {
  alive = true;
  readonly calls: Call[] = [];
  closed = 0;
  returnValue: unknown = undefined;
  sideEffect: Effect = null;
  onClose: (() => void) | null = null;

  constructor(returnValue?: unknown) {
    this.returnValue = returnValue;
  }

  async call(method: string, params?: JsonObject | null): Promise<unknown> {
    this.calls.push([method, params]);
    const effect = this.sideEffect;
    if (effect instanceof Error) throw effect;
    if (Array.isArray(effect)) {
      if (!effect.length) throw new Error("StopIteration: no side effect left");
      const next = effect.shift();
      if (next instanceof Error) throw next;
      return next;
    }
    if (typeof effect === "function") return effect(method, params);
    return this.returnValue;
  }

  close(): void {
    this.closed += 1;
    this.onClose?.();
  }

  methods(): string[] {
    return this.calls.map(([method]) => method);
  }

  /** (method, controlsOnly) for each call, as the Python read_modes helper. */
  modes(): Array<[string, unknown]> {
    return this.calls.map(([method, params]) => [method, params?.controlsOnly]);
  }

  reset(): void {
    this.calls.length = 0;
  }
}

/** A Gate with the port's name for a Python error code (D19). */
export function gate(python: string): Gate {
  return new Gate(code(python));
}

export function meta(name = "ses_test", key = "ai.opencode/sessionID"): Record<string, string> {
  return { [key]: name };
}

export function page(text = "Ready", labels: string[] = ["Continue"], disabled = false): Record<string, any> {
  return {
    status: "observed", pageProtocolVersion: 2, snapshot: "backend-token", url: "https://example.test/", title: "Fixture", text,
    mode: "full", partial: false, opaqueSurfaces: [], truncation: { text: false, actions: false, opaqueSurfaces: false, labels: false, title: false },
    actions: labels.map((label, i) => ({ id: String(i), kind: "click", label, role: "button", disabled }))
  };
}

export function stepsPage(actions: Array<[string, string]>, options: { text?: string; token?: string } = {}): Record<string, any> {
  const raw = page(options.text ?? "Ready");
  raw.snapshot = options.token ?? "backend-token";
  raw.actions = actions.map(([kind, label], i) => ({ id: String(i), kind, label, role: kind === "fill" ? "textbox" : "button", disabled: false }));
  return raw;
}

export function filePage(): Record<string, any> {
  const value = page("Ready", ["Upload PDF"]);
  value.actions[0].kind = "upload";
  return value;
}

/** Answer observePage with `raw` and actPage with `status`, after `delay` ms. */
export function serve(connection: FakeConnection, raw: unknown, status = "executed", delay = 0): void {
  connection.sideEffect = async (method: string) => {
    if (method !== "actPage") return raw;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    return { status };
  };
}

/** mode_dispatch: controls-only reads have no text; full reads carry a canary and a truncated-text flag. */
export function modeDispatch(labels: string[] = ["Continue"]) {
  return (method: string, params: any): unknown => {
    if (method === "actPage") return { status: "executed" };
    const limited = params?.controlsOnly ?? false;
    const raw = page(limited ? "" : "Ready BODY_CANARY", labels);
    raw.mode = limited ? "controls-only" : "full";
    raw.truncation.text = !limited;
    return raw;
  };
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; settled: () => boolean } {
  let resolve!: (value: T) => void;
  let done = false;
  const promise = new Promise<T>((settle) => {
    resolve = (value) => {
      done = true;
      settle(value);
    };
  });
  return { promise, resolve, settled: () => done };
}

/** Wait until `condition` holds, polling every 5 ms, or fail after `ms`. */
export async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The code of a rejected promise or thrown call (null when it succeeds). */
export async function refusal(body: Promise<unknown> | (() => unknown)): Promise<string | null> {
  try {
    await (typeof body === "function" ? body() : body);
    return null;
  } catch (error) {
    if (error instanceof Gate) return error.code;
    throw error;
  }
}

export interface Fixture {
  server: BrowserControl;
  env: Record<string, string | undefined>;
  root: string;
  shutdown: Shutdown;
  ctx: PoolContext;
  sockets: string;
  userSocket: string;
  connections: Array<{ path: string }>;
}

/**
 * A server over a fresh private state root. The user socket is <root>/sockets/default.sock; connect() goes to
 * `connect` when given, else fails the test. FAST_CHROME_UNSHARED_SITES=reap.global keeps the Python pool intent (C5).
 */
export function fixture(options: Partial<AppOptions> & { extraEnv?: Record<string, string | undefined> } = {}): Fixture {
  const root = privateTemp();
  const sockets = path.join(root, "sockets");
  fs.mkdirSync(sockets, { recursive: true, mode: 0o700 });
  const userSocket = path.join(sockets, "default.sock");
  const env = testEnv(root, { BROWSER_CONTROL_STATE_DIR: root, BROWSER_CONTROL_HOST_SOCKET: userSocket, FAST_CHROME_UNSHARED_SITES: "reap.global", ...options.extraEnv });
  const shutdown = options.shutdown ?? new Shutdown();
  const server = new BrowserControl({ connect: async () => { throw new Error("unexpected connect"); }, ...options, env, shutdown });
  return { server, env, root, shutdown, ctx: poolContext(env), sockets, userSocket, connections: [] };
}

/** Replace the server's connect (monkeypatch server.connect). */
export function setConnect(server: BrowserControl, connect: (socket: string) => HostConnection | Promise<HostConnection>): void {
  (server as { connect: unknown }).connect = async (socket: string) => connect(socket);
}

/** A managed tab 1 of ses_test on https://example.test with a connection answering page(), like the tab fixture. */
export function tabFixture(target: Fixture, owner = "ses_test", id = 1, created = true): Tab {
  const connection = new FakeConnection(page());
  const tab = target.server.newTab(owner, connection, id, "https://example.test", created);
  target.server.registry.tabs.set(tab.key, tab);
  return tab;
}

export function connectionOf(tab: Tab): FakeConnection {
  return tab.connection as FakeConnection;
}

/** A socket file with no listener where claims look for a running controller. */
export async function running(sockets: string, controller: string): Promise<void> {
  const file = path.join(sockets, `${controller}.sock`);
  const temporary = `${file}.t`;
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(temporary, () => resolve());
  });
  fs.renameSync(temporary, file);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Fake Browser Control endpoint behind one socket: user tabs to list and claim, created tabs, one page each. */
export class Chrome {
  user = new Map<number, string>();
  nextId: number;
  calls: string[] = [];
  connections = 0;

  constructor(urls: string[], firstId = 10) {
    urls.forEach((url, i) => this.user.set(firstId + i, url));
    this.nextId = firstId + 100;
  }

  connect(): FakeConnection {
    this.connections += 1;
    const owned = new Map<number, string>();
    const created = new Set<number>();
    const connection = new FakeConnection();
    connection.sideEffect = (method: string, params: any) => {
      const args = params ?? {};
      this.calls.push(method);
      const tabId = args.tabId;
      if (method === "getInfo") return { version: "0.2.0" };
      if (method === "getUserTabs") return [...this.user].map(([n, url]) => ({ id: n, url, title: "User" }));
      if (method === "getTabs") return [...owned].map(([n, url]) => ({ id: n, url, title: "Owned" }));
      if (method === "createTab") {
        this.nextId += 1;
        owned.set(this.nextId, "about:blank");
        created.add(this.nextId);
        return { id: this.nextId, active: false, url: "about:blank", title: "" };
      }
      if (method === "claimUserTab") {
        owned.set(tabId, this.user.get(tabId) as string);
        this.user.delete(tabId);
        return { id: tabId, url: owned.get(tabId), title: "User" };
      }
      if (method === "navigatePage") {
        owned.set(tabId, args.url);
        return { status: "dispatched" };
      }
      if (method === "observePage") return { ...page(), url: owned.get(tabId) };
      if (method === "capturePage") return { data: JPEG_4X4 };
      if (method === "finalizeTabs") {
        const kept = new Set(args.keep.map((item: { tabId: number }) => item.tabId));
        for (const [n, url] of [...owned]) {
          owned.delete(n);
          if (kept.has(n) || !created.has(n)) this.user.set(n, url);
        }
        return { closedOrReleased: true };
      }
      const fixed: Record<string, unknown> = {
        nameSession: { name: args.name, confirmed: true }, attach: { attached: true }, bindPage: { bound: true }, actPage: { status: "executed" }
      };
      if (!(method in fixed)) throw new Error(`KeyError: ${method}`);
      return fixed[method];
    };
    return connection;
  }
}

/** Image.new("RGB", (4, 4)).save(..., "JPEG"), captured from Pillow (tests/server/fixtures/python-jpeg.json). */
export const JPEG_4X4 = (() => {
  const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/python-jpeg.json"), "utf8")) as { cases: Array<{ name: string; data: string }> };
  return (corpus.cases.find((item) => item.name === "rgb-4x4") as { data: string }).data;
})();

/** An in-memory MCP client of the server (create_connected_server_and_client_session). */
export async function mcpClient(server: BrowserControl): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = mcpServer(server, server.shutdown);
  await mcp.connect(serverTransport);
  const client = new Client({ name: "browser-control-tests", version: "0" });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await mcp.close(); } };
}

/** The JSON body of a text tool result. */
export function body(result: { content?: unknown }): any {
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}

export function text(result: { content?: unknown }): string {
  return (result.content as Array<{ text: string }>)[0].text;
}
