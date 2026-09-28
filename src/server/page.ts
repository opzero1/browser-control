// Pure checks of native_server.py: the HTTPS origin policy, group titles, host rows, local PDFs and the
// act_steps action choice. Nothing here calls the host.
import fs from "node:fs";
import { allowLoopback, type Env } from "./config";
import { Gate } from "./gate";
import { isPyInt } from "./pyjson";
import { pyLen, pyLower, pySlice, pyStrip } from "./pystr";
import { idnaEncode } from "./unicode/idna2003";
import { urlsplit } from "./urlsplit";

export type Dict = Record<string, unknown>;

export function isDict(value: unknown): value is Dict {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** dict.get(key, fallback) */
export function get(value: Dict, key: string, fallback: unknown = null): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : fallback;
}

/**
 * type(value) is int for a number, never a bool. It cannot see a float literal such as 5.0; for values read from
 * the native host, use isPyInt(container, key), which can.
 */
export function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** Python iteration over a JSON value: list items, dict keys or string characters; anything else is a TypeError. */
export function pyIter(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isDict(value)) return Object.keys(value);
  if (typeof value === "string") return [...value];
  throw new TypeError("object is not iterable");
}

/**
 * The exact origin of an approved web URL: HTTPS only, or http on 127.0.0.1 or localhost with
 * FAST_CHROME_ALLOW_LOOPBACK=1. No credentials; default ports are dropped.
 */
export function origin(url: unknown, env: Env = process.env): string {
  try {
    if (typeof url !== "string" || pyLen(url) > 8192 || /[\x00-\x20\x7f\\]/.test(url)) throw new Error();
    const parsed = urlsplit(url);
    if (parsed.username !== null || parsed.password !== null || !parsed.hostname) throw new Error();
    let host = idnaEncode(parsed.hostname).toLowerCase();
    const loopback = parsed.scheme === "http" && (host === "127.0.0.1" || host === "localhost");
    if (parsed.scheme !== "https" && !(loopback && allowLoopback(env))) throw new Error();
    host = host.includes(":") ? `[${host}]` : host;
    const port = parsed.port;
    const suffix = port && port !== (parsed.scheme === "https" ? 443 : 80) ? `:${port}` : "";
    return `${parsed.scheme}://${host}${suffix}`;
  } catch {
    throw new Gate("fast-chrome-approved-web-url-required");
  }
}

const HIDDEN = /[\x00-\x1f\x7f-\x9f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** The given group label, or "OpenCode · <8 chars of the session>" when none is given. */
export function validatedGroupTitle(session: string, label: unknown = null): string {
  if (label === null || label === undefined) {
    const suffix = session.startsWith("ses_") ? session.slice(4) : session;
    return `OpenCode · ${pySlice(suffix, 8)}`;
  }
  // A lone surrogate cannot be encoded as UTF-16, which Python counted as too long.
  const utf16 = typeof label === "string" ? (LONE_SURROGATE.test(label) ? 81 : label.length) : 0;
  if (typeof label !== "string" || label !== pyStrip(label) || !label || utf16 > 80 || HIDDEN.test(label)) {
    throw new Gate("fast-chrome-group-title-required");
  }
  return label;
}

export interface TabRow { tab_id: string; url: string; title: string }

/** A host tab row: a positive integer id, a URL and a title (cut to 200 characters). */
export function tabInfo(raw: unknown): TabRow {
  if (!isDict(raw) || !isPyInt(raw, "id") || (raw.id as number) <= 0) throw new Gate("fast-chrome-invalid-tab-response");
  const url = get(raw, "url");
  const title = get(raw, "title", "");
  if (typeof url !== "string" || typeof title !== "string") throw new Gate("fast-chrome-invalid-tab-response");
  return { tab_id: String(raw.id), url, title: pySlice(title, 200) };
}

// ---------------------------------------------------------------------------------------------- pages

export interface Action { id: string; kind: string; label: string; role: string; disabled: boolean }
export interface Truncation { text: boolean; actions: boolean; opaqueSurfaces: boolean; labels: boolean; title: boolean; [key: string]: boolean }
export interface Page {
  tab_id: string; url: string; title: string; text: string; actions: Action[]; page_protocol: 2; mode: "full" | "controls-only";
  partial: boolean; opaqueSurfaces: Array<{ id: string; kind: string }>; truncation: Truncation;
}

export interface Expectation { readonly url: string | null; readonly text: string | null; readonly action_label: string | null }

export function match(page: Page, expect: Expectation): "match" | "no_match" | "ambiguous" {
  if (expect.url !== null && page.url !== expect.url) return "no_match";
  if (expect.text !== null && !page.text.includes(expect.text)) return "no_match";
  if (expect.action_label !== null) {
    const count = page.actions.filter((action) => action.label === expect.action_label && !action.disabled).length;
    if (count !== 1) return count > 1 ? "ambiguous" : "no_match";
  }
  return "match";
}

export interface StepLike { readonly label: string; readonly kind: string | null; readonly role: string | null; readonly text: string | null }

/** The one enabled action a step names, or the reason it stops before input and the matching count. */
export function stepAction(page: Page, step: StepLike): [Action | null, string | null, number] {
  const candidates = page.actions.filter((action) => action.label === step.label
    && (step.kind === null || step.kind === action.kind) && (step.role === null || step.role === action.role));
  const matches = candidates.filter((action) => !action.disabled);
  if (!matches.length) return [null, candidates.length ? "disabled" : "no_match", candidates.length];
  if (matches.length > 1) return [null, "ambiguous", matches.length];
  const action = matches[0];
  if (action.kind === "upload") return [null, "upload_excluded", 1];
  if (action.kind === "fill" && step.text === null) return [null, "text_required", 1];
  if (action.kind !== "fill" && step.text !== null) return [null, "invalid_public_input", 1];
  return [action, null, 1];
}

// ---------------------------------------------------------------------------------------------- files

/** pathlib.PurePosixPath(value): collapse slashes and "." parts, keep a leading "//", drop a trailing slash. */
export function posixPath(value: string): { text: string; name: string; absolute: boolean } {
  const root = value.startsWith("//") && !value.startsWith("///") ? "//" : value.startsWith("/") ? "/" : "";
  const parts = value.split("/").filter((part) => part && part !== ".");
  const text = root + parts.join("/") || ".";
  return { text, name: parts.length ? parts[parts.length - 1] : "", absolute: root !== "" };
}

/** pathlib suffix: the final dot of the name, when the name neither starts nor ends there. */
function suffix(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 && index < name.length - 1 ? name.slice(index) : "";
}

export interface PdfChecks { lstat?: (file: string) => fs.Stats | { mode: number; uid: number; size: number; isSymbolicLink(): boolean; isFile(): boolean }; uid?: number }

/** An absolute, current-user-owned, non-empty regular *.pdf file that starts with %PDF-. */
export function validatedPdf(pathValue: unknown, checks: PdfChecks = {}): { path: string; name: string; size: number } {
  try {
    if (typeof pathValue !== "string" || !pathValue || pathValue.includes("\0")) throw new Error();
    const local = posixPath(pathValue);
    if (!local.absolute || pyLower(suffix(local.name)) !== ".pdf") throw new Error();
    const info = (checks.lstat ?? fs.lstatSync)(local.text);
    if (info.isSymbolicLink() || !info.isFile() || info.uid !== (checks.uid ?? process.getuid?.()) || !(Number(info.size) > 0)) throw new Error();
    const fd = fs.openSync(local.text, "r");
    try {
      const head = Buffer.alloc(5);
      const read = fs.readSync(fd, head, 0, 5, 0);
      if (read !== 5 || head.toString("latin1") !== "%PDF-") throw new Error();
    } finally {
      fs.closeSync(fd);
    }
    return { path: local.text, name: local.name, size: Number(info.size) };
  } catch {
    throw new Gate("fast-chrome-valid-owned-pdf-required");
  }
}
