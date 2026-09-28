// str.encode("idna"): CPython 3.13 Lib/encodings/idna.py (RFC 3490 ToASCII with RFC 3491 nameprep) and
// Lib/encodings/punycode.py. Normalization follows unicodedata.ucd_3_2_0.normalize("NFKC"): Unicode 3.2
// decompositions with the current combining classes and composition pairs, as Modules/unicodedata.c does.
import { pyLower } from "../pystr";
import { B1, B2, COMBINING, COMPOSE, D1, D2, NFKD_32, PROHIBITED } from "./idna2003-tables";
import { codePoints, decodeMap, decodeNumbers, decodeRanges, inRanges, lazy } from "./decode";

/** UnicodeError from the idna codec. The message is fixed; it never carries the input. */
export class IdnaError extends Error {
  constructor() {
    super("idna encoding failed");
    this.name = "IdnaError";
  }
}

const tables = lazy(() => {
  const compose = new Map<number, Map<number, number>>();
  for (const [composite, pair] of decodeMap(COMPOSE)) {
    const [firstPoint, second] = codePoints(pair);
    let row = compose.get(firstPoint);
    if (!row) compose.set(firstPoint, row = new Map());
    row.set(second, composite);
  }
  const lastPoints = new Set<number>();
  for (const row of compose.values()) for (const second of row.keys()) lastPoints.add(second);
  return {
    b1: decodeRanges(B1),
    b2: decodeMap(B2),
    prohibited: decodeRanges(PROHIBITED),
    d1: decodeRanges(D1),
    d2: decodeRanges(D2),
    decomposition: decodeMap(NFKD_32),
    combining: decodeNumbers(COMBINING),
    compose,
    lastPoints
  };
});

const S_BASE = 0xac00, L_BASE = 0x1100, V_BASE = 0x1161, T_BASE = 0x11a7;
const L_COUNT = 19, V_COUNT = 21, T_COUNT = 28;

function fromPoints(points: number[]): string {
  let result = "";
  for (let i = 0; i < points.length; i += 4096) result += String.fromCodePoint(...points.slice(i, i + 4096));
  return result;
}

/** unicodedata.ucd_3_2_0.normalize("NFKC", text) */
export function nfkc32(text: string): string {
  if (!text) return text;
  const { decomposition, combining, compose, lastPoints } = tables();
  const ccc = (point: number) => combining.get(point) ?? 0;
  const points: number[] = [];
  for (const point of codePoints(text)) {
    const mapped = decomposition.get(point);
    if (mapped === undefined) points.push(point);
    else points.push(...codePoints(mapped));
  }
  // Canonical ordering (Modules/unicodedata.c nfd_nfkd).
  let previous = ccc(points[0]);
  for (let i = 1; i < points.length; i += 1) {
    const current = ccc(points[i]);
    if (previous === 0 || current === 0 || previous <= current) {
      previous = current;
      continue;
    }
    let o = i - 1;
    while (true) {
      [points[o], points[o + 1]] = [points[o + 1], points[o]];
      o -= 1;
      if (o < 0) break;
      previous = ccc(points[o]);
      if (previous === 0 || previous <= current) break;
    }
    previous = ccc(points[i]);
  }
  // Canonical composition (Modules/unicodedata.c nfc_nfkc).
  const output: number[] = [];
  const skipped = new Set<number>();
  let i = 0;
  while (i < points.length) {
    if (skipped.has(i)) {
      skipped.delete(i);
      i += 1;
      continue;
    }
    let code = points[i];
    if (code >= L_BASE && code < L_BASE + L_COUNT && i + 1 < points.length
        && points[i + 1] >= V_BASE && points[i + 1] < V_BASE + V_COUNT) {
      code = S_BASE + ((code - L_BASE) * V_COUNT + (points[i + 1] - V_BASE)) * T_COUNT;
      i += 2;
      if (i < points.length && points[i] > T_BASE && points[i] < T_BASE + T_COUNT) {
        code += points[i] - T_BASE;
        i += 1;
      }
      output.push(code);
      continue;
    }
    let row = compose.get(code);
    if (!row) {
      output.push(code);
      i += 1;
      continue;
    }
    let i1 = i + 1;
    let blocking = 0;
    while (i1 < points.length) {
      const next = points[i1];
      const nextClass = ccc(next);
      if (blocking) {
        if (nextClass === 0) break;
        if (blocking >= nextClass) {
          i1 += 1;
          continue;
        }
      }
      const composite = lastPoints.has(next) ? row.get(next) : undefined;
      if (composite === undefined) {
        if (nextClass === 0) break;
        blocking = nextClass;
        i1 += 1;
        continue;
      }
      code = composite;
      skipped.add(i1);
      i1 += 1;
      row = compose.get(code);
      if (!row) break;
    }
    output.push(code);
    i += 1;
  }
  return fromPoints(output);
}

/** encodings.idna.nameprep */
export function nameprep(label: string): string {
  const { b1, b2, prohibited, d1, d2 } = tables();
  let mapped = "";
  for (const character of label) {
    const point = character.codePointAt(0) as number;
    if (inRanges(b1, point)) continue;
    mapped += b2.get(point) ?? character;
  }
  const normalized = nfkc32(mapped);
  const points = codePoints(normalized);
  for (const point of points) if (inRanges(prohibited, point)) throw new IdnaError();
  const randAL = points.map((point) => inRanges(d1, point));
  if (randAL.some(Boolean)) {
    if (points.some((point) => inRanges(d2, point))) throw new IdnaError();
    if (!randAL[0] || !randAL[randAL.length - 1]) throw new IdnaError();
  }
  return normalized;
}

const DIGITS = "abcdefghijklmnopqrstuvwxyz0123456789";

function threshold(j: number, bias: number): number {
  const result = 36 * (j + 1) - bias;
  return result < 1 ? 1 : result > 26 ? 26 : result;
}

function adapt(delta: number, first: boolean, count: number): number {
  delta = first ? Math.floor(delta / 700) : Math.floor(delta / 2);
  delta += Math.floor(delta / count);
  let divisions = 0;
  while (delta > 455) {
    delta = Math.floor(delta / 35);
    divisions += 36;
  }
  return divisions + Math.floor((36 * delta) / (delta + 38));
}

/** str.encode("punycode") */
export function punycode(text: string): string {
  const points = codePoints(text);
  const base = points.filter((point) => point < 128);
  const extended = [...new Set(points.filter((point) => point >= 128))].sort((a, b) => a - b);
  const deltas: number[] = [];
  let oldChar = 0x80;
  let oldIndex = -1;
  for (const char of extended) {
    let index = -1;
    let position = -1;
    const current = points.filter((point) => point < char).length;
    let delta = (current + 1) * (char - oldChar);
    while (true) {
      // selective_find
      let found = false;
      while (true) {
        position += 1;
        if (position === points.length) break;
        const point = points[position];
        if (point === char) {
          index += 1;
          found = true;
          break;
        }
        if (point < char) index += 1;
      }
      if (!found) break;
      delta += index - oldIndex;
      deltas.push(delta - 1);
      oldIndex = index;
      delta = 0;
    }
    oldChar = char;
  }
  let encoded = "";
  let bias = 72;
  deltas.forEach((value, count) => {
    let n = value;
    for (let j = 0; ; j += 1) {
      const t = threshold(j, bias);
      if (n < t) {
        encoded += DIGITS[n];
        break;
      }
      encoded += DIGITS[t + ((n - t) % (36 - t))];
      n = Math.floor((n - t) / (36 - t));
    }
    bias = adapt(value, count === 0, base.length + count + 1);
  });
  const prefix = String.fromCodePoint(...base);
  return base.length ? `${prefix}-${encoded}` : encoded;
}

function isAscii(text: string): boolean {
  return /^[\x00-\x7f]*$/.test(text);
}

/** encodings.idna.ToASCII for one label. */
export function toAscii(label: string): string {
  if (isAscii(label)) {
    if (label.length > 0 && label.length < 64) return label;
    throw new IdnaError();
  }
  const prepared = nameprep(label);
  if (isAscii(prepared)) {
    if (prepared.length > 0 && prepared.length < 64) return prepared;
    throw new IdnaError();
  }
  if (pyLower(prepared).startsWith("xn--")) throw new IdnaError();
  const ascii = `xn--${punycode(prepared)}`;
  if (ascii.length < 64) return ascii;
  throw new IdnaError();
}

/** host.encode("idna").decode("ascii"); throws IdnaError where Python raises UnicodeError. */
export function idnaEncode(host: string): string {
  if (!host) return "";
  if (isAscii(host)) {
    const labels = host.split(".");
    if (labels.slice(0, -1).some((label) => label.length === 0)) throw new IdnaError();
    if (labels.some((label) => label.length >= 64)) throw new IdnaError();
    return host;
  }
  const labels = host.split(/[.\u3002\uff0e\uff61]/);
  let trailing = "";
  if (labels.length && !labels[labels.length - 1]) {
    trailing = ".";
    labels.pop();
  }
  return labels.map(toAscii).join(".") + trailing;
}
