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
import { Z_INDEX, buildFrameCache, type Part, type PartKind } from "./compose";
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
  kind: PartKind | "monster";
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
};

/** Fetches, parses and renders one part into its sheet and its metadata. */
export async function exportPart(
  entry: PartEntry,
  options: ExportOptions
): Promise<ExportedPart> {
  const [sprBuf, actBuf] = await Promise.all([fetchFile(entry.sprId), fetchFile(entry.actId)]);

  // Monsters compose as a standalone sprite, so they render on the body's
  // terms: origin at the character origin, no attach point.
  const monster = options.kind === "monster";
  const kind: PartKind = options.kind === "monster" ? "body" : options.kind;
  const part: Part = {
    kind,
    zIndex: Z_INDEX[kind],
    spr: parseSpr(sprBuf),
    act: parseAct(actBuf),
  };

  const cache = buildFrameCache([part]);
  const sheet = renderPartSheet(
    part,
    cache,
    options.specs,
    options.direction,
    options.headDirection,
    // A monster renders as a body but nothing ever attaches to it, so it ships
    // without the anchor table a real body owes its heads.
    !monster
  );

  const packed = await encodeSpritesheet(sheet.frames, sheet.columns);
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
