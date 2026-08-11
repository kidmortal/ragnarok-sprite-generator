/**
 * Builds an animated PNG from a list of equally sized canvases.
 *
 * Rather than pulling in a deflate implementation, this lets the browser encode
 * each frame to a normal PNG and then re-assembles the pieces: the IHDR of the
 * first frame, an acTL, and per frame an fcTL plus the frame's own IDAT data
 * (as IDAT for frame 0, as fdAT for the rest). Frames are full-size and use
 * dispose=background/blend=source, so no inter-frame math is needed.
 */

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

type Chunk = { type: string; data: Uint8Array };

function readChunks(png: Uint8Array): Chunk[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Chunk[] = [];
  let offset = 8; // skip signature
  while (offset + 8 <= png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length; // length + type + data + crc
    if (type === "IEND") break;
  }
  return chunks;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("canvas encoding failed"));
      blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
    }, "image/png");
  });
}

export type ApngOptions = {
  /** Frame delay in milliseconds. */
  delay: number;
  /** 0 loops forever. */
  plays?: number;
};

export async function encodeApng(
  canvases: HTMLCanvasElement[],
  options: ApngOptions
): Promise<Blob> {
  if (canvases.length === 0) throw new Error("no frames to encode");

  const width = canvases[0].width;
  const height = canvases[0].height;
  const framePngs = await Promise.all(canvases.map(canvasToPngBytes));

  const parts: Uint8Array[] = [SIGNATURE];
  let sequence = 0;

  const fcTL = (index: number) => {
    const data = new Uint8Array(26);
    const view = new DataView(data.buffer);
    view.setUint32(0, sequence++);
    view.setUint32(4, width);
    view.setUint32(8, height);
    view.setUint32(12, 0); // x offset
    view.setUint32(16, 0); // y offset
    view.setUint16(20, Math.max(Math.round(options.delay), 1)); // delay numerator (ms)
    view.setUint16(22, 1000); // denominator
    data[24] = 1; // dispose: background
    data[25] = 0; // blend: source
    void index;
    return makeChunk("fcTL", data);
  };

  framePngs.forEach((png, index) => {
    const chunks = readChunks(png);

    if (index === 0) {
      const ihdr = chunks.find((c) => c.type === "IHDR");
      if (!ihdr) throw new Error("frame 0 has no IHDR");
      parts.push(makeChunk("IHDR", ihdr.data));

      const actl = new Uint8Array(8);
      const view = new DataView(actl.buffer);
      view.setUint32(0, framePngs.length);
      view.setUint32(4, options.plays ?? 0);
      parts.push(makeChunk("acTL", actl));
    }

    parts.push(fcTL(index));

    for (const chunk of chunks) {
      if (chunk.type !== "IDAT") continue;
      if (index === 0) {
        parts.push(makeChunk("IDAT", chunk.data));
      } else {
        // fdAT is an IDAT payload prefixed with its sequence number.
        const data = new Uint8Array(4 + chunk.data.length);
        new DataView(data.buffer).setUint32(0, sequence++);
        data.set(chunk.data, 4);
        parts.push(makeChunk("fdAT", data));
      }
    }
  });

  parts.push(makeChunk("IEND", new Uint8Array(0)));
  return new Blob(parts as BlobPart[], { type: "image/png" });
}

export type Sheet = {
  blob: Blob;
  columns: number;
  rows: number;
  frameWidth: number;
  frameHeight: number;
};

/** Pack frames into a grid spritesheet. */
export async function encodeSpritesheet(
  canvases: HTMLCanvasElement[],
  columns = canvases.length
): Promise<Sheet> {
  if (canvases.length === 0) throw new Error("no frames to pack");

  const frameWidth = canvases[0].width;
  const frameHeight = canvases[0].height;
  const cols = Math.max(Math.min(columns, canvases.length), 1);
  const rows = Math.ceil(canvases.length / cols);

  const sheet = document.createElement("canvas");
  sheet.width = frameWidth * cols;
  sheet.height = frameHeight * rows;
  const ctx = sheet.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  canvases.forEach((canvas, i) => {
    ctx.drawImage(canvas, (i % cols) * frameWidth, Math.floor(i / cols) * frameHeight);
  });

  const blob = await new Promise<Blob>((resolve, reject) =>
    sheet.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas encoding failed"))), "image/png")
  );

  return { blob, columns: cols, rows, frameWidth, frameHeight };
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
