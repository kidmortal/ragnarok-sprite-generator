/**
 * Just enough of a Lua 5.1 bytecode reader to recover the constant tables the
 * Ragnarok client ships, compiled, in `luafiles514`.
 *
 * The tables are written as `SomeTable[JOBID.JT_THING] = "value"`, which
 * compiles to GETGLOBAL/GETTABLE/LOADK feeding a SETTABLE, so the instruction
 * stream is walked with a small register file that remembers what each register
 * last held. A table is filled before it is published, so each NEWTABLE gets an
 * id and the SETGLOBAL that names it supplies the name afterwards.
 *
 * Only the opcodes those table definitions use are interpreted; everything else
 * is skipped, which is why this is a reader and not an emulator.
 */

import fs from "node:fs";

type Constant = { type: "nil" | "bool" | "number" | "string"; value: unknown };
type Proto = { code: number[]; constants: Constant[]; protos: Proto[] };

const utf8 = new TextDecoder("utf-8", { fatal: false });
let eucKr: TextDecoder | null = null;
try {
  eucKr = new TextDecoder("euc-kr", { fatal: true });
} catch {
  eucKr = null;
}

/** Client strings are EUC-KR where they are not plain ASCII. */
function decodeString(raw: Buffer): string {
  const asUtf8 = utf8.decode(raw);
  if (!asUtf8.includes("�")) return asUtf8.normalize("NFC");
  if (eucKr) {
    try {
      return eucKr.decode(raw).normalize("NFC");
    } catch {
      /* fall through */
    }
  }
  return asUtf8;
}

class Reader {
  offset = 0;
  constructor(readonly bytes: Buffer) {}
  u8() {
    return this.bytes.readUInt8(this.offset++);
  }
  i32() {
    const v = this.bytes.readInt32LE(this.offset);
    this.offset += 4;
    return v;
  }
  u32() {
    const v = this.bytes.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }
  f64() {
    const v = this.bytes.readDoubleLE(this.offset);
    this.offset += 8;
    return v;
  }
  /** Lua strings are length-prefixed and NUL-terminated; the NUL is dropped. */
  string(): Buffer | null {
    const length = this.u32();
    if (length === 0) return null;
    const value = this.bytes.subarray(this.offset, this.offset + length - 1);
    this.offset += length;
    return value;
  }
}

function readProto(r: Reader): Proto {
  r.string(); // source
  r.i32();
  r.i32(); // line defined, last line defined
  r.u8();
  r.u8();
  r.u8();
  r.u8(); // upvalues, params, is_vararg, stack size

  const code: number[] = [];
  for (let n = r.i32(), i = 0; i < n; i++) code.push(r.u32());

  const constants: Constant[] = [];
  for (let n = r.i32(), i = 0; i < n; i++) {
    const type = r.u8();
    if (type === 0) constants.push({ type: "nil", value: null });
    else if (type === 1) constants.push({ type: "bool", value: r.u8() !== 0 });
    else if (type === 3) constants.push({ type: "number", value: r.f64() });
    else if (type === 4) {
      const raw = r.string();
      constants.push({ type: "string", value: raw ? decodeString(raw) : "" });
    } else throw new Error(`unknown Lua constant type ${type}`);
  }

  const protos: Proto[] = [];
  for (let n = r.i32(), i = 0; i < n; i++) protos.push(readProto(r));

  // Debug sections: line info, locals, upvalue names.
  for (let n = r.i32(), i = 0; i < n; i++) r.i32();
  for (let n = r.i32(), i = 0; i < n; i++) {
    r.string();
    r.i32();
    r.i32();
  }
  for (let n = r.i32(), i = 0; i < n; i++) r.string();

  return { code, constants, protos };
}

function loadChunk(file: string): Proto {
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 4).toString("binary") !== "\x1bLua" || bytes[4] !== 0x51) {
    throw new Error(`${file}: not Lua 5.1 bytecode`);
  }
  const r = new Reader(bytes);
  r.offset = 12; // header
  return readProto(r);
}

const OP_LOADK = 1;
const OP_GETGLOBAL = 5;
const OP_GETTABLE = 6;
const OP_SETGLOBAL = 7;
const OP_SETTABLE = 9;
const OP_NEWTABLE = 10;

type Slot = { kind: "constant" | "global" | "index" | "table"; value: unknown; id?: number };

/** A table stored as another table's value, resolved after the walk. */
type Nested = { nestedTable: number };
const isNested = (value: unknown): value is Nested =>
  typeof value === "object" && value !== null && "nestedTable" in value;

export type LuaTable = Map<string, unknown>;

/**
 * Every global table the chunk defines, as `name -> (key -> value)`.
 *
 * Keys are stringified: a key written `JOBID.JT_NOVICE` comes back as exactly
 * that, since the constant it resolves to lives in a different chunk.
 */
export function readTables(file: string): Map<string, LuaTable> {
  const entriesById = new Map<number, Map<string, unknown>>();
  const nameById = new Map<number, string>();
  let nextId = 0;

  const visit = (proto: Proto) => {
    const registers: (Slot | undefined)[] = [];
    const rk = (index: number): Slot =>
      index >= 256
        ? { kind: "constant", value: proto.constants[index - 256]?.value }
        : registers[index] ?? { kind: "constant", value: undefined };

    for (const instruction of proto.code) {
      const op = instruction & 0x3f;
      const a = (instruction >>> 6) & 0xff;
      const c = (instruction >>> 14) & 0x1ff;
      const b = (instruction >>> 23) & 0x1ff;
      const bx = (instruction >>> 14) & 0x3ffff;

      if (op === OP_LOADK) {
        registers[a] = { kind: "constant", value: proto.constants[bx]?.value };
      } else if (op === OP_GETGLOBAL) {
        registers[a] = { kind: "global", value: proto.constants[bx]?.value };
      } else if (op === OP_NEWTABLE) {
        const id = nextId++;
        entriesById.set(id, new Map());
        registers[a] = { kind: "table", value: null, id };
      } else if (op === OP_GETTABLE) {
        registers[a] = { kind: "index", value: `${registers[b]?.value ?? "?"}.${rk(c).value}` };
      } else if (op === OP_SETGLOBAL) {
        const slot = registers[a];
        if (slot?.kind === "table" && slot.id !== undefined) {
          nameById.set(slot.id, String(proto.constants[bx]?.value));
        }
      } else if (op === OP_SETTABLE) {
        const target = registers[a];
        if (target?.kind === "table" && target.id !== undefined) {
          // A value that is itself a table is kept as a reference and resolved
          // below: item tables are one row of fields per item id, and the row
          // is built and filled before it is assigned into its parent.
          const value = rk(c);
          entriesById
            .get(target.id)!
            .set(
              String(rk(b).value),
              value.kind === "table" && value.id !== undefined
                ? ({ nestedTable: value.id } satisfies Nested)
                : value.value
            );
        }
      }
    }
    for (const sub of proto.protos) visit(sub);
  };
  visit(loadChunk(file));

  // Splice nested tables into their parents. Generated data has no cycles, but
  // a malformed chunk should not be able to spin here.
  const resolve = (entries: LuaTable, seen: Set<number>): LuaTable => {
    for (const [key, value] of entries) {
      if (!isNested(value)) continue;
      const id = value.nestedTable;
      const child = entriesById.get(id);
      entries.set(key, child && !seen.has(id) ? resolve(child, new Set(seen).add(id)) : null);
    }
    return entries;
  };

  const tables = new Map<string, LuaTable>();
  for (const [id, entries] of entriesById) {
    const name = nameById.get(id);
    if (name && entries.size) tables.set(name, resolve(entries, new Set([id])));
  }
  return tables;
}
