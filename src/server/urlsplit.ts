// urllib.parse.urlsplit for str input, ported from CPython 3.13 Lib/urllib/parse.py.
import { parseIpAddress } from "./ipaddress";
import { pyIsAscii, pyLower } from "./pystr";

/** ValueError from urlsplit or from the port property. */
export class UrlSplitError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "UrlSplitError";
  }
}

export interface SplitResult {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string;
  readonly username: string | null;
  readonly password: string | null;
  readonly hostname: string | null;
  /** Throws UrlSplitError (Python ValueError) for a non-numeric or out-of-range port. */
  readonly port: number | null;
}

/** str.partition(separator) */
function partition(text: string, separator: string): [string, string, string] {
  const index = text.indexOf(separator);
  return index < 0 ? [text, "", ""] : [text.slice(0, index), separator, text.slice(index + separator.length)];
}

/** str.rpartition(separator) */
function rpartition(text: string, separator: string): [string, string, string] {
  const index = text.lastIndexOf(separator);
  return index < 0 ? ["", "", text] : [text.slice(0, index), separator, text.slice(index + separator.length)];
}

function hostinfo(netloc: string): [string, string | null] {
  const [, , info] = rpartition(netloc, "@");
  const [, openBracket, bracketed] = partition(info, "[");
  let hostname: string;
  let port: string;
  if (openBracket) {
    let rest: string;
    [hostname, , rest] = partition(bracketed, "]");
    [, , port] = partition(rest, ":");
  } else {
    [hostname, , port] = partition(info, ":");
  }
  return [hostname, port ? port : null];
}

class Split implements SplitResult {
  constructor(public scheme: string, public netloc: string, public path: string, public query: string, public fragment: string) {}

  private get userinfo(): [string | null, string | null] {
    const [userinfo, haveInfo] = rpartition(this.netloc, "@");
    if (!haveInfo) return [null, null];
    const [username, havePassword, password] = partition(userinfo, ":");
    return [username, havePassword ? password : null];
  }

  get username() { return this.userinfo[0]; }
  get password() { return this.userinfo[1]; }

  get hostname(): string | null {
    const [host] = hostinfo(this.netloc);
    if (!host) return null;
    // A scoped IPv6 zone is not lowercased.
    const [name, percent, zone] = partition(host, "%");
    return pyLower(name) + percent + zone;
  }

  get port(): number | null {
    const [, port] = hostinfo(this.netloc);
    if (port === null) return null;
    if (!/^[0-9]+$/.test(port)) throw new UrlSplitError("Port could not be cast to integer value");
    const value = Number(port);
    if (!(value >= 0 && value <= 65535)) throw new UrlSplitError("Port out of range 0-65535");
    return value;
  }
}

function splitNetloc(url: string, start: number): [string, string] {
  let delimiter = url.length;
  for (const character of "/?#") {
    const index = url.indexOf(character, start);
    if (index >= 0) delimiter = Math.min(delimiter, index);
  }
  return [url.slice(start, delimiter), url.slice(delimiter)];
}

function checkNetloc(netloc: string) {
  if (!netloc || pyIsAscii(netloc)) return;
  const stripped = netloc.replace(/[@:#?]/g, "");
  const normalized = stripped.normalize("NFKC");
  if (stripped === normalized) return;
  for (const character of "/?#@:") {
    if (normalized.includes(character)) throw new UrlSplitError("netloc contains invalid characters under NFKC normalization");
  }
}

function checkBracketedHost(hostname: string) {
  if (hostname.startsWith("v")) {
    // Python's "." excludes only "\n"; \Z anchors at the very end.
    if (!/^v[a-fA-F0-9]+\.[^\n]+$/.test(hostname)) throw new UrlSplitError("IPvFuture address is invalid");
    return;
  }
  const ip = parseIpAddress(hostname);
  if (ip === null) throw new UrlSplitError("does not appear to be an IPv4 or IPv6 address");
  if (ip.version === 4) throw new UrlSplitError("An IPv4 address cannot be in brackets");
}

function checkBracketedNetloc(netloc: string) {
  const [, , hostAndPort] = rpartition(netloc, "@");
  const [before, openBracket, bracketed] = partition(hostAndPort, "[");
  let hostname: string;
  if (openBracket) {
    if (before) throw new UrlSplitError("Invalid IPv6 URL");
    let port: string;
    [hostname, , port] = partition(bracketed, "]");
    if (port && !port.startsWith(":")) throw new UrlSplitError("Invalid IPv6 URL");
  } else {
    [hostname] = partition(hostAndPort, ":");
  }
  checkBracketedHost(hostname);
}

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]*$/;

/** urllib.parse.urlsplit(url) with the default scheme "" and allow_fragments=True. */
export function urlsplit(input: string): SplitResult {
  let url = input.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  let scheme = "";
  let netloc = "";
  let query = "";
  let fragment = "";
  const colon = url.indexOf(":");
  if (colon > 0 && /^[A-Za-z]/.test(url) && SCHEME_CHARS.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
  }
  if (url.slice(0, 2) === "//") {
    [netloc, url] = splitNetloc(url, 2);
    if ((netloc.includes("[") && !netloc.includes("]")) || (netloc.includes("]") && !netloc.includes("["))) {
      throw new UrlSplitError("Invalid IPv6 URL");
    }
    if (netloc.includes("[") && netloc.includes("]")) checkBracketedNetloc(netloc);
  }
  if (url.includes("#")) [url, , fragment] = partition(url, "#");
  if (url.includes("?")) [url, , query] = partition(url, "?");
  checkNetloc(netloc);
  return new Split(scheme, netloc, url, query, fragment);
}
