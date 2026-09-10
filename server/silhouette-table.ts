/**
 * `resolver-data/narrow_bodies.txt`, read once at startup.
 *
 * The measurement behind it lives in `measure-silhouettes.ts`; this is only the
 * lookup, so the API never pays for it.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "resolver-data/narrow_bodies.txt"
);

const narrow = new Set<string>();
try {
  for (const line of fs.readFileSync(FILE, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [gender, body] = line.split("\t");
    if (gender && body) narrow.add(`${gender.trim()}|${body.trim()}`);
  }
} catch {
  /* not generated yet -- every body is treated as fitting */
}

/** Whether a body is too small for the weapon art it is offered. */
export const isNarrow = (gender: string, body: string): boolean =>
  narrow.has(`${gender}|${body}`);
