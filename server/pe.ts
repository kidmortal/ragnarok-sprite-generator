/**
 * Minimal PE reader plus recovery of the client's job tables.
 *
 * The tables are not static arrays. The client builds them with an unrolled
 * initialiser, thousands of instructions of the form
 *
 *   8B 06                     mov eax, [esi]
 *   C7 80 <disp32> <imm32>    mov dword ptr [eax+disp32], <string address>
 *
 * so the displacement is the job id times four and the immediate points at the
 * name. Every table is written through the same base register, which leaves
 * code order as the only structure: within one table a job id is written once,
 * so a repeat means the initialiser has moved on to the next table.
 */

import fs from "node:fs";

type Section = { name: string; va: number; vsize: number; raw: number; rawSize: number };
type Image = { bytes: Buffer; imageBase: number; sections: Section[] };

export function loadImage(file: string): Image {
  const bytes = fs.readFileSync(file);
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.readUInt32LE(pe) !== 0x00004550) throw new Error(`${file}: not a PE image`);
  const count = bytes.readUInt16LE(pe + 6);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const imageBase = bytes.readUInt32LE(pe + 24 + 28);
  const sections: Section[] = [];
  let offset = pe + 24 + optionalSize;
  for (let i = 0; i < count; i++) {
    sections.push({
      name: bytes.subarray(offset, offset + 8).toString("ascii").replace(/\0+$/, "") || `sec${i}`,
      vsize: bytes.readUInt32LE(offset + 8),
      va: bytes.readUInt32LE(offset + 12),
      rawSize: bytes.readUInt32LE(offset + 16),
      raw: bytes.readUInt32LE(offset + 20),
    });
    offset += 40;
  }
  return { bytes, imageBase, sections };
}

/** Virtual address to file offset, or -1 when it is not backed by raw data. */
function vaToOffset(img: Image, va: number): number {
  const rva = va - img.imageBase;
  for (const s of img.sections) {
    if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) {
      const delta = rva - s.va;
      return delta < s.rawSize ? s.raw + delta : -1;
    }
  }
  return -1;
}

const eucKr = new TextDecoder("euc-kr", { fatal: false });

/** A NUL-terminated string at a virtual address, if one is really there. */
function stringAt(img: Image, va: number): string | null {
  const start = vaToOffset(img, va);
  if (start < 0) return null;
  let end = start;
  while (end < img.bytes.length && img.bytes[end] !== 0 && end - start < 64) end++;
  if (end >= img.bytes.length || img.bytes[end] !== 0 || end === start) return null;
  const raw = img.bytes.subarray(start, end);
  for (const byte of raw) if (byte < 0x20) return null; // reject binary
  return eucKr.decode(raw).normalize("NFC");
}

export type ClientTable = Map<number, string>;

/** Every job table the initialiser builds, in the order it builds them. */
export function readJobTables(file: string): ClientTable[] {
  const img = loadImage(file);
  const stores: { at: number; index: number; value: string }[] = [];

  for (const s of img.sections) {
    if (!s.rawSize) continue;
    for (let o = s.raw; o < s.raw + s.rawSize - 10; o++) {
      if (img.bytes[o] !== 0xc7) continue;
      const modrm = img.bytes[o + 1];
      // mov [eax|esi|edi + disp32], imm32
      if (modrm !== 0x80 && modrm !== 0x86 && modrm !== 0x87) continue;
      const disp = img.bytes.readUInt32LE(o + 2);
      if (disp % 4 !== 0 || disp > 0x8000) continue;
      const value = stringAt(img, img.bytes.readUInt32LE(o + 6));
      if (value === null) continue;
      stores.push({ at: o, index: disp / 4, value });
    }
  }
  stores.sort((a, b) => a.at - b.at);

  const tables: ClientTable[] = [];
  let current: ClientTable = new Map();
  let previous = stores[0]?.at ?? 0;
  for (const store of stores) {
    // A repeated id, or a long jump in the code, starts the next table.
    if (current.size && (current.has(store.index) || store.at - previous > 4096)) {
      tables.push(current);
      current = new Map();
    }
    current.set(store.index, store.value);
    previous = store.at;
  }
  if (current.size) tables.push(current);
  return tables.filter((t) => t.size >= 40);
}

/** How well a recovered table agrees with a line-indexed reference table. */
export function agreement(table: ClientTable, reference: string[]): number {
  let same = 0;
  for (const [index, value] of table) if (reference[index] === value) same++;
  return same / table.size;
}
