/**
 * Pet identity, derived from the sprite folder rather than a vendored table.
 *
 * The Ragnarok data has no pet folder. A pet is an ordinary monster sprite in
 * `몬스터/` that *also* ships an accessory action file named
 * `{pet}_{액세서리}.act` -- the same pet animated wearing its equipment. That
 * act indexes into the pet's own `.spr` and, for most pets, has no `.spr` of
 * its own: a pet is one sprite with two acts, not two sprites.
 *
 * Two things mark a monster as tameable, and a sprite needs either one:
 *
 * - it carries an accessory act, as above;
 * - its act holds more than the five action groups (idle, walk, attack, hurt,
 *   die) an ordinary monster has. Groups past those are the pet-only idle and
 *   performance animations, and only a pet is ever asked to play them.
 *
 * Neither alone is enough: Drops and Poporing are pets whose accessory sprites
 * this data set does not carry, while a few bosses have a sixth and seventh
 * group for extra attacks. Both marks re-derive themselves for whichever client
 * version was extracted.
 *
 * Some pets carry neither mark, because nothing in their sprite says "pet" --
 * the Puzzle & Dragons collaboration pets have the five ordinary monster action
 * groups and no accessory at all. Those come from `resolver-data/pet_names.txt`,
 * a copy of rAthena's pet_db, which also supplies English names for the
 * accessories the folder can only spell in Korean.
 *
 * This does its own directory read rather than reusing `listParts`, which pairs
 * a `.spr` with the `.act` of the same name and so cannot see the act-only
 * accessory files this is looking for.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { displayName, encodeId, join, resolveId, ROOT } from "./paths.ts";
import { label } from "./translate.ts";

export type PetAccessory = { name: string; label: string; sprId: string; actId: string };
export type PetEntry = {
  name: string;
  /** The name in English, or "" when it needs none. Display only. */
  label: string;
  sprId: string;
  actId: string;
  /** The same pet wearing its equipment, or null when the data has no such act. */
  accessory: PetAccessory | null;
};

const MONSTERS = "몬스터";

/** A name is an accessory variant only if what follows the pet is Korean. */
const HANGUL = /[가-힣]/;

/**
 * Action slots an act needs before its extra groups read as pet animations
 * rather than a boss's extra attacks: eight groups of eight facings. Ordinary
 * monsters have five groups, bosses occasionally six or seven.
 */
const MIN_PET_ACTIONS = 64;

const TABLE = path.resolve(ROOT, "server/resolver-data/pet_names.txt");

/**
 * rAthena's pet roster: monster aegis name to accessory item name, tab
 * separated, the accessory blank when the pet has none. Aegis names are not
 * sprite file names, so callers resolve them against the folder.
 */
async function petTable(): Promise<Map<string, string>> {
  const table = new Map<string, string>();
  let text: string;
  try {
    text = await fs.readFile(TABLE, "utf-8");
  } catch {
    return table; // the table is a supplement; the marks still work without it
  }
  for (const line of text.split("\n")) {
    const [mob, equip = ""] = line.split("\t");
    if (mob.trim()) table.set(mob.trim().toLowerCase(), equip.trim());
  }
  return table;
}

/** `Tiny_Egg_Shell` is how the item db spells it; a label should not be. */
const itemLabel = (aegis: string) => aegis.replace(/_/g, " ");

/**
 * Highest sprite index any layer of an act draws.
 *
 * An accessory act names no sprite file, so this is what says which `.spr` it
 * was authored against: `poring_책가방.act` reaches frame 48, and `poring.spr`
 * holds 49 frames while `poring_.spr` -- a different sprite that merely shares
 * the prefix -- holds 47.
 */
function maxSprIndex(buf: Buffer): number {
  if (buf.length < 16 || buf[0] !== 0x41 || buf[1] !== 0x43) return -1;
  const version = buf[3] + buf[2] / 10;
  let o = 4;
  const actionCount = buf.readUInt16LE(o);
  o += 2 + 10; // count, then reserved

  let max = -1;
  for (let a = 0; a < actionCount; a++) {
    const motionCount = buf.readUInt32LE(o);
    o += 4;
    for (let m = 0; m < motionCount; m++) {
      o += 32; // two unused bounding ranges
      const layerCount = buf.readUInt32LE(o);
      o += 4;
      for (let l = 0; l < layerCount; l++) {
        const sprIndex = buf.readInt32LE(o + 8); // after x, y
        if (sprIndex > max) max = sprIndex;
        o += 16; // x, y, sprIndex, mirror
        if (version >= 2.0) {
          o += 4; // rgba
          o += version >= 2.4 ? 8 : 4; // scaleX, and scaleY once it is its own field
          o += 8; // rotation, sprType
          if (version >= 2.5) o += 8; // width, height
        }
      }
      if (version >= 2.0) o += 4; // event id
      if (version >= 2.3) {
        const anchorCount = buf.readInt32LE(o);
        o += 4 + anchorCount * 16;
      }
    }
  }
  return max;
}

/** Action slots in an `.act`, from its header alone. Each group is 8 facings. */
function actActionCount(buf: Buffer): number {
  if (buf.length < 6 || buf[0] !== 0x41 || buf[1] !== 0x43) return 0;
  return buf.readUInt16LE(4);
}

/** Frames in a `.spr`, from its header alone -- no pixels are decoded. */
function sprFrameCount(buf: Buffer): number {
  if (buf.length < 8 || buf[0] !== 0x53 || buf[1] !== 0x50) return 0;
  const version = buf[3] + buf[2] / 10;
  return buf.readUInt16LE(4) + (version >= 2.0 ? buf.readUInt16LE(6) : 0);
}

export async function listPets(): Promise<PetEntry[]> {
  const dir = Buffer.from(MONSTERS);
  let names: Buffer[];
  try {
    names = (await fs.readdir(resolveId(encodeId(dir)), {
      encoding: "buffer" as never,
    })) as unknown as Buffer[];
  } catch {
    return [];
  }

  // Raw bytes are the identity, but pairing is done on the decoded names.
  const acts = new Map<string, Buffer>();
  const sprs = new Map<string, Buffer>();
  for (const name of names) {
    const display = displayName(name);
    const lower = display.toLowerCase();
    if (lower.endsWith(".act")) acts.set(display.slice(0, -4), name);
    else if (lower.endsWith(".spr")) sprs.set(display.slice(0, -4), name);
  }

  // Longest prefix first, so `baphomet_뼉다구모자` is offered `baphomet_`
  // (Bapho Jr.) before the full-sized `baphomet` it also starts with.
  const bases = [...sprs.keys()].filter((name) => acts.has(name)).sort((a, b) => b.length - a.length);
  /** First bytes of a file in the folder, which is all a header needs. */
  const headOf = async (file: Buffer, bytes: number): Promise<Buffer> => {
    const head = Buffer.alloc(bytes);
    try {
      const handle = await fs.open(resolveId(encodeId(join(dir, file))));
      try {
        await handle.read(head, 0, bytes, 0);
      } finally {
        await handle.close();
      }
    } catch {
      return Buffer.alloc(0);
    }
    return head;
  };

  const frames = new Map<string, number>();
  const framesOf = async (base: string): Promise<number> => {
    const cached = frames.get(base);
    if (cached !== undefined) return cached;
    const count = sprFrameCount(await headOf(sprs.get(base)!, 8));
    frames.set(base, count);
    return count;
  };

  // Aegis name to sprite base, for the pets the table knows and the marks miss.
  // A sprite is usually the lower-cased aegis name; the collaboration pets are
  // filed under either their `pad_` prefix or the bare name, so both are tried.
  const table = await petTable();
  const listed = new Map<string, string>();
  for (const [mob, equip] of table) {
    const named = [mob, mob.startsWith("pad_") ? mob.slice(4) : `pad_${mob}`];
    const base = named.find((name) => bases.some((b) => b.toLowerCase() === name));
    if (base) listed.set(bases.find((b) => b.toLowerCase() === base)!, equip);
  }

  const found = new Map<string, PetAccessory>();
  /** Bases that own an accessory act, whether or not it could be matched to a sprite. */
  const marked = new Set<string>();
  /** Act names already claimed as somebody's accessory, so they are not pets themselves. */
  const worn = new Set<string>();
  for (const [actName, actFile] of acts) {
    const candidates = bases.filter(
      (base) => actName.length > base.length && actName.startsWith(base) && HANGUL.test(actName.slice(base.length))
    );
    if (candidates.length === 0) continue;

    // A variant that ships its own .spr draws from that, so the prefix alone
    // settles it; an act-only variant has to be matched to the sprite it draws.
    const ownSpr = sprs.get(actName);
    let base = candidates[0];
    let fits = true;
    if (!ownSpr) {
      let act: Buffer;
      try {
        act = await fs.readFile(resolveId(encodeId(join(dir, actFile))));
      } catch {
        continue;
      }
      const needed = maxSprIndex(act);
      if (needed < 0) continue;
      // The pet is the longest candidate whose sprite actually holds the frames
      // this act draws; a shorter prefix that merely matches is a different mob.
      fits = false;
      for (const candidate of candidates) {
        if ((await framesOf(candidate)) > needed) {
          base = candidate;
          fits = true;
          break;
        }
      }
    }
    // Claimed either way: a second accessory act for a pet that already has one
    // is still that pet's clothing, not a pet in its own right.
    worn.add(actName);
    // Owning an accessory act is the mark, even when no sprite in the folder
    // holds the frames it draws -- `bacsojin_`'s overruns by one and
    // `pouring_책가방` looks like a copy of Poring's, filed against a sprite
    // eight frames shorter. Those stay pets, but are not offered a toggle that
    // would animate with layers missing.
    marked.add(base);
    if (!fits || found.has(base)) continue;

    // The folder can only spell the accessory in Korean; the table names it.
    const korean = actName.slice(base.length).replace(/^_/, "").replace(/_$/, "");
    const equip = listed.get(base);
    const accessoryName = equip ? itemLabel(equip) : korean;
    const accessorySpr = sprs.get(actName) ?? sprs.get(base)!;
    found.set(base, {
      name: accessoryName,
      label: label(accessoryName, "monster"),
      sprId: encodeId(join(dir, accessorySpr)),
      actId: encodeId(join(dir, actFile)),
    });
  }

  const pets: PetEntry[] = [];
  for (const base of bases) {
    if (worn.has(base)) continue; // an accessory sprite, already offered on its pet
    const accessory = found.get(base) ?? null;
    if (
      !marked.has(base) &&
      !listed.has(base) &&
      (await headOf(acts.get(base)!, 6).then(actActionCount)) < MIN_PET_ACTIONS
    ) {
      continue;
    }
    pets.push({
      name: base,
      label: label(base, "monster"),
      sprId: encodeId(join(dir, sprs.get(base)!)),
      actId: encodeId(join(dir, acts.get(base)!)),
      accessory,
    });
  }
  return pets.sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

let cache: { mtimeMs: number; pets: Promise<PetEntry[]> } | null = null;

/**
 * `listPets` reads a header from every act in the folder, so the answer is
 * memoized -- but keyed on the folder's own mtime rather than held for the
 * life of the process. Sprites do get dropped into `몬스터/` while the server
 * is running, and a roster that ignores them looks like a detection bug.
 *
 * A directory's mtime moves when an entry is added or removed, not when a file
 * already there is rewritten; replacing a sprite in place still needs a restart.
 */
export async function listPetsCached(): Promise<PetEntry[]> {
  let mtimeMs = 0;
  try {
    mtimeMs = (await fs.stat(resolveId(encodeId(Buffer.from(MONSTERS))))).mtimeMs;
  } catch {
    /* unreadable: let listPets answer with an empty roster */
  }
  if (!cache || cache.mtimeMs !== mtimeMs) cache = { mtimeMs, pets: listPets() };
  try {
    return await cache.pets;
  } catch (err) {
    cache = null; // a failed listing should not be cached
    throw err;
  }
}
