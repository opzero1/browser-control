// Python str semantics the port depends on. Python len() and slicing count code points; JS counts UTF-16 units.
import { ALNUM, CASED, CASE_IGNORABLE, CASEFOLD, LOWER, SPACE } from "./unicode/casefold-table";
import { codePoints, decodeMap, decodeRanges, inRanges, lazy } from "./unicode/decode";

const tables = lazy(() => ({
  lower: decodeMap(LOWER),
  casefold: decodeMap(CASEFOLD),
  space: decodeRanges(SPACE),
  alnum: decodeRanges(ALNUM),
  ignorable: decodeRanges(CASE_IGNORABLE),
  cased: decodeRanges(CASED)
}));

export function pyLen(s: string): number {
  let count = 0;
  for (const _ of s) count += 1;
  return count;
}

/** s[:end] for a non-negative end. */
export function pySlice(s: string, end: number): string {
  if (end <= 0) return "";
  let result = "";
  let count = 0;
  for (const character of s) {
    if (count === end) break;
    result += character;
    count += 1;
  }
  return result;
}

export function utf16Len(s: string): number {
  return s.length;
}

function first(ch: string): number {
  return ch.codePointAt(0) ?? -1;
}

export function pyIsSpace(ch: string): boolean {
  return ch !== "" && inRanges(tables().space, first(ch));
}

export function pyIsAlnum(ch: string): boolean {
  return ch !== "" && inRanges(tables().alnum, first(ch));
}

/** str.strip() with no arguments. */
export function pyStrip(s: string): string {
  const space = tables().space;
  let start = 0;
  while (start < s.length) {
    const point = s.codePointAt(start) as number;
    if (!inRanges(space, point)) break;
    start += point > 0xffff ? 2 : 1;
  }
  let end = s.length;
  while (end > start) {
    const low = s.charCodeAt(end - 1);
    const pair = end - 2 >= start && low >= 0xdc00 && low <= 0xdfff
      && s.charCodeAt(end - 2) >= 0xd800 && s.charCodeAt(end - 2) <= 0xdbff;
    const point = pair ? s.codePointAt(end - 2) as number : low;
    if (!inRanges(space, point)) break;
    end -= pair ? 2 : 1;
  }
  return s.slice(start, end);
}

/** str.split() with no arguments: runs of Python whitespace separate fields; no empty fields. */
export function pySplitWhitespace(s: string): string[] {
  const result: string[] = [];
  let current = "";
  for (const character of s) {
    if (pyIsSpace(character)) {
      if (current) result.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current) result.push(current);
  return result;
}

/** str.splitlines() without keepends. */
export function pySplitLines(s: string): string[] {
  const lines = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function casefold(s: string): string {
  const map = tables().casefold;
  let result = "";
  for (const character of s) result += map.get(first(character)) ?? character;
  return result;
}

/** str.lower(), including the Final_Sigma rule of Objects/unicodeobject.c handle_capital_sigma. */
export function pyLower(s: string): string {
  const { lower, ignorable, cased } = tables();
  const points = codePoints(s);
  let result = "";
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (point !== 0x3a3) {
      result += lower.get(point) ?? String.fromCodePoint(point);
      continue;
    }
    let j = i - 1;
    while (j >= 0 && inRanges(ignorable, points[j])) j -= 1;
    let finalSigma = j >= 0 && inRanges(cased, points[j]);
    if (finalSigma && i + 1 < points.length) {
      j = i + 1;
      while (j < points.length && inRanges(ignorable, points[j])) j += 1;
      finalSigma = j === points.length || !inRanges(cased, points[j]);
    }
    result += finalSigma ? "\u03c2" : "\u03c3";
  }
  return result;
}

/** str.isascii() */
export function pyIsAscii(s: string): boolean {
  return /^[\x00-\x7f]*$/.test(s);
}
