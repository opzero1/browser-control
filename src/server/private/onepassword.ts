// Private, fail-closed credential reads from an already-open 1Password window (onepassword.py).
//
// The public API is readField(expectedEmail, field). It returns the copied field only to its caller and
// otherwise throws VaultError with a static code. Importing this module does not start Cua Driver, load the
// MCP client or inspect the desktop.
//
// Python's asyncio cancellation becomes an AbortSignal: every Cua call and poll sleep rejects with the
// signal's reason as soon as it aborts, which is where Python delivered CancelledError. Values from the
// accessibility tree are compared with Python's str(), ==, hashing and truthiness, so malformed rows fail the
// same way they did there.
import { randomBytes } from "node:crypto";
import type { PackageAssets } from "../assets";
import { statePaths, type Env } from "../config";
import { openDirectory, type PrivateDir } from "../fs-private";
import { isGate } from "../gate";
import { lockNow, type HeldLock } from "../lock";
import type { JsonObject } from "../pyjson";
import { pyFloatRepr } from "../pyjson";
import { casefold, pyIsAlnum, pyIsAscii, pyIsSpace, pyLen, pyStrip } from "../pystr";
import { clipboardGuardBinary } from "../stable-copy";
import { monotonic, sleep } from "../time";
import { ClipboardError, withPreservedClipboard } from "./clipboard-guard";

/** Module constants that tests shorten, as the Python tests monkeypatched them. Seconds. */
export const VAULT_TIMING = { timeoutSeconds: 60, searchWaitSeconds: 2, searchPollSeconds: 0.05, selectionWaitSeconds: 5 };
const LOCK_NAME = "onepassword.lock";
const LOCK_POLL_SECONDS = 0.05;
const COPY_POLLS = 20;
const COPY_POLL_SECONDS = 0.05;

export type VaultField = "username" | "password" | "one-time password";
const FIELDS: ReadonlySet<string> = new Set<VaultField>(["username", "password", "one-time password"]);

export const ERROR_CODES: ReadonlySet<string> = new Set([
  "account-ambiguous",
  "account-mismatch",
  "account-not-found",
  "action-unconfirmed",
  "clipboard-restore-failed",
  "clipboard-unavailable",
  "deadline-exceeded",
  "field-ambiguous",
  "field-not-found",
  "invalid-email",
  "observation-unavailable",
  "operation-failed",
  "search-not-empty",
  "secret-invalid",
  "transport-unavailable",
  "unsupported-field",
  "vault-ambiguous",
  "vault-busy",
  "vault-locked",
  "vault-not-running",
  "window-ambiguous"
]);

/** A credential operation failure with no private or upstream text. Unknown codes become operation-failed. */
export class VaultError extends Error {
  readonly code: string;

  constructor(code: string) {
    const fixed = ERROR_CODES.has(code) ? code : "operation-failed";
    super(fixed);
    this.code = fixed;
    this.name = "VaultError";
  }
}

export interface CuaCaller { call(name: string, args: JsonObject, options?: { deadline?: number }): Promise<Record<string, unknown>> }
export interface CuaSession { cua: CuaCaller; close(): Promise<void> }
export type ClipboardGuard = <T>(body: () => Promise<T>, options?: { binary?: string; signal?: AbortSignal }) => Promise<T>;
export interface VaultDeps { openCua(deadline: number, signal: AbortSignal): Promise<CuaSession>; lockDir: PrivateDir; clipboard: ClipboardGuard }
export type ReadField = (email: string, field: VaultField, options?: { allow_foreground_search: true }) => Promise<string>;

type Row = Record<string, unknown>;
type Candidates = Map<string, Row>;

function fail(code: string): never {
  throw new VaultError(code);
}

// Python value semantics for accessibility payloads.

function isDict(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** dict.get(key, fallback): the fallback only for a missing key; a JSON null is None. */
function get(row: Row, key: string, fallback: unknown = null): unknown {
  return Object.prototype.hasOwnProperty.call(row, key) ? row[key] : fallback;
}

function isNone(value: unknown): boolean {
  return value === null || value === undefined;
}

/** type(value) is int */
function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function truthy(value: unknown): boolean {
  if (isNone(value) || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return true;
}

function quote(text: string): string {
  const mark = text.includes("'") && !text.includes("\"") ? "\"" : "'";
  let result = mark;
  for (const character of text) {
    const point = character.codePointAt(0) as number;
    if (character === mark || character === "\\") result += `\\${character}`;
    else if (character === "\n") result += "\\n";
    else if (character === "\r") result += "\\r";
    else if (character === "\t") result += "\\t";
    else if (character !== " " && /^[\p{C}\p{Z}]$/u.test(character)) {
      result += point <= 0xff ? `\\x${point.toString(16).padStart(2, "0")}`
        : point <= 0xffff ? `\\u${point.toString(16).padStart(4, "0")}` : `\\U${point.toString(16).padStart(8, "0")}`;
    } else result += character;
  }
  return result + mark;
}

function repr(value: unknown): string {
  if (isNone(value)) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return Number.isInteger(value) ? BigInt(value).toString() : pyFloatRepr(value);
  if (typeof value === "string") return quote(value);
  if (Array.isArray(value)) return `[${value.map(repr).join(", ")}]`;
  if (isDict(value)) return `{${Object.entries(value).map(([key, item]) => `${quote(key)}: ${repr(item)}`).join(", ")}}`;
  return String(value);
}

/** str(value) for a JSON value. Containers print as Python reprs, so they never equal a plain label. */
function str(value: unknown): string {
  return typeof value === "string" ? value : repr(value);
}

/** A dict key with Python's hash equality (1 == 1.0 == True); a list or dict is unhashable. */
function key(value: unknown): string {
  if (isNone(value)) return "none";
  if (typeof value === "boolean") return `n:${value ? 1 : 0}`;
  if (typeof value === "number") return `n:${value === 0 ? 0 : value}`;
  if (typeof value === "string") return `s:${value}`;
  throw new TypeError("unhashable type");
}

/** Python == for JSON values. */
function equal(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => equal(item, b[index]));
  }
  if (isDict(a) || isDict(b)) {
    if (!isDict(a) || !isDict(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((name) => Object.prototype.hasOwnProperty.call(b, name) && equal(a[name], b[name]));
  }
  return key(a) === key(b);
}

/** The items of set(value or []): a string yields its characters and a dict its keys; other scalars are not iterable. */
function setItems(value: unknown): unknown[] {
  if (!truthy(value)) return [];
  let items: unknown[];
  if (Array.isArray(value)) items = value;
  else if (typeof value === "string") items = [...value];
  else if (isDict(value)) items = Object.keys(value);
  else throw new TypeError("not iterable");
  for (const item of items) key(item);
  return items;
}

/** {element.get(name): element for element in elements}: later rows win. */
function indexBy(elements: readonly Row[], name: string): Map<string, Row> {
  const result = new Map<string, Row>();
  for (const element of elements) result.set(key(get(element, name)), element);
  return result;
}

function roleOf(element: Row): string {
  return casefold(str(get(element, "role", "")).replaceAll(" ", ""));
}

function labelOf(element: Row): string {
  return casefold(pyStrip(str(get(element, "label", ""))));
}

function isPopup(element: Row): boolean {
  const role = casefold(str(get(element, "role", "")));
  return role.includes("popup") || role.includes("pop up");
}

// Cancellation: every call and sleep of one read observes the read's signal.

const GUARDED = new WeakMap<CuaCaller, { raw: CuaCaller; signal: AbortSignal }>();

function guarded(raw: CuaCaller, signal: AbortSignal | undefined): CuaCaller {
  if (!signal) return raw;
  const cua: CuaCaller = {
    call(name, args, options) {
      if (signal.aborted) return Promise.reject(signal.reason);
      let pending: Promise<Record<string, unknown>>;
      try {
        pending = raw.call(name, args, options);
      } catch (error) {
        pending = Promise.reject(error);
      }
      return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        pending.then(
          (value) => { signal.removeEventListener("abort", abort); resolve(value); },
          (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); }
        );
      });
    }
  };
  GUARDED.set(cua, { raw, signal });
  return cua;
}

async function pause(cua: CuaCaller, seconds: number): Promise<void> {
  const signal = GUARDED.get(cua)?.signal;
  await sleep(seconds * 1000, signal);
  if (signal?.aborted) throw signal.reason;
}

function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted && error === signal.reason;
}

// onepassword.py, function by function.

function validate(expectedEmail: unknown, field: unknown): void {
  if (typeof field !== "string" || !FIELDS.has(field)) fail("unsupported-field");
  if (
    typeof expectedEmail !== "string"
    || !(pyLen(expectedEmail) >= 3 && pyLen(expectedEmail) <= 320)
    || !expectedEmail.includes("@")
    || [...expectedEmail].some((character) => (character.codePointAt(0) as number) < 33 || character.codePointAt(0) === 127)
  ) fail("invalid-email");
}

async function exclusiveLock(dir: PrivateDir, deadline: number): Promise<HeldLock> {
  while (true) {
    try {
      return lockNow(dir, LOCK_NAME, true);
    } catch (error) {
      if (!isGate(error, "browser-controller-pinned")) throw error;
    }
    if (monotonic() >= deadline) fail("vault-busy");
    await sleep(LOCK_POLL_SECONDS * 1000);
  }
}

/**
 * _mcp_client: open the private Cua connection, run the body, then close it. A body error is kept apart from
 * the transport and thrown after the connection closes; an open or close failure is transport-unavailable.
 */
export async function usingCua<T>(deps: Pick<VaultDeps, "openCua">, deadline: number, signal: AbortSignal, body: (cua: CuaCaller) => Promise<T>): Promise<T> {
  let session: CuaSession;
  try {
    session = await deps.openCua(deadline, signal);
  } catch (error) {
    if (error instanceof VaultError) throw error;
    fail("transport-unavailable");
  }
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await body(session.cua) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    await session.close();
  } catch {
    fail("transport-unavailable");
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function rows(payload: Row, name: string): Row[] {
  const found = get(payload, name);
  if (!Array.isArray(found) || !found.every(isDict)) fail("observation-unavailable");
  return found as Row[];
}

/** The one on-screen window on the current space. */
export function mainWindow(windows: readonly Row[]): number {
  const visible = windows.filter((window) => isInt(get(window, "window_id"))
    && get(window, "is_on_screen") === true && get(window, "on_current_space") === true);
  if (visible.length !== 1) fail("window-ambiguous");
  return visible[0].window_id as number;
}

async function snapshot(cua: CuaCaller, pid: number, windowId: number): Promise<[string, Row[]]> {
  const payload = await cua.call("get_window_state", { pid, window_id: windowId, include_screenshot: false });
  const snapshotId = get(payload, "snapshot_id");
  const elements = get(payload, "elements");
  if (typeof snapshotId !== "string" || !Array.isArray(elements)) fail("observation-unavailable");
  if (!elements.every(isDict)) fail("observation-unavailable");
  return [snapshotId, elements as Row[]];
}

async function screenshotSnapshot(cua: CuaCaller, pid: number, windowId: number): Promise<[Row, Row[]]> {
  const payload = await cua.call("get_window_state", { pid, window_id: windowId, include_screenshot: true });
  const elements = get(payload, "elements");
  if (typeof get(payload, "snapshot_id") !== "string" || !Array.isArray(elements)) fail("observation-unavailable");
  if (!elements.every(isDict)) fail("observation-unavailable");
  return [payload, elements as Row[]];
}

function text(element: Row): string {
  return pyStrip([get(element, "label"), get(element, "value")].filter((value) => typeof value === "string").join(" "));
}

function token(element: Row): string {
  const found = get(element, "element_token");
  if (typeof found !== "string" || !found) fail("observation-unavailable");
  return found;
}

function isLocked(elements: readonly Row[]): boolean {
  const phrases = ["unlock 1password", "enter your account password", "vault is locked"];
  return elements.some((element) => casefold(pyStrip(text(element))) === "unlock"
    || phrases.some((phrase) => casefold(text(element)).includes(phrase)));
}

function searchField(elements: readonly Row[]): Row | null {
  const byIndex = indexBy(elements, "element_index");
  const found = elements.filter((element) => {
    if (!["axtextfield", "axsearchfield"].includes(roleOf(element))) return false;
    if (casefold(str(get(element, "label", ""))).includes("search")) return true;
    const parent = byIndex.get(key(get(element, "parent_index")));
    return (parent ? get(parent, "role") : null) === "AXToolbar";
  });
  if (found.length > 1) fail("account-ambiguous");
  return found[0] ?? null;
}

function equalsPublicValue(element: Row, expected: string): boolean {
  const folded = casefold(expected);
  return [get(element, "label"), get(element, "value")].some((value) => typeof value === "string" && casefold(pyStrip(value)) === folded);
}

/** label[index] on code points; out of range is Python's IndexError. */
function at(points: readonly string[], index: number): string {
  if (index < 0 || index >= points.length) throw new RangeError("string index out of range");
  return points[index];
}

/** A menu result whose label holds the email as a whole word followed by more text; never "Show all". */
export function menuResultMatches(element: Row, expectedEmail: string): boolean {
  const role = roleOf(element);
  const label = pyStrip(str(get(element, "label", "")));
  if (role !== "axmenuitem" || casefold(label).includes("show all matching items")) return false;
  const foldedLabel = casefold(label);
  const found = foldedLabel.indexOf(casefold(expectedEmail));
  // str.find counts code points in the folded label; Python then indexes the unfolded label with it.
  const position = found < 0 ? -1 : pyLen(foldedLabel.slice(0, found));
  const points = [...label];
  if (position < 0 || (position > 0 && !pyIsSpace(at(points, position - 1)))) return false;
  const suffix = points.slice(position + pyLen(expectedEmail));
  return suffix.length > 0 && pyIsSpace(suffix[0]) && pyStrip(suffix.join("")) !== "";
}

function pressable(actions: unknown): boolean {
  if (!Array.isArray(actions)) return false;
  for (const action of actions) key(action);
  return actions.some((action) => typeof action === "string" && ["AXPress", "AXPick", "AXConfirm"].includes(action));
}

/** The unique pressable ancestor of each row that shows the account, excluding the search field and "Show all". */
export function accountCandidates(elements: readonly Row[], expectedEmail: string): Candidates {
  const byIndex = indexBy(elements, "element_index");
  const search = searchField(elements);
  const searchIndex = search !== null ? get(search, "element_index") : null;
  const candidates: Candidates = new Map();
  for (const element of elements) {
    if (equal(get(element, "element_index"), searchIndex)) continue;
    if (!(equalsPublicValue(element, expectedEmail) || menuResultMatches(element, expectedEmail))) continue;
    let current: Row | undefined = element;
    // Python walked parents without a bound; a cyclic tree is a malformed observation here.
    const visited = new Set<Row>();
    while (current !== undefined && isDict(current)) {
      if (visited.has(current)) fail("observation-unavailable");
      visited.add(current);
      if (casefold(str(get(current, "label", ""))).includes("show all matching items")) break;
      if (pressable(get(current, "actions"))) {
        const role = roleOf(current);
        if (role.includes("webarea") || role.includes("window")) break;
        try {
          candidates.set(token(current), current);
        } catch (error) {
          if (!(error instanceof VaultError)) throw error;
        }
        break;
      }
      current = byIndex.get(key(get(current, "parent_index")));
    }
  }
  if (candidates.size > 1) fail("account-ambiguous");
  return candidates;
}

/** Poll until the selected detail matches or one result appears; a transient duplicate may settle first. */
export async function pollAccountResult(cua: CuaCaller, pid: number, windowId: number, expectedEmail: string, deadline: number): Promise<[Row[], Candidates]> {
  while (true) {
    const [, latest] = await snapshot(cua, pid, windowId);
    if (selectedUsernameMatches(latest, expectedEmail)) return [latest, new Map()];
    let candidates: Candidates;
    try {
      candidates = accountCandidates(latest, expectedEmail);
    } catch (error) {
      if (!(error instanceof VaultError) || error.code !== "account-ambiguous" || monotonic() >= deadline) throw error;
      candidates = new Map();
    }
    if (candidates.size || monotonic() >= deadline) return [latest, candidates];
    await pause(cua, Math.min(VAULT_TIMING.searchPollSeconds, Math.max(0, deadline - monotonic())));
  }
}

async function pollSelectedDetail(cua: CuaCaller, pid: number, windowId: number, expectedEmail: string, deadline: number): Promise<Row[] | null> {
  while (true) {
    const [, elements] = await snapshot(cua, pid, windowId);
    if (selectedUsernameMatches(elements, expectedEmail)) return elements;
    if (monotonic() >= deadline) return null;
    await pause(cua, Math.min(VAULT_TIMING.searchPollSeconds, Math.max(0, deadline - monotonic())));
  }
}

function pixelCenter(payload: Row, element: Row): [number, number] {
  const frame = get(element, "frame");
  const bounds = get(payload, "window_bounds");
  if (!isDict(frame) || !isDict(bounds)) fail("observation-unavailable");
  const values = [get(frame, "x"), get(frame, "y"), get(frame, "w"), get(frame, "h"), get(bounds, "x"), get(bounds, "y"),
    get(bounds, "width"), get(bounds, "height"), get(payload, "screenshot_width"), get(payload, "screenshot_height")];
  if (!values.every((value) => typeof value === "number")) fail("observation-unavailable");
  const [frameX, frameY, frameWidth, frameHeight, windowX, windowY, windowWidth, windowHeight, width, height] = values as number[];
  if (frameWidth <= 0 || frameHeight <= 0 || windowWidth <= 0 || windowHeight <= 0 || width <= 0 || height <= 0) fail("observation-unavailable");
  const x = (frameX - windowX + frameWidth / 2) * width / windowWidth;
  const y = (frameY - windowY + frameHeight / 2) * height / windowHeight;
  if (!(x >= 0 && x <= width && y >= 0 && y <= height)) fail("observation-unavailable");
  return [x, y];
}

function searchIsEmpty(search: Row): boolean {
  const value = get(search, "value");
  if (isNone(value) || value === "") return true;
  return typeof value === "string" && value === get(search, "label")
    && (casefold(value) === "search" || casefold(value).startsWith("search "));
}

function activeApp(apps: readonly Row[]): Row & { pid: number } {
  const active = apps.filter((app) => get(app, "active") === true && isInt(get(app, "pid")));
  if (active.length !== 1) fail("action-unconfirmed");
  return active[0] as Row & { pid: number };
}

/** The frontmost ordinary window, ignoring open, go-to, panel, sheet and dialog windows. */
export function ordinaryWindow(windows: readonly Row[]): number {
  const isChildPanel = (window: Row) => {
    const title = casefold(pyStrip(str(get(window, "title", ""))));
    const normalizedTitle = [...title].filter(pyIsAlnum).join("");
    const windowKind = ["role", "subrole"].map((name) => casefold(str(get(window, name, "")))).join(" ");
    return title === "open" || title.startsWith("open ") || title === "go to" || title.startsWith("go to ")
      || normalizedTitle === "gotowindow" || ["panel", "sheet", "dialog"].some((kind) => windowKind.includes(kind));
  };
  const ordinary = windows.filter((window) => isInt(get(window, "window_id")) && get(window, "is_on_screen") === true
    && get(window, "on_current_space") === true && !isChildPanel(window));
  if (!ordinary.length || ordinary.some((window) => !isInt(get(window, "z_index")))) fail("action-unconfirmed");
  const highest = Math.max(...ordinary.map((window) => window.z_index as number));
  const frontmost = ordinary.filter((window) => window.z_index === highest);
  if (frontmost.length !== 1) fail("action-unconfirmed");
  return frontmost[0].window_id as number;
}

/**
 * Bring the vault's exact window to the front for the body, then try to restore the prior app's frontmost
 * ordinary window. The restore runs even after a cancellation, as Python's finally did; it is best-effort.
 */
async function foregroundVault<T>(cua: CuaCaller, pid: number, windowId: number, body: () => Promise<T>): Promise<T> {
  const raw = GUARDED.get(cua)?.raw ?? cua;
  const prior = activeApp(rows(await cua.call("list_apps", {}), "apps"));
  const priorPid = prior.pid;
  let priorWindowId: number | null = null;
  if (priorPid !== pid) {
    const priorWindows = rows(await cua.call("list_windows", { pid: priorPid }), "windows");
    priorWindowId = ordinaryWindow(priorWindows);
  }
  try {
    const focused = await cua.call("bring_to_front", { pid, window_id: windowId });
    const exactEffect = get(focused, "exact_window_effect");
    if (!isDict(exactEffect) || get(exactEffect, "verified") !== true) fail("action-unconfirmed");
    if (activeApp(rows(await cua.call("list_apps", {}), "apps")).pid !== pid) fail("action-unconfirmed");
    return await body();
  } finally {
    if (priorWindowId !== null) {
      try {
        await raw.call("bring_to_front", { pid: priorPid, window_id: priorWindowId });
      } catch {
        try {
          await raw.call("bring_to_front", { pid: priorPid });
        } catch {
          // Focus restoration is best-effort.
        }
      }
    }
  }
}

/** The explicitly permitted foreground search: clear the query, type the email, press return, then select. */
export async function clearAndSearchAccount(cua: CuaCaller, pid: number, windowId: number, expectedEmail: string): Promise<[Row[], Candidates]> {
  return foregroundVault(cua, pid, windowId, async (): Promise<[Row[], Candidates]> => {
    let [payload, elements] = await screenshotSnapshot(cua, pid, windowId);
    let search = searchField(elements);
    if (search === null) fail("account-not-found");
    const [x, y] = pixelCenter(payload, search);
    await cua.call("hotkey", { pid, window_id: windowId, x, y, keys: ["cmd", "a"], delivery_mode: "foreground" });
    [payload, elements] = await screenshotSnapshot(cua, pid, windowId);
    search = searchField(elements);
    if (search === null) fail("action-unconfirmed");
    await cua.call("press_key", { pid, window_id: windowId, key: "backspace", delivery_mode: "foreground" });
    [payload, elements] = await screenshotSnapshot(cua, pid, windowId);
    search = searchField(elements);
    if (search === null || !searchIsEmpty(search)) fail("action-unconfirmed");
    await cua.call("type_text", { pid, window_id: windowId, text: expectedEmail, delivery_mode: "foreground" });
    [payload, elements] = await screenshotSnapshot(cua, pid, windowId);
    search = searchField(elements);
    if (search === null || casefold(str(get(search, "value", ""))) !== casefold(expectedEmail)) fail("action-unconfirmed");
    await cua.call("press_key", { pid, window_id: windowId, key: "return", delivery_mode: "foreground" });
    let selected = await pollSelectedDetail(cua, pid, windowId, expectedEmail, monotonic() + VAULT_TIMING.selectionWaitSeconds);
    if (selected === null) {
      const [latest, candidates] = await pollAccountResult(cua, pid, windowId, expectedEmail, monotonic() + VAULT_TIMING.searchWaitSeconds);
      if (selectedUsernameMatches(latest, expectedEmail)) return [latest, new Map()];
      if (candidates.size === 1) {
        await cua.call("click", { pid, window_id: windowId, element_token: [...candidates.keys()][0], delivery_mode: "foreground" });
        selected = await pollSelectedDetail(cua, pid, windowId, expectedEmail, monotonic() + VAULT_TIMING.selectionWaitSeconds);
      }
    }
    if (selected === null) fail("action-unconfirmed");
    return [selected, new Map()];
  });
}

/** Select the expected Login: in the background first, and in the foreground only when explicitly allowed. */
export async function prepareAccount(cua: CuaCaller, pid: number, windowId: number, expectedEmail: string, elements: Row[], options: { allowForegroundSearch?: boolean } = {}): Promise<Row[]> {
  const allowForegroundSearch = options.allowForegroundSearch ?? false;
  if (selectedUsernameMatches(elements, expectedEmail)) return elements;
  let candidates = accountCandidates(elements, expectedEmail);
  if (!candidates.size) {
    let search = searchField(elements);
    if (search === null) fail("account-not-found");
    if (get(search, "value") !== expectedEmail) {
      await cua.call("set_value", { pid, window_id: windowId, element_token: token(search), value: expectedEmail });
      await cua.call("verify_state", {
        pid,
        window_id: windowId,
        expect: [{ element: { selector: { role: str(get(search, "role", "AXTextField")) }, value_equals: expectedEmail } }],
        include_screenshot: false,
        stable_samples: 1,
        timeout_ms: 1000
      });
    }
    const pollDeadline = monotonic() + VAULT_TIMING.searchWaitSeconds;
    let backgroundDeadline = pollDeadline;
    if (allowForegroundSearch) backgroundDeadline = Math.min(backgroundDeadline, monotonic() + VAULT_TIMING.searchWaitSeconds / 4);
    [elements, candidates] = await pollAccountResult(cua, pid, windowId, expectedEmail, backgroundDeadline);
    if (selectedUsernameMatches(elements, expectedEmail)) return elements;
    if (!candidates.size) {
      if (!allowForegroundSearch) fail("account-not-found");
      [, elements] = await snapshot(cua, pid, windowId);
      candidates = accountCandidates(elements, expectedEmail);
      if (!candidates.size) {
        search = searchField(elements);
        if (search === null) fail("account-not-found");
        [elements] = await clearAndSearchAccount(cua, pid, windowId, expectedEmail);
        return elements;
      }
    }
  }
  await cua.call("click", { pid, window_id: windowId, element_token: [...candidates.keys()][0], delivery_mode: "background" });
  const selectionDeadline = monotonic() + VAULT_TIMING.selectionWaitSeconds;
  const backgroundDeadline = Math.min(selectionDeadline, monotonic() + VAULT_TIMING.selectionWaitSeconds / 10);
  const selected = await pollSelectedDetail(cua, pid, windowId, expectedEmail, backgroundDeadline);
  if (selected !== null) return selected;
  if (!allowForegroundSearch) fail("action-unconfirmed");
  const [found] = await clearAndSearchAccount(cua, pid, windowId, expectedEmail);
  return found;
}

function groupedCopyControl(elements: readonly Row[], field: string): [Row, unknown] | null {
  const byIndex = indexBy(elements, "element_index");
  const byParent = new Map<string, Row[]>();
  for (const element of elements) {
    const parent = key(get(element, "parent_index"));
    const siblings = byParent.get(parent) ?? [];
    siblings.push(element);
    byParent.set(parent, siblings);
  }
  const wanted = `${field}. more actions`;
  const popups = elements.filter((element) => isPopup(element) && labelOf(element) === wanted && !isNone(get(element, "parent_index")));
  if (!popups.length) return null;
  if (popups.length !== 1) fail("field-ambiguous");
  const rowIndex = get(popups[0], "parent_index");
  const row = byIndex.get(key(rowIndex));
  if (row === undefined || !casefold(str(get(row, "role", ""))).includes("group")) return null;
  if (labelOf(row) !== field || isNone(get(row, "parent_index"))) fail("field-ambiguous");
  const siblings = byParent.get(key(rowIndex)) ?? [];
  const copies = siblings.filter((element) => casefold(str(get(element, "role", ""))).includes("button") && labelOf(element) === "copy");
  if (copies.length !== 1) fail("field-ambiguous");
  token(copies[0]);
  return [copies[0], get(row, "parent_index")];
}

function flatCopyControl(elements: readonly Row[], field: string): [Row, unknown] {
  const starts: [number, Row][] = [];
  const ends: [number, Row][] = [];
  const wantedMenu = `${field}. more actions`;
  elements.forEach((element, position) => {
    if (roleOf(element).includes("statictext") && labelOf(element) === field && !isNone(get(element, "parent_index"))) starts.push([position, element]);
  });
  elements.forEach((element, position) => {
    if (isPopup(element) && labelOf(element) === wantedMenu && !isNone(get(element, "parent_index"))) ends.push([position, element]);
  });
  if (!starts.length || !ends.length) fail("field-not-found");
  if (starts.length !== 1 || ends.length !== 1) fail("field-ambiguous");
  const [startPosition, start] = starts[0];
  const [endPosition, end] = ends[0];
  const parent = get(start, "parent_index");
  if (!equal(parent, get(end, "parent_index")) || startPosition >= endPosition) fail("field-ambiguous");
  const copies: Row[] = [];
  for (const element of elements.slice(startPosition + 1, endPosition)) {
    if (!equal(get(element, "parent_index"), parent)) fail("field-ambiguous");
    const role = roleOf(element);
    const label = labelOf(element);
    if ((role.includes("statictext") && FIELDS.has(label)) || (role.includes("popup") && label.endsWith(". more actions"))) fail("field-ambiguous");
    const isCopy = role.includes("button") && label === "copy";
    const passive = role === "axstatictext" || role === "aximage";
    if (!isCopy && (!passive || setItems(get(element, "actions")).some((action) => !(typeof action === "string"
      && (action === "AXShowMenu" || action === "AXScrollToVisible"))))) fail("field-ambiguous");
    if (isCopy) copies.push(element);
  }
  if (copies.length !== 1) fail("field-ambiguous");
  token(copies[0]);
  return [copies[0], parent];
}

function copyControl(elements: readonly Row[], field: string): [Row, unknown, "grouped" | "flat"] {
  const grouped = groupedCopyControl(elements, field);
  if (grouped !== null) return [grouped[0], grouped[1], "grouped"];
  const [control, parent] = flatCopyControl(elements, field);
  return [control, parent, "flat"];
}

/** The username copy control and the requested field's, from one detail region of one projection. */
export function detailControls(elements: readonly Row[], field: string): [Row, Row] {
  const [username, usernameParent, usernameMode] = copyControl(elements, "username");
  if (field === "username") return [username, username];
  const [requested, requestedParent, requestedMode] = copyControl(elements, field);
  if (usernameMode !== requestedMode || !equal(usernameParent, requestedParent)) fail("field-ambiguous");
  return [username, requested];
}

/** The selected item's username region shows the expected email exactly once. */
export function selectedUsernameMatches(elements: readonly Row[], expectedEmail: string): boolean {
  let control: Row;
  let mode: "grouped" | "flat";
  try {
    [control, , mode] = copyControl(elements, "username");
  } catch (error) {
    if (error instanceof VaultError) return false;
    throw error;
  }
  let region: readonly Row[];
  if (mode === "grouped") {
    const rowIndex = get(control, "parent_index");
    region = elements.filter((element) => equal(get(element, "parent_index"), rowIndex));
  } else {
    const start: number[] = [];
    const end: number[] = [];
    elements.forEach((element, position) => {
      if (roleOf(element).includes("statictext") && labelOf(element) === "username") start.push(position);
      if (labelOf(element) === "username. more actions") end.push(position);
    });
    if (start.length !== 1 || end.length !== 1 || start[0] >= end[0]) return false;
    region = elements.slice(start[0] + 1, end[0]);
  }
  return region.filter((element) => equalsPublicValue(element, expectedEmail)).length === 1;
}

async function clipboard(cua: CuaCaller): Promise<[string[], string]> {
  const payload = await cua.call("clipboard_read", { include_text: true });
  const types = get(payload, "types");
  const value = get(payload, "text");
  if (!Array.isArray(types) || !types.every((item) => typeof item === "string")) fail("clipboard-unavailable");
  if (typeof value !== "string") fail("clipboard-unavailable");
  return [types as string[], value];
}

async function writeAndVerify(cua: CuaCaller, value: string): Promise<string[]> {
  await cua.call("clipboard_write", { text: value });
  const [types, actual] = await clipboard(cua);
  if (actual !== value) fail("clipboard-unavailable");
  return types;
}

async function armClipboard(cua: CuaCaller): Promise<string> {
  const sentinel = `op-private-${randomBytes(16).toString("hex")}`;
  await writeAndVerify(cua, sentinel);
  return sentinel;
}

async function copyControlValue(cua: CuaCaller, pid: number, windowId: number, control: Row, sentinel: string): Promise<string> {
  await cua.call("click", { pid, window_id: windowId, element_token: token(control), delivery_mode: "background" });
  for (let poll = 0; poll < COPY_POLLS; poll += 1) {
    const [, value] = await clipboard(cua);
    if (value !== sentinel) return value;
    await pause(cua, COPY_POLL_SECONDS);
  }
  fail("action-unconfirmed");
}

export interface ReadOptions { allowForegroundSearch?: boolean; signal?: AbortSignal; clipboard?: ClipboardGuard }

/**
 * _read_with: find the one running vault and its window, select the expected Login, then copy inside the
 * clipboard guard: the username, the field, and the username again, each against a fresh sentinel.
 */
export async function readWith(raw: CuaCaller, expectedEmail: string, field: VaultField, options: ReadOptions = {}): Promise<string> {
  const { signal } = options;
  const guard = options.clipboard ?? withPreservedClipboard;
  const cua = guarded(raw, signal);
  const apps = rows(await cua.call("list_apps", {}), "apps");
  const matches = apps.filter((app) => get(app, "running") === true
    && (casefold(str(get(app, "bundle_id", ""))) === "com.1password.1password" || casefold(str(get(app, "name", ""))) === "1password")
    && isInt(get(app, "pid")) && (app.pid as number) > 0);
  if (!matches.length) fail("vault-not-running");
  if (matches.length !== 1) fail("vault-ambiguous");
  const pid = matches[0].pid as number;
  const windows = rows(await cua.call("list_windows", { pid }), "windows");
  const windowId = mainWindow(windows);
  let [, elements] = await snapshot(cua, pid, windowId);
  if (isLocked(elements)) fail("vault-locked");
  elements = await prepareAccount(cua, pid, windowId, expectedEmail, elements, { allowForegroundSearch: options.allowForegroundSearch });
  if (isLocked(elements)) fail("vault-locked");

  try {
    return await guard(async () => {
      let sentinel = await armClipboard(cua);
      const [, detail] = await snapshot(cua, pid, windowId);
      const [usernameControl, requestedControl] = detailControls(detail, field);
      const username = await copyControlValue(cua, pid, windowId, usernameControl, sentinel);
      if (casefold(username) !== casefold(expectedEmail)) fail("account-mismatch");
      let value: string;
      if (field === "username") {
        value = username;
      } else {
        sentinel = await armClipboard(cua);
        value = await copyControlValue(cua, pid, windowId, requestedControl, sentinel);
        sentinel = await armClipboard(cua);
        const [, recheckDetail] = await snapshot(cua, pid, windowId);
        const [recheckUsername] = detailControls(recheckDetail, field);
        const rechecked = await copyControlValue(cua, pid, windowId, recheckUsername, sentinel);
        if (casefold(rechecked) !== casefold(expectedEmail)) fail("account-mismatch");
      }
      if (!value) fail("secret-invalid");
      if (field === "one-time password" && (pyLen(value) !== 6 || !pyIsAscii(value) || !/^[0-9]*$/.test(value))) fail("secret-invalid");
      return value;
    }, { signal });
  } catch (error) {
    if (error instanceof ClipboardError) throw new VaultError(error.code);
    if (error instanceof VaultError || isCancellation(error, signal)) throw error;
    fail("operation-failed");
  }
}

/**
 * asyncio.wait_for for a read: at the deadline abort the read, wait for it to settle (the clipboard guard
 * restores first), then fail with deadline-exceeded. A different error the read ends with is kept.
 */
export async function withDeadline<T>(seconds: number, body: (signal: AbortSignal) => Promise<T>, controller = new AbortController()): Promise<T> {
  let expired = false;
  const reason = new Error("deadline");
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(reason);
  }, seconds * 1000);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await body(controller.signal) };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
  if (!outcome.ok) {
    if (outcome.error === reason || (controller.signal.aborted && outcome.error === controller.signal.reason)) fail("deadline-exceeded");
    throw outcome.error;
  }
  if (expired) fail("deadline-exceeded");
  return outcome.value;
}

async function run(expectedEmail: string, field: VaultField, deadline: number, allowForegroundSearch: boolean, deps: VaultDeps): Promise<string> {
  const controller = new AbortController();
  try {
    return await usingCua(deps, deadline, controller.signal, (cua) => withDeadline(
      Math.max(0.01, deadline - monotonic()),
      (signal) => readWith(cua, expectedEmail, field, { allowForegroundSearch, signal, clipboard: deps.clipboard }),
      controller
    ));
  } catch (error) {
    if (error instanceof VaultError) throw error;
    fail("operation-failed");
  }
}

/**
 * The production dependencies under the state root: the bounded lock at <state>/locks/onepassword.lock, a
 * private cua-driver MCP connection per read (resolved by CUA_DRIVER, PATH, then ~/.local/bin), and the
 * clipboard guard at <state>/bin/clipboard-guard-<sha12> (D16).
 */
export function vaultDeps(env: Env = process.env, assets?: PackageAssets): VaultDeps {
  return {
    lockDir: openDirectory(statePaths(env).locks),
    // Loaded on first use, like Python's delayed MCP import: importing this module starts nothing.
    openCua: async (deadline, signal) => (await import("./cua-mcp")).openCuaMcp(deadline, signal, env),
    clipboard: async (body, options = {}) => {
      let binary: string;
      try {
        binary = options.binary ?? clipboardGuardBinary(env, assets);
      } catch {
        throw new ClipboardError("clipboard-unavailable");
      }
      return withPreservedClipboard(body, { ...options, binary });
    }
  };
}

/**
 * read_field: return one field from the uniquely matched, already-unlocked Login item. `field` is username,
 * password or one-time password. The caller must keep the returned value in private process memory. Reads
 * are serialized across processes by the vault lock, bounded by the same 60 s deadline as the read.
 */
export async function readField(expectedEmail: string, field: VaultField, options: { allow_foreground_search?: boolean; deps?: VaultDeps; env?: Env } = {}): Promise<string> {
  validate(expectedEmail, field);
  const allowForegroundSearch: unknown = options.allow_foreground_search === undefined ? false : options.allow_foreground_search;
  if (typeof allowForegroundSearch !== "boolean") fail("operation-failed");
  const deadline = monotonic() + VAULT_TIMING.timeoutSeconds;
  const deps = options.deps ?? vaultDeps(options.env);
  const lock = await exclusiveLock(deps.lockDir, deadline);
  try {
    return await run(expectedEmail, field, deadline, allowForegroundSearch, deps);
  } catch (error) {
    if (error instanceof VaultError) throw error;
    fail("operation-failed");
  } finally {
    lock.release();
  }
}

/** A ReadField for the server, reading its dependencies from `env` on each call. */
export function createReadField(env: Env = process.env): ReadField {
  return (email, field, options) => readField(email, field, { ...options, env });
}
