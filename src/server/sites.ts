// Cookie-site keys from the vendored, hash-pinned Public Suffix List (sites.py).
//
// Hosts are converted with the IDNA 2003 codec, like Python's stdlib, so the few labels where IDNA 2003 and
// IDNA 2008 differ (for example "ß") can map to a different key than Chrome's. Chrome-provided URLs already
// carry ASCII hosts, which are unaffected. The list loads on first use (D14): a missing or mismatched file
// fails the calling tool with the same gate instead of failing at import.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { packageAssets } from "./assets";
import { Gate, isGate } from "./gate";
import { ipAddressString } from "./ipaddress";
import { pyLen, pySplitLines, pySplitWhitespace, pyStrip } from "./pystr";
import { IdnaError, idnaEncode } from "./unicode/idna2003";
import { urlsplit, UrlSplitError } from "./urlsplit";

export const PSL_SHA256 = "257b298daca42f6d8ec964e238c2a55518e14f09d3117917ec8acee6f188503e";
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

export interface SuffixRules { rules: ReadonlySet<string>; wildcards: ReadonlySet<string>; exceptions: ReadonlySet<string> }

export function loadPublicSuffixList(file = packageAssets().publicSuffixList, expected = PSL_SHA256): SuffixRules {
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch {
    throw new Gate("fast-chrome-public-suffix-list-unavailable");
  }
  if (createHash("sha256").update(data).digest("hex") !== expected) throw new Gate("fast-chrome-public-suffix-list-mismatch");
  const rules = new Set<string>();
  const wildcards = new Set<string>();
  const exceptions = new Set<string>();
  for (const raw of pySplitLines(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data))) {
    const line = pyStrip(raw);
    if (!line || line.startsWith("//")) continue;
    const rule = pySplitWhitespace(line)[0];
    const target = rule.startsWith("!") ? exceptions : rule.startsWith("*.") ? wildcards : rules;
    let name = rule.replace(/^!+/, "");
    if (name.startsWith("*.")) name = name.slice(2);
    target.add(idnaEncode(name));
  }
  return { rules, wildcards, exceptions };
}

let loaded: SuffixRules | null = null;
let listFile: string | undefined;

function suffixRules(): SuffixRules {
  loaded ??= loadPublicSuffixList(listFile);
  return loaded;
}

/** Test hook: load the list from `file` (default: the packaged copy) on the next lookup. */
export function usePublicSuffixListForTesting(file?: string): void {
  listFile = file;
  loaded = null;
}

export function ipLiteral(value: string): string | null {
  let host = value;
  if (host.startsWith("[")) host = host.slice(1);
  if (host.endsWith("]")) host = host.slice(0, -1);
  return ipAddressString(host);
}

/** The lowercase ASCII host of a URL or bare host, without port or trailing dot. */
export function asciiHost(value: unknown): string {
  try {
    if (typeof value !== "string" || !value || pyLen(value) > 8192 || /[\x00-\x20\x7f\\]/.test(value)) throw new UrlSplitError("invalid");
    let host = ipLiteral(value) ?? urlsplit(value.includes("://") ? value : `//${value}`).hostname;
    if (!host) throw new UrlSplitError("invalid");
    if (host.endsWith(".")) host = host.slice(0, -1);
    const literal = ipLiteral(host);
    if (literal) return literal;
    host = idnaEncode(host).toLowerCase();
    if (host.length > 253 || !host.split(".").every((label) => LABEL.test(label))) throw new UrlSplitError("invalid");
    return host;
  } catch (error) {
    if (error instanceof UrlSplitError || error instanceof IdnaError) throw new Gate("fast-chrome-site-invalid");
    throw error;
  }
}

/** Registrable domain (eTLD+1) of a URL or host; IP literals, localhost and bare suffixes map to the host. */
export function cookieSite(value: unknown): string {
  const { rules, wildcards, exceptions } = suffixRules();
  const host = asciiHost(value);
  if (host === "localhost" || ipLiteral(host)) return host;
  const labels = host.split(".");
  const candidates = labels.map((_, i) => labels.slice(i).join("."));
  let suffix: number | null = null;
  for (let i = 0; i < candidates.length; i += 1) {
    if (exceptions.has(candidates[i])) {
      suffix = labels.length - i - 1;
      break;
    }
  }
  if (suffix === null) {
    suffix = 1;
    for (let i = 0; i < candidates.length; i += 1) {
      if (rules.has(candidates[i]) || wildcards.has(labels.slice(i + 1).join("."))) {
        suffix = labels.length - i;
        break;
      }
    }
  }
  return suffix >= labels.length ? host : labels.slice(-suffix - 1).join(".");
}

/** A canonical cookie-site key. List-loading gates still fail closed. */
export function validSite(value: unknown): boolean {
  try {
    return typeof value === "string" && cookieSite(value) === value;
  } catch (error) {
    if (isGate(error, "fast-chrome-site-invalid")) return false;
    throw error;
  }
}
