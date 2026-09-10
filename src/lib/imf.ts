/**
 * Parser for .imf files, which carry a character's per-frame draw order.
 *
 * One file per body sprite (`data/imf/{imfName}_{gender}.imf`). The layout is a
 * version float, a checksum, then a layer count followed by that many *plus
 * one* layers; each layer holds one entry per action, each action one entry per
 * frame, and each entry is a priority and an (x, y) offset.
 *
 * What the files in this data set actually contain, measured across all 304:
 *
 * - Always exactly two layers, and layer 1 is the exact complement of layer 0
 *   in every one of the 138552 cells -- so there is one real bit per frame.
 * - Priorities are only ever 0 or 1, and 1 (weapon in front of the body) is the
 *   default; 1.81% of cells are 0, concentrated in the attack, pick-up, skill
 *   and hurt actions, usually on the later frames of a swing and only for the
 *   facings that turn the character away from the camera.
 * - Every (x, y) offset is zero, in every file. The format can carry positional
 *   data; this data set does not use it.
 */

export type ImfCell = { priority: number; x: number; y: number };
/** Indexed `[layer][action][frame]`. */
export type Imf = ImfCell[][][];

export function parseImf(buffer: ArrayBuffer): Imf {
  const view = new DataView(buffer);
  let offset = 0;
  const i32 = () => {
    const value = view.getInt32(offset, true);
    offset += 4;
    return value;
  };

  offset = 4; // version float
  i32(); // checksum
  const lastLayer = i32();

  const layers: Imf = [];
  for (let layer = 0; layer <= lastLayer; layer++) {
    const actions: ImfCell[][] = [];
    for (let n = i32(), a = 0; a < n; a++) {
      const frames: ImfCell[] = [];
      for (let m = i32(), f = 0; f < m; f++) frames.push({ priority: i32(), x: i32(), y: i32() });
      actions.push(frames);
    }
    layers.push(actions);
  }
  return layers;
}

/** Layer 0 is the weapon's priority; 1 draws it over the body, 0 behind it. */
export const WEAPON_LAYER = 0;

/**
 * Whether the weapon is drawn in front of the body for this action and frame.
 *
 * Anything the file does not cover keeps the default, which is in front.
 */
export function weaponInFront(imf: Imf | null, action: number, frame: number): boolean {
  const cell = imf?.[WEAPON_LAYER]?.[action]?.[frame];
  return cell ? cell.priority !== 0 : true;
}
