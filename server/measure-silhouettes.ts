/**
 * Measures every body against the art it is offered and writes
 * `resolver-data/narrow_bodies.txt`.
 *
 *   npm run silhouettes
 *
 * Why this is a build step and not a request: it reads and transforms every
 * frame of 428 bodies and a few thousand weapons. That is four seconds once,
 * or four seconds on the first `/api/parts` of every server start.
 *
 * The reference for a folder's art is the narrowest body sprite named after a
 * folder holding *that exact art*, byte for byte. Third and fourth jobs have no
 * weapon sprites of their own -- 로얄가드/ is a copy of 크루세이더/ down to the
 * md5 -- so the folder a body resolves to is frequently not the folder the art
 * was drawn in, and which copy came first is not recoverable from the data set.
 * Taking the narrowest of the candidates is the conservative reading: it flags
 * only bodies narrower than every body the art is known to have been drawn for.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DATA_DIR, displayName, encodeId, resolveId } from "./paths.ts";
import { GENDERS, listParts, RACES, weaponsForBody, type PartEntry } from "./weapons.ts";
import { loadPart, narrowing, reach, weaponSides } from "./silhouette.ts";

/**
 * Pixels of width a body may lose before the art stops fitting it.
 *
 * Measured, the human bodies heap up between -57 and +2.5 and then scatter: one
 * at 3, nothing until 6.5, and eleven above 9. Everything from 3 up was
 * rendered and looks wrong -- riders drawn without their mount, Rebellion's
 * limbs-only gun poses, 가드_여_4 holding a sword at arm's length from its
 * hand. Everything at 2.5 and below that was rendered looks right, with one
 * exception this cannot reach: 가드_남_1 misses its hilt by a hand's width and
 * measures 2, which is where correct bodies also sit. That is the limit of the
 * test, and why `narrow_bodies.txt` also carries a hand-marked section.
 *
 * Run with `--min=1 --dry` to see the shape of the tail again after a data set
 * changes; the threshold is only worth what the rendering behind it is worth.
 */
const THRESHOLD = 3;

/** `--min=<px>` lowers the threshold for a calibration run; `--dry` skips the write. */
const minArg = process.argv.find((arg) => arg.startsWith("--min="));
const threshold = minArg ? Number(minArg.slice("--min=".length)) : THRESHOLD;
const dry = process.argv.includes("--dry");

const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "resolver-data/narrow_bodies.txt"
);
const MANUAL = "# --- hand-marked, below the measurement's resolution ---";

/** md5 of every .spr in a weapon folder, keyed by gender and weapon name. */
async function fingerprint(raceRoot: string, folder: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const dir = resolveId(encodeId(Buffer.from(`${raceRoot}/${folder}`)));
  let names: Buffer[];
  try {
    names = (await fs.readdir(dir, { encoding: "buffer" as never })) as unknown as Buffer[];
  } catch {
    return out;
  }
  for (const name of names) {
    const display = displayName(name);
    if (!display.toLowerCase().endsWith(".spr")) continue;
    // Drop the folder's own prefix so two folders can be compared on weapon id.
    const parts = display.slice(0, -4).match(/^(.*)_([남여])_?(.*)$/);
    if (!parts) continue;
    const bytes = await fs.readFile(Buffer.concat([dir, Buffer.from(path.sep), name]));
    out.set(`${parts[2]}_${parts[3]}`, createHash("md5").update(bytes).digest("hex"));
  }
  return out;
}

/** Weapon folders holding the same art, grouped together. */
async function copyGroups(raceRoot: string, folders: string[]): Promise<Map<string, string[]>> {
  const prints = new Map<string, Map<string, string>>();
  for (const folder of folders) {
    const print = await fingerprint(raceRoot, folder);
    if (print.size) prints.set(folder, print);
  }

  const names = [...prints.keys()];
  const parent = new Map(names.map((name) => [name, name]));
  const find = (name: string): string => {
    const up = parent.get(name)!;
    if (up === name) return name;
    const root = find(up);
    parent.set(name, root);
    return root;
  };

  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = prints.get(names[i])!;
      const b = prints.get(names[j])!;
      let shared = 0;
      let same = 0;
      for (const [id, hash] of a) {
        if (!b.has(id)) continue;
        shared++;
        if (b.get(id) === hash) same++;
      }
      // Enough weapons in common to mean something, and near enough all of them
      // identical: a folder that merely shares a few placeholders is not a copy.
      if (shared >= 5 && same / shared >= 0.9) parent.set(find(names[i]), find(names[j]));
    }
  }

  const groups = new Map<string, string[]>();
  for (const name of names) {
    const root = find(name);
    groups.set(root, [...(groups.get(root) ?? []), name]);
  }
  const byFolder = new Map<string, string[]>();
  for (const group of groups.values()) for (const folder of group) byFolder.set(folder, group);
  return byFolder;
}

const raceRoot = RACES.human.root;
const dirs = (
  (await fs.readdir(resolveId(encodeId(Buffer.from(raceRoot))), {
    encoding: "buffer" as never,
    withFileTypes: true,
  })) as unknown as { name: Buffer; isDirectory(): boolean }[]
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => displayName(entry.name))
  .filter((name) => !["머리통", "몸통", "악세사리", "아이템"].includes(name));

const groups = await copyGroups(raceRoot, dirs);

type Row = { gender: string; body: string; folder: string; narrowing: number };
const rows: Row[] = [];
let measured = 0;

for (const gender of Object.values(GENDERS)) {
  const bodies = await listParts(`${raceRoot}/몸통/${gender}`);
  const bodyNames = new Set(bodies.map((body) => body.name));
  const folders = new Map<string, Promise<PartEntry[]>>();
  const reaches = new Map<string, Promise<(number | null)[]>>();

  for (const body of bodies) {
    const { weaponFolder, weapons } = await weaponsForBody(raceRoot, gender, body.name, folders);
    if (weapons.length === 0) continue;

    // Voting on a spread of the folder's weapons rather than all of them: the
    // side a blade hangs on is the same for all of them, and this runs per body.
    const sides = await weaponSides(
      raceRoot,
      weaponFolder,
      weapons.slice(0, 12).map((weapon) => weapon.name)
    );
    const key = sides.join(",");
    const reachOf = (name: string) => {
      const id = `${name}|${key}`;
      let pending = reaches.get(id);
      if (!pending) {
        pending = loadPart(`${raceRoot}/몸통/${gender}/${name}`, "body").then((loaded) =>
          loaded ? reach(loaded, sides) : sides.map(() => null)
        );
        reaches.set(id, pending);
      }
      return pending;
    };

    const family = [...new Set([weaponFolder, ...(groups.get(weaponFolder) ?? [])])]
      .map((folder) => `${folder}_${gender}`)
      .filter((name) => bodyNames.has(name));
    if (family.length === 0) continue;

    const mine = await reachOf(body.name);
    const references = await Promise.all(family.map(reachOf));
    const reference = sides.map((_, direction) => {
      const values = references
        .map((one) => one[direction])
        .filter((value): value is number => value !== null);
      return values.length ? Math.min(...values) : null;
    });

    const short = narrowing(mine, reference);
    measured++;
    if (short !== null && short >= threshold) {
      rows.push({ gender, body: body.name, folder: weaponFolder, narrowing: short });
    }
  }
}

rows.sort((a, b) => b.narrowing - a.narrowing || a.body.localeCompare(b.body, "ko"));

// Hand-marked entries are the point of the file that a re-measure must not
// destroy, so they are read back out of the file being replaced.
let manual = "";
try {
  const existing = await fs.readFile(OUT, "utf8");
  const at = existing.indexOf(MANUAL);
  if (at >= 0) manual = existing.slice(at);
} catch {
  /* first run */
}

const header = `# Bodies whose outline is too small for the weapon art they are offered.
#
# Generated by \`npm run silhouettes\`; see server/measure-silhouettes.ts for
# what is measured and server/silhouette.ts for why it is measured that way.
# Hand-marked rows below the marker line are kept across regeneration.
#
# Format: <gender> <TAB> <body sprite> <TAB> <weapon folder> <TAB> <pixels narrower>
#
# Measured at a threshold of ${THRESHOLD}px, against ${measured} bodies.
`;

const body = rows
  .map((row) => `${row.gender}\t${row.body}\t${row.folder}\t${row.narrowing}`)
  .join("\n");

if (dry) {
  for (const row of rows) console.log(`${row.narrowing}\t${row.gender}\t${row.body}\t${row.folder}`);
  console.log(`${rows.length} of ${measured} bodies over ${threshold}px (dry run, nothing written)`);
  process.exit(0);
}

await fs.writeFile(
  OUT,
  `${header}${body}\n\n${manual || `${MANUAL}\n`}`.replace(/\n{3,}$/, "\n"),
  "utf8"
);
console.log(`${rows.length} of ${measured} bodies over ${THRESHOLD}px -> ${path.relative(DATA_DIR, OUT)}`);
