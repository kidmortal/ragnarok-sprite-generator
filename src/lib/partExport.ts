/**
 * Turns one catalogue entry into the pair of files a game engine consumes: a
 * uniform-grid, lossless WebP sheet and the JSON that says how to read it.
 *
 * The contract is documented in `PLAN.md`. In short: every sheet declares an
 * origin pixel, and what that pixel *means* is the whole runtime API --
 * the character origin for a body, weapon, shield or garment, and the attach
 * point for a head or headgear.
 */

import { fetchFile, type PartEntry } from "../api";
import { SHEET_EXTENSION, encodeSpritesheet } from "./apng";
import { Z_INDEX, buildFrameCache, hasTrueColour, type Part, type PartKind } from "./compose";
import { renderPartSheet, type SheetAction, type SheetActionSpec } from "./partSheet";
import { parseAct } from "./act";
import { parseSpr } from "./spr";

/**
 * Everything an engine needs to read one part's sheet.
 *
 * This lives inline in `manifest.json` rather than in a file per part: a
 * runtime character builder wants one fetch, not one per sprite, and the whole
 * table for a few hundred parts is a few hundred KB before compression.
 */
export type PartMeta = {
  key: string;
  kind: PartKind | "monster" | "pet" | "prop";
  /** The sprite's Korean name, for a human reading the manifest. */
  label: string;
  /** The app's own id for the source file: base64url of the raw path bytes. */
  source: string;
  image: string;
  cell: { w: number; h: number };
  origin: [number, number];
  columns: number;
  direction: number;
  headDirection: number;
  zIndex: number;
  actions: Record<string, SheetAction>;
  /**
   * Poses whose frames already carry a weapon, and which sprite that is.
   *
   * Provenance rather than instruction: nothing has to read it to draw the
   * sheet - the gun is *in* the frames - but an export that welded art in has
   * to say so, the same way `base` says which pose a substituted action was cut
   * from. Absent from every sheet that holds nothing, which is nearly all.
   */
  holds?: Record<string, string>;
  /**
   * Which of this body's poses is its **ordinary** swing - what it plays when
   * nothing named one.
   *
   * Absent on everything that swings the one way it has, which is all but a
   * gunner. Present, it names a pose in `actions` above and nothing else: the
   * frames are unchanged and in RO's own order, and this only says which of
   * them answers when nobody asked for a particular one.
   */
  swing?: string;
  race?: string;
  gender?: string;
  /**
   * The job whose folder this came from. Weapons, shields and garments are
   * only valid on a body of the same job, and the manifest has to preserve
   * that or a picker will offer a Priest's staff to a Knight.
   */
  job?: string;
};

export type ExportedPart = {
  meta: PartMeta;
  /** The packed sheet, lossless WebP — `meta.image` is where it belongs. */
  image: Blob;
};

/**
 * A stable ASCII key for a sprite whose real name is Korean, and sometimes
 * legacy EUC-KR. Derived from the file's id, so re-exporting the same data
 * produces the same key and a saved appearance keeps pointing at the right art.
 */
export async function partKey(kind: string, sprId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sprId));
  const hex = Array.from(new Uint8Array(digest).slice(0, 4))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${kind}_${hex}`;
}

export type ExportOptions = {
  kind: PartMeta["kind"];
  specs: readonly SheetActionSpec[];
  direction: number;
  headDirection: number;
  race?: string;
  gender?: string;
  job?: string;
  /** Which pose is this body's ordinary swing; see `PartMeta.swing`. */
  swing?: string;
  /**
   * Sprites to draw into this part's own cells, each on one named pose - a gun
   * a job holds for one of its swings and never puts down. See `holds` in
   * `renderPartSheet` for why a weapon is ever welded in rather than shipped as
   * the separate sheet a weapon normally is.
   */
  holds?: readonly HeldPart[];
};

/** One sprite welded into one pose of the part being exported. */
export type HeldPart = {
  /** The exported action it is drawn on, e.g. `attack2`. */
  slug: string;
  /** The sprite's own name, which is what the manifest records. */
  name: string;
  sprId: string;
  actId: string;
};

/** Fetches, parses and renders one part into its sheet and its metadata. */
export async function exportPart(
  entry: PartEntry,
  options: ExportOptions
): Promise<ExportedPart> {
  const [sprBuf, actBuf] = await Promise.all([fetchFile(entry.sprId), fetchFile(entry.actId)]);

  // Monsters, pets and props compose as a standalone sprite, so they render on
  // the body's terms: origin at the character origin, no attach point. A prop
  // is the plainest of the three - one pose, nothing worn, nothing attached -
  // and it takes this path for exactly the same reason a monster does.
  const kind: PartKind =
    options.kind === "monster" || options.kind === "pet" || options.kind === "prop"
      ? "body"
      : options.kind;
  const standalone = kind !== options.kind;
  const part: Part = {
    kind,
    zIndex: Z_INDEX[kind],
    spr: parseSpr(sprBuf),
    act: parseAct(actBuf),
  };

  // Whatever this sprite holds, parsed alongside it: a held gun is drawn into
  // the body's own cells, so it goes through the same frame cache and counts
  // towards the same palette decision as the body it is welded to.
  const held = await Promise.all(
    (options.holds ?? []).map(async (hold) => {
      const [spr, act] = await Promise.all([fetchFile(hold.sprId), fetchFile(hold.actId)]);
      return {
        slug: hold.slug,
        name: hold.name,
        part: {
          kind: "weapon" as PartKind,
          zIndex: Z_INDEX.weapon,
          spr: parseSpr(spr),
          act: parseAct(act),
        },
      };
    })
  );

  const holds: Record<string, Part[]> = {};
  for (const one of held) (holds[one.slug] ??= []).push(one.part);

  const cache = buildFrameCache([part, ...held.map((one) => one.part)]);
  const sheet = renderPartSheet(
    part,
    cache,
    options.specs,
    options.direction,
    options.headDirection,
    // These render as a body but nothing ever attaches to them, so they ship
    // without the anchor table a real body owes its heads.
    !standalone,
    holds
  );

  const packed = await encodeSpritesheet(sheet.frames, sheet.columns, {
    trueColour: hasTrueColour([part, ...held.map((one) => one.part)]),
  });
  const key = await partKey(options.kind, entry.sprId);
  const image = `${options.kind}/${key}.${SHEET_EXTENSION}`;

  return {
    image: packed.blob,
    meta: {
      key,
      kind: options.kind,
      label: entry.name,
      source: entry.sprId,
      image,
      cell: sheet.cell,
      origin: sheet.origin,
      columns: sheet.columns,
      direction: options.direction,
      headDirection: options.headDirection,
      zIndex: Z_INDEX[kind],
      actions: sheet.actions,
      ...(held.length > 0
        ? { holds: Object.fromEntries(held.map((one) => [one.slug, one.name])) }
        : {}),
      ...(options.swing ? { swing: options.swing } : {}),
      ...(options.race ? { race: options.race } : {}),
      ...(options.gender ? { gender: options.gender } : {}),
      ...(options.job ? { job: options.job } : {}),
    },
  };
}

export type Manifest = {
  version: number;
  /** Sheets are native size; scale in the engine, never in the export. */
  scale: number;
  direction: number;
  headDirection: number;
  actions: string[];
  zOrder: Record<string, number>;
  generatedAt: string;
  parts: Record<string, PartMeta[]>;
};

/** Every part key already present in a manifest, for skipping re-renders. */
export function manifestKeys(manifest: Manifest | null | undefined): Set<string> {
  const keys = new Set<string>();
  for (const list of Object.values(manifest?.parts ?? {})) {
    for (const entry of list) keys.add(entry.key);
  }
  return keys;
}

/**
 * The manifest as it is written to the zip: one part per line, each part itself
 * compact.
 *
 * `JSON.stringify(manifest, null, 2)` spread 193 parts over 23,000 lines and
 * three times the bytes, for indentation nobody reads — the anchor tables alone
 * are thousands of two-number arrays. Compact throughout would be one 158 KB
 * line, which is smaller still but turns every re-export into a diff of the
 * whole file.
 *
 * A line per part is the middle: the same size as fully compact to within a few
 * hundred bytes, and a re-export of one sprite shows up as one changed line.
 * Going further — a binary or packed encoding — buys nothing worth having: the
 * file is served compressed, and gzip already takes this shape to under 9 KB.
 */
export function stringifyManifest(manifest: Manifest): string {
  const { parts, ...head } = manifest;

  const kinds = Object.entries(parts).map(([kind, list]) => {
    const rows = list.map((part) => `    ${JSON.stringify(part)}`).join(",\n");
    return `  ${JSON.stringify(kind)}: [\n${rows}\n  ]`;
  });

  const fields = Object.entries(head).map(
    ([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`
  );

  return `{\n${fields.join(",\n")},\n  "parts": {\n${kinds.join(",\n")}\n  }\n}\n`;
}

export function buildManifest(
  entries: PartMeta[],
  specs: readonly SheetActionSpec[],
  direction: number,
  headDirection: number,
  /**
   * A manifest from an earlier run to fold this one into. This is what makes
   * the export incremental: ship a few hundred parts today, a few hundred more
   * next week, and drop the new sheets plus the merged manifest into the same
   * folder without re-rendering anything already there.
   */
  base?: Manifest | null
): Manifest {
  const parts: Record<string, PartMeta[]> = {};
  for (const entry of [...(base ? Object.values(base.parts).flat() : []), ...entries]) {
    const list = (parts[entry.kind] ??= []);
    // A re-export of the same sprite wins: same key, newer data.
    const at = list.findIndex((existing) => existing.key === entry.key);
    if (at === -1) list.push(entry);
    else list[at] = entry;
  }
  for (const list of Object.values(parts)) {
    list.sort((a, b) => a.label.localeCompare(b.label));
  }

  const actions = [...new Set([...(base?.actions ?? []), ...specs.map((spec) => spec.slug)])];

  return {
    version: 1,
    scale: 1,
    direction,
    headDirection,
    actions,
    zOrder: { ...Z_INDEX },
    generatedAt: new Date().toISOString(),
    parts,
  };
}
