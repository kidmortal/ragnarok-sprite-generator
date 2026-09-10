/**
 * Renders bodies wearing their weapons, so a pairing can be judged by eye.
 *
 *   npm run contact-sheet -- --min=1            every body measuring 1px narrow or worse
 *   npm run contact-sheet -- 가드_남_1 크루세이더_남   named bodies, in the order given
 *   npm run contact-sheet -- --min=1 --gender=female --out=cache/review.png
 *
 * The four automatic tests tried before the width check all passed art that
 * plainly does not fit, so the width check is not trusted on its own either:
 * the threshold in `measure-silhouettes.ts` is where it is because these sheets
 * were looked at. This is also the tool for the rows that live below that
 * threshold -- render the band, look, and hand-mark what is wrong in
 * `resolver-data/narrow_bodies.txt`.
 *
 * One row per body, three facings, drawn at the same origin so the weapon's
 * position is comparable down the column: what to look for is whether the hilt
 * end finishes inside the hand or out in the air beside it.
 */

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { ROOT } from "./paths.ts";
import { GENDERS, listParts, RACES, weaponsForBody, type PartEntry } from "./weapons.ts";
import { DIRECTIONS, HOLD_ACTION, loadPart, narrowing, reach, weaponSides } from "./silhouette.ts";
import { paintOps } from "./thumbnail.ts";
import { drawOpsForPart, type ComposeOptions } from "../src/lib/compose.ts";

const CELL = 120;
const SCALE = 3;
const LABEL = 230;
/** South, south-east, east: the facings where a held weapon is most exposed. */
const FACINGS = [0, 7, 6];

const args = process.argv.slice(2);
const flag = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
const named = args.filter((arg) => !arg.startsWith("--"));
const min = flag("min") === undefined ? null : Number(flag("min"));
const genderArg = flag("gender");
const out = path.resolve(ROOT, flag("out") ?? "cache/contact-sheet.png");

const raceRoot = RACES.human.root;
const genders = genderArg
  ? [GENDERS[genderArg as keyof typeof GENDERS] ?? GENDERS.male]
  : Object.values(GENDERS);

type Subject = { gender: string; body: PartEntry; folder: string; weapon: string | null; narrow: number | null };

const subjects: Subject[] = [];
for (const gender of genders) {
  const bodies = await listParts(`${raceRoot}/몸통/${gender}`);
  const bodyNames = new Set(bodies.map((body) => body.name));
  const folders = new Map<string, Promise<PartEntry[]>>();

  for (const body of bodies) {
    if (named.length && !named.includes(body.name)) continue;
    const { weaponFolder, weapons } = await weaponsForBody(raceRoot, gender, body.name, folders);
    if (weapons.length === 0) continue;

    // A sword if the folder has one, since a long blade shows a bad grip most
    // clearly; otherwise whatever sits in the middle of the list.
    const weapon =
      weapons.find((entry) => entry.name.endsWith("_검"))?.name ??
      weapons[Math.floor(weapons.length / 2)]?.name ??
      null;

    let narrow: number | null = null;
    if (min !== null) {
      const sides = await weaponSides(raceRoot, weaponFolder, weapons.slice(0, 12).map((w) => w.name));
      const reachOf = async (name: string) => {
        const loaded = await loadPart(`${raceRoot}/몸통/${gender}/${name}`, "body");
        return loaded ? reach(loaded, sides) : sides.map(() => null);
      };
      const reference = `${weaponFolder}_${gender}`;
      if (bodyNames.has(reference)) {
        narrow = narrowing(await reachOf(body.name), await reachOf(reference));
      }
      if (narrow === null || narrow < min) continue;
    }
    subjects.push({ gender, body, folder: weaponFolder, weapon, narrow });
  }
}

if (named.length) {
  subjects.sort((a, b) => named.indexOf(a.body.name) - named.indexOf(b.body.name));
} else {
  subjects.sort((a, b) => (b.narrow ?? 0) - (a.narrow ?? 0));
}
if (subjects.length === 0) {
  console.log("nothing to render");
  process.exit(0);
}

const width = LABEL + CELL * SCALE * FACINGS.length;
const height = CELL * SCALE * subjects.length;
const canvas = new Uint8ClampedArray(width * height * 4);
const labels: string[] = [];

for (let row = 0; row < subjects.length; row++) {
  const subject = subjects[row];
  const body = await loadPart(`${raceRoot}/몸통/${subject.gender}/${subject.body.name}`, "body");
  const weapon = subject.weapon
    ? await loadPart(`${raceRoot}/${subject.folder}/${subject.weapon}`, "weapon")
    : null;
  if (!body) continue;

  for (let column = 0; column < FACINGS.length; column++) {
    const options: ComposeOptions = {
      actionBase: HOLD_ACTION,
      direction: FACINGS[column],
      headDirection: 0,
    };
    const cell = new Uint8ClampedArray(CELL * CELL * 4);
    // Origin low and centred: bodies hang above it and mounts extend below.
    const origin = { x: CELL / 2, y: CELL * 0.72 };
    paintOps(cell, CELL, CELL, drawOpsForPart(body.part, body.cache, options, 0, { x: 0, y: 0 }), origin.x, origin.y);
    if (weapon) {
      paintOps(cell, CELL, CELL, drawOpsForPart(weapon.part, weapon.cache, options, 0, { x: 0, y: 0 }), origin.x, origin.y);
    }

    const left = LABEL + column * CELL * SCALE;
    const top = row * CELL * SCALE;
    for (let y = 0; y < CELL * SCALE; y++) {
      for (let x = 0; x < CELL * SCALE; x++) {
        const source = (Math.floor(y / SCALE) * CELL + Math.floor(x / SCALE)) * 4;
        const target = ((top + y) * width + left + x) * 4;
        for (let channel = 0; channel < 4; channel++) canvas[target + channel] = cell[source + channel];
      }
    }
  }

  // Korean glyphs depend on the fonts sharp finds, so the name is also the
  // thing least worth relying on here -- the picture is the point.
  const top = row * CELL * SCALE;
  const text = (dy: number, size: number, fill: string, value: string) =>
    `<text x="10" y="${top + dy}" font-family="monospace" font-size="${size}" fill="${fill}">${value}</text>`;
  labels.push(
    text(30, 17, "#fff", `${subject.body.name} (${subject.gender})`),
    text(54, 15, "#8f8", subject.narrow === null ? "" : `${subject.narrow}px narrow`),
    text(76, 13, "#999", `${subject.folder} / ${subject.weapon ?? "no weapon"}`),
    `<line x1="0" y1="${top + CELL * SCALE}" x2="${width}" y2="${top + CELL * SCALE}" stroke="#333"/>`
  );
}

await fs.mkdir(path.dirname(out), { recursive: true });
await sharp({
  create: { width, height, channels: 4, background: { r: 24, g: 24, b: 28, alpha: 1 } },
})
  .composite([
    {
      input: Buffer.from(canvas.buffer, canvas.byteOffset, canvas.byteLength),
      raw: { width, height, channels: 4 },
    },
    { input: Buffer.from(`<svg width="${width}" height="${height}">${labels.join("")}</svg>`) },
  ])
  .png()
  .toFile(out);

console.log(`${subjects.length} bodies -> ${path.relative(ROOT, out)}`);
