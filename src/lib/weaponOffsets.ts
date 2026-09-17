/**
 * Hand-written corrections to where a weapon is drawn on a given body.
 *
 * A weapon is not parented to anything: its act draws it at the character
 * origin, so the same art lands in the same place on every body that is offered
 * it, and the body's own outline is the only thing deciding whether a hand is
 * waiting there. When the body was drawn to a slightly different build than the
 * art expects -- which is most of what `narrow_bodies.txt` measures -- the grip
 * misses by a few pixels and there is nothing in either file to derive the fix
 * from. Somebody has to look at it and say "two pixels left".
 *
 * This is where that judgement is written down. The format the *client* would
 * use for it is `.imf`, which carries an (x, y) per layer per action per frame
 * -- and every one of those offsets is zero in all 304 files of this data set,
 * so the game ships the misfit too. A correction here is that unused field,
 * hand-authored: same granularity, kept as text so a row can carry a reason.
 *
 * Matching is deliberately dumb. A rule states which body, which weapon, which
 * action, which facing and which frames it speaks for -- `*` for "any" -- and
 * every matching rule is applied in file order, later rows overriding earlier
 * ones. So a broad nudge for a body goes at the top and the frames that need
 * something else go under it.
 */

import { DIRECTIONS, PLAYER_ACTIONS, type ComposeOptions } from "./compose";

export type WeaponOffsetRule = {
  /** Body sprite name, or a glob such as `가드_여*`. */
  body: string;
  /** Weapon sprite name, or a glob. */
  weapon: string;
  /** Action base (see `PLAYER_ACTIONS`), or null for any. */
  actionBase: number | null;
  /** Facing 0-7, or null for any. */
  direction: number | null;
  /** Inclusive frame range, or null for any. */
  frames: [number, number] | null;
  dx: number;
  dy: number;
  /** The reason column, kept so the table explains itself. */
  note: string;
};

export type Offset = { x: number; y: number };

const NO_OFFSET: Offset = { x: 0, y: 0 };

/** `*` matches any run of characters; everything else is literal, case-folded. */
export function matchesName(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) =>
    char === "*" ? "\0" : `\\${char}`
  );
  // A NUL stands in for the wildcard while the rest is escaped: a file name may
  // hold any printable character, but never that one.
  return new RegExp(`^${escaped.split("\0").join(".*")}$`, "i").test(value);
}

/** Action bases by the name the table spells them with (`attack-wait`). */
const actionBases = new Map(
  PLAYER_ACTIONS.map((action) => [action.name.toLowerCase().replace(/ /g, "-"), action.base])
);

/** Facings by name (`south-east`) as well as by index. */
const directionIndices = new Map(
  DIRECTIONS.map((name, index) => [name.toLowerCase(), index] as const)
);

function parseAction(field: string): number | null {
  if (field === "*") return null;
  const base = actionBases.get(field.toLowerCase());
  if (base === undefined) throw new Error(`unknown action "${field}"`);
  return base;
}

function parseDirection(field: string): number | null {
  if (field === "*") return null;
  const named = directionIndices.get(field.toLowerCase());
  if (named !== undefined) return named;
  const index = Number(field);
  if (!Number.isInteger(index) || index < 0 || index > 7) {
    throw new Error(`unknown facing "${field}"`);
  }
  return index;
}

function parseFrames(field: string): [number, number] | null {
  if (field === "*") return null;
  const match = /^(\d+)(?:-(\d+))?$/.exec(field.trim());
  if (!match) throw new Error(`unknown frame spec "${field}"`);
  const first = Number(match[1]);
  const last = match[2] === undefined ? first : Number(match[2]);
  return [Math.min(first, last), Math.max(first, last)];
}

function parsePixels(field: string, column: string): number {
  const value = Number(field.trim());
  if (!Number.isFinite(value)) throw new Error(`${column} is not a number: "${field}"`);
  return value;
}

/**
 * Reads the table. Tab separated, `#` comments, blank lines ignored:
 *
 *     body <TAB> weapon <TAB> action <TAB> facing <TAB> frames <TAB> dx <TAB> dy <TAB> note
 *
 * A malformed row throws with its line number rather than being skipped -- a
 * correction that silently does nothing is worse than one that fails loudly,
 * because the only way to notice would be to spot the misfit all over again.
 */
export function parseWeaponOffsets(text: string): WeaponOffsetRule[] {
  const rules: WeaponOffsetRule[] = [];
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const fields = line.split("\t").map((field) => field.trim());
    if (fields.length < 7) {
      throw new Error(`weapon_offsets.txt:${index + 1}: expected 7 tab-separated columns`);
    }

    try {
      rules.push({
        body: fields[0],
        weapon: fields[1],
        actionBase: parseAction(fields[2]),
        direction: parseDirection(fields[3]),
        frames: parseFrames(fields[4]),
        dx: parsePixels(fields[5], "dx"),
        dy: parsePixels(fields[6], "dy"),
        note: fields[7] ?? "",
      });
    } catch (error) {
      throw new Error(`weapon_offsets.txt:${index + 1}: ${(error as Error).message}`);
    }
  }

  return rules;
}

/** Rules that could apply to this pairing, in file order. */
export function rulesFor(
  rules: readonly WeaponOffsetRule[],
  body: string,
  weapon: string
): WeaponOffsetRule[] {
  return rules.filter(
    (rule) => matchesName(rule.body, body) && matchesName(rule.weapon, weapon)
  );
}

/**
 * The correction for one frame: the last matching rule wins, or zero.
 *
 * `frame` is the *body's* frame number, the one the whole composition is driven
 * by, so a row means the same thing whether or not the weapon act happens to
 * hold as many motions as the body does.
 */
export function weaponOffset(
  rules: readonly WeaponOffsetRule[],
  options: ComposeOptions,
  frame: number
): Offset {
  let offset = NO_OFFSET;
  for (const rule of rules) {
    if (rule.actionBase !== null && rule.actionBase !== options.actionBase) continue;
    if (rule.direction !== null && rule.direction !== options.direction) continue;
    if (rule.frames && (frame < rule.frames[0] || frame > rule.frames[1])) continue;
    offset = { x: rule.dx, y: rule.dy };
  }
  return offset;
}

/**
 * The `Part.offset` hook for a weapon, or undefined when nothing applies.
 *
 * Returning undefined rather than a function that always answers zero keeps the
 * common case -- no correction for this pairing -- free of a per-frame call.
 */
export function weaponOffsetFn(
  rules: readonly WeaponOffsetRule[],
  body: string,
  weapon: string
): ((options: ComposeOptions, frame: number) => Offset) | undefined {
  const applicable = rulesFor(rules, body, weapon);
  if (applicable.length === 0) return undefined;
  return (options, frame) => weaponOffset(applicable, options, frame);
}
