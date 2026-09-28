// What Image.open(...) plus verify() accepted as format "JPEG" in the reference: a port of Pillow 12.3
// JpegImagePlugin._open (marker walk, SOF, DQT and APP parsing) and of jpeg_factory's MPO promotion. Pillow's
// JPEG verify() does nothing, so this walk is the whole check. Verdicts are pinned by python-jpeg.json.

class Refused extends Error {}

/** A BytesIO-like reader: short reads at EOF, like fp.read(n). */
class Reader {
  position = 0;
  constructor(readonly data: Uint8Array) {}
  read(count: number): Uint8Array {
    const result = this.data.subarray(this.position, Math.min(this.data.length, this.position + count));
    this.position += result.length;
    return result;
  }
  /** ImageFile._safe_read: exactly `count` bytes or OSError; non-positive counts read nothing. */
  safeRead(count: number): Uint8Array {
    if (count <= 0) return new Uint8Array(0);
    const result = this.read(count);
    if (result.length < count) throw new Refused();
    return result;
  }
}

/** i16be(bytes, offset) raising struct.error on short input. */
function i16(bytes: Uint8Array, offset = 0): number {
  if (bytes.length < offset + 2) throw new Refused();
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function startsWith(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) if (bytes[i] !== prefix.charCodeAt(i)) return false;
  return true;
}

/** bytes[index], raising IndexError when out of range. */
function at(bytes: Uint8Array, index: number): number {
  if (index < 0 || index >= bytes.length) throw new Refused();
  return bytes[index];
}

type Handler = "skip" | "app" | "com" | "sof" | "dqt" | null;
const MARKERS = new Map<number, Handler>();
for (const marker of [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf, 0xde]) MARKERS.set(0xff00 | marker, "sof");
for (const marker of [0xc4, 0xcc, 0xda, 0xdc, 0xdd, 0xdf]) MARKERS.set(0xff00 | marker, "skip");
for (let marker = 0xe0; marker <= 0xef; marker += 1) MARKERS.set(0xff00 | marker, "app");
for (const marker of [0xc8, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9]) MARKERS.set(0xff00 | marker, null);
for (let marker = 0xf0; marker <= 0xfd; marker += 1) MARKERS.set(0xff00 | marker, null);
MARKERS.set(0xffdb, "dqt");
MARKERS.set(0xfffe, "com");

interface State { width: number; height: number; layers: number; mode: string; icc: Uint8Array[]; applist: Array<[string, Uint8Array]>; mp: Uint8Array | null }

function segment(reader: Reader): Uint8Array {
  const length = i16(reader.read(2)) - 2;
  return reader.safeRead(length);
}

function app(state: State, marker: number, s: Uint8Array) {
  state.applist.push([`APP${marker & 15}`, s]);
  if (marker === 0xffe0 && startsWith(s, "JFIF")) {
    i16(s, 5);
  } else if (marker === 0xffe2 && startsWith(s, "ICC_PROFILE\0")) {
    state.icc.push(s);
  } else if (marker === 0xffed && startsWith(s, "Photoshop 3.0\0")) {
    let offset = 14;
    try {
      while (startsWith(s.subarray(offset, offset + 4), "8BIM") && offset + 4 <= s.length) {
        offset += 4;
        i16(s, offset);
        offset += 2;
        const nameLength = s[offset];
        if (nameLength === undefined) throw new IndexError();
        offset += 1 + nameLength;
        offset += offset & 1;
        if (s.length < offset + 4) throw new Refused();
        const size = ((s[offset] << 24) >>> 0) + (s[offset + 1] << 16) + (s[offset + 2] << 8) + s[offset + 3];
        offset += 4;
        offset += size;
        offset += offset & 1;
      }
    } catch (error) {
      // struct.error ends the resource walk; IndexError escapes it.
      if (error instanceof IndexError) throw new Refused();
    }
  } else if (marker === 0xffee && startsWith(s, "Adobe")) {
    i16(s, 5);
  } else if (marker === 0xffe2 && startsWith(s, "MPF\0")) {
    state.mp = s.subarray(4);
  }
}

class IndexError extends Error {}

function sof(state: State, s: Uint8Array) {
  const height = i16(s, 1);
  const width = i16(s, 3);
  if (at(s, 0) !== 8) throw new Refused();
  const layers = at(s, 5);
  if (layers !== 1 && layers !== 3 && layers !== 4) throw new Refused();
  state.width = width;
  state.height = height;
  state.layers = layers;
  state.mode = layers === 1 ? "L" : layers === 3 ? "RGB" : "CMYK";
  if (state.icc.length) {
    const sorted = [...state.icc].sort(compareBytes);
    at(sorted[0], 13);
    state.icc = [];
  }
  for (let i = 6; i < s.length; i += 3) {
    const t = s.subarray(i, i + 3);
    at(t, 0);
    at(t, 1);
    at(t, 2);
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function dqt(s: Uint8Array) {
  let rest = s;
  while (rest.length) {
    const precision = Math.floor(rest[0] / 16) === 0 ? 1 : 2;
    const length = 1 + precision * 64;
    if (rest.length < length) throw new Refused();
    rest = rest.subarray(length);
  }
}

/** jpeg_factory's MPO promotion: "jpeg" keeps format JPEG, "mpo" becomes MPO, "refused" fails to open. */
function mpVerdict(state: State): "jpeg" | "mpo" | "refused" {
  const data = state.mp as Uint8Array;
  const head = data.subarray(0, 8);
  const little = startsWith(head, "II*\0");
  if (!little && !startsWith(head, "MM\0*")) return "jpeg";
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, little);
  const u32 = (offset: number) => view.getUint32(offset, little);
  if (head.length < 8) return "jpeg";
  const next = u32(4);
  const tags = new Map<number, { type: number; count: number; value: Uint8Array }>();
  const sizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };
  if (next + 2 <= data.length) {
    const count = u16(next);
    for (let i = 0; i < count; i += 1) {
      const entry = next + 2 + i * 12;
      if (entry + 12 > data.length) break;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const items = u32(entry + 4);
      const unit = sizes[type];
      if (!unit) continue;
      const size = unit * items;
      let value: Uint8Array;
      if (size > 4) {
        const offset = u32(entry + 8);
        value = data.subarray(offset, offset + size);
        if (value.length !== size) continue;
      } else {
        value = data.subarray(entry + 8, entry + 8 + size);
      }
      tags.set(tag, { type, count: items, value });
    }
  }
  const number = tags.get(0xb001);
  if (!number) return "jpeg";
  if ((number.type !== 3 && number.type !== 4) || number.count !== 1) return "jpeg";
  const images = number.type === 3 ? new DataView(number.value.buffer, number.value.byteOffset).getUint16(0, little)
    : new DataView(number.value.buffer, number.value.byteOffset).getUint32(0, little);
  const entries = tags.get(0xb002);
  if (!entries || entries.type !== 7) return images > 0 && !entries ? "jpeg" : images > 0 ? "jpeg" : images > 1 ? "mpo" : "jpeg";
  for (let i = 0; i < images; i += 1) {
    if (entries.value.length < i * 16 + 16) return "refused";
    const attribute = new DataView(entries.value.buffer, entries.value.byteOffset + i * 16).getUint32(0, little);
    if (((attribute >>> 24) & 7) !== 0) return "jpeg";
  }
  if (images <= 1) return "jpeg";
  if (state.applist.some(([name, content]) => name === "APP1" && Buffer.from(content).includes(" hdrgm:Version=\""))) return "jpeg";
  return "mpo";
}

/** The dimensions Pillow reported for a JPEG it opened as format "JPEG", or null. */
export function inspectJpeg(data: Uint8Array): { width: number; height: number } | null {
  try {
    const reader = new Reader(data);
    const prefix = reader.read(3);
    if (prefix.length < 3 || prefix[0] !== 0xff || prefix[1] !== 0xd8 || prefix[2] !== 0xff) return null;
    const state: State = { width: 0, height: 0, layers: 0, mode: "", icc: [], applist: [], mp: null };
    let s: Uint8Array = Uint8Array.of(0xff);
    while (true) {
      const first = at(s, 0);
      if (first !== 0xff) {
        s = reader.read(1);
        continue;
      }
      s = Uint8Array.of(0xff, ...reader.read(1));
      const marker = i16(s);
      if (MARKERS.has(marker)) {
        const handler = MARKERS.get(marker);
        if (handler === "skip") segment(reader);
        else if (handler === "app") app(state, marker, segment(reader));
        else if (handler === "com") state.applist.push(["COM", segment(reader)]);
        else if (handler === "sof") sof(state, segment(reader));
        else if (handler === "dqt") dqt(segment(reader));
        if (marker === 0xffda) break;
        s = reader.read(1);
      } else if (marker === 0xffff) {
        s = Uint8Array.of(0xff);
      } else if (marker === 0xff00) {
        s = reader.read(1);
      } else {
        return null;
      }
    }
    if (!state.mode || state.width <= 0 || state.height <= 0) return null;
    // Image.open refuses decompression bombs above twice MAX_IMAGE_PIXELS.
    if (state.width * state.height > 2 * 89478485) return null;
    if (state.mp && mpVerdict(state) !== "jpeg") return null;
    return { width: state.width, height: state.height };
  } catch (error) {
    if (error instanceof Refused || error instanceof IndexError || error instanceof RangeError) return null;
    throw error;
  }
}
