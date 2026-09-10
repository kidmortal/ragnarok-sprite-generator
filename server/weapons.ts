/**
 * Which weapon sprites a body may wear.
 *
 * Equipment folders come from zrenderer's resolver tables (see
 * `resolver-data/README.md`), because a job's weapon folder is often not its
 * own name:
 *
 *   weapons   인간족/{weaponFolder}/{weaponPrefix}_{gender}{name}
 *   shields   방패/{job}/{job}_{gender}{name}
 *   garments  로브/{garment}/{gender}/{job}_{gender}, else 로브/{garment}/{garment}
 *
 * The client sends the body sprite's file name and the resolver derives the job
 * from it, since body files are not always a bare `{job}_{gender}`.
 *
 * This lives apart from the API so the offline tools can resolve a body the
 * same way the server does -- `measure-silhouettes.ts` has to know which art a
 * body is actually offered before it can ask whether that art fits.
 */

import fs from "node:fs/promises";
import { foldersForJob } from "./resolver.ts";
import { displayName, encodeId, join, resolveId } from "./paths.ts";
import { label } from "./translate.ts";

/**
 * Character part folders, using the standard Ragnarok data layout. Gender and
 * race are folder names in Korean, which is why they are spelled out here.
 */
export const RACES = {
  human: { label: "Human", root: "인간족", headgearSuffix: "" },
  doram: { label: "Doram", root: "도람족", headgearSuffix: "_doram" },
} as const;

export const GENDERS = { male: "남", female: "여" } as const;

export type PartEntry = {
  /** The file's own name, which is its identity -- see `translate.ts`. */
  name: string;
  /**
   * The same name in English, or "" when it needs none. Display only: the data
   * directory is a GRF extract and nothing here renames anything on disk.
   */
  label: string;
  sprId: string;
  actId: string;
};

/** What kind of part a folder holds, which is what `translate.ts` needs to know. */
export type PartLabelKind =
  | "body"
  | "head"
  | "headgear"
  | "weapon"
  | "shield"
  | "garment"
  | "monster";

/**
 * Where a body's weapons came from, most trustworthy first.
 *
 * This records *provenance*, not correctness -- nothing in a .spr or .act says
 * which body it was drawn for, so there is no way to test a pairing. What can
 * be said is whether the weapons are the job's own sprites or something it
 * inherited, and that is what this distinguishes.
 *
 *   own         a folder named after the job itself, e.g. abyss_chaser
 *   descendant  the job's own folder, reached by name (타조레인져 -> 레인져)
 *   override    a hand-checked correction, see job_weapon_overrides.txt
 *   inherited   only the table's answer, usually an ancestor class
 *   probe       a filesystem guess for a body no table covers
 */
export type WeaponOrigin = "own" | "descendant" | "override" | "inherited" | "probe";

/** The origins we are confident actually belong to the job. */
export const TRUSTED: readonly WeaponOrigin[] = ["own", "descendant", "override"];

/** List a folder and pair each .spr with the .act of the same base name. */
export async function listParts(
  relative: string,
  kind: PartLabelKind = "monster"
): Promise<PartEntry[]> {
  const rel = Buffer.from(relative);
  let abs: Buffer;
  try {
    abs = resolveId(encodeId(rel));
  } catch {
    return [];
  }

  let names: Buffer[];
  try {
    names = (await fs.readdir(abs, { encoding: "buffer" as never })) as unknown as Buffer[];
  } catch {
    return [];
  }

  const acts = new Set<string>();
  for (const name of names) {
    const display = displayName(name);
    if (display.toLowerCase().endsWith(".act")) acts.add(display.slice(0, -4).toLowerCase());
  }

  const parts: PartEntry[] = [];
  for (const name of names) {
    const display = displayName(name);
    if (!display.toLowerCase().endsWith(".spr")) continue;
    const base = display.slice(0, -4);
    if (!acts.has(base.toLowerCase())) continue; // a part needs both halves
    const sprRel = join(rel, name);
    const actRel = Buffer.concat([sprRel.subarray(0, sprRel.length - 4), Buffer.from(".act")]);
    parts.push({ name: base, label: label(base, kind), sprId: encodeId(sprRel), actId: encodeId(actRel) });
  }

  return parts.sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

/** Names of the sub-directories of a folder inside the data directory. */
async function listDirs(relative: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(resolveId(encodeId(Buffer.from(relative))), {
      encoding: "buffer" as never,
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => displayName(entry.name as unknown as Buffer));
  } catch {
    return [];
  }
}

/**
 * `listDirs`, memoized. Weapon resolution asks for a race root's sub-folders
 * once per body, and the data directory does not change while the server runs.
 */
const dirCache = new Map<string, Promise<string[]>>();
const listDirsCached = (relative: string): Promise<string[]> => {
  let pending = dirCache.get(relative);
  if (!pending) {
    pending = listDirs(relative);
    dirCache.set(relative, pending);
  }
  return pending;
};

/**
 * The folder a job's weapons would live in if the data set has caught up with
 * it, given the folder the tables name.
 *
 * The tables were taken from a client that predates third-job weapon sprites,
 * so they answer with a job's *ancestor*: 룬나이트 is sent to 기사, 여우워록 to
 * 위저드, 슈라알파카 to 몽크. This data set has the descendants' own folders, so
 * the longest folder name spelled out inside the job name wins -- costume and
 * mount bodies carry their job in the middle of a longer name (타조레인져,
 * 켈베로스길로틴크로스, ARCH_MAGE_RIDING), which is why this is a substring
 * test and not the token walk `foldersForJob` does.
 *
 * A mounted body must stay mounted, though. When the table's answer is itself a
 * mount folder -- one spelling out a plainer folder inside it, 페코페코_기사
 * around 기사 -- the job is substituted into that name instead, and the result
 * only counts if it is really on disk: 룬나이트쁘띠2 becomes 페코페코_룬나이트,
 * never the dismounted 룬나이트. Nothing is invented; a job with no folder of
 * its own keeps the table's answer.
 */
function descendantFolder(job: string, tableFolder: string, dirs: string[]): string | null {
  const lower = job.toLowerCase();
  let own = "";
  for (const dir of dirs) {
    if (dir.length > own.length && lower.includes(dir.toLowerCase())) own = dir;
  }
  if (!own || own.toLowerCase() === tableFolder.toLowerCase()) return null;

  // The plainer folder the table's answer is built around, if it is a mount.
  let base = "";
  for (const dir of dirs) {
    if (dir.length === tableFolder.length || dir.length <= base.length) continue;
    if (tableFolder.toLowerCase().includes(dir.toLowerCase())) base = dir;
  }
  if (!base) return dirs.includes(own) ? own : null;

  const mounted = tableFolder.replace(base, own);
  return dirs.includes(mounted) ? mounted : null;
}

/**
 * Weapons for one body sprite, resolved through the job tables. `folders`
 * memoizes directory listings so scanning a whole body list stays cheap.
 *
 * Three sources, most specific first: the job's own folder, the descendant
 * folder the tables are too old to name, and the table's own answer. They are
 * merged rather than replaced, because a job can own a couple of weapons and
 * inherit the rest -- 쉐도우체이서 has exactly one of its own and takes the
 * other forty from 로그.
 */
export async function weaponsForBody(
  raceRoot: string,
  gender: string,
  bodyName: string,
  folders: Map<string, Promise<PartEntry[]>>
): Promise<{
  job: string;
  weaponFolder: string;
  origin: WeaponOrigin | null;
  weapons: PartEntry[];
}> {
  const listCached = (relative: string) => {
    let pending = folders.get(relative);
    if (!pending) {
      pending = listParts(relative, "weapon");
      folders.set(relative, pending);
    }
    return pending;
  };

  const resolved = foldersForJob(bodyName);
  const dirs = await listDirsCached(raceRoot);

  // `folder/prefix` pairs to draw weapons from, most specific first.
  const sources: { folder: string; prefix: string; origin: WeaponOrigin }[] = [];
  const add = (folder: string, prefix: string, origin: WeaponOrigin) => {
    if (!sources.some((s) => s.folder === folder && s.prefix === prefix)) {
      sources.push({ folder, prefix, origin });
    }
  };

  const own = dirs.find((dir) => dir.toLowerCase() === resolved.job.toLowerCase());
  if (own) add(own, `${own}_${gender}`, "own");

  if (resolved.matched) {
    const descendant = descendantFolder(resolved.job, resolved.weaponFolder, dirs);
    if (descendant) add(descendant, `${descendant}_${gender}`, "descendant");
    add(
      resolved.weaponFolder,
      resolved.weaponHasGender ? `${resolved.weaponPrefix}_${gender}` : resolved.weaponPrefix,
      resolved.weaponOverridden ? "override" : "inherited"
    );
  } else {
    // Bodies with no table entry (운영자2_남, 무희바지_남, costume sets) can still
    // have a weapon folder on disk whose name is a prefix of the body name --
    // note a *string* prefix, not a token one: 운영자2_남 lives under 운영자.
    // Those folders hold files named either after the body itself
    // (운영자2_남_검) or after the folder (무희_남_검).
    let fallback = "";
    for (const dir of dirs) {
      if (bodyName.startsWith(dir) && dir.length > fallback.length) fallback = dir;
    }
    if (fallback) {
      add(fallback, bodyName, "probe");
      add(fallback, `${fallback}_${gender}`, "probe");
    }
  }

  // Keyed by what follows the prefix -- the weapon's item id or Korean name --
  // so the same weapon from two folders collapses to the more specific one.
  const byWeapon = new Map<string, PartEntry>();
  let origin: WeaponOrigin | null = null;
  for (const source of sources) {
    const prefix = source.prefix.toLowerCase();
    if (!prefix) continue;
    let added = 0;
    for (const part of await listCached(`${raceRoot}/${source.folder}`)) {
      const name = part.name.toLowerCase();
      if (!name.startsWith(prefix) || part.name.endsWith("_검광")) continue;
      const weapon = name.slice(prefix.length);
      if (byWeapon.has(weapon)) continue;
      byWeapon.set(weapon, part);
      added++;
    }
    // The first source that actually supplies weapons is the one that counts.
    if (added && !origin) origin = source.origin;
  }

  const weapons = [...byWeapon.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));

  return {
    job: resolved.job,
    weaponFolder: sources[0]?.folder ?? resolved.weaponFolder,
    origin,
    weapons,
  };
}
