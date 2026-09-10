import { context2d, createCanvas, createImageData, type SheetCanvas } from "./canvas";

/**
 * Parser for Ragnarok-style .spr sprite files.
 *
 * Layout: "SP" magic, version (minor, major), indexed frame count, and -- from
 * version 2.0 -- an rgba frame count. Indexed frames are raw palette indices,
 * or RLE-compressed on zero-bytes from 2.1. The 1024-byte palette sits at the
 * very end of the file; palette index 0 is transparent.
 */

export type SprFrame = {
  index: number;
  width: number;
  height: number;
  /** RGBA pixels, top-down, ready for putImageData. */
  pixels: Uint8ClampedArray<ArrayBuffer>;
  kind: "indexed" | "rgba";
};

export type Spr = {
  version: number;
  frames: SprFrame[];
  indexedCount: number;
  rgbaCount: number;
  palette: Uint8Array | null;
};

class Reader {
  offset = 0;
  constructor(readonly view: DataView) {}
  u8() {
    return this.view.getUint8(this.offset++);
  }
  u16() {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
}

export function parseSpr(buffer: ArrayBuffer): Spr {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x53 || bytes[1] !== 0x50) {
    throw new Error("Not a .spr file (missing SP magic)");
  }
  const version = bytes[3] + bytes[2] / 10;
  const r = new Reader(new DataView(buffer));
  r.offset = 4;

  const indexedCount = r.u16();
  const rgbaCount = version >= 2.0 ? r.u16() : 0;

  const palette =
    indexedCount > 0 && buffer.byteLength >= 1024
      ? bytes.subarray(buffer.byteLength - 1024)
      : null;

  const frames: SprFrame[] = [];


  for (let i = 0; i < indexedCount; i++) {
    const width = r.u16();
    const height = r.u16();
    const size = width * height;
    const indices = new Uint8Array(size);

    if (version >= 2.1) {
      const compressed = r.u16();
      const end = r.offset + compressed;
      let p = 0;
      while (r.offset < end && p < size) {
        const value = r.u8();
        if (value === 0) {
          const run = r.u8();
          // A zero run of 0 still consumes one pixel in practice.
          for (let n = 0; n < Math.max(run, 1) && p < size; n++) indices[p++] = 0;
        } else {
          indices[p++] = value;
        }
      }
      r.offset = end;
    } else {
      for (let p = 0; p < size; p++) indices[p] = r.u8();
    }

    frames.push({
      index: frames.length,
      width,
      height,
      pixels: indexedToRgba(indices, palette),
      kind: "indexed",
    });
  }

  for (let i = 0; i < rgbaCount; i++) {
    const width = r.u16();
    const height = r.u16();
    const size = width * height;
    const pixels = new Uint8ClampedArray(size * 4);
    // Stored as ABGR, bottom-up.
    for (let row = height - 1; row >= 0; row--) {
      for (let col = 0; col < width; col++) {
        const dst = (row * width + col) * 4;
        const a = r.u8();
        const b = r.u8();
        const g = r.u8();
        const red = r.u8();
        pixels[dst] = red;
        pixels[dst + 1] = g;
        pixels[dst + 2] = b;
        pixels[dst + 3] = a;
      }
    }
    frames.push({ index: frames.length, width, height, pixels, kind: "rgba" });
  }

  return { version, frames, indexedCount, rgbaCount, palette: palette ?? null };
}

function indexedToRgba(indices: Uint8Array, palette: Uint8Array | null): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(indices.length * 4);
  for (let p = 0; p < indices.length; p++) {
    const idx = indices[p];
    const dst = p * 4;
    if (idx === 0 || !palette) continue; // index 0 is the transparent color
    out[dst] = palette[idx * 4];
    out[dst + 1] = palette[idx * 4 + 1];
    out[dst + 2] = palette[idx * 4 + 2];
    out[dst + 3] = 255;
  }
  return out;
}

export function frameToCanvas(frame: SprFrame): SheetCanvas {
  const canvas = createCanvas(frame.width, frame.height);
  const ctx = context2d(canvas);
  if (frame.width && frame.height) {
    ctx.putImageData(createImageData(frame.pixels, frame.width, frame.height), 0, 0);
  }
  return canvas;
}
