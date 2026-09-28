// str(ipaddress.ip_address(value)) for a str value, ported from CPython 3.13 Lib/ipaddress.py.
import { pyLen } from "./pystr";

class AddressError extends Error {}

/** Python str.split(sep, maxsplit): at most maxsplit splits, the remainder stays in the last part. */
function splitMax(text: string, separator: string, maxsplit: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (parts.length < maxsplit) {
    const index = rest.indexOf(separator);
    if (index < 0) break;
    parts.push(rest.slice(0, index));
    rest = rest.slice(index + separator.length);
  }
  parts.push(rest);
  return parts;
}

function parseOctet(octet: string): number {
  if (!octet) throw new AddressError();
  if (!/^[0-9]+$/.test(octet)) throw new AddressError();
  if (octet.length > 3) throw new AddressError();
  if (octet !== "0" && octet[0] === "0") throw new AddressError();
  const value = Number(octet);
  if (value > 255) throw new AddressError();
  return value;
}

function ipv4Int(text: string): number {
  if (!text) throw new AddressError();
  const octets = text.split(".");
  if (octets.length !== 4) throw new AddressError();
  return octets.map(parseOctet).reduce((total, octet) => total * 256 + octet, 0);
}

function ipv4String(value: number): string {
  return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
}

function parseHextet(hextet: string): bigint {
  if (!/^[0-9a-fA-F]*$/.test(hextet)) throw new AddressError();
  if (hextet.length > 4) throw new AddressError();
  if (!hextet) throw new AddressError();
  return BigInt(`0x${hextet}`);
}

function ipv6Int(text: string): bigint {
  if (!text) throw new AddressError();
  if (pyLen(text) > 45) throw new AddressError();
  const maxParts = 9;
  const parts = splitMax(text, ":", maxParts);
  if (parts.length < 3) throw new AddressError();
  if (parts[parts.length - 1].includes(".")) {
    const ipv4 = ipv4Int(parts.pop() as string);
    parts.push(((ipv4 >>> 16) & 0xffff).toString(16), (ipv4 & 0xffff).toString(16));
  }
  if (parts.length > maxParts) throw new AddressError();
  let skipIndex: number | null = null;
  for (let i = 1; i < parts.length - 1; i += 1) {
    if (!parts[i]) {
      if (skipIndex !== null) throw new AddressError();
      skipIndex = i;
    }
  }
  let partsHi: number;
  let partsLo: number;
  let partsSkipped: number;
  if (skipIndex !== null) {
    partsHi = skipIndex;
    partsLo = parts.length - skipIndex - 1;
    if (!parts[0]) {
      partsHi -= 1;
      if (partsHi) throw new AddressError();
    }
    if (!parts[parts.length - 1]) {
      partsLo -= 1;
      if (partsLo) throw new AddressError();
    }
    partsSkipped = 8 - (partsHi + partsLo);
    if (partsSkipped < 1) throw new AddressError();
  } else {
    if (parts.length !== 8) throw new AddressError();
    if (!parts[0] || !parts[parts.length - 1]) throw new AddressError();
    partsHi = parts.length;
    partsLo = 0;
    partsSkipped = 0;
  }
  let value = 0n;
  for (let i = 0; i < partsHi; i += 1) value = (value << 16n) | parseHextet(parts[i]);
  value <<= 16n * BigInt(partsSkipped);
  for (let i = -partsLo; i < 0; i += 1) value = (value << 16n) | parseHextet(parts[parts.length + i]);
  return value;
}

function compressHextets(hextets: string[]): string[] {
  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  let length = 0;
  hextets.forEach((hextet, index) => {
    if (hextet === "0") {
      length += 1;
      if (start === -1) start = index;
      if (length > bestLength) {
        bestLength = length;
        bestStart = start;
      }
    } else {
      length = 0;
      start = -1;
    }
  });
  if (bestLength > 1) {
    const end = bestStart + bestLength;
    let result = [...hextets];
    if (end === result.length) result.push("");
    result.splice(bestStart, bestLength, "");
    if (bestStart === 0) result = ["", ...result];
    return result;
  }
  return hextets;
}

function ipv6String(value: bigint): string {
  const hex = value.toString(16).padStart(32, "0");
  const hextets: string[] = [];
  for (let x = 0; x < 32; x += 4) hextets.push(parseInt(hex.slice(x, x + 4), 16).toString(16));
  return compressHextets(hextets).join(":");
}

function ipv6Address(address: string): string {
  if (address.includes("/")) throw new AddressError();
  const percent = address.indexOf("%");
  let text = address;
  let scope: string | null = null;
  if (percent >= 0) {
    text = address.slice(0, percent);
    scope = address.slice(percent + 1);
    if (!scope || scope.includes("%")) throw new AddressError();
  }
  const value = ipv6Int(text);
  let result: string;
  if (value >> 32n === 0xffffn) result = `${ipv6String(value >> 32n)}:${ipv4String(Number(value & 0xffffffffn))}`;
  else result = ipv6String(value);
  return scope ? `${result}%${scope}` : result;
}

export type IpVersion = 4 | 6;

/** The version and canonical string of an IP address, or null where ipaddress.ip_address raises ValueError. */
export function parseIpAddress(value: string): { version: IpVersion; text: string } | null {
  try {
    if (value.includes("/")) throw new AddressError();
    return { version: 4, text: ipv4String(ipv4Int(value)) };
  } catch (error) {
    if (!(error instanceof AddressError)) throw error;
  }
  try {
    return { version: 6, text: ipv6Address(value) };
  } catch (error) {
    if (!(error instanceof AddressError)) throw error;
  }
  return null;
}

/** str(ipaddress.ip_address(value)), or null. */
export function ipAddressString(value: string): string | null {
  return parseIpAddress(value)?.text ?? null;
}
