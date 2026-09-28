// JSON with Python json module semantics, checked against tests/server/fixtures/python-json.json.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

/** A number that keeps its JSON source text, so integers above 2 ** 53 survive a rewrite (Preferences). */
export class LosslessNumber {
  readonly source: string;
  constructor(source: string) {
    this.source = source;
  }
  get isInteger(): boolean {
    return !/[.eE]/.test(this.source);
  }
  valueOf(): number {
    return Number(this.source);
  }
}

/** A JSON object parsed losslessly: insertion order like a Python dict, including integer-like keys. */
export type LosslessObject = Map<string, LosslessValue>;
export type LosslessValue = null | boolean | string | LosslessNumber | LosslessValue[] | LosslessObject;

/** json.JSONDecodeError (a ValueError). */
export class JsonDecodeError extends SyntaxError {
  constructor(message = "invalid JSON") {
    super(message);
    this.name = "JsonDecodeError";
  }
}

/** RecursionError while decoding or encoding. */
export class JsonDepthError extends RangeError {
  constructor() {
    super("maximum JSON nesting depth exceeded");
    this.name = "JsonDepthError";
  }
}

/** ValueError or TypeError from json.dumps (NaN with allow_nan=False, circular values, unsupported types). */
export class JsonEncodeError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "JsonEncodeError";
  }
}

/** CPython's C scanner refuses deeper nesting with RecursionError (captured: 9998). */
export const MAX_PARSE_DEPTH = 9998;

/**
 * Parsed objects and arrays, mapped to the keys or indexes whose number was written with a fraction or an
 * exponent. Python keeps such a number a float even when it is integral (2.0); a JS number cannot.
 */
const floatLiterals = new WeakMap<object, Set<string | number>>();

/**
 * type(container[key]) is int for a value this module parsed: an integral number written without a fraction or
 * exponent. A bool is never an int here, as Python's `type(value) is int` excludes it.
 */
export function isPyInt(container: unknown, key: string | number): boolean {
  if (typeof container !== "object" || container === null || !Object.prototype.hasOwnProperty.call(container, key)) return false;
  const value = (container as Record<string | number, unknown>)[key];
  return typeof value === "number" && Number.isInteger(value) && !floatLiterals.get(container)?.has(key);
}

function markFloat(container: object, key: string | number, float: boolean): void {
  let keys = floatLiterals.get(container);
  if (float) {
    if (!keys) floatLiterals.set(container, keys = new Set());
    keys.add(key);
  } else {
    keys?.delete(key);
  }
}

interface ParseOptions {
  /** Accept NaN, Infinity and -Infinity (json.loads default); false mirrors parse_constant raising. */
  constants: boolean;
  /** "last" is the Python dict default; "error" mirrors an object_pairs_hook that refuses repeats. */
  duplicates: "last" | "error";
  lossless: boolean;
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;

function parse(text: string, options: ParseOptions): unknown {
  let index = 0;
  const fail = (): never => { throw new JsonDecodeError(`invalid JSON at ${index}`); };
  const skip = () => {
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
      index += 1;
    }
  };
  const string = (): string => {
    index += 1;
    let result = "";
    let start = index;
    while (true) {
      if (index >= text.length) fail();
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        result += text.slice(start, index);
        index += 1;
        return result;
      }
      if (code < 0x20) fail();
      if (code !== 0x5c) {
        index += 1;
        continue;
      }
      result += text.slice(start, index);
      const escape = text[index + 1];
      if (escape === undefined) fail();
      const simple: Record<string, string> = { "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (escape in simple) {
        result += simple[escape];
        index += 2;
      } else if (escape === "u") {
        const hex = text.slice(index + 2, index + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
        result += String.fromCharCode(parseInt(hex, 16));
        index += 6;
      } else {
        fail();
      }
      start = index;
    }
  };
  /** Whether the scalar just read was a float literal; assign() records it for isPyInt. */
  let floatLiteral = false;
  const number = (): unknown => {
    NUMBER.lastIndex = index;
    const match = NUMBER.exec(text);
    if (!match) return fail();
    index += match[0].length;
    const source = match[0];
    if (options.lossless) return new LosslessNumber(source);
    floatLiteral = Boolean(match[1] || match[2]);
    if (!match[1] && !match[2]) {
      const value = Number(source);
      return Object.is(value, -0) ? 0 : value;
    }
    return Number(source);
  };
  const constant = (): unknown => {
    for (const [word, value] of [["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity]] as const) {
      if (text.startsWith(word, index)) {
        if (!options.constants) fail();
        index += word.length;
        return options.lossless ? new LosslessNumber(word) : value;
      }
    }
    return undefined;
  };
  const scalar = (): unknown => {
    const character = text[index];
    if (character === "\"") return string();
    if (text.startsWith("true", index)) { index += 4; return true; }
    if (text.startsWith("false", index)) { index += 5; return false; }
    if (text.startsWith("null", index)) { index += 4; return null; }
    const special = constant();
    if (special !== undefined) return special;
    if (character === "-" || (character >= "0" && character <= "9")) return number();
    return fail();
  };

  type Frame = { container: unknown[] | Record<string, unknown> | Map<string, unknown>; key: string | null; keys?: Set<string> };
  const stack: Frame[] = [];
  let root: unknown;
  let hasRoot = false;
  const assign = (value: unknown, float = false) => {
    const frame = stack[stack.length - 1];
    if (!frame) {
      root = value;
      hasRoot = true;
      return;
    }
    if (Array.isArray(frame.container)) {
      if (float) markFloat(frame.container, frame.container.length, true);
      frame.container.push(value);
      return;
    }
    const key = frame.key as string;
    if (options.duplicates === "error") {
      if (frame.keys?.has(key)) fail();
      frame.keys?.add(key);
    }
    if (frame.container instanceof Map) {
      frame.container.set(key, value);
    } else {
      // A repeated key keeps the last value (duplicates "last"), and with it the last value's number type.
      if (float || options.duplicates === "last") markFloat(frame.container, key, float);
      Object.defineProperty(frame.container, key, { value, writable: true, enumerable: true, configurable: true });
    }
    frame.key = null;
  };
  const open = (container: Frame["container"]) => {
    if (stack.length >= MAX_PARSE_DEPTH) throw new JsonDepthError();
    stack.push({ container, key: null, keys: options.duplicates === "error" ? new Set() : undefined });
  };
  const key = () => {
    skip();
    if (text[index] !== "\"") fail();
    stack[stack.length - 1].key = string();
    skip();
    if (text[index] !== ":") fail();
    index += 1;
  };

  // Iterative descent, so deep documents fail with JsonDepthError rather than a JS stack overflow.
  skip();
  let expectValue = true;
  while (true) {
    if (expectValue) {
      skip();
      const character = text[index];
      if (character === "[") {
        index += 1;
        open([]);
        skip();
        if (text[index] === "]") {
          index += 1;
          const frame = stack.pop() as Frame;
          assign(frame.container);
          expectValue = false;
        }
        continue;
      }
      if (character === "{") {
        index += 1;
        open(options.lossless ? new Map() : {});
        skip();
        if (text[index] === "}") {
          index += 1;
          const frame = stack.pop() as Frame;
          assign(frame.container);
          expectValue = false;
          continue;
        }
        key();
        continue;
      }
      floatLiteral = false;
      const value = scalar();
      assign(value, floatLiteral);
      expectValue = false;
      continue;
    }
    const frame = stack[stack.length - 1];
    if (!frame) break;
    skip();
    const character = text[index];
    const closing = Array.isArray(frame.container) ? "]" : "}";
    if (character === ",") {
      index += 1;
      if (!Array.isArray(frame.container)) key();
      expectValue = true;
      continue;
    }
    if (character !== closing) fail();
    index += 1;
    stack.pop();
    assign(frame.container);
  }
  skip();
  if (!hasRoot || index !== text.length) fail();
  return root;
}

/** json.loads with an object_pairs_hook that refuses duplicate keys and a parse_constant that refuses NaN. */
export function parseStrictJson(text: string): JsonValue {
  return parse(text, { constants: false, duplicates: "error", lossless: false }) as JsonValue;
}

/** json.loads with its defaults: duplicate keys keep the last value; NaN and Infinity are accepted. */
export function parsePythonJson(text: string): JsonValue {
  return parse(text, { constants: true, duplicates: "last", lossless: false }) as JsonValue;
}

/**
 * json.load(..., parse_constant=reject) for Chrome Preferences: numbers keep their source text and objects keep
 * Python dict order. Returns Maps and LosslessNumbers rather than plain JSON values.
 */
export function parseLosslessJson(text: string): LosslessValue {
  return parse(text, { constants: false, duplicates: "last", lossless: true }) as LosslessValue;
}

// ----------------------------------------------------------------------------------------------- encoding

function shortest(value: number): { digits: string; point: number } {
  const [mantissa, exponent] = Math.abs(value).toExponential().split("e");
  return { digits: mantissa.replace(".", ""), point: Number(exponent) + 1 };
}

/** repr(float): the shortest round-trip digits, exponent form when the point is at <= -4 or > 16. */
export function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const sign = value < 0 ? "-" : "";
  const { digits, point } = shortest(value);
  if (point <= -4 || point > 16) {
    const exponent = point - 1;
    const tail = digits.length > 1 ? `.${digits.slice(1)}` : "";
    return `${sign}${digits[0]}${tail}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}.0`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** pydantic_core float text (ryu layout with a signed exponent), as FastMCP result text shows. */
export function pydanticFloat(value: number): string {
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const sign = value < 0 ? "-" : "";
  const { digits, point } = shortest(value);
  if (point >= digits.length && point <= 16) return `${sign}${digits}${"0".repeat(point - digits.length)}.0`;
  if (point > 0 && point <= 16) return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
  if (point > -5 && point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  const exponent = point - 1;
  const tail = digits.length > 1 ? `.${digits.slice(1)}` : "";
  return `${sign}${digits[0]}${tail}e${exponent < 0 ? "-" : "+"}${Math.abs(exponent)}`;
}

const SIMPLE_ESCAPES: Record<number, string> = { 0x22: "\\\"", 0x5c: "\\\\", 0x0a: "\\n", 0x0d: "\\r", 0x09: "\\t", 0x08: "\\b", 0x0c: "\\f" };

function hex4(code: number): string {
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

function pyString(value: string, ensureAscii: boolean): string {
  let result = "\"";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const simple = SIMPLE_ESCAPES[code];
    if (simple) result += simple;
    else if (code < 0x20 || (ensureAscii && code > 0x7e)) result += hex4(code);
    else result += value[i];
  }
  return `${result}"`;
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function pydanticString(value: string): string {
  if (LONE_SURROGATE.test(value)) throw new JsonEncodeError("surrogates not allowed");
  let result = "\"";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const simple = SIMPLE_ESCAPES[code];
    if (simple) result += simple;
    else if (code < 0x20) result += hex4(code);
    else result += value[i];
  }
  return `${result}"`;
}

export interface DumpOptions {
  separators?: [string, string];
  indent?: number;
  ensureAscii?: boolean;
  allowNan?: boolean;
}

/** Python's recursion limit bounds json.dumps too; the port uses a fixed nesting bound. */
const MAX_DUMP_DEPTH = 990;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encoder(scalarNumber: (value: number) => string, stringify: (value: string) => string, options: DumpOptions) {
  const indent = options.indent;
  const [itemSeparator, keySeparator] = options.separators ?? (indent === undefined ? [", ", ": "] : [",", ": "]);
  const allowNan = options.allowNan ?? true;
  const active = new Set<unknown>();
  const encode = (value: unknown, level: number): string => {
    if (value === null) return "null";
    if (value === true) return "true";
    if (value === false) return "false";
    if (typeof value === "string") return stringify(value);
    if (typeof value === "bigint") return value.toString();
    if (value instanceof LosslessNumber) {
      if (value.isInteger) return BigInt(value.source).toString();
      return scalarNumber(Number(value.source));
    }
    if (typeof value === "number") {
      if (Number.isNaN(value) || !Number.isFinite(value)) {
        if (!allowNan) throw new JsonEncodeError("Out of range float values are not JSON compliant");
        return Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity";
      }
      if (Number.isInteger(value) && !Object.is(value, -0)) return BigInt(value).toString();
      return scalarNumber(value);
    }
    const entries = Array.isArray(value)
      ? value.map((item) => [null, item] as const)
      : value instanceof Map
        ? [...value.entries()].map(([key, item]) => [String(key), item] as const)
        : isPlainObject(value)
          ? Object.entries(value).filter(([, item]) => item !== undefined)
          : null;
    if (entries === null) throw new JsonEncodeError(`Object of type ${typeof value} is not JSON serializable`);
    if (Array.isArray(value) && value.some((item) => item === undefined)) throw new JsonEncodeError("undefined is not JSON serializable");
    if (active.has(value)) throw new JsonEncodeError("Circular reference detected");
    if (level >= MAX_DUMP_DEPTH) throw new JsonDepthError();
    const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
    if (!entries.length) return `${open}${close}`;
    active.add(value);
    try {
      const inner = indent === undefined ? "" : `\n${" ".repeat(indent * (level + 1))}`;
      const outer = indent === undefined ? "" : `\n${" ".repeat(indent * level)}`;
      const parts = entries.map(([key, item]) => (key === null ? "" : `${stringify(key)}${keySeparator}`) + encode(item, level + 1));
      return `${open}${inner}${parts.join(itemSeparator + inner)}${outer}${close}`;
    } finally {
      active.delete(value);
    }
  };
  return encode;
}

/** json.dumps(value, ...) with Python's defaults: ensure_ascii, ", " and ": " separators, allow_nan. */
export function pyDumps(value: unknown, options: DumpOptions = {}): string {
  const ensureAscii = options.ensureAscii ?? true;
  if (value === undefined) throw new JsonEncodeError("undefined is not JSON serializable");
  return encoder(pyFloatRepr, (text) => pyString(text, ensureAscii), options)(value, 0);
}

/** pydantic_core.to_json(value, indent=...): FastMCP's text form of a dict tool result. */
export function pydanticDumps(value: unknown, options: { indent?: number } = {}): string {
  if (value === undefined) throw new JsonEncodeError("undefined is not JSON serializable");
  return encoder(pydanticFloat, pydanticString, { indent: options.indent, separators: options.indent === undefined ? [",", ":"] : [",", ": "] })(value, 0);
}
