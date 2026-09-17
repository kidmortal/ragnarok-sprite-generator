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
 * A prop takes the **party's** facing, for the party's reason.
 *
 * Most props have no front at all - a bonfire is a bonfire from every angle -
 * and the ones that do (a shopkeeper, a signpost) are furniture the party
 * walks up to rather than an opponent standing against them. South-east is the
 * angle everything on the party's side of the field is drawn at, so a prop
 * beside them agrees with them; a prop that needs to face the other way is
 * mirrored where it is drawn, which is a decision about a scene and not about
 * an export.
 */
export const PROP_DIRECTION = 7;

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
 *
 * **`sit` replaced `walk`, and it ships one frame.** A character in this realm
 * holds their ground: they are seen standing ready, swinging, casting, flinching
 * and falling, and never once crossing the ground, so a walk cycle was eight
 * frames of nothing in every body, head, headgear, weapon, shield and garment in
 * the library. What is wanted instead is a character *at rest* - a portrait
 * pose for a picker, a lobby, a page where nobody is fighting - and that is sit.
 * One frame because it is a pose held rather than an animation played: RO's sit
 * is a short cycle of somebody settling, and the seated figure is its first
 * frame. See `FRAME_CAPS`.
 */
export const PLAYER_ACTION_SLUGS = ["idle", "sit", "hurt", "dead", "skill"] as const;
export const MONSTER_ACTION_SLUGS = ["stand", "attack", "hurt", "dead"] as const;
/**
 * **A prop ships `stand` and nothing else**, because that is all it has.
 *
 * The sprites under `npc/` carry one action of eight facings - a fire burning,
 * a shopkeeper idling - and nothing in the file says anything about swinging,
 * flinching or falling, because a prop does none of those. It is exported
 * under the monster's own name for its own pose so that a consumer needs no
 * third case: a sheet with a `stand` on it is something a client already knows
 * how to stand still and breathe.
 */
export const PROP_ACTION_SLUGS = ["stand"] as const;

/**
 * Poses a player sprite ships **only when its override names a source for
 * them** - `poses: { channel: "skill" }` - and never by default.
 *
 * A player's list above is the whole library's, and adding a pose to it
 * re-cuts every one of the 451 player-side sheets for a frame nothing draws.
 * `channel` exists for one class whose one skill is held press after press
 * and needs a pose of its own beside `attack` and `skill`: RO's casting act
 * (`skill`, base 96) on a body whose exported `skill` was already taken from
 * attack 3. Opt-in per sprite, so the library is untouched and the sheet that
 * wants it says so in the same table that says everything else about it.
 *
 * `attack2` and `attack3` are the same bargain from the other end. Nearly every
 * job in RO animates three swings and uses one, which is what `attack` above is
 * for - but a gunner really does use all three, one per weapon, and a class
 * whose skills are told apart by which gun comes up needs the poses under their
 * own names rather than one chosen for it. Opt-in, because a library where
 * every body shipped three swings would be half again as large for two poses
 * that only one job ever plays.
 */
export const OPTIONAL_PLAYER_POSES = ["channel", "attack2", "attack3"] as const;

/**
 * Poses that ship a fixed number of frames whatever their act runs for.
 *
 * One entry, and the rule it states is about the pose rather than about size:
 * `sit` is *held*, so what an export owes a consumer is the figure and not the
 * business of getting into it. A consumer that received the cycle would have to
 * know to stop it on frame one, which is a rule in the wrong repository.
 */
const FRAME_CAPS: Record<string, number> = { sit: 1 };

/** Which of RO's three attack poses an export may be told to use. */
export const ATTACK_VARIANTS = ["attack", "attack2", "attack3"] as const;
export type AttackVariant = (typeof ATTACK_VARIANTS)[number];

export type SpriteOverride = {
  /** Which of the three attack poses becomes the exported `attack`. */
  attack?: AttackVariant;
  /** Exported name → the source pose its frames come from. */
  poses?: Record<string, string>;
  /**
   * Exported pose → the sprite drawn into its frames, by that sprite's own
   * name.
   *
   * For a job that does not *carry* a weapon so much as change weapons between
   * poses: a gunner's second swing is two pistols and the third is a rifle, and
   * neither is a thing the wearer chose. A weapon anybody picks stays a sheet
   * of its own; this is for the art the pose is made of. The name is resolved
   * against the weapons of the body being exported, so it can only ever name a
   * gun that body could really hold.
   */
  holds?: Record<string, string>;
  /**
   * Which exported pose this body's **ordinary** swing is - the one it plays
   * when nothing named a pose, which is every auto-attack it will ever throw.
   *
   * `attack` for all but one sprite in the library, because all but one have
   * only that. A gunner has three and the one it opens with is not the first:
   * the Night Watch levels a minigun on RO's attack 1 and that is a heavy
   * thing to do twice a second, so the pistols - its attack 2 - are what it
   * does by default and the minigun is what a skill asks for by name.
   *
   * It changes nothing about the sheet. The poses are exported in RO's own
   * order under RO's own names, and this is a note on top saying which of them
   * is the resting answer, carried in the manifest so a consumer does not have
   * to keep a table of its own.
   */
  swing?: string;
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
    holds: { ...byDefault.holds, ...byName.holds, ...byKey.holds },
    swing: byKey.swing ?? byName.swing ?? byDefault.swing,
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
  const prop = kind === "prop";
  const player = !prop && kind !== "monster" && kind !== "pet";
  const catalogue = player ? PLAYER_SHEET_ACTIONS : MONSTER_SHEET_ACTIONS;
  const optional = player
    ? OPTIONAL_PLAYER_POSES.filter((pose) => override.poses?.[pose] !== undefined)
    : [];
  const wanted = player
    ? [...PLAYER_ACTION_SLUGS, "attack", ...optional]
    : prop
      ? [...PROP_ACTION_SLUGS]
      : [...MONSTER_ACTION_SLUGS];

  const baseOf = (slug: string): number | undefined =>
    catalogue.find((spec) => spec.slug === slug)?.base;
  // The pose the frames actually come from: the attack variant for `attack`,
  // an override where one is named, and otherwise the pose of the same name.
  const sourceOf = (slug: string): string =>
    slug === "attack" ? (override.attack ?? "attack") : (override.poses?.[slug] ?? slug);

  // **Laid out in the catalogue's order, not the order they were asked for.**
  // A sheet's frames are packed in spec order, so the order *is* part of the
  // art: `sit, idle, attack, hurt, dead, skill` is where every player sheet
  // Ilumnia ships puts its frames, and a list that merely contained the same
  // slugs in a different order would re-cut every sheet in the library for
  // nothing. Sorted by the slug's own place in the RO action table - which is
  // where `attack` sits whatever pose it was actually taken from. An optional
  // pose has no place of its own in the table, so it takes its *source's*,
  // which lands `channel` after `skill` exactly where RO's casting act sits.
  const placeOf = (slug: string): number => {
    const own = catalogue.findIndex((spec) => spec.slug === slug);
    return own >= 0 ? own : catalogue.findIndex((spec) => spec.slug === sourceOf(slug));
  };
  const ordered = [...wanted].sort((a, b) => placeOf(a) - placeOf(b));

  const specs: SheetActionSpec[] = [];
  for (const slug of ordered) {
    const source = sourceOf(slug);
    const base = baseOf(source);
    // A sprite whose act is short simply has nothing at that base; the renderer
    // would draw an empty action, so it is left out of the sheet entirely.
    if (base === undefined) continue;
    const cap = FRAME_CAPS[slug];
    specs.push(cap === undefined ? { slug, base } : { slug, base, frames: cap });
  }

  return {
    specs,
    direction:
      kind === "monster"
        ? MONSTER_DIRECTION
        : kind === "pet"
          ? PET_DIRECTION
          : prop
            ? PROP_DIRECTION
            : PLAYER_DIRECTION,
    headDirection: HEAD_STRAIGHT,
  };
}
