/**
 * Renders one body holding one weapon at a grid of offsets, so a correction for
 * `resolver-data/weapon_offsets.txt` can be picked by eye.
 *
 *   npm run nudge -- 가드_여_2 --weapon=1463
 *   npm run nudge -- 가드_여_2 --weapon=1463 --facing=south-east --action=attack
 *   npm run nudge -- 가드_여_2 --weapon=검 --frame=3 --dx=-2,2 --dy=-2,2
 *
 * The contact sheet answers "does this pairing look wrong"; this answers "by how
 * much". Each cell is the same frame drawn with the weapon moved by the labelled
 * (dx, dy), and the row to paste is printed under the picture -- which is the
 * whole point, since the numbers are a judgement and the file is where the
 * judgement is kept.
 *
 * Whatever the table already says for the pairing is applied first, so the grid
 * is always relative to what the app currently draws: at (0, 0) you are looking
 * at today's result, and a second pass refines rather than restarts.
 */

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { ROOT } from "./paths.ts";
import { GENDERS, RACES, weaponsForBody } from "./weapons.ts";
import { loadPart } from "./silhouette.ts";
import { paintOps } from "./thumbnail.ts";
import { weaponOffsetsForBody } from "./weapon-offsets.ts";
import { weaponOffsetFn } from "../src/lib/weaponOffsets.ts";
import {
  DIRECTIONS,
  PLAYER_ACTIONS,
  drawOpsForPart,
  type ComposeOptions,
} from "../src/lib/compose.ts";

const CELL = 70;
const SCALE = 5;

const args = process.argv.slice(2);
const flag = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
const bodyName = args.find((arg) => !arg.startsWith("--"));
if (!bodyName) {
  console.error("usage: npm run nudge -- <body sprite> [--weapon=…] [--action=…] [--facing=…]");
  process.exit(1);
}

/** A range flag: `--dx=-2,3` or a single `--dx=4`, defaulting to `fallback`. */
function range(name: string, fallback: [number, number]): number[] {
  const value = flag(name);
  if (!value) return span(fallback[0], fallback[1]);
  const parts = value.split(",").map(Number);
  if (parts.some((n) => !Number.isInteger(n))) throw new Error(`--${name} takes whole pixels`);
  return parts.length === 1 ? parts : span(parts[0], parts[1]);
}
const span = (from: number, to: number) =>
  Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => Math.min(from, to) + i);

const actionName = (flag("action") ?? "attack-wait").toLowerCase();
const action = PLAYER_ACTIONS.find(
  (entry) => entry.name.toLowerCase().replace(/ /g, "-") === actionName
);
if (!action) throw new Error(`unknown action "${actionName}"`);

const facingArg = flag("facing") ?? "south-east";
const direction = /^\d$/.test(facingArg)
  ? Number(facingArg)
  : DIRECTIONS.findIndex((name) => name.toLowerCase() === facingArg.toLowerCase());
if (direction < 0 || direction > 7) throw new Error(`unknown facing "${facingArg}"`);

const frame = Number(flag("frame") ?? 0);
const dxs = range("dx", [0, 4]);
const dys = range("dy", [-1, 1]);
const out = path.resolve(ROOT, flag("out") ?? "cache/nudge.png");

const raceRoot = RACES.human.root;
// The gender is in the file name, since that is how the extract names bodies.
const gender = bodyName.includes(`_${GENDERS.female}`) ? GENDERS.female : GENDERS.male;

const { weaponFolder, weapons } = await weaponsForBody(raceRoot, gender, bodyName, new Map());
const weaponArg = flag("weapon");
const weaponName = weaponArg
  ? weapons.find((entry) => entry.name.toLowerCase().includes(weaponArg.toLowerCase()))?.name
  : weapons.find((entry) => entry.name.endsWith("_검"))?.name ?? weapons[0]?.name;
if (!weaponName) throw new Error(`no weapon matching "${weaponArg ?? "any"}" for ${bodyName}`);

const body = await loadPart(`${raceRoot}/몸통/${gender}/${bodyName}`, "body");
const weapon = await loadPart(`${raceRoot}/${weaponFolder}/${weaponName}`, "weapon");
if (!body || !weapon) throw new Error(`could not load ${bodyName} or ${weaponName}`);

const options: ComposeOptions = { actionBase: action.base, direction, headDirection: 0 };
const existing =
  weaponOffsetFn(weaponOffsetsForBody(bodyName), bodyName, weaponName)?.(options, frame) ??
  { x: 0, y: 0 };

const width = CELL * SCALE * dxs.length;
const height = CELL * SCALE * dys.length;
const canvas = new Uint8ClampedArray(width * height * 4);
const labels: string[] = [];

for (let row = 0; row < dys.length; row++) {
  for (let column = 0; column < dxs.length; column++) {
    const cell = new Uint8ClampedArray(CELL * CELL * 4);
    // Origin low and slightly left of centre: the figure hangs above it and a
    // held weapon swings out to the side the facing turns it to.
    const originX = CELL * 0.55;
    const originY = CELL * 0.82;
    const shift = { x: existing.x + dxs[column], y: existing.y + dys[row] };
    paintOps(cell, CELL, CELL, drawOpsForPart(body.part, body.cache, options, frame, { x: 0, y: 0 }), originX, originY);
    paintOps(cell, CELL, CELL, drawOpsForPart(weapon.part, weapon.cache, options, frame, shift), originX, originY);

    const left = column * CELL * SCALE;
    const top = row * CELL * SCALE;
    for (let y = 0; y < CELL * SCALE; y++) {
      for (let x = 0; x < CELL * SCALE; x++) {
        const source = (Math.floor(y / SCALE) * CELL + Math.floor(x / SCALE)) * 4;
        const target = ((top + y) * width + left + x) * 4;
        for (let channel = 0; channel < 4; channel++) canvas[target + channel] = cell[source + channel];
      }
    }
    // The label is the row's numbers, not the cell's, so what you read off the
    // picture is what you paste into the table.
    labels.push(
      `<text x="${left + 8}" y="${top + 22}" font-family="monospace" font-size="18" fill="#ff0">${shift.x}, ${shift.y}</text>`,
      `<rect x="${left}" y="${top}" width="${CELL * SCALE}" height="${CELL * SCALE}" fill="none" stroke="#333"/>`
    );
  }
}

await fs.mkdir(path.dirname(out), { recursive: true });
await sharp({
  create: { width, height, channels: 4, background: { r: 20, g: 20, b: 24, alpha: 1 } },
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

const facing = DIRECTIONS[direction].toLowerCase();
console.log(`${bodyName} / ${weaponName} -> ${path.relative(ROOT, out)}`);
if (existing.x || existing.y) {
  console.log(`(0, 0) is the table's current ${existing.x}, ${existing.y}; labels are absolute`);
}
console.log("\npick a cell, then add its numbers to server/resolver-data/weapon_offsets.txt:\n");
console.log(
  [bodyName, weaponName, actionName, facing, frame, "<dx>", "<dy>", "why"].join("\t")
);
