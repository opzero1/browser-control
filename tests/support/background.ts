import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { expect, vi } from "vitest";

function event() {
  const listeners: ((...args: any[]) => void)[] = [];
  return { addListener: (fn: (...args: any[]) => void) => listeners.push(fn), emit: (...args: any[]) => listeners.forEach(fn => fn(...args)) };
}

type Timers = { setTimeout?: typeof setTimeout };

export async function background(initialStorage: Record<string, unknown> = {}, timers: Timers = {}) {
  const responses: any[] = [];
  const tabs = new Map<number, any>();
  let nextTab = 1;
  const ports: any[] = [];
  const newPort = () => {
    const sent: any[] = [];
    const port = { onMessage: event(), onDisconnect: event(), postMessage: (msg: any) => { responses.push(msg); sent.push(msg); }, disconnect: vi.fn(), sent };
    ports.push(port);
    return port;
  };
  const storage: Record<string, unknown> = { ...initialStorage };
  let group = { id: 1, title: "", collapsed: false };
  const chrome = {
    runtime: { connectNative: vi.fn(() => newPort()), getManifest: () => ({ name: "Browser Control", version: "test" }), id: "test", onMessage: event(), onStartup: event(), onInstalled: event(), onUpdateAvailable: event(), reload: vi.fn() },
    storage: { local: { get: (key: string, cb: Function) => cb({ [key]: storage[key] }), set: (value: object, cb: Function) => { Object.assign(storage, value); cb(); } }, session: { get: (_: unknown, cb: Function) => cb({}) } },
    alarms: { create: vi.fn(), clear: vi.fn(), onAlarm: event() },
    windows: { getCurrent: (_: unknown, cb: Function) => cb({ id: 1, type: "normal" }) },
    tabs: {
      create: vi.fn((props: any, cb: Function) => { const tab = { id: nextTab++, ...props }; tabs.set(tab.id, tab); cb(tab); }),
      get: (id: number, cb: Function) => cb(tabs.get(id)),
      group: (_: unknown, cb: Function) => cb(1), ungroup: (_: unknown, cb: Function) => cb(),
      query: (_: unknown, cb: Function) => cb([...tabs.values()]),
      onRemoved: event(), onReplaced: event(), onUpdated: event()
    },
    tabGroups: {
      get: vi.fn((_: unknown, cb: Function) => cb({ ...group })),
      update: vi.fn((_: unknown, value: object, cb: Function) => { group = { ...group, ...value }; cb({ ...group }); })
    },
    debugger: { attach: vi.fn((_: unknown, __: unknown, cb: Function) => cb()), detach: (_: unknown, cb: Function) => cb(), getTargets: (cb: Function) => cb([{ tabId: 1 }, { tabId: 2 }]), sendCommand: vi.fn((_: unknown, __: unknown, ___: unknown, cb: Function) => cb({})), onEvent: event(), onDetach: event() },
    scripting: { executeScript: vi.fn((_: unknown, cb: Function) => cb([{ documentId: "doc-1", frameId: 0, result: { status: "observed", origin: "https://synthetic.invalid", url: "https://synthetic.invalid/" } }])) }
  };
  vm.runInNewContext(fs.readFileSync("dist/extension/background.js", "utf8"), { chrome, crypto: webcrypto, setTimeout: timers.setTimeout ?? setTimeout, clearTimeout, console, URL, TextEncoder, TextDecoder, AbortController });
  await new Promise(resolve => setTimeout(resolve, 10));
  let id = 0;
  async function rpc(method: string, params: Record<string, unknown> = {}) {
    const requestId = ++id;
    ports[ports.length - 1].onMessage.emit({ jsonrpc: "2.0", id: requestId, method, params });
    await vi.waitFor(() => expect(responses.find(r => r.id === requestId)).toBeDefined());
    return responses.find(r => r.id === requestId);
  }
  function popup(type: string) {
    return new Promise<any>(resolve => chrome.runtime.onMessage.emit({ type }, {}, resolve));
  }
  return { chrome, get port() { return ports[ports.length - 1]; }, ports, responses, rpc, popup, storage };
}
