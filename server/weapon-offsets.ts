/**
 * `resolver-data/weapon_offsets.txt`, for the API.
 *
 * The format and the reasoning live in `src/lib/weaponOffsets.ts`, which the
 * browser shares; this is only the file half. A body's rows ride along on
 * `/api/equipment` with the rest of what is job-specific.
 *
 * The table is re-read when its mtime changes rather than once at startup:
 * writing these numbers is a loop of nudge, look, nudge again, and `tsx watch`
 * does not restart for a `.txt`. Reloading costs one `stat` per equipment
 * request and buys picking a new body being enough to see the edit.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchesName, parseWeaponOffsets, type WeaponOffsetRule } from "../src/lib/weaponOffsets.ts";

const FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "resolver-data/weapon_offsets.txt"
);

let rules: WeaponOffsetRule[] = [];
let stamp = -1;

function current(): WeaponOffsetRule[] {
  let mtime: number;
  try {
    mtime = fs.statSync(FILE).mtimeMs;
  } catch {
    // No table written yet, which is a perfectly good state: no corrections.
    rules = [];
    stamp = -1;
    return rules;
  }
  if (mtime === stamp) return rules;
  stamp = mtime;
  try {
    rules = parseWeaponOffsets(fs.readFileSync(FILE, "utf8"));
  } catch (error) {
    // A malformed table is worth shouting about but not worth taking the
    // server down for: the rest of the app has nothing to do with it.
    console.error(`weapon offsets: ${(error as Error).message}`);
    rules = [];
  }
  return rules;
}

/** Every rule that could apply to this body, in file order. */
export const weaponOffsetsForBody = (body: string): WeaponOffsetRule[] =>
  current().filter((rule) => matchesName(rule.body, body));

/** The five columns that identify a row; writing one replaces its match. */
export type OffsetKey = {
  body: string;
  weapon: string;
  action: string;
  facing: string;
  frames: string;
};

export type OffsetRow = OffsetKey & { dx: number; dy: number; note: string };

const clean = (value: string) => value.replace(/[\t\r\n]/g, " ").trim();

/**
 * Writes one correction into the table, from the preview's nudge control.
 *
 * A row is identified by its first five columns, so re-saving the same pairing
 * at the same action and facing rewrites that row rather than stacking another
 * one under it -- otherwise the file would grow a sediment of every failed
 * attempt, and only the last would ever be read. A zero offset deletes instead:
 * "no correction" is the absence of a row, not a row saying nothing.
 *
 * The file is rewritten whole, comments and hand-written rows included, because
 * the header explains the format to whoever opens it next.
 */
export async function saveWeaponOffset(row: OffsetRow): Promise<"written" | "removed"> {
  const key: OffsetKey = {
    body: clean(row.body),
    weapon: clean(row.weapon),
    action: clean(row.action),
    facing: clean(row.facing),
    frames: clean(row.frames),
  };
  if (!key.body || !key.weapon) throw new Error("body and weapon are required");
  if (!Number.isInteger(row.dx) || !Number.isInteger(row.dy)) {
    throw new Error("dx and dy must be whole pixels");
  }

  const line = [
    key.body,
    key.weapon,
    key.action,
    key.facing,
    key.frames,
    row.dx,
    row.dy,
    clean(row.note) || "from the preview's nudge control",
  ].join("\t");

  // Parse first, so a table that is already broken is not silently rewritten
  // around the damage.
  let text = "";
  try {
    text = await fsp.readFile(FILE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  parseWeaponOffsets(text);

  const matches = (candidate: string) => {
    const fields = candidate.split("\t").map((field) => field.trim());
    return (
      fields.length >= 7 &&
      fields[0] === key.body &&
      fields[1] === key.weapon &&
      fields[2] === key.action &&
      fields[3] === key.facing &&
      fields[4] === key.frames
    );
  };

  const lines = text.split("\n");
  const at = lines.findIndex((candidate) => !candidate.trimStart().startsWith("#") && matches(candidate));
  const removing = row.dx === 0 && row.dy === 0;

  if (at >= 0) {
    if (removing) lines.splice(at, 1);
    else lines[at] = line;
  } else if (!removing) {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push(line, "");
  }

  await fsp.writeFile(FILE, lines.join("\n"), "utf8");
  stamp = -1; // force the next read to pick this up even within the mtime tick
  return removing ? "removed" : "written";
}
