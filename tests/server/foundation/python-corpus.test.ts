// Golden checks against captured CPython 3.13 / Pillow 12.3 behavior (tests/server/fixtures/python-*.json).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { strictBase64 } from "../../../src/server/captures";
import { Gate } from "../../../src/server/gate";
import { ipAddressString } from "../../../src/server/ipaddress";
import { inspectJpeg } from "../../../src/server/jpeg";
import { JsonDecodeError, LosslessNumber, parseLosslessJson, parsePythonJson, parseStrictJson, pydanticDumps, pyDumps } from "../../../src/server/pyjson";
import { casefold, pyIsAlnum, pyIsSpace, pyLen, pyLower, pyStrip } from "../../../src/server/pystr";
import { asciiHost, cookieSite, ipLiteral, validSite } from "../../../src/server/sites";
import { idnaEncode, nameprep, nfkc32, punycode } from "../../../src/server/unicode/idna2003";
import { urlsplit } from "../../../src/server/urlsplit";

function fixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures", name), "utf8")) as T;
}

type Outcome = { ok?: unknown; gate?: string; error?: string };

function outcome(body: () => unknown): Outcome {
  try {
    return { ok: body() };
  } catch (error) {
    if (error instanceof Gate) return { gate: error.code };
    return { error: "raised" };
  }
}

/** Python outcomes compare by kind: the TS error classes are not Python's exception names. */
function sameOutcome(actual: Outcome, expected: Outcome) {
  if ("ok" in expected) expect(actual).toEqual({ ok: expected.ok });
  else if ("gate" in expected) expect(actual).toEqual({ gate: expected.gate });
  else expect(actual).toHaveProperty("error");
}

describe("Unicode helpers match CPython", () => {
  const corpus = fixture<{ cases: Array<Record<string, unknown> & { input: string }> }>("python-unicode.json");

  it("normalizes, cases, strips and classifies like Python str", () => {
    expect(corpus.cases.length).toBeGreaterThan(800);
    for (const item of corpus.cases) {
      const text = item.input;
      expect(nfkc32(text), JSON.stringify(text)).toBe(item.nfkc32);
      expect(pyLower(text), JSON.stringify(text)).toBe(item.lower);
      expect(casefold(text), JSON.stringify(text)).toBe(item.casefold);
      expect(pyStrip(text), JSON.stringify(text)).toBe(item.strip);
      expect(pyLen(text)).toBe(item.len);
      expect([...text].map(pyIsSpace)).toEqual(item.isspace);
      expect([...text].map(pyIsAlnum)).toEqual(item.isalnum);
    }
  });

  it("encodes IDNA 2003, nameprep and punycode like the stdlib codecs", () => {
    for (const item of corpus.cases) {
      const text = item.input;
      sameOutcome(outcome(() => idnaEncode(text)), item.idna as Outcome);
      sameOutcome(outcome(() => nameprep(text)), item.nameprep as Outcome);
      sameOutcome(outcome(() => punycode(text)), item.punycode as Outcome);
    }
  });
});

describe("URL and host helpers match CPython and sites.py", () => {
  const corpus = fixture<{ cases: Array<Record<string, unknown> & { input: string }>; non_strings: Array<Record<string, unknown>> }>("python-urls.json");

  it("splits URLs like urllib.parse.urlsplit", () => {
    expect(corpus.cases.length).toBeGreaterThan(300);
    for (const item of corpus.cases) {
      const expected = item.urlsplit as Record<string, unknown>;
      let actual: Record<string, unknown>;
      try {
        const parts = urlsplit(item.input);
        actual = { scheme: parts.scheme, netloc: parts.netloc, path: parts.path, query: parts.query, fragment: parts.fragment,
          username: parts.username, password: parts.password, hostname: parts.hostname };
        try {
          actual.port = parts.port;
        } catch {
          actual.port_error = true;
        }
      } catch {
        actual = { error: "ValueError" };
      }
      expect(actual, JSON.stringify(item.input)).toEqual(expected);
    }
  });

  it("formats IP addresses like ipaddress.ip_address", () => {
    for (const item of corpus.cases) {
      expect(ipAddressString(item.input), JSON.stringify(item.input)).toBe(item.ip_address);
      expect(ipLiteral(item.input), JSON.stringify(item.input)).toBe(item.ip_literal);
    }
  });

  it("derives ASCII hosts and cookie sites like sites.py", () => {
    for (const item of corpus.cases) {
      sameOutcome(outcome(() => asciiHost(item.input)), item.ascii_host as Outcome);
      sameOutcome(outcome(() => cookieSite(item.input)), item.cookie_site as Outcome);
      expect(validSite(item.input), JSON.stringify(item.input)).toBe(item.valid_site);
    }
    for (const item of corpus.non_strings) {
      sameOutcome(outcome(() => asciiHost(item.input)), item.ascii_host as Outcome);
      sameOutcome(outcome(() => cookieSite(item.input)), item.cookie_site as Outcome);
      expect(validSite(item.input)).toBe(item.valid_site);
    }
  });
});

/**
 * JS has one number type: a Python float with an integral value prints as an integer (D13), and an integer
 * beyond 2 ** 53 loses precision (D20). JS objects also list integer-like keys first (D20). Such values compare
 * as parsed JSON; everything else compares byte for byte.
 */
function numberLimited(source: string): boolean {
  const walk = (value: unknown): boolean => {
    if (value instanceof LosslessNumber) {
      const number = Number(value.source);
      if (/[.eE]/.test(value.source)) return Number.isInteger(number);
      return !Number.isSafeInteger(number);
    }
    if (Array.isArray(value)) return value.some(walk);
    if (value instanceof Map) return [...value.keys()].some((key) => /^(0|[1-9][0-9]*)$/.test(key)) || [...value.values()].some(walk);
    return false;
  };
  return walk(parseLosslessJson(source.replaceAll(/NaN|-?Infinity/g, "null")));
}

function sameJson(actual: string, expected: string, source: string) {
  if (numberLimited(source)) expect(JSON.parse(actual), source).toEqual(JSON.parse(expected));
  else expect(actual, source).toBe(expected);
}

describe("JSON matches the json module", () => {
  const corpus = fixture<{
    cases: Array<{ input: string; default: string; compact: string; indent2: string; unicode: string; pydantic_indent2: Outcome }>;
    parse: Array<{ input: string; ok?: string; error?: string }>;
    max_parse_depth: number;
  }>("python-json.json");

  it("dumps like json.dumps and pydantic_core.to_json", () => {
    for (const item of corpus.cases) {
      const value = parsePythonJson(item.input);
      sameJson(pyDumps(value), item.default, item.input);
      sameJson(pyDumps(value, { separators: [",", ":"] }), item.compact, item.input);
      sameJson(pyDumps(value, { indent: 2 }), item.indent2, item.input);
      sameJson(pyDumps(value, { ensureAscii: false }), item.unicode, item.input);
      const pydantic = outcome(() => pydanticDumps(value, { indent: 2 }));
      if (typeof item.pydantic_indent2.ok === "string" && typeof pydantic.ok === "string") sameJson(pydantic.ok, item.pydantic_indent2.ok, item.input);
      else sameOutcome(pydantic, item.pydantic_indent2);
    }
    expect(corpus.cases.filter((item) => !numberLimited(item.input)).length).toBeGreaterThan(40);
  });

  it("parses like json.loads and refuses what the strict hooks refuse", () => {
    for (const item of corpus.parse) {
      if (item.error) {
        expect(() => parsePythonJson(item.input), item.input).toThrow(JsonDecodeError);
        continue;
      }
      sameJson(pyDumps(parsePythonJson(item.input)), item.ok as string, item.ok as string);
    }
    expect(() => parseStrictJson("{\"a\":1,\"a\":2}")).toThrow(JsonDecodeError);
    expect(() => parseStrictJson("[NaN]")).toThrow(JsonDecodeError);
    expect(() => parseStrictJson("[Infinity]")).toThrow(JsonDecodeError);
    expect(parseStrictJson("{\"a\":{\"a\":1}}")).toEqual({ a: { a: 1 } });
    const deep = corpus.max_parse_depth;
    expect(() => parsePythonJson(`${"[".repeat(deep)}${"]".repeat(deep)}`)).not.toThrow();
    expect(() => parsePythonJson(`${"[".repeat(deep + 1)}${"]".repeat(deep + 1)}`)).toThrow(RangeError);
  });
});

describe("JPEG inspection matches Pillow", () => {
  const corpus = fixture<{ cases: Array<{ name: string; data: string; verdict: { format?: string; width?: number; height?: number } }>; base64: Array<{ input: string; ok?: string; error?: string }> }>("python-jpeg.json");

  it("accepts exactly the images Pillow opened as JPEG, with its dimensions", () => {
    expect(corpus.cases.length).toBeGreaterThan(250);
    for (const item of corpus.cases) {
      const expected = item.verdict.format === "JPEG" ? { width: item.verdict.width, height: item.verdict.height } : null;
      expect(inspectJpeg(Buffer.from(item.data, "base64")), item.name).toEqual(expected);
    }
  });

  it("decodes base64 like b64decode(validate=True)", () => {
    for (const item of corpus.base64) {
      const decoded = strictBase64(item.input);
      expect(decoded === null ? null : decoded.toString("hex"), JSON.stringify(item.input)).toBe(item.ok ?? null);
    }
  });
});
