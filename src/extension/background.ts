import { Context, Effect, Either, Layer } from "effect";
import { parseJsonRpcMessage, type JsonRpcMessage, type JsonRpcRequest } from "../shared/rpc";
import { parseWithSchema, RuntimeMessageSchema, type CursorState, type NativeHostStatus, type RuntimeMessage } from "../shared/extension-schemas";
import { observePrivateFields, fillPrivateFields } from "./private-input";
import { pageControl, type PageOptions } from "./page-control";

const HOST_NAMES = [
  "com.opzero.chrome",
  "com.opzero.chrome.internal",
  "com.opzero.chrome.dev"
];
const HOST_NAME = "com.opzero.chrome";
const NATIVE_HOST_STATUS_KEY = "NATIVE_HOST_STATUS";
const NATIVE_HOST_PAUSED_KEY = "NATIVE_HOST_PAUSED";
const TAB_GROUPS_KEY = "TAB_GROUPS";
const EXTENSION_INSTANCE_ID_KEY = "extensionInstanceId";
const PENDING_UPDATE_KEY = "opChromePendingUpdateVersion";
const RECONNECT_ALARM = `native-transport-reconnect:${HOST_NAME}`;
const HEARTBEAT_ALARM = "client-heartbeat-alarm";
const DEFAULT_SESSION_TITLE = "Browser Control";
const DELIVERABLE_TITLE = "✅ Browser Control";
const DELIVERABLE_COLOR = "blue";
const SESSION_COLORS = ["grey", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const;
const DEBUGGER_VERSION = "1.3";
const DEFAULT_CDP_TIMEOUT_MS = 10000;
const MESSAGE_TIMEOUT_MS = 1000;
const HEARTBEAT_TIMEOUT_MS = 3000;
const HOST_HANDSHAKE_TIMEOUT_MS = 15000;

type RpcId = number | string | null | undefined;
type JsonRecord = Record<string, unknown>;
type TabOrigin = "agent" | "user";
type RpcErrorWithCode = Error & { code?: number };
type Session = {
  id: string;
  turnId: string;
  tabIds: Set<number>;
  origins: Map<number, TabOrigin>;
  groupId: number | null;
  groupColorIndex: number;
  title: string;
  active: boolean;
  createdAt: number;
};
type TabInfo = {
  id?: number;
  title: string;
  active: boolean;
  url: string;
  windowId?: number;
  index?: number;
  groupId?: number;
  origin: TabOrigin;
};
type CursorWaiter = { resolve: () => void };
type PendingNativeRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type RpcHandler = (params?: JsonRecord) => Effect.Effect<unknown, Error, ChromeApi>;
type ChromeApiService = {
  call: <T = unknown>(namespace: keyof typeof chrome, method: string, ...args: unknown[]) => Effect.Effect<T, Error>;
  storageGet: <T extends Record<string, unknown> = Record<string, unknown>>(keys: string | string[] | Record<string, unknown>) => Effect.Effect<T, Error>;
  storageSet: (value: Record<string, unknown>) => Effect.Effect<void, Error>;
  sessionStorageGet: <T extends Record<string, unknown> = Record<string, unknown>>(keys: string | string[] | Record<string, unknown>) => Effect.Effect<T, Error>;
  safeCall: <T = unknown>(namespace: keyof typeof chrome, method: string, ...args: unknown[]) => Effect.Effect<T | undefined, never>;
};

class ChromeApi extends Context.Tag("opzero/ChromeApi")<ChromeApi, ChromeApiService>() {}

const sessions = new Map<string, Session>();
const tabToSession = new Map<number, string>();
const attachedTabs = new Set<number>();
const commandQueues = new Map<number, Promise<unknown>>();
const cursorStates = new Map<number, CursorState>();
const cursorWaiters = new Map<string, CursorWaiter>();
const tabOrigins = new Map<number, TabOrigin>();
const revokedSessions = new Set<string>();
const tabGenerations = new Map<number, number>();
const privateObservations = new Map<number, { token: string; origin: string; url: string; documentId: string; expires: number; selectors: string[] }>();
const pageOrigins = new Map<number, string>();
const pageOperations = new Map<number, Promise<unknown>>();
const pageSnapshots = new Map<number, { token: string; documentId: string }>();
const pageRecordings = new Set<number>();
const PRIVATE_CAPTURE_KEY = "PRIVATE_CAPTURE_QUARANTINE";
let deliverableGroupId: number | null = null;
let nativeTransport: NativeTransport;

function jsonRpcError(id: RpcId, error: unknown) {
  const rpcError = error as Partial<RpcErrorWithCode> | undefined;
  const message = rpcError?.message || String(error || "Unknown error");
  const code = Number.isInteger(rpcError?.code) ? rpcError?.code as number : -32000;
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function createRpcError(message: string, code = -32000): RpcErrorWithCode {
  const error = new Error(message) as RpcErrorWithCode;
  error.code = code;
  return error;
}

function isNativeHostStatus(value: unknown): value is NativeHostStatus {
  return typeof value === "object"
    && value != null
    && "state" in value
    && typeof value.state === "string";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error || "Unknown error"));
}

function chromeCallback<T = unknown>(namespace: keyof typeof chrome, method: string, ...args: unknown[]): Promise<T> {
  return chromeCallbackFrom<T>(chrome[namespace], method, ...args);
}

function chromeCallbackFrom<T = unknown>(target: unknown, method: string, ...args: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const callable = (target as Record<string, unknown>)[method];
    if (typeof callable !== "function") {
      reject(new Error(`Chrome API method ${method} is not callable`));
      return;
    }
    Reflect.apply(callable, target, [...args, (result: T) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    }]);
  });
}

const ChromeApiLive = Layer.succeed(ChromeApi, {
  call: <T = unknown>(namespace: keyof typeof chrome, method: string, ...args: unknown[]) =>
    Effect.tryPromise({ try: () => chromeCallback<T>(namespace, method, ...args), catch: toError }),
  storageGet: <T extends Record<string, unknown> = Record<string, unknown>>(keys: string | string[] | Record<string, unknown>) =>
    Effect.tryPromise({ try: () => chromeCallbackFrom<T>(chrome.storage.local, "get", keys), catch: toError }),
  storageSet: (value: Record<string, unknown>) =>
    Effect.tryPromise({ try: () => chromeCallbackFrom<void>(chrome.storage.local, "set", value), catch: toError }),
  sessionStorageGet: <T extends Record<string, unknown> = Record<string, unknown>>(keys: string | string[] | Record<string, unknown>) =>
    Effect.tryPromise({ try: () => chromeCallbackFrom<T>(chrome.storage.session, "get", keys), catch: toError }),
  safeCall: <T = unknown>(namespace: keyof typeof chrome, method: string, ...args: unknown[]) =>
    Effect.catchAll(
      Effect.tryPromise({ try: () => chromeCallback<T>(namespace, method, ...args), catch: toError }),
      () => Effect.succeed(undefined)
    )
});

function runChromeEffect<A>(program: Effect.Effect<A, Error, ChromeApi>): Promise<A> {
  return Effect.runPromise(Effect.provide(program, ChromeApiLive));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
}

function normalizeSessionParams(params: JsonRecord = {}) {
  const sessionId = params.session_id || params.sessionId;
  const turnId = params.turn_id || params.turnId;
  if (typeof sessionId !== "string" || !sessionId) {
    throw createRpcError("Missing required browser session_id");
  }
  if (typeof turnId !== "string" || !turnId) {
    throw createRpcError("Missing required browser turn_id");
  }
  return { sessionId, turnId };
}

function ensureSession(params: JsonRecord = {}): Session {
  const { sessionId, turnId } = normalizeSessionParams(params);
  if (revokedSessions.has(sessionId)) throw createRpcError("Session revoked; reconnect requires a new session");
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      id: sessionId,
      turnId,
      tabIds: new Set(),
      origins: new Map(),
      groupId: null,
      groupColorIndex: sessions.size % SESSION_COLORS.length,
      title: DEFAULT_SESSION_TITLE,
      active: true,
      createdAt: Date.now()
    };
    sessions.set(sessionId, session);
  }
  session.turnId = turnId;
  session.active = true;
  return session;
}

function getSessionForTab(tabId: number): Session | null {
  const sessionId = tabToSession.get(tabId);
  if (!sessionId) return null;
  return sessions.get(sessionId) || null;
}

function requireSessionTab(params: JsonRecord = {}) {
  const session = ensureSession(params);
  const target = typeof params.target === "object" && params.target != null ? params.target as JsonRecord : {};
  const tabId = Number(params.tabId ?? target.tabId);
  if (!Number.isInteger(tabId)) throw createRpcError("Missing or invalid tabId");
  if (!session.tabIds.has(tabId)) throw createRpcError(`Tab ${tabId} does not belong to session ${session.id}`);
  return { session, tabId };
}

function isControllableUrl(url = "") {
  if (!url) return true;
  if (url === "about:blank") return true;
  return !/^(chrome|chrome-extension|edge|about|devtools):/i.test(url);
}

function tabInfo(tab?: chrome.tabs.Tab | { id: number } | null): TabInfo | null {
  if (!tab) return null;
  if (tab.id == null) return null;
  const fullTab = tab as chrome.tabs.Tab;
  return {
    id: tab.id,
    title: fullTab.title || "",
    active: Boolean(fullTab.active),
    url: fullTab.url || "",
    windowId: fullTab.windowId,
    index: fullTab.index,
    groupId: fullTab.groupId,
    origin: tabOrigins.get(tab.id) || getSessionForTab(tab.id)?.origins.get(tab.id) || "user"
  };
}

function getExtensionInstanceId() {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const stored = yield* chromeApi.storageGet<Record<string, unknown>>(EXTENSION_INSTANCE_ID_KEY);
    if (typeof stored[EXTENSION_INSTANCE_ID_KEY] === "string") return stored[EXTENSION_INSTANCE_ID_KEY];
    const value = crypto.randomUUID();
    yield* chromeApi.storageSet({ [EXTENSION_INSTANCE_ID_KEY]: value });
    return value;
  });
}

function persistGroupState() {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const sessionGroups: Record<string, number> = {};
    const sessionGroupTitles: Record<string, string> = {};
    for (const session of sessions.values()) {
      if (session.groupId != null) sessionGroups[session.id] = session.groupId;
      sessionGroupTitles[session.id] = session.title;
    }
    yield* chromeApi.storageSet({
      [TAB_GROUPS_KEY]: {
        groups: Array.from(sessions.values()).map((session) => ({
          sessionId: session.id,
          groupId: session.groupId,
          tabIds: Array.from(session.tabIds)
        })),
        sessionGroups,
        sessionGroupTitles,
        deliverableGroupId
      }
    });
  });
}

function ensureSessionGroup(session: Session, tabId: number) {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    if (session.groupId != null) {
      const grouped = yield* Effect.either(Effect.gen(function* () {
        yield* chromeApi.call("tabGroups", "get", session.groupId);
        yield* chromeApi.call("tabs", "group", { groupId: session.groupId, tabIds: [tabId] });
        yield* chromeApi.call("tabGroups", "update", session.groupId, {
          title: session.title || DEFAULT_SESSION_TITLE,
          color: SESSION_COLORS[session.groupColorIndex],
          collapsed: false
        });
        yield* persistGroupState();
        return session.groupId;
      }));
      if (Either.isRight(grouped)) return grouped.right;
      session.groupId = null;
    }

    const groupId = yield* chromeApi.call<number>("tabs", "group", { tabIds: [tabId] });
    session.groupId = groupId;
    yield* chromeApi.call("tabGroups", "update", groupId, {
      title: session.title || DEFAULT_SESSION_TITLE,
      color: SESSION_COLORS[session.groupColorIndex],
      collapsed: false
    });
    yield* persistGroupState();
    return groupId;
  });
}

function ensureDeliverableGroup(tabIds: number[]) {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    if (!tabIds.length) return null;
    if (deliverableGroupId != null) {
      const grouped = yield* Effect.either(Effect.gen(function* () {
        yield* chromeApi.call("tabGroups", "get", deliverableGroupId);
        yield* chromeApi.call("tabs", "group", { groupId: deliverableGroupId, tabIds });
        yield* chromeApi.call("tabGroups", "update", deliverableGroupId, {
          title: DELIVERABLE_TITLE,
          color: DELIVERABLE_COLOR,
          collapsed: false
        });
        yield* persistGroupState();
        return deliverableGroupId;
      }));
      if (Either.isRight(grouped)) return grouped.right;
      deliverableGroupId = null;
    }
    deliverableGroupId = yield* chromeApi.call<number>("tabs", "group", { tabIds });
    yield* chromeApi.call("tabGroups", "update", deliverableGroupId, {
      title: DELIVERABLE_TITLE,
      color: DELIVERABLE_COLOR,
      collapsed: false
    });
    yield* persistGroupState();
    return deliverableGroupId;
  });
}

function registerSessionTab(session: Session, tab: chrome.tabs.Tab | { id: number }, origin: TabOrigin) {
  if (tab.id == null) throw createRpcError("Missing tab id");
  if (sessions.get(session.id) !== session || revokedSessions.has(session.id)) throw createRpcError("Session revoked");
  const owner = tabToSession.get(tab.id);
  if (owner && owner !== session.id) throw createRpcError("Tab already owned");
  session.tabIds.add(tab.id);
  session.origins.set(tab.id, origin);
  tabToSession.set(tab.id, session.id);
  tabOrigins.set(tab.id, origin);
}

function releaseSessionTab(session: Session, tabId: number, ungroup = true) {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    session.tabIds.delete(tabId);
    session.origins.delete(tabId);
    tabToSession.delete(tabId);
    tabOrigins.delete(tabId);
    cursorStates.delete(tabId);
    if (ungroup) yield* chromeApi.safeCall("tabs", "ungroup", tabId);
    yield* detachTab(tabId);
  });
}

function cleanupSessionIfEmpty(session: Session) {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    if (session.tabIds.size > 0) return;
    if (session.groupId != null) yield* chromeApi.safeCall("tabGroups", "update", session.groupId, { collapsed: true });
    sessions.delete(session.id);
    yield* persistGroupState();
  });
}

function findNormalWindow() {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const current = yield* chromeApi.safeCall<chrome.windows.Window>("windows", "getCurrent", { populate: false });
    if (current?.id && current.type === "normal") return current;
    const windows = yield* chromeApi.call<chrome.windows.Window[]>("windows", "getAll", { populate: false, windowTypes: ["normal"] });
    return windows.find((win) => win.focused) || windows[0] || null;
  });
}

class NativeTransport {
  hostName: string;
  port: chrome.runtime.Port | null = null;
  nextId = 1;
  pending = new Map<number, PendingNativeRequest>();
  reconnectAttempt = 0;
  connected = false;
  paused = false;
  handshakeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(hostName: string) {
    this.hostName = hostName;
  }

  start() {
    void this.ensureConnected();
  }

  scheduleAlarms() {
    chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
    chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
  }

  async loadPausedState(): Promise<boolean> {
    const stored = await runChromeEffect(Effect.flatMap(ChromeApi, (chromeApi) =>
      chromeApi.storageGet<Record<string, unknown>>(NATIVE_HOST_PAUSED_KEY)
    ));
    return stored[NATIVE_HOST_PAUSED_KEY] === true;
  }

  async persistPaused(paused: boolean) {
    this.paused = paused;
    await runChromeEffect(Effect.flatMap(ChromeApi, (chromeApi) =>
      chromeApi.storageSet({ [NATIVE_HOST_PAUSED_KEY]: paused })
    ));
  }

  async ensureConnected(): Promise<void> {
    this.paused = await this.loadPausedState();
    if (this.paused) {
      await this.setStatus("paused").catch(() => undefined);
      return;
    }
    this.scheduleAlarms();
    this.connect();
  }

  disconnect(message = "Native host disconnected") {
    this.clearHandshake();
    const port = this.port;
    this.port = null;
    this.connected = false;
    revokeAllSessions();
    if (port) {
      try {
        port.disconnect();
      } catch {
        // The port may already be dead; ignore.
      }
    }
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(message));
    }
    this.pending.clear();
  }

  async reload(): Promise<NativeHostStatus> {
    await this.persistPaused(false);
    this.disconnect("Native host reloaded");
    this.reconnectAttempt = 0;
    this.scheduleAlarms();
    this.connect();
    return this.refreshStatus();
  }

  async pause(): Promise<NativeHostStatus> {
    await this.persistPaused(true);
    this.disconnect("Native host paused");
    await chrome.alarms.clear(RECONNECT_ALARM);
    await chrome.alarms.clear(HEARTBEAT_ALARM);
    await runChromeEffect(stopActiveSessions("Native host paused by user")).catch(() => undefined);
    return this.setStatus("paused");
  }

  async resume(): Promise<NativeHostStatus> {
    await this.persistPaused(false);
    this.reconnectAttempt = 0;
    this.scheduleAlarms();
    this.connect();
    return this.refreshStatus();
  }

  async setStatus(state: string, extra: Partial<NativeHostStatus> = {}) {
    const status: NativeHostStatus = {
      state,
      hostName: this.hostName,
      lastChecked: Date.now(),
      reconnectAttempt: this.reconnectAttempt,
      ...extra
    };
    await runChromeEffect(Effect.gen(function* () {
      const chromeApi = yield* ChromeApi;
      yield* chromeApi.storageSet({ [NATIVE_HOST_STATUS_KEY]: status });
      return status;
    }));
    return status;
  }

  connect() {
    if (this.paused || this.port) return;
    try {
      this.port = chrome.runtime.connectNative(this.hostName);
      this.connected = false;
      this.setStatus("connecting").catch(() => undefined);
      const port = this.port;
      this.clearHandshake();
      this.handshakeTimer = setTimeout(() => {
        if (this.port === port && !this.connected) this.failPort("Native host did not respond");
      }, HOST_HANDSHAKE_TIMEOUT_MS);
      port.onMessage.addListener((message) => {
        if (this.port !== port) return;
        this.markConnected();
        this.onMessage(message);
      });
      port.onDisconnect.addListener(() => { if (this.port === port) this.onDisconnect(); });
    } catch (error) {
      this.connected = false;
      this.port = null;
      this.reconnectAttempt += 1;
      this.setStatus("disconnected", {
        error: error instanceof Error ? error.message : String(error),
        nextRetryMs: 5000
      }).catch(() => undefined);
    }
  }

  // connectNative returns a port even when no host is installed, so only a
  // message from the host proves that it is running.
  markConnected() {
    if (this.connected) return;
    this.clearHandshake();
    this.connected = true;
    this.reconnectAttempt = 0;
    this.setStatus("connected").catch(() => undefined);
  }

  clearHandshake() {
    if (this.handshakeTimer !== undefined) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
  }

  // Drops a port whose host never answered or stopped answering, so the
  // reconnect alarm can start a fresh host instead of waiting forever.
  failPort(message: string) {
    this.disconnect(message);
    if (this.paused) return;
    this.reconnectAttempt += 1;
    this.setStatus("disconnected", { error: message, nextRetryMs: 5000 }).catch(() => undefined);
  }

  onDisconnect() {
    const message = chrome.runtime.lastError?.message || "Native host disconnected";
    this.clearHandshake();
    this.connected = false;
    this.port = null;
    revokeAllSessions();
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(message));
    }
    this.pending.clear();
    if (this.paused) return;
    this.reconnectAttempt += 1;
    this.setStatus("disconnected", { error: message, nextRetryMs: 5000 }).catch(() => undefined);
  }

  onMessage(message: unknown) {
    let rpcMessage: JsonRpcMessage;
    try {
      rpcMessage = parseJsonRpcMessage(message);
    } catch {
      return;
    }
    if (!rpcMessage || rpcMessage.jsonrpc !== "2.0") return;
    if ("id" in rpcMessage && ("result" in rpcMessage || "error" in rpcMessage)) {
      const pending = this.pending.get(Number(rpcMessage.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(Number(rpcMessage.id));
      if (rpcMessage.error) pending.reject(new Error(rpcMessage.error.message || "Native JSON-RPC error"));
      else pending.resolve(rpcMessage.result);
      return;
    }
    if ("method" in rpcMessage) {
      const port = this.port;
      handleJsonRpcRequest(rpcMessage, (response) => { if (port && this.port === port) port.postMessage(response); }).catch(() => undefined);
    }
  }

  post(message: unknown) {
    if (!this.port) throw new Error("Native host is not connected");
    this.port.postMessage(message);
  }

  call(method: string, params: JsonRecord = {}, timeoutMs = 10000) {
    const port = this.port;
    if (!port) return Promise.reject(new Error("Native host is not connected"));
    const id = this.nextId++;
    const request = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      port.postMessage(request);
    });
  }

  notify(method: string, params: JsonRecord = {}) {
    if (!this.port) return;
    this.port.postMessage({ jsonrpc: "2.0", method, params });
  }

  async refreshStatus(): Promise<NativeHostStatus> {
    if (!this.connected && !this.port) {
      this.paused = await this.loadPausedState();
      if (!this.paused) this.connect();
    }
    const hostName = this.hostName;
    const reconnectAttempt = this.reconnectAttempt;
    return runChromeEffect(Effect.gen(function* () {
      const chromeApi = yield* ChromeApi;
      const value = yield* chromeApi.storageGet<Record<string, unknown>>(NATIVE_HOST_STATUS_KEY);
      const storedStatus = value[NATIVE_HOST_STATUS_KEY];
      if (isNativeHostStatus(storedStatus)) return storedStatus;
      return {
        state: "disconnected",
        hostName,
        lastChecked: Date.now(),
        reconnectAttempt
      };
    }));
  }
}

function injectPage(tabId: number, origin: string, operation: "observe" | "act" | "capture-check" | "document-check" | "prepare-submit" | "submit" | "prepare-file" | "validate-file" | "verify-file" | "cancel-file", token = "", actionId = "", text?: string, documentId?: string, options: PageOptions = { selectors: [], controlsOnly: false }) {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const owner = getSessionForTab(tabId);
    if (!owner) throw createRpcError("Page owner revoked");
    const results = yield* chromeApi.call<chrome.scripting.InjectionResult<Record<string, unknown>>[]>("scripting", "executeScript", {
      target: documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [0] },
      world: "ISOLATED", func: pageControl, args: [operation, origin, token, actionId, text ?? null, options]
    });
    const result = results[0];
    if (getSessionForTab(tabId) !== owner || !result?.documentId || result.frameId !== 0) throw createRpcError("Page changed or owner revoked");
    return result;
  });
}

function scopedContext(tabId: number, origin: string, documentId?: string) {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const key = `${PRIVATE_CAPTURE_KEY}:${tabId}`;
    const previous = (yield* chromeApi.storageGet<Record<string, unknown>>(key))[key];
    if (typeof previous === "string") return yield* Effect.fail(createRpcError("private-quarantine"));
    let selectors: string[] = [], quarantinedDocument: string | undefined;
    if (previous != null) {
      if (typeof previous !== "object" || !("documentId" in previous) || typeof previous.documentId !== "string"
        || !("selectors" in previous) || !Array.isArray(previous.selectors) || previous.selectors.length > 256
        || !previous.selectors.every((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 1024)) return yield* Effect.fail(createRpcError("invalid-private-selectors"));
      selectors = previous.selectors; quarantinedDocument = previous.documentId;
    }
    const checked = yield* injectPage(tabId, origin, "document-check", "", "", undefined, documentId);
    if (checked.result?.status !== "checked") return yield* Effect.fail(createRpcError("Page origin not ready or mismatch"));
    if (quarantinedDocument === checked.documentId) return yield* Effect.fail(createRpcError("private-quarantine"));
    return { documentId: checked.documentId, selectors };
  });
}

function assertCapture(tabId: number, origin: string) {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const key = `${PRIVATE_CAPTURE_KEY}:${tabId}`;
    const stored = yield* chromeApi.storageGet<Record<string, { documentId: string; selectors: string[] } | string | null>>(key);
    const previous = stored[key];
    if (typeof previous === "string") throw createRpcError("private-quarantine");
    const checked = yield* injectPage(tabId, origin, "capture-check", "", "", JSON.stringify(previous?.selectors ?? []));
    if (checked.result?.status !== "checked") throw createRpcError("Page origin not ready or mismatch");
    if (previous?.documentId === checked.documentId) throw createRpcError("private-quarantine");
    if (checked.result.allowed !== true) {
      switch (checked.result.reason) {
        case "private-quarantine": case "populated-private-input": case "restored-private-selector": case "invalid-private-selectors":
          throw createRpcError(checked.result.reason);
        default: throw createRpcError("Capture privacy check failed");
      }
    }
    return checked.documentId;
  });
}

const api: Record<string, RpcHandler> = {
  uploadFile: (params: JsonRecord = {}) => Effect.gen(function* () {
    const { tabId } = yield* Effect.try({ try: () => requireSessionTab(params), catch: toError });
    const origin = pageOrigins.get(tabId), snapshot = pageSnapshots.get(tabId);
    pageSnapshots.delete(tabId);
    const valid = typeof params.snapshot === "string" && typeof params.actionId === "string" && typeof params.path === "string" && params.path.startsWith("/") && !params.path.includes("\0")
      && typeof params.name === "string" && params.name.length > 0 && params.name.length <= 255 && !/[\\/\0]/.test(params.name)
      && Number.isInteger(params.size) && (params.size as number) > 0;
    if (!origin || !snapshot || params.snapshot !== snapshot.token || !valid || pageRecordings.has(tabId)) return { status: "not-executed", retry: false };
    const context = yield* Effect.either(scopedContext(tabId, origin, snapshot.documentId));
    if (Either.isLeft(context)) return { status: "not-executed", retry: false };
    const prepared = yield* Effect.either(injectPage(tabId, origin, "prepare-file", snapshot.token, params.actionId as string, undefined,
      context.right.documentId, { selectors: context.right.selectors, controlsOnly: false }));
    if (Either.isLeft(prepared) || prepared.right.result?.status !== "prepared" || typeof prepared.right.result.fileToken !== "string"
      || typeof prepared.right.result.selector !== "string") return { status: "not-executed", retry: false };
    const fileToken = prepared.right.result.fileToken, selector = prepared.right.result.selector;
    const cancel = () => injectPage(tabId, origin, "cancel-file", fileToken, "", undefined, context.right.documentId);
    const root = yield* Effect.either(sendDebuggerCommand<{ root?: { nodeId?: number } }>(tabId, "DOM.getDocument", { depth: 0, pierce: true }));
    if (Either.isLeft(root) || !Number.isInteger(root.right.root?.nodeId)) { yield* Effect.either(cancel()); return { status: "not-executed", retry: false }; }
    const matches = yield* Effect.either(sendDebuggerCommand<{ nodeIds?: number[] }>(tabId, "DOM.querySelectorAll", { nodeId: root.right.root!.nodeId, selector }));
    if (Either.isLeft(matches) || !Array.isArray(matches.right.nodeIds) || matches.right.nodeIds.length !== 1 || !Number.isInteger(matches.right.nodeIds[0])) {
      yield* Effect.either(cancel()); return { status: "not-executed", retry: false };
    }
    const fresh = yield* Effect.either(scopedContext(tabId, origin, context.right.documentId));
    if (Either.isLeft(fresh)) { yield* Effect.either(cancel()); return { status: "not-executed", retry: false }; }
    const validated = yield* Effect.either(injectPage(tabId, origin, "validate-file", fileToken, "", undefined, context.right.documentId,
      { selectors: fresh.right.selectors, controlsOnly: false }));
    if (Either.isLeft(validated) || validated.right.result?.status !== "validated") { yield* Effect.either(cancel()); return { status: "not-executed", retry: false }; }
    const dispatched = yield* Effect.either(sendDebuggerCommand(tabId, "DOM.setFileInputFiles", { nodeId: matches.right.nodeIds[0], files: [params.path] }));
    if (Either.isLeft(dispatched)) { yield* Effect.either(cancel()); return { status: "unknown", retry: false }; }
    const verified = yield* Effect.either(injectPage(tabId, origin, "verify-file", fileToken, "", JSON.stringify({ name: params.name, size: params.size }), context.right.documentId,
      { selectors: fresh.right.selectors, controlsOnly: false }));
    if (Either.isLeft(verified) || verified.right.result?.status !== "attached") { yield* Effect.either(cancel()); return { status: "unknown", retry: false }; }
    return { status: "attached", retry: false };
  }),
  preparePrivateSubmit: (params: JsonRecord = {}) => Effect.gen(function* () {
    const { tabId } = yield* Effect.try({ try: () => requireSessionTab(params), catch: toError });
    const origin = pageOrigins.get(tabId), snapshot = pageSnapshots.get(tabId);
    pageSnapshots.delete(tabId);
    if (!origin || !snapshot || params.snapshot !== snapshot.token || typeof params.actionId !== "string") throw createRpcError("Fresh observed submit action required");
    const context = yield* scopedContext(tabId, origin, snapshot.documentId);
    const result = yield* injectPage(tabId, origin, "prepare-submit", snapshot.token, params.actionId, undefined, context.documentId, { selectors: context.selectors, controlsOnly: false });
    return { ...result.result, documentId: result.documentId };
  }),

  submitPrivate: (params: JsonRecord = {}) => Effect.gen(function* () {
    const { tabId } = yield* Effect.try({ try: () => requireSessionTab(params), catch: toError });
    const origin = pageOrigins.get(tabId);
    if (!origin || typeof params.submitToken !== "string" || typeof params.documentId !== "string" || pageRecordings.has(tabId)) return { status: "not-executed", reason: "invalid-or-recording" };
    const result = yield* Effect.either(injectPage(tabId, origin, "submit", params.submitToken, "", undefined, params.documentId));
    return Either.isRight(result) ? result.right.result : { status: "unknown", retry: false };
  }),
  recordingState: (params: JsonRecord = {}) => Effect.gen(function* () {
    const { tabId } = yield* Effect.try({ try: () => requireSessionTab(params), catch: toError });
    if (params.active === false) { pageRecordings.delete(tabId); return { recording: false }; }
    const origin = pageOrigins.get(tabId);
    if (!origin || params.active !== true || pageRecordings.has(tabId)) throw createRpcError("Recording unavailable or already active");
    yield* assertCapture(tabId, origin);
    pageRecordings.add(tabId);
    return { recording: true };
  }),
  bindPage: (params: JsonRecord = {}) => Effect.gen(function* () {
    const { tabId } = yield* Effect.try({ try: () => requireSessionTab(params), catch: toError });
    const origin = params.expectedOrigin;
    if (typeof origin !== "string" || new URL(origin).origin !== origin || !/^https:\/\//.test(origin) && !(params.allowInsecureLoopback === true && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))) throw createRpcError("Exact HTTPS origin required; loopback needs opt-in");
    if (pageOrigins.has(tabId) && pageOrigins.get(tabId) !== origin) throw createRpcError("Page origin binding is immutable");
    pageOrigins.set(tabId, origin);
    return { bound: true, tabId, origin };
  }),

  navigatePage: (params: JsonRecord = {}) => Effect.gen(function* () {
    const { tabId } = yield* Effect.try({ try: () => requireSessionTab(params), catch: toError });
    const origin = pageOrigins.get(tabId);
    if (!origin || typeof params.url !== "string" || new URL(params.url).origin !== origin) throw createRpcError("Navigation outside bound origin refused");
    pageSnapshots.delete(tabId);
    const result = yield* sendDebuggerCommand<{ errorText?: string }>(tabId, "Page.navigate", { url: params.url });
    if (result.errorText) throw createRpcError("Navigation failed; do not replay");
    return { status: "dispatched", retry: false };
  }),

  observePage: (params: JsonRecord = {}) => Effect.gen(function* () {
    const { tabId } = yield* Effect.try({ try: () => requireSessionTab(params), catch: toError });
    const origin = pageOrigins.get(tabId);
    if (!origin) throw createRpcError("Page has no origin binding");
    pageSnapshots.delete(tabId);
    if (params.controlsOnly !== undefined && typeof params.controlsOnly !== "boolean") throw createRpcError("Invalid observation mode");
    const context = yield* scopedContext(tabId, origin);
    const token = crypto.randomUUID();
    const result = yield* injectPage(tabId, origin, "observe", token, "", undefined, context.documentId, { selectors: context.selectors, controlsOnly: params.controlsOnly === true });
    if (result.result?.status !== "observed") {
      switch (result.result?.reason) {
        case "private-quarantine": case "populated-private-input": case "restored-private-selector": case "invalid-private-selectors": case "unsupported-shadow-root":
          throw createRpcError(result.result.reason);
        default: throw createRpcError("Observation unavailable");
      }
    }
    if (result.result?.status === "observed" && result.documentId) pageSnapshots.set(tabId, { token, documentId: result.documentId });
    return result.result;
  }),

  actPage: (params: JsonRecord = {}) => Effect.gen(function* () {
    const { tabId } = yield* Effect.try({ try: () => requireSessionTab(params), catch: toError });
    const origin = pageOrigins.get(tabId), snapshot = pageSnapshots.get(tabId);
    pageSnapshots.delete(tabId);
    if (!origin || !snapshot || params.snapshot !== snapshot.token || typeof params.actionId !== "string" || params.text !== undefined && typeof params.text !== "string") return { status: "not-executed", reason: "stale-or-invalid" };
    const context = yield* Effect.either(scopedContext(tabId, origin, snapshot.documentId));
    if (Either.isLeft(context)) return { status: "not-executed", reason: "privacy-or-document-changed", retry: false };
    const result = yield* Effect.either(injectPage(tabId, origin, "act", snapshot.token, params.actionId, params.text, context.right.documentId, { selectors: context.right.selectors, controlsOnly: false }));
    return Either.isRight(result) ? result.right.result : { status: "unknown", retry: false };
  }),

  capturePage: (params: JsonRecord = {}) => Effect.gen(function* () {
    const { tabId } = yield* Effect.try({ try: () => requireSessionTab(params), catch: toError });
    const origin = pageOrigins.get(tabId);
    if (!origin) throw createRpcError("Page has no origin binding");
    const documentId = yield* assertCapture(tabId, origin);
    const result = yield* sendDebuggerCommand(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 80 });
    if ((yield* assertCapture(tabId, origin)) !== documentId) throw createRpcError("Document changed during capture; image discarded");
    return result;
  }),
  ping: () => Effect.succeed("pong"),

  getInfo: () => Effect.gen(function* () {
    return {
    name: chrome.runtime.getManifest().name,
    version: chrome.runtime.getManifest().version,
    protocolVersion: 2,
    pageProtocolVersion: 2,
    type: "extension",
    metadata: {
      extensionId: chrome.runtime.id,
      extensionInstanceId: yield* getExtensionInstanceId(),
      supportedHostNames: HOST_NAMES
    }
    };
  }),

  getTabs: (params: JsonRecord = {}) => Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const session = yield* Effect.try({ try: () => ensureSession(params), catch: toError });
    const tabIds = Array.from(session.tabIds);
    const tabs = yield* Effect.all(tabIds.map((id) => chromeApi.safeCall<chrome.tabs.Tab>("tabs", "get", id)));
    return tabs.flatMap((tab) => {
      const info = tabInfo(tab);
      return info ? [info] : [];
    });
  }),

  getUserTabs: (params: JsonRecord = {}) => Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    yield* Effect.try({ try: () => ensureSession(params), catch: toError });
    const tabs = yield* chromeApi.call<chrome.tabs.Tab[]>("tabs", "query", {});
    return tabs.flatMap((tab) => {
      if (tab.id == null || !isControllableUrl(tab.url) || tabToSession.has(tab.id)) return [];
      const info = tabInfo(tab);
      return info ? [info] : [];
    });
  }),

  createTab: (params: JsonRecord = {}) => Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const session = yield* Effect.try({ try: () => ensureSession(params), catch: toError });
    const win = yield* findNormalWindow();
    if (!win?.id) return yield* Effect.fail(createRpcError("No normal window; background creation will not open a window"));
    const tab = yield* chromeApi.call<chrome.tabs.Tab>("tabs", "create", { windowId: win.id, url: "about:blank", active: false });
    if (!tab?.id) return yield* Effect.fail(createRpcError("Failed to create tab"));
    yield* Effect.try({ try: () => registerSessionTab(session, tab, "agent"), catch: toError });
    yield* ensureSessionGroup(session, tab.id);
    yield* persistGroupState();
    return tabInfo(yield* chromeApi.call<chrome.tabs.Tab>("tabs", "get", tab.id));
  }),

  claimUserTab: (params: JsonRecord = {}) => Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const session = yield* Effect.try({ try: () => ensureSession(params), catch: toError });
    const tabId = Number(params.tabId);
    if (!Number.isInteger(tabId)) return yield* Effect.fail(createRpcError("Missing or invalid tabId"));
    const tab = yield* chromeApi.call<chrome.tabs.Tab>("tabs", "get", tabId);
    if (!isControllableUrl(tab.url)) return yield* Effect.fail(createRpcError(`Cannot claim Chrome internal tab: ${tab.url || ""}`));
    const owner = tabToSession.get(tabId);
    if (owner && owner !== session.id) return yield* Effect.fail(createRpcError(`Tab ${tabId} already belongs to another session`));
    yield* Effect.try({ try: () => registerSessionTab(session, tab, "user"), catch: toError });
    yield* ensureSessionGroup(session, tabId);
    yield* persistGroupState();
    return tabInfo(yield* chromeApi.call<chrome.tabs.Tab>("tabs", "get", tabId));
  }),

  finalizeTabs: (params: JsonRecord = {}) => Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const session = yield* Effect.try({ try: () => ensureSession(params), catch: toError });
    const keep = Array.isArray(params.keep) ? params.keep : [];
    const seen = new Set<number>();
    const deliverable: number[] = [];
    const handoff: number[] = [];
    for (const rawItem of keep) {
      const item = typeof rawItem === "object" && rawItem != null ? rawItem as JsonRecord : {};
      const tabId = Number(item?.tabId);
      const status = item.status;
      if (!Number.isInteger(tabId)) return yield* Effect.fail(createRpcError("Invalid keep tabId"));
      if (seen.has(tabId)) return yield* Effect.fail(createRpcError(`Duplicate keep tabId ${tabId}`));
      if (!session.tabIds.has(tabId)) return yield* Effect.fail(createRpcError(`Unknown keep tabId ${tabId}`));
      if (status !== "handoff" && status !== "deliverable") return yield* Effect.fail(createRpcError(`Invalid keep status ${String(status)}`));
      seen.add(tabId);
      if (status === "deliverable") deliverable.push(tabId);
      else handoff.push(tabId);
    }

    for (const tabId of Array.from(session.tabIds)) {
      if (seen.has(tabId)) continue;
      const origin = session.origins.get(tabId) || "user";
      yield* detachTab(tabId);
      if (origin === "agent") yield* chromeApi.safeCall("tabs", "remove", tabId);
      else yield* releaseSessionTab(session, tabId, true);
    }

    if (deliverable.length) {
      yield* ensureDeliverableGroup(deliverable);
      for (const tabId of deliverable) yield* releaseSessionTab(session, tabId, false);
    }

    for (const tabId of handoff) yield* detachTab(tabId);
    yield* cleanupSessionIfEmpty(session);
    yield* maybeApplyPendingUpdate();
    return { kept: keep, closedOrReleased: true };
  }),

  nameSession: (params: JsonRecord = {}) => Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const session = yield* Effect.try({ try: () => ensureSession(params), catch: toError });
    const name = String(params.name || DEFAULT_SESSION_TITLE).slice(0, 80);
    const nextTitle = name || DEFAULT_SESSION_TITLE;
    const confirmed = session.groupId != null;
    if (session.groupId != null) {
      yield* chromeApi.call("tabGroups", "update", session.groupId, { title: nextTitle, collapsed: false });
      const group = yield* chromeApi.call<chrome.tabGroups.TabGroup>("tabGroups", "get", session.groupId);
      if (group.title !== nextTitle) throw createRpcError("Session group title confirmation failed");
    }
    session.title = nextTitle;
    yield* persistGroupState();
    return { name: session.title, confirmed };
  }),

  attach: (params: JsonRecord = {}) => Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const { session, tabId } = yield* Effect.try({ try: () => requireSessionTab(params), catch: toError });
    const generation = tabGenerations.get(tabId) || 0;
    if (attachedTabs.has(tabId)) return { attached: true };
    const attached = yield* Effect.either(chromeApi.call("debugger", "attach", { tabId }, DEBUGGER_VERSION));
    if (Either.isLeft(attached)) return yield* Effect.fail(attached.left);
    if (getSessionForTab(tabId) !== session || generation !== (tabGenerations.get(tabId) || 0)) {
      yield* chromeApi.safeCall("debugger", "detach", { tabId });
      return yield* Effect.fail(createRpcError("Session revoked during attach"));
    }
    attachedTabs.add(tabId);
    return { attached: true };
  }),

  detach: (params: JsonRecord = {}) => Effect.gen(function* () {
    const { tabId } = yield* Effect.try({ try: () => requireSessionTab(params), catch: toError });
    yield* detachTab(tabId);
    return { detached: true };
  }),

  executeCdp: (params: JsonRecord = {}) => Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const { session, tabId } = yield* Effect.try({ try: () => requireSessionTab(params), catch: toError });
    const method = String(params.method || "");
    if (!method) return yield* Effect.fail(createRpcError("Missing CDP method"));
    if (pageOrigins.has(tabId)) throw createRpcError("Raw CDP disabled for origin-bound pages; use typed page methods");
    const quarantine = yield* chromeApi.storageGet<Record<string, string | null>>(`${PRIVATE_CAPTURE_KEY}:${tabId}`);
    if (quarantine[`${PRIVATE_CAPTURE_KEY}:${tabId}`]) throw createRpcError("Raw CDP disabled for a privately filled tab; bind and verify a new document first");
    if (method === "Target.getTargets") {
      const targets = yield* chromeApi.call<chrome.debugger.TargetInfo[]>("debugger", "getTargets");
      return { targetInfos: targets.filter(target => target.tabId != null && session.tabIds.has(target.tabId)) };
    }
    if (/^(Target|Browser)\./.test(method)) return yield* Effect.fail(createRpcError("Cross-target CDP methods are not supported"));
    if (!attachedTabs.has(tabId)) return yield* Effect.fail(createRpcError(`Tab ${tabId} is not attached`));
    const commandParams: JsonRecord = typeof params.commandParams === "object" && params.commandParams != null
      ? params.commandParams as JsonRecord
      : {};
    const requestedTimeoutMs = Number(params.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0 ? requestedTimeoutMs : DEFAULT_CDP_TIMEOUT_MS;
    return yield* sendDebuggerCommand(tabId, method, commandParams, timeoutMs);
  }),

  observeDocument: (params: JsonRecord = {}) => Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const { session, tabId } = yield* Effect.try({ try: () => requireSessionTab(params), catch: toError });
    const generation = tabGenerations.get(tabId) || 0;
    privateObservations.delete(tabId);
    const origin = params.expectedOrigin;
    const expectedUrl = params.expectedUrl;
    const selectors = params.selectors;
    if (pageOrigins.has(tabId) && pageOrigins.get(tabId) !== origin) throw createRpcError("Private fill origin differs from bound page origin");
    if (typeof origin !== "string" || !/^https?:\/\//.test(origin) || new URL(origin).origin !== origin
      || !Array.isArray(selectors) || !selectors.length || selectors.length > 16
      || !selectors.every((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024)) {
      return yield* Effect.fail(createRpcError("Invalid private observation request"));
    }
    const parsedOrigin = new URL(origin);
    if (expectedUrl !== undefined && (typeof expectedUrl !== "string" || expectedUrl.length > 16384)) {
      return yield* Effect.fail(createRpcError("Invalid private observation URL"));
    }
    if (typeof expectedUrl === "string") {
      const parsedUrl = yield* Effect.try({ try: () => new URL(expectedUrl), catch: () => createRpcError("Invalid private observation URL") });
      if (parsedUrl.href !== expectedUrl || parsedUrl.origin !== origin) {
        return yield* Effect.fail(createRpcError("Private observation URL differs from expected origin"));
      }
    }
    const allowInsecureLoopback = params.allowInsecureLoopback === true;
    if (parsedOrigin.protocol !== "https:" && !(allowInsecureLoopback && ["127.0.0.1", "localhost", "[::1]"].includes(parsedOrigin.hostname))) {
      return yield* Effect.fail(createRpcError("Private input requires HTTPS; loopback HTTP requires explicit opt-in"));
    }
    const token = crypto.randomUUID();
    const results = yield* chromeApi.call<chrome.scripting.InjectionResult<{ status: string; origin?: string; url?: string }>[]>("scripting", "executeScript", {
      target: { tabId, frameIds: [0] }, world: "ISOLATED", func: observePrivateFields, args: [origin, selectors, token, allowInsecureLoopback, expectedUrl]
    });
    const observed = results[0];
    if (!observed?.documentId || observed.result?.status !== "observed" || observed.result.origin !== origin
      || typeof observed.result.url !== "string" || (expectedUrl !== undefined && observed.result.url !== expectedUrl)
      || new URL(observed.result.url).origin !== origin
      || getSessionForTab(tabId) !== session || generation !== (tabGenerations.get(tabId) || 0)) {
      return yield* Effect.fail(createRpcError("Private observation refused"));
    }
    const url = observed.result.url;
    privateObservations.set(tabId, { token, origin, url, documentId: observed.documentId, expires: Date.now() + 30000, selectors });
    return { token, origin, url, documentId: observed.documentId, expiresInMs: 30000 };
  }),

  privateFill: (params: JsonRecord = {}) => Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const { tabId, session } = yield* Effect.try({ try: () => requireSessionTab(params), catch: toError });
    if (pageRecordings.has(tabId)) return { status: "refused", retry: false };
    if (!pageOrigins.has(tabId)) return { status: "refused", retry: false };
    const observed = privateObservations.get(tabId);
    privateObservations.delete(tabId);
    const values = params.values;
    if (!observed || pageOrigins.get(tabId) !== observed.origin || params.token !== observed.token || params.documentId !== observed.documentId
      || params.expectedOrigin !== observed.origin || observed.expires < Date.now()
      || !Array.isArray(values) || !values.length || values.length > 16
      || !values.every((value): value is string => typeof value === "string" && value.length <= 16384)) {
      return { status: "refused", retry: false };
    }
    const key = `${PRIVATE_CAPTURE_KEY}:${tabId}`;
    const previous = (yield* chromeApi.storageGet<Record<string, { selectors: string[] } | string | null>>(key))[key];
    if (typeof previous === "string") return { status: "refused", retry: false };
    const selectors = [...new Set([...(previous?.selectors ?? []), ...observed.selectors])];
    if (selectors.length > 256) return { status: "refused", retry: false };
    yield* chromeApi.storageSet({ [key]: { documentId: observed.documentId, selectors } });
    if (getSessionForTab(tabId) !== session) return { status: "refused", retry: false };
    const outcome = yield* Effect.either(chromeApi.call<chrome.scripting.InjectionResult<{ status: string }>[]>("scripting", "executeScript", {
      target: { tabId, documentIds: [observed.documentId] }, world: "ISOLATED", func: fillPrivateFields,
      args: [observed.origin, observed.token, values]
    }));
    return { status: Either.isRight(outcome) && outcome.right[0]?.result?.status === "filled" ? "filled" : "unknown", retry: false };
  }),

  moveMouse: (params: JsonRecord = {}) => Effect.gen(function* () {
    const { session, tabId } = yield* Effect.try({ try: () => requireSessionTab(params), catch: toError });
    const x = Number(params.x);
    const y = Number(params.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return yield* Effect.fail(createRpcError("Missing or invalid cursor coordinates"));
    const previous = cursorStates.get(tabId)?.cursor;
    const moveSequence = (previous?.moveSequence || 0) + 1;
    const state: CursorState = {
      cursor: {
        visible: true,
        x,
        y,
        animateMovement: params.animateMovement !== false,
        moveSequence
      },
      isVisible: true,
      sessionId: session.id,
      turnId: session.turnId
    };
    cursorStates.set(tabId, state);
    const contentScriptDelivery = yield* Effect.either(Effect.gen(function* () {
      yield* ensureContentScript(tabId);
      const arrival = params.waitForArrival ? waitForCursorArrival(tabId, session.id, session.turnId, moveSequence) : null;
      yield* sendTabMessage(tabId, { type: "AGENT_CURSOR_STATE", state });
      if (arrival) yield* Effect.tryPromise({ try: () => arrival, catch: toError });
    }));

    if (Either.isRight(contentScriptDelivery)) {
      return { arrived: Boolean(params.waitForArrival), moveSequence, transport: "content-script" };
    }
    if (!attachedTabs.has(tabId)) return yield* Effect.fail(contentScriptDelivery.left);
    yield* renderCursorWithCdp(tabId, state);
    return { arrived: Boolean(params.waitForArrival), moveSequence, transport: "cdp" };
  }),

  turnEnded: (params: JsonRecord = {}) => Effect.gen(function* () {
    const session = yield* Effect.try({ try: () => ensureSession(params), catch: toError });
    for (const tabId of session.tabIds) {
      const current = cursorStates.get(tabId);
      if (!current) continue;
      const state = { ...current, cursor: null, isVisible: false };
      cursorStates.set(tabId, state);
      runChromeEffect(Effect.gen(function* () {
        const delivered = yield* Effect.either(sendTabMessage(tabId, { type: "AGENT_CURSOR_STATE", state }));
        if (Either.isLeft(delivered) && attachedTabs.has(tabId)) yield* renderCursorWithCdp(tabId, state);
      })).catch(() => undefined);
    }
    session.active = false;
    yield* maybeApplyPendingUpdate();
    return { ok: true };
  }),

  executeUnhandledCommand: (params: JsonRecord = {}) =>
    Effect.fail(createRpcError(`Unsupported browser command: ${params.command || params.method || "unknown"}`))
};

async function handleJsonRpcRequest(message: JsonRpcRequest, respond: (response: unknown) => void) {
  const { id, method, params } = message;
  if (method === "internal.releaseClient") {
    if (typeof params === "object" && params !== null && "session_id" in params && typeof params.session_id === "string") revokeSession(params.session_id);
    return;
  }
  if (!method || typeof method !== "string") {
    if (id != null) respond(jsonRpcError(id, createRpcError("Invalid JSON-RPC method", -32600)));
    return;
  }
  const fn = Object.hasOwn(api, method) ? api[method] : api.executeUnhandledCommand;
  try {
    const run = () => runChromeEffect(Effect.gen(function* () {
      const rpcParams = typeof params === "object" && params != null ? params as JsonRecord : {};
      return yield* fn(rpcParams);
    }));
    const rpcParams = typeof params === "object" && params != null ? params as JsonRecord : {};
    const targetParams = typeof rpcParams.target === "object" && rpcParams.target != null ? rpcParams.target as JsonRecord : {};
    const tabId = Number(rpcParams.tabId ?? targetParams.tabId);
    const serialized = ["uploadFile", "preparePrivateSubmit", "submitPrivate", "recordingState", "bindPage", "navigatePage", "observePage", "actPage", "capturePage", "observeDocument", "privateFill", "executeCdp"].includes(method) && Number.isInteger(tabId);
    let result: unknown;
    if (serialized) {
      const previous = pageOperations.get(tabId) || Promise.resolve();
      const generation = tabGenerations.get(tabId) || 0;
      const next = previous.catch(() => undefined).then(() => {
        if (generation !== (tabGenerations.get(tabId) || 0)) throw createRpcError("Stale queued page operation; not dispatched");
        return run();
      });
      pageOperations.set(tabId, next);
      try { result = await next; } finally { if (pageOperations.get(tabId) === next) pageOperations.delete(tabId); }
    } else result = await run();
    if (id != null) respond({ jsonrpc: "2.0", id, result });
  } catch (error) {
    if (id != null) respond(jsonRpcError(id, method === "privateFill" ? createRpcError("Private input refused or outcome unknown; do not replay") : error));
  }
}

function enqueueCdp(tabId: number, task: () => Promise<unknown>) {
  const previous = commandQueues.get(tabId) || Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const settled = next.then(() => undefined, () => undefined);
  commandQueues.set(tabId, settled);
  void settled.then(() => { if (commandQueues.get(tabId) === settled) commandQueues.delete(tabId); });
  return next;
}

function sendDebuggerCommand<T = unknown>(
  tabId: number,
  method: string,
  commandParams: JsonRecord = {},
  timeoutMs = DEFAULT_CDP_TIMEOUT_MS
) {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const generation = tabGenerations.get(tabId) || 0;
    const owner = tabToSession.get(tabId);
    return yield* Effect.tryPromise({
      try: async () => await enqueueCdp(tabId, () => {
        if (!attachedTabs.has(tabId) || !owner || tabToSession.get(tabId) !== owner || (tabGenerations.get(tabId) || 0) !== generation) {
          throw createRpcError("Stale command; not replayed");
        }
        return withTimeout(
        Effect.runPromise(chromeApi.call<T>("debugger", "sendCommand", { tabId }, method, commandParams)),
        timeoutMs,
        `CDP command ${method}`
      ).catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (/timed out/i.test(message)) await runChromeEffect(detachTab(tabId));
        throw error;
      }); }) as T,
      catch: toError
    });
  });
}

function renderCursorWithCdp(tabId: number, state: CursorState | null) {
  const stateJson = JSON.stringify(state).replace(/</g, "\\u003c");
  const expression = `
(() => {
  const state = ${stateJson};
  const rootId = "opzero-chrome-cdp-cursor-root";
  const existing = document.getElementById(rootId);
  if (!state || !state.cursor || state.isVisible === false || state.cursor.visible === false) {
    existing?.remove();
    return { ok: true, visible: false };
  }

  const mount = document.documentElement || document.body;
  if (!mount) return { ok: false, reason: "missing document root" };

  let root = existing;
  if (!root) {
    root = document.createElement("div");
    root.id = rootId;
    Object.assign(root.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "2147483647",
      contain: "layout style paint"
    });
    const cursor = document.createElement("div");
    cursor.dataset.opzeroCursor = "true";
    Object.assign(cursor.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "22px",
      height: "22px",
      background: "#111827",
      border: "2px solid #fff",
      clipPath: "polygon(0 0, 0 100%, 35% 72%, 55% 100%, 75% 88%, 55% 61%, 100% 60%)",
      filter: "drop-shadow(0 3px 8px rgba(0,0,0,.28))",
      pointerEvents: "none",
      willChange: "transform, opacity",
      transition: "opacity 120ms linear"
    });
    root.appendChild(cursor);
    mount.appendChild(root);
  }

  const cursor = root.querySelector("[data-opzero-cursor='true']");
  if (!cursor) return { ok: false, reason: "missing cursor" };
  const viewport = window.visualViewport;
  const width = viewport?.width || window.innerWidth || document.documentElement.clientWidth || 1;
  const height = viewport?.height || window.innerHeight || document.documentElement.clientHeight || 1;
  const x = Math.max(0, Math.min(width - 1, Number(state.cursor.x) || 0));
  const y = Math.max(0, Math.min(height - 1, Number(state.cursor.y) || 0));
  cursor.style.opacity = "1";
  cursor.style.transform = "translate3d(" + Math.round(x) + "px, " + Math.round(y) + "px, 0)";
  return { ok: true, visible: true, x, y, moveSequence: state.cursor.moveSequence };
})()
`;
  return sendDebuggerCommand(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: false
  }, 2000);
}

function detachTab(tabId: number) {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    attachedTabs.delete(tabId);
    invalidateTab(tabId);
    yield* chromeApi.safeCall("debugger", "detach", { tabId });
  });
}

function sendTabMessage(tabId: number, message: RuntimeMessage) {
  return Effect.tryPromise({
    try: () => withTimeout(
      runChromeEffect(Effect.flatMap(ChromeApi, (api) => api.call("tabs", "sendMessage", tabId, message))),
      MESSAGE_TIMEOUT_MS,
      `Message ${message.type}`
    ),
    catch: toError
  });
}

function ensureContentScript(tabId: number) {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const ping = yield* Effect.either(sendTabMessage(tabId, { type: "CONTENT_PING" }));
    if (Either.isRight(ping)) return;
    const session = getSessionForTab(tabId);
    if (!session) return yield* Effect.fail(createRpcError(`Cannot inject content script into untracked tab ${tabId}`));
    yield* chromeApi.call("scripting", "executeScript", {
      target: { tabId },
      files: ["content-scripts/opzero-chrome.js"],
      injectImmediately: true
    });
    yield* sendTabMessage(tabId, { type: "CONTENT_PING" });
  });
}

function waitForCursorArrival(tabId: number, sessionId: string, turnId: string, sequence: number): Promise<void> {
  const key = `${tabId}:${sessionId}:${turnId}:${sequence}`;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cursorWaiters.delete(key);
      reject(new Error("Cursor arrival timed out"));
    }, 2000);
    cursorWaiters.set(key, {
      resolve: () => {
        clearTimeout(timer);
        cursorWaiters.delete(key);
        resolve();
      }
    });
  });
}

function stopActiveSessions(reason: string) {
  return Effect.gen(function* () {
    revokeAllSessions();
    nativeTransport?.notify("onControlStopped", { reason });
  });
}

function maybeApplyPendingUpdate() {
  return Effect.gen(function* () {
    const active = Array.from(sessions.values()).some((session) => session.active);
    if (active) return;
    const stored = yield* Effect.catchAll(
      Effect.flatMap(ChromeApi, (api) => api.sessionStorageGet(PENDING_UPDATE_KEY)),
      () => Effect.succeed({} as Record<string, unknown>)
    );
    if (stored[PENDING_UPDATE_KEY]) chrome.runtime.reload();
  });
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  (async () => {
    const parsedMessage = parseWithSchema(RuntimeMessageSchema, message);
    if (!parsedMessage) {
      sendResponse({ ok: false, error: "Unknown message type" });
      return;
    }
    if (parsedMessage.type === "GET_NATIVE_HOST_STATUS") {
      const status = await nativeTransport.refreshStatus();
      sendResponse({ ok: status.state === "connected", status, error: status.error || null });
      return;
    }
    if (parsedMessage.type === "RELOAD_NATIVE_HOST") {
      const status = await nativeTransport.reload();
      sendResponse({ ok: status.state === "connected", status, error: status.error || null });
      return;
    }
    if (parsedMessage.type === "PAUSE_NATIVE_HOST") {
      const status = await nativeTransport.pause();
      sendResponse({ ok: true, status, error: status.error || null });
      return;
    }
    if (parsedMessage.type === "RESUME_NATIVE_HOST") {
      const status = await nativeTransport.resume();
      sendResponse({ ok: status.state === "connected", status, error: status.error || null });
      return;
    }
    if (parsedMessage.type === "GET_AGENT_CURSOR_STATE") {
      const tabId = sender.tab?.id;
      sendResponse({ ok: true, state: tabId == null ? null : cursorStates.get(tabId) || null });
      return;
    }
    if (parsedMessage.type === "AGENT_CURSOR_ARRIVED") {
      const tabId = sender.tab?.id;
      const { sessionId, turnId, moveSequence } = parsedMessage;
      if (Number.isInteger(tabId) && typeof sessionId === "string" && typeof turnId === "string" && Number.isInteger(moveSequence)) {
        cursorWaiters.get(`${tabId}:${sessionId}:${turnId}:${moveSequence}`)?.resolve();
      }
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: "Unknown message type" });
  })().catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const session = source.tabId == null ? null : getSessionForTab(source.tabId);
  if (session) nativeTransport?.notify("onCDPEvent", { session_id: session.id, source, method, params: params || {} });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const session = source.tabId == null ? null : getSessionForTab(source.tabId);
  if (source.tabId != null && Number.isInteger(source.tabId)) { attachedTabs.delete(source.tabId); invalidateTab(source.tabId); }
  if (session) nativeTransport?.notify("onCDPDetach", { session_id: session.id, source, reason });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  invalidateTab(tabId);
  const session = getSessionForTab(tabId);
  if (session) {
    session.tabIds.delete(tabId);
    session.origins.delete(tabId);
  }
  tabToSession.delete(tabId);
  tabOrigins.delete(tabId);
  cursorStates.delete(tabId);
  attachedTabs.delete(tabId);
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  const session = getSessionForTab(removedTabId);
  if (!session) return;
  const origin = session.origins.get(removedTabId) || "user";
  session.tabIds.delete(removedTabId);
  session.origins.delete(removedTabId);
  tabToSession.delete(removedTabId);
  tabOrigins.delete(removedTabId);
  attachedTabs.delete(removedTabId);
  invalidateTab(removedTabId);
  try { registerSessionTab(session, { id: addedTabId }, origin); }
  catch { revokeSession(session.id); }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.url) invalidateTab(tabId);
});

function invalidateTab(tabId: number) {
  tabGenerations.set(tabId, (tabGenerations.get(tabId) || 0) + 1);
    privateObservations.delete(tabId);
    pageSnapshots.delete(tabId);
}

function revokeSession(sessionId: string) {
  revokedSessions.add(sessionId);
  if (revokedSessions.size > 4096) {
    const oldest = revokedSessions.values().next().value;
    if (oldest !== undefined) revokedSessions.delete(oldest);
  }
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  for (const tabId of session.tabIds) {
    tabToSession.delete(tabId);
    pageOrigins.delete(tabId);
    pageRecordings.delete(tabId);
    tabOrigins.delete(tabId);
    cursorStates.delete(tabId);
    invalidateTab(tabId);
    void runChromeEffect(detachTab(tabId)).catch(() => undefined);
  }
  void runChromeEffect(persistGroupState()).catch(() => undefined);
}

function revokeAllSessions() {
  for (const id of sessions.keys()) revokeSession(id);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && !nativeTransport?.connected && !nativeTransport?.paused) nativeTransport.connect();
  if (alarm.name === HEARTBEAT_ALARM && nativeTransport?.connected) {
    const transport = nativeTransport;
    const port = transport.port;
    withTimeout(transport.call("ping", {}, HEARTBEAT_TIMEOUT_MS), HEARTBEAT_TIMEOUT_MS, "Native heartbeat")
      .catch(async (error) => {
        if (transport.port !== port) return;
        const message = error instanceof Error ? error.message : String(error);
        await runChromeEffect(stopActiveSessions(message)).catch(() => undefined);
        if (transport.port === port) transport.failPort(message);
      });
  }
});

chrome.runtime.onUpdateAvailable.addListener((details) => {
  const active = Array.from(sessions.values()).some((session) => session.active);
  if (!active) chrome.runtime.reload();
  else chrome.storage.session.set({ [PENDING_UPDATE_KEY]: details.version });
});

chrome.runtime.onStartup.addListener(() => {
  void nativeTransport?.ensureConnected();
});

chrome.runtime.onInstalled.addListener(() => {
  void nativeTransport?.ensureConnected();
});

nativeTransport = new NativeTransport(HOST_NAME);
nativeTransport.start();
