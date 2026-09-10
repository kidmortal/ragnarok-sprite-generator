/**
 * Silhouette measurement, for asking whether a body is the shape its weapon
 * art was drawn for.
 *
 * A weapon is drawn at the character origin -- unlike a head or a headgear it
 * is not hung off an attach point -- so the hilt lands in the same place on
 * every body wearing that art, and only the body's own outline decides whether
 * a hand is there to hold it. Nothing in a .spr or .act says which body the art
 * was drawn for, so the outline is all there is to compare.
 *
 * Used by `measure-silhouettes.ts`; the server reads its output rather than
 * measuring anything itself.
 */

import fs from "node:fs/promises";
import { parseSpr } from "../src/lib/spr.ts";
import { parseAct } from "../src/lib/act.ts";
import {
  drawOpsForPart,
  Z_INDEX,
  type ComposeOptions,
  type FrameCache,
  type Part,
  type PartKind,
} from "../src/lib/compose.ts";
import { encodeId, resolveId } from "./paths.ts";

/** Attack wait: the static hold pose, where a weapon sits in the hand. */
export const HOLD_ACTION = 32;
export const DIRECTIONS = [0, 1, 2, 3, 4, 5, 6, 7] as const;

export type Loaded = { part: Part; cache: FrameCache };

/** A .spr/.act pair, with its frames in the shape the compose module wants. */
export async function loadPart(relative: string, kind: PartKind): Promise<Loaded | null> {
  const read = async (extension: string) => {
    const rel = Buffer.from(`${relative}${extension}`);
    const bytes = await fs.readFile(resolveId(encodeId(rel)));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  };

  let spr: ArrayBuffer;
  let act: ArrayBuffer;
  try {
    [spr, act] = await Promise.all([read(".spr"), read(".act")]);
  } catch {
    return null;
  }

  let part: Part;
  try {
    part = { kind, zIndex: Z_INDEX[kind], spr: parseSpr(spr), act: parseAct(act) };
  } catch {
    return null;
  }

  // The compose module only ever reads width/height/pixels off a frame, so the
  // same stand-in `thumbnail.ts` uses serves here -- there is no canvas in node.
  const cache: FrameCache = new Map();
  cache.set(
    part,
    part.spr.frames.map((frame) => ({
      width: Math.max(frame.width, 1),
      height: Math.max(frame.height, 1),
      pixels: frame.pixels,
    })) as unknown as HTMLCanvasElement[]
  );
  return { part, cache };
}

export type Extent = { minX: number; maxX: number; minY: number; maxY: number };

/**
 * Horizontal and vertical extent of a frame's opaque pixels, in character
 * coordinates.
 *
 * The pixels are transformed forward rather than rasterised: only the outermost
 * ones matter, and painting a frame to read its bounding box would cost an
 * allocation and a second pass for nothing. `drawOpsForPart` is asked for the
 * ops so this measures exactly what the renderer would draw, rotation, scale
 * and mirroring included.
 */
export function extent(loaded: Loaded, direction: number, frame = 0): Extent | null {
  const options: ComposeOptions = { actionBase: HOLD_ACTION, direction, headDirection: 0 };
  const ops = drawOpsForPart(loaded.part, loaded.cache, options, frame, { x: 0, y: 0 });

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let opaque = 0;

  for (const op of ops) {
    const src = op.canvas as unknown as {
      width: number;
      height: number;
      pixels: Uint8ClampedArray;
    };
    if (!src.width || !src.height || op.alpha <= 0) continue;

    const radians = (op.rotation * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);

    for (let v = 0; v < src.height; v++) {
      for (let u = 0; u < src.width; u++) {
        if (src.pixels[(v * src.width + u) * 4 + 3] <= 8) continue;
        const rx = (u + 0.5 - src.width / 2) * op.scaleX;
        const ry = (v + 0.5 - src.height / 2) * op.scaleY;
        const x = op.x + rx * cos - ry * sin;
        const y = op.y + rx * sin + ry * cos;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        opaque++;
      }
    }
  }

  if (!opaque) return null;
  return {
    minX: Math.floor(minX),
    maxX: Math.ceil(maxX),
    minY: Math.floor(minY),
    maxY: Math.ceil(maxY),
  };
}

/**
 * Which side of the character origin a folder's weapons hang on, per direction.
 *
 * Facing east the blade runs out to +x and the hand is at its low end; facing
 * south it is the mirror of that. Rather than hard-code the eight answers they
 * are voted on by the folder's own art, so a folder of bows or guns is read on
 * its own terms.
 */
export async function weaponSides(raceRoot: string, folder: string, weapons: string[]) {
  const votes = DIRECTIONS.map(() => 0);
  for (const weapon of weapons) {
    const loaded = await loadPart(`${raceRoot}/${folder}/${weapon}`, "weapon");
    if (!loaded) continue;
    for (const direction of DIRECTIONS) {
      const box = extent(loaded, direction);
      if (box) votes[direction] += Math.abs(box.maxX) >= Math.abs(box.minX) ? 1 : -1;
    }
  }
  return votes.map((vote) => (vote >= 0 ? 1 : -1));
}

/** How far a body's outline reaches on `side`, per direction. */
export function reach(loaded: Loaded, sides: number[]): (number | null)[] {
  return DIRECTIONS.map((direction) => {
    const box = extent(loaded, direction);
    if (!box) return null;
    return sides[direction] > 0 ? box.maxX : -box.minX;
  });
}

/**
 * How much narrower a body is than the body its weapon art was drawn for.
 *
 * Reach in one direction and reach in its opposite are the two lateral extremes
 * of the same outline, so their mean is half the body's width and the thing
 * they have in common is size rather than position. Averaging the pair is what
 * makes this a *width* test: a costume drawn a few pixels off-centre falls
 * short facing one way and overhangs facing the other, and cancels, while a
 * body genuinely smaller than the art expects falls short both ways.
 *
 * Without that, mounted bodies score as badly as broken ones -- a peco whose
 * beak and tail sit differently reads as 9px short east and 9px wide west, and
 * renders perfectly.
 */
export function narrowing(body: (number | null)[], reference: (number | null)[]): number | null {
  const pairs: number[] = [];
  for (let direction = 0; direction < 4; direction++) {
    const opposite = direction + 4;
    const near = reference[direction];
    const far = reference[opposite];
    const mineNear = body[direction];
    const mineFar = body[opposite];
    if (near === null || far === null || mineNear === null || mineFar === null) continue;
    pairs.push((near - mineNear + (far - mineFar)) / 2);
  }
  return pairs.length ? Math.max(...pairs) : null;
}
