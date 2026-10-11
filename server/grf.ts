/**
 * Reads a GRF archive in place: its file table, and any one entry's bytes.
 *
 * Two layouts are handled. Version 0x200 is what every client ships:
 * "Master of Magic" magic, 32-bit offsets. Version 0x300 is GRF Editor's
 * extension for archives past 4 GB: 64-bit offsets, a 4-byte pad before the
 * table sizes, and whatever magic the packer felt like ("Event Horizon").
 *
 * Entries are zlib streams, some of them scrambled first. Gravity's scheme is a
 * single round of DES with an all-zero key, applied to the first 20 blocks
 * (flag 4) or, for flag 2, to every `cycle`-th block after that too, with every
 * eighth remaining block byte-shuffled instead. Ported from rAthena's grfio.c.
 */

import fs from "node:fs";
import zlib from "node:zlib";

export const GRF_HEADER = 46;

export type GrfEntry = {
  /** Path as stored, backslashes and all, in the archive's own (EUC-KR) bytes. */
  rawName: Buffer;
  /** `rawName` decoded to a string, backslashes turned into `/`. */
  name: string;
  /** False when `rawName` is not EUC-KR and `name` is a Latin-1 stand-in for it. */
  nameDecoded: boolean;
  /** Length of the zlib stream. */
  compressedSize: number;
  /** Bytes actually occupied on disk: `compressedSize` rounded up to 8 when encrypted. */
  alignedSize: number;
  /** Length after inflating. */
  size: number;
  flags: number;
  /** Offset of the data past the 46-byte header. */
  offset: number;
};

export const FLAG_FILE = 1;
export const FLAG_MIXCRYPT = 2;
export const FLAG_DES_HEADER = 4;

const eucKr = new TextDecoder("euc-kr", { fatal: true });

/** A name string for an entry, EUC-KR when it decodes and Latin-1 when it does not. */
export function decodeName(raw: Buffer): { name: string; decoded: boolean } {
  try {
    return { name: eucKr.decode(raw).replaceAll("\\", "/"), decoded: true };
  } catch {
    return { name: raw.toString("latin1").replaceAll("\\", "/"), decoded: false };
  }
}

/** The file table, in archive order. */
export function readTable(fd: number): { version: number; entries: GrfEntry[] } {
  const header = Buffer.alloc(GRF_HEADER);
  fs.readSync(fd, header, 0, GRF_HEADER, 0);
  const version = header.readUInt32LE(42);
  let tableOffset: number;
  let offsetBytes: 4 | 8;
  let sizesPad: number;
  if (version === 0x200) {
    tableOffset = header.readUInt32LE(30);
    offsetBytes = 4;
    sizesPad = 0;
  } else if (version === 0x300) {
    tableOffset = Number(header.readBigUInt64LE(30));
    offsetBytes = 8;
    sizesPad = 4;
  } else {
    throw new Error(`unsupported GRF version 0x${version.toString(16)}`);
  }

  const sizes = Buffer.alloc(8);
  fs.readSync(fd, sizes, 0, 8, GRF_HEADER + tableOffset + sizesPad);
  const compressed = Buffer.alloc(sizes.readUInt32LE(0));
  fs.readSync(fd, compressed, 0, compressed.length, GRF_HEADER + tableOffset + sizesPad + 8);
  const table = zlib.inflateSync(compressed);

  const entries: GrfEntry[] = [];
  let pos = 0;
  while (pos < table.length) {
    const end = table.indexOf(0, pos);
    const rawName = Buffer.from(table.subarray(pos, end));
    pos = end + 1;
    const compressedSize = table.readUInt32LE(pos);
    const alignedSize = table.readUInt32LE(pos + 4);
    const size = table.readUInt32LE(pos + 8);
    const flags = table[pos + 12];
    const offset =
      offsetBytes === 4 ? table.readUInt32LE(pos + 13) : Number(table.readBigUInt64LE(pos + 13));
    pos += 13 + offsetBytes;
    const { name, decoded } = decodeName(rawName);
    entries.push({
      rawName,
      name,
      nameDecoded: decoded,
      compressedSize,
      alignedSize,
      size,
      flags,
      offset,
    });
  }
  return { version, entries };
}

/** The inflated bytes of one entry. */
export function readEntry(fd: number, entry: GrfEntry): Buffer {
  const packed = Buffer.alloc(entry.alignedSize);
  fs.readSync(fd, packed, 0, packed.length, GRF_HEADER + entry.offset);
  if (entry.flags & FLAG_MIXCRYPT) {
    decodeFull(packed, entry.compressedSize);
  } else if (entry.flags & FLAG_DES_HEADER) {
    decodeHeader(packed);
  }
  const out = zlib.inflateSync(packed.subarray(0, entry.compressedSize));
  if (out.length !== entry.size) {
    throw new Error(`${entry.name}: inflated to ${out.length} bytes, table says ${entry.size}`);
  }
  return out;
}

// --- Gravity's DES ---------------------------------------------------------

// Standard DES tables, 1-based bit positions as in the FIPS 46 spec.
// prettier-ignore
const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17,  9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];
// prettier-ignore
const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41,  9, 49, 17, 57, 25,
];
// prettier-ignore
const E = [
  32,  1,  2,  3,  4,  5,  4,  5,  6,  7,  8,  9,
   8,  9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25,
  24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32,  1,
];
// prettier-ignore
const P = [
  16,  7, 20, 21, 29, 12, 28, 17,  1, 15, 23, 26,  5, 18, 31, 10,
   2,  8, 24, 14, 32, 27,  3,  9, 19, 13, 30,  6, 22, 11,  4, 25,
];
// prettier-ignore
const S = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
    0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
   15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
    3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
   13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
   13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
   13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
    1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [ 7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
   13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
   10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
    3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [ 2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
   14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
   11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
   10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
    4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [ 4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
   13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
    6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
    1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
    2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

const bit = (buf: Uint8Array, i: number) => (buf[i >> 3] >> (7 - (i & 7))) & 1;

function permute(src: Uint8Array, table: number[]): Uint8Array {
  const out = new Uint8Array(table.length / 8);
  for (let i = 0; i < table.length; i++) {
    if (bit(src, table[i] - 1)) out[i >> 3] |= 0x80 >> (i & 7);
  }
  return out;
}

/** One DES round with a zero subkey, so `L ^= f(R)` and R stays; its own inverse. */
function desBlock(block: Uint8Array): void {
  const ip = permute(block, IP);
  const r = ip.subarray(4, 8);
  const expanded = permute(r, E);
  const sboxed = new Uint8Array(4);
  for (let box = 0; box < 8; box++) {
    const base = box * 6;
    const row = (bit(expanded, base) << 1) | bit(expanded, base + 5);
    const col =
      (bit(expanded, base + 1) << 3) |
      (bit(expanded, base + 2) << 2) |
      (bit(expanded, base + 3) << 1) |
      bit(expanded, base + 4);
    const v = S[box][row * 16 + col];
    sboxed[box >> 1] |= box & 1 ? v : v << 4;
  }
  const f = permute(sboxed, P);
  for (let i = 0; i < 4; i++) ip[i] ^= f[i];
  block.set(permute(ip, FP));
}

// prettier-ignore
const SUBSTITUTE: Record<number, number> = {
  0x00: 0x2b, 0x2b: 0x00, 0x6c: 0x80, 0x01: 0x68, 0x68: 0x01, 0x48: 0x77, 0x60: 0xff,
  0x77: 0x48, 0xb9: 0xc0, 0xc0: 0xb9, 0xfe: 0xeb, 0xeb: 0xfe, 0x80: 0x6c, 0xff: 0x60,
};

function shuffleBlock(block: Uint8Array): void {
  const [b0, b1, b2, b3, b4, b5, b6, b7] = block;
  block[0] = b3;
  block[1] = b4;
  block[2] = b6;
  block[3] = b0;
  block[4] = b1;
  block[5] = b2;
  block[6] = b5;
  block[7] = SUBSTITUTE[b7] ?? b7;
}

/** Flag 4: only the first 20 blocks went through DES. */
function decodeHeader(buf: Buffer): void {
  const blocks = Math.min(20, buf.length >> 3);
  for (let p = 0; p < blocks; p++) desBlock(buf.subarray(p * 8, p * 8 + 8));
}

/** Flag 2: DES on the first 20 blocks, then on every `cycle`-th; every eighth other block shuffled. */
function decodeFull(buf: Buffer, compressedSize: number): void {
  const digits = String(compressedSize).length;
  const cycle = digits < 3 ? 1 : digits < 5 ? digits + 1 : digits < 7 ? digits + 9 : digits + 15;
  const blocks = buf.length >> 3;
  let p = 0;
  for (; p < 20 && p < blocks; p++) desBlock(buf.subarray(p * 8, p * 8 + 8));
  for (let j = -1; p < blocks; p++) {
    const block = buf.subarray(p * 8, p * 8 + 8);
    if (p % cycle === 0) {
      desBlock(block);
      continue;
    }
    if (++j === 7) {
      shuffleBlock(block);
      j = 0;
    }
  }
}
