/**
 * The folders holding everything that is neither a player nor a monster.
 *
 * There is no test that tells a prop from a person. `npc/` has a bonfire and a
 * shopkeeper sitting side by side, both one action of eight facings, and
 * nothing in either file says which is which -- the client knows because the
 * map told it. So the folder is as fine a classification as the data supports,
 * and both the picker and the headless catalogue offer it whole rather than
 * pretending to a filter neither can back up.
 *
 * All four are read flat. `ì´í©í¸/` nests its bigger effects a directory deeper
 * (`black_bubble/{large,midium,small}`) and `ìì´í/` keeps body and accessory
 * art in sub-folders; both are left alone, since what sits at the top level of
 * each already stands on its own.
 *
 * It lives in a file of its own because two routes need it and one of them is
 * `export-routes.ts`, which `index.ts` imports: a table on either would be a
 * cycle.
 */
export const PROP_SOURCES: Record<string, string> = {
  npc: "npc",
  effect: "이팩트",
  drop: "아이템",
  ammo: "item",
};

/** The source a prop's folder came from, or undefined for a folder nothing names. */
export function propSourceOf(folder: string): string | undefined {
  return Object.entries(PROP_SOURCES).find(([, name]) => name === folder)?.[0];
}
