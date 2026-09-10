/**
 * Recovers the per-sprite export settings from a manifest somebody already
 * shipped.
 *
 * `sprite-overrides.json` records the two judgements nothing in a sprite file
 * can answer: which of RO's three attack poses this job actually uses, and
 * which pose a broken one was substituted with. Those judgements were made once
 * already — by a person at the Batch tab, sprite by sprite — and the evidence
 * survives, because every manifest row records the *source* pose each exported
 * action was taken from under `base`.
 *
 * So the table is derived rather than retyped: read a shipped manifest, compare
 * each action's `base` against the pose of the same name, and write down every
 * one that differs. Without this a headless re-export would silently rewrite
 * every character's attack animation to the pose the sprite ships rather than
 * the one the game was tuned against.
 *
 *   npm run overrides -- <path to manifest.json>
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLAYER_SHEET_ACTIONS, MONSTER_SHEET_ACTIONS } from "../src/lib/partSheet.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TABLE = path.join(HERE, "sprite-overrides.json");

const source = process.argv[2];
if (!source) {
  console.error("Usage: npm run overrides -- <path to a shipped manifest.json>");
  process.exit(1);
}

const manifest = JSON.parse(await fs.readFile(source, "utf8")) as {
  parts: Record<string, Array<{ key: string; kind: string; label: string; actions: Record<string, { base: number }> }>>;
};

const table = JSON.parse(await fs.readFile(TABLE, "utf8"));
const keys: Record<string, { attack?: string; poses?: Record<string, string> }> = {};

let withAttack = 0;
let withPoses = 0;

for (const list of Object.values(manifest.parts)) {
  for (const part of list) {
    const player = part.kind !== "monster" && part.kind !== "pet";
    const catalogue = player ? PLAYER_SHEET_ACTIONS : MONSTER_SHEET_ACTIONS;
    const nameOf = (base: number) => catalogue.find((spec) => spec.base === base)?.slug;

    const entry: { attack?: string; poses?: Record<string, string> } = {};

    for (const [slug, action] of Object.entries(part.actions)) {
      const from = nameOf(action.base);
      // A base this build has no name for is a pose outside the action list —
      // a pet's performance group, say. Nothing to record: it could not be
      // asked for by name anyway.
      if (!from || from === slug) continue;

      if (slug === "attack") entry.attack = from;
      else (entry.poses ??= {})[slug] = from;
    }

    if (entry.attack) withAttack++;
    if (entry.poses) withPoses++;
    if (entry.attack || entry.poses) keys[part.key] = entry;
  }
}

table.keys = keys;
await fs.writeFile(TABLE, `${JSON.stringify(table, null, 2)}\n`);

console.log(
  `Recovered ${Object.keys(keys).length} sprite(s): ${withAttack} with a non-default attack pose, ${withPoses} with a substituted pose.`,
);
