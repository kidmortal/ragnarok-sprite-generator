/**
 * Minimal ZIP writer, store method only.
 *
 * A batch export is hundreds of files and a browser will not sit still for
 * hundreds of downloads. Everything going in is already a PNG or a short JSON,
 * so deflating would buy almost nothing and cost a compression library -- the
 * same trade `apng.ts` makes, and its `crc32` is reused here rather than
 * carrying a second copy of the table.
 */

import { crc32 } from "./apng";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

/** Bit 11: the name is UTF-8, which the Korean sprite names need. */
const FLAG_UTF8 = 0x0800;

/** Zip64 is out of scope; a 4GB export is a mistake rather than a use case. */
const MAX_SIZE = 0xffffffff;

type Entry = {
  name: Uint8Array;
  data: Uint8Array;
  crc: number;
  offset: number;
};

class Writer {
  readonly bytes: Uint8Array<ArrayBuffer>;
  private offset = 0;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
  }

  /** How far in we are, which is what a central directory entry records. */
  get position(): number {
    return this.offset;
  }

  u16(value: number): void {
    this.bytes[this.offset++] = value & 0xff;
    this.bytes[this.offset++] = (value >>> 8) & 0xff;
  }

  u32(value: number): void {
    this.u16(value & 0xffff);
    this.u16((value >>> 16) & 0xffff);
  }

  raw(value: Uint8Array): void {
    this.bytes.set(value, this.offset);
    this.offset += value.length;
  }
}

/** DOS date/time, which is all a zip entry can carry. */
function dosStamp(date: Date): { time: number; date: number } {
  return {
    time:
      (Math.floor(date.getSeconds() / 2) & 0x1f) |
      ((date.getMinutes() & 0x3f) << 5) |
      ((date.getHours() & 0x1f) << 11),
    date:
      (date.getDate() & 0x1f) |
      (((date.getMonth() + 1) & 0x0f) << 5) |
      (((date.getFullYear() - 1980) & 0x7f) << 9),
  };
}

/**
 * Collects files and emits one archive.
 *
 * Blobs are read into memory as they are added rather than held as Blobs and
 * read at the end, so a caller can drop its canvases as it goes -- which a
 * few-hundred-sprite export has to do.
 */
export class ZipBuilder {
  private entries: Entry[] = [];
  private size = 0;

  async add(path: string, content: Blob | string): Promise<void> {
    const data =
      typeof content === "string"
        ? new TextEncoder().encode(content)
        : new Uint8Array(await content.arrayBuffer());

    const name = new TextEncoder().encode(path);
    this.entries.push({ name, data, crc: crc32(data), offset: 0 });

    // local header + central directory record, both of which carry the name
    this.size += 30 + name.length + data.length + 46 + name.length;
    if (this.size > MAX_SIZE) {
      throw new Error("archive would exceed 4GB; export fewer parts at a time");
    }
  }

  get count(): number {
    return this.entries.length;
  }

  /** Approximate archive size so far, for a progress readout. */
  get bytes(): number {
    return this.size;
  }

  build(): Blob {
    const stamp = dosStamp(new Date());
    const writer = new Writer(this.size + 22);

    for (const entry of this.entries) {
      entry.offset = writer.position;
      writer.u32(LOCAL_HEADER);
      writer.u16(20); // version needed
      writer.u16(FLAG_UTF8);
      writer.u16(0); // stored
      writer.u16(stamp.time);
      writer.u16(stamp.date);
      writer.u32(entry.crc);
      writer.u32(entry.data.length);
      writer.u32(entry.data.length);
      writer.u16(entry.name.length);
      writer.u16(0); // no extra field
      writer.raw(entry.name);
      writer.raw(entry.data);
    }

    const centralStart = writer.position;

    for (const entry of this.entries) {
      writer.u32(CENTRAL_HEADER);
      writer.u16(20); // version made by
      writer.u16(20); // version needed
      writer.u16(FLAG_UTF8);
      writer.u16(0); // stored
      writer.u16(stamp.time);
      writer.u16(stamp.date);
      writer.u32(entry.crc);
      writer.u32(entry.data.length);
      writer.u32(entry.data.length);
      writer.u16(entry.name.length);
      writer.u16(0); // extra
      writer.u16(0); // comment
      writer.u16(0); // disk number
      writer.u16(0); // internal attributes
      writer.u32(0); // external attributes
      writer.u32(entry.offset);
      writer.raw(entry.name);
    }

    const centralSize = writer.position - centralStart;

    writer.u32(END_OF_CENTRAL);
    writer.u16(0); // this disk
    writer.u16(0); // disk with the central directory
    writer.u16(this.entries.length);
    writer.u16(this.entries.length);
    writer.u32(centralSize);
    writer.u32(centralStart);
    writer.u16(0); // comment

    return new Blob([writer.bytes], { type: "application/zip" });
  }
}
