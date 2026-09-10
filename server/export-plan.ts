/**
 * What a request means, in the vocabulary the renderer takes.
 *
 * A caller asks for "the Poring monster" or "a Knight's body and its garments";
 * `renderSheet` wants a slug/base pair per action, a facing, and a head facing.
 * Everything between the two is a rule about how this realm exports art, and
 * every one of those rules used to live in a React component — which is why
 * nothing but a person at a browser could apply them.
 *
 * The rules themselves are unchanged and deliberately so: the facings, the
 * action lists and the one-attack-pose rule are the Batch tab's, moved rather
 * than reinvented, so an export from here is an export from there.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MONSTER_SHEET_ACTIONS,
  PLAYER_SHEET_ACTIONS,
  type SheetActionSpec,
} from "../src/lib/partSheet.ts";

/**
 * Players and pets face **south-east**; monsters face **south-west**.
 *
 * The party stands on the left of the battlefield facing right, so south-east
 * is the angle a character is actually seen from in play — and an opponent on
 * the right has to face back the other way to read as facing them. A pet
 * stands on its owner's side, so it takes the party's facing rather than the
 * opposition's. Three constants and not one, because they are three separate
 * decisions that happen to agree twice.
 */
export const PLAYER_DIRECTION = 7;
export const PET_DIRECTION = 7;
export const MONSTER_DIRECTION = 1;

/**
 * The head looks **straight** ahead.
 *
 * `HEAD_DIRECTIONS` offers left and right as well; both are a pose for a
 * portrait rather than for a fighter, and a party of characters all glancing
 * aside reads as a crowd looking at something off-screen.
 */
export const HEAD_STRAIGHT = 0;

/**
 * What each kind ships, and the order it is laid into the sheet in.
 *
 * **A player has no `stand`, and that is not an omission.** RO's `stand` pose
 * (base 0) is the flat-footed one a character holds out of combat; what every
 * character in this game is actually seen doing is **attack-wait** (base 32),
 * the ready loop — which is why it is exported as `idle` and why the client
 * reaches for `idle` first for every animation it plays. Exporting `stand` as
 * well shipped a pose nothing ever drew, in every body, head, headgear, weapon,
 * shield and garment sheet in the library.
 *
 * **A monster keeps its `stand`**, because a monster's act has no attack-wait:
 * RO's monster action list is stand, move, attack, hurt, dead, and the client
 * maps its idle onto `stand` for exactly that reason. The two lists disagree
 * because the two skeletons do.
 *
 * `move` is left out of the monster list for the same reason `stand` leaves the
 * player one: nothing plays it, and an action nobody plays is pure weight in
 * every sheet that carries it.
 */
export const PLAYER_ACTION_SLUGS = ["idle", "walk", "hurt", "dead", "skill"] as const;
export const MONSTER_ACTION_SLUGS = ["stand", "attack", "hurt", "dead"] as const;

/** Which of RO's three attack poses an export may be told to use. */
export const ATTACK_VARIANTS = ["attack", "attack2", "attack3"] as const;
export type AttackVariant = (typeof ATTACK_VARIANTS)[number];

export type SpriteOverride = {
  /** Which of the three attack poses becomes the exported `attack`. */
  attack?: AttackVariant;
  /** Exported name → the source pose its frames come from. */
  poses?: Record<string, string>;
};

type OverrideFile = {
  defaults?: Record<string, SpriteOverride>;
  names?: Record<string, SpriteOverride>;
  keys?: Record<string, SpriteOverride>;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OVERRIDES_FILE = path.join(HERE, "sprite-overrides.json");

let cached: OverrideFile | null = null;

/**
 * The checked-in per-sprite table.
 *
 * Read fresh whenever it changes on disk would be nicer, but an export run is
 * short and a server restart is cheap; what matters is that it is read from a
 * *file in the repository* rather than carried in a request, so two exports a
 * month apart agree without anybody remembering why.
 */
export async function loadOverrides(): Promise<OverrideFile> {
  if (cached) return cached;
  try {
    cached = JSON.parse(await fs.readFile(OVERRIDES_FILE, "utf8")) as OverrideFile;
  } catch {
    cached = {};
  }
  return cached;
}

/** Forgets the cached table, so a run can pick up an edit without a restart. */
export function reloadOverrides(): void {
  cached = null;
}

/**
 * The settings for one sprite: its own row, then its name's, then its kind's.
 *
 * Most specific wins, and the two halves merge rather than replace — a sprite
 * that only names a broken pose keeps whatever attack its kind uses.
 */
export function overrideFor(
  file: OverrideFile,
  kind: string,
  name: string,
  key?: string,
): SpriteOverride {
  const byDefault = file.defaults?.[kind] ?? {};
  const byName = file.names?.[name] ?? {};
  const byKey = key ? (file.keys?.[key] ?? {}) : {};

  return {
    attack: byKey.attack ?? byName.attack ?? byDefault.attack ?? "attack",
    poses: { ...byDefault.poses, ...byName.poses, ...byKey.poses },
  };
}

/**
 * The action list one sprite is exported with.
 *
 * **Exactly one attack**, always, under the name `attack` — that is what keeps
 * a weapon on the hand, since a body swinging `attack 2` against a weapon
 * animated on `attack` drifts apart frame by frame. Which of the three it is
 * comes from the table; where a `poses` entry names a different source, the
 * exported *name* stays put and the frames behind it move, so an engine that
 * plays `cast` keeps playing `cast`.
 */
export function specsFor(
  kind: string,
  override: SpriteOverride,
): { specs: SheetActionSpec[]; direction: number; headDirection: number } {
  const player = kind !== "monster" && kind !== "pet";
  const catalogue = player ? PLAYER_SHEET_ACTIONS : MONSTER_SHEET_ACTIONS;
  const wanted = player ? [...PLAYER_ACTION_SLUGS, "attack"] : [...MONSTER_ACTION_SLUGS];

  const baseOf = (slug: string): number | undefined =>
    catalogue.find((spec) => spec.slug === slug)?.base;

  // **Laid out in the catalogue's order, not the order they were asked for.**
  // A sheet's frames are packed in spec order, so the order *is* part of the
  // art: `stand, walk, idle, attack, hurt, dead, skill` is where every sheet
  // Ilumnia ships put its frames, and a list that merely contained the same
  // slugs in a different order would re-cut every sheet in the library for
  // nothing. Sorted by the slug's own place in the RO action table - which is
  // where `attack` sits whatever pose it was actually taken from.
  const ordered = [...wanted].sort((a, b) => {
    const at = catalogue.findIndex((spec) => spec.slug === a);
    const bt = catalogue.findIndex((spec) => spec.slug === b);
    return at - bt;
  });

  const specs: SheetActionSpec[] = [];
  for (const slug of ordered) {
    // The pose the frames actually come from: the attack variant for `attack`,
    // an override where one is named, and otherwise the pose of the same name.
    const source =
      slug === "attack" ? (override.attack ?? "attack") : (override.poses?.[slug] ?? slug);
    const base = baseOf(source);
    // A sprite whose act is short simply has nothing at that base; the renderer
    // would draw an empty action, so it is left out of the sheet entirely.
    if (base === undefined) continue;
    specs.push({ slug, base });
  }

  return {
    specs,
    direction:
      kind === "monster" ? MONSTER_DIRECTION : kind === "pet" ? PET_DIRECTION : PLAYER_DIRECTION,
    headDirection: HEAD_STRAIGHT,
  };
}
