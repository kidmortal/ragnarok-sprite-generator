/**
 * Snaps a composited sheet back onto the palette its art was drawn in, before
 * it is encoded.
 *
 * The source art is 256-colour indexed with hard alpha, and that is what makes
 * a lossless WebP of it tiny: the encoder stores the whole sheet as palette
 * indices (its `color-indexing` transform) rather than as pixels. Rendering is
 * what breaks it. A frame the .act rotates goes through `ctx.rotate`, and no
 * amount of `imageSmoothingEnabled = false` stops a canvas anti-aliasing the
 * *edges* of what it rotates — so a few frames arrive carrying thousands of
 * blended half-colours. Past 256 the palette transform is gone entirely, and
 * even below it a speckle of near-duplicates wrecks the runs the entropy coder
 * lives on. One rotated frame is enough to do this to a whole sheet.
 *
 * Putting those strays back is not a quality trade: the blended pixels are the
 * artifact, and pixel art wants its hard edge back.
 *
 * Two rules do it, and both are about how a value is *used* rather than how it
 * looks:
 *
 * - **Alpha.** A layer the .act draws at half opacity paints thousands of
 *   pixels at one exact alpha; anti-aliasing sprays a handful each across a
 *   hundred levels. So a level carrying its weight is authored and kept, and
 *   the long tail is snapped to on or off. A sheet holding both keeps the layer
 *   and loses only the fringe.
 * - **Colour.** A colour the sprite is drawn in covers a lot of pixels; a blend
 *   along one edge covers a few and sits right next to the colour it came from.
 *   So the frequent colours anchor the palette, and a rare one is merged into an
 *   anchor when it is close enough to be a rounding artifact of it. A rare
 *   colour that is nobody's neighbour — a two-pixel highlight — is left alone,
 *   unless the sheet is over 256 and something has to give.
 */

/** WebP can only store a palette this big; past it the transform is gone. */
export const MAX_PALETTE = 256;

/** An alpha level covering at least this share of the drawn pixels was authored, not blended. */
const AUTHORED_ALPHA_SHARE = 0.005;

/** …and never fewer than this many pixels, so a small sheet cannot promote its own fringe. */
const AUTHORED_ALPHA_PIXELS = 64;

/** Which way a snapped fringe pixel goes: mostly there, or mostly not. */
const ALPHA_FLOOR = 128;

/** A colour this well used anchors the palette; the rest are candidates for merging. */
const ANCHOR_SHARE = 0.0005;
const ANCHOR_PIXELS = 16;

/**
 * How far a rare colour may sit from a common one and still be treated as a
 * rounding artifact of it: squared distance in premultiplied space, about four
 * levels on a single channel.
 *
 * Deliberately tight. A canvas stores premultiplied and `getImageData`
 * unpremultiplies, so a fringe pixel comes back within a level or two of the
 * colour it was blended from - while a sprite's own shading ramp steps much
 * further than that. Widening this starts flattening gradients, which on a
 * butterfly wing is visible; keeping it narrow only ever collects the artifact.
 */
const MERGE_DISTANCE = 48;

/** How much commoner a colour must be before it may absorb a rare neighbour. */
const DOMINANCE = 8;

export type QuantiseReport = {
  /** Distinct RGBA values before, and after. */
  before: number;
  after: number;
  /** Pixels actually rewritten. Zero means the sheet was left exactly as it was. */
  changed: number;
  /** Alpha levels kept as authored translucency. */
  keptAlphas: number;
  /** Alpha levels treated as anti-aliasing and snapped away. */
  snappedAlphas: number;
  /** Whether the cap forced colours together that were not near neighbours. */
  forced: boolean;
};

/**
 * Reduces `pixels` (RGBA, as `ImageData.data`) to at most `maxColors` distinct
 * values, in place. Returns what it did, so a caller can log or skip the write.
 */
export function quantiseSheet(
  pixels: Uint8ClampedArray,
  maxColors = MAX_PALETTE
): QuantiseReport {
  const words = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.length >> 2);

  let histogram = count(words);
  const before = histogram.size;
  let changed = 0;

  // Measured against drawn pixels rather than the whole sheet: a sheet is mostly
  // empty space, and counting that would make every level look negligible.
  let drawn = 0;
  const perAlpha = new Map<number, number>();
  for (const [colour, times] of histogram) {
    const alpha = colour >>> 24;
    if (alpha === 0) continue;
    drawn += times;
    if (alpha !== 255) perAlpha.set(alpha, (perAlpha.get(alpha) ?? 0) + times);
  }

  const alphaFloor = Math.max(drawn * AUTHORED_ALPHA_SHARE, AUTHORED_ALPHA_PIXELS);
  const keptAlphas = new Set<number>();
  for (const [alpha, times] of perAlpha) if (times >= alphaFloor) keptAlphas.add(alpha);
  const snappedAlphas = perAlpha.size - keptAlphas.size;

  if (snappedAlphas > 0) {
    for (let i = 0; i < words.length; i++) {
      const alpha = words[i] >>> 24;
      if (alpha === 0 || alpha === 255 || keptAlphas.has(alpha)) continue;
      words[i] = alpha < ALPHA_FLOOR ? 0 : (words[i] | 0xff000000) >>> 0;
      changed++;
    }
    histogram = count(words);
  }

  // Ties break on the colour itself, so the outcome cannot depend on Map order.
  const ranked = [...histogram.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const keep = ranked.slice(0, maxColors);
  const merge = new Map<number, number>();

  // Anything past the cap has to go somewhere, near neighbour or not — but only
  // the tail does, so the forced part of this is as small as the sheet allows.
  const forced = ranked.length > maxColors;
  const survivors = keep.map(([colour]) => colour);
  for (const [colour] of ranked.slice(maxColors)) {
    merge.set(colour, closest(colour, survivors)[0]);
  }

  // Then the tidying that pays even when the sheet already fits: a rare colour
  // sitting on top of a much commoner one is a rounding artifact of it, and
  // folding it back turns a speckle into a run the entropy coder can eat.
  // Rarest first, and only ever into something that dominates it, so a palette
  // ramp of evenly used colours is never flattened into one.
  const rareFloor = Math.max(drawn * ANCHOR_SHARE, ANCHOR_PIXELS);
  for (let i = keep.length - 1; i >= 0; i--) {
    const [colour, times] = keep[i];
    if (times >= rareFloor) break;

    let best = 0;
    let bestDistance = Infinity;
    for (let j = 0; j < i; j++) {
      const [candidate, candidateTimes] = keep[j];
      if (candidateTimes < times * DOMINANCE) continue;
      const distance = separation(colour, candidate);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    if (bestDistance <= MERGE_DISTANCE) merge.set(colour, best);
  }

  if (merge.size > 0) {
    // A target may itself have been merged, so follow the chain once here
    // rather than rewriting the sheet more than once.
    for (const [from] of merge) {
      let to = merge.get(from)!;
      for (let hops = 0; hops < merge.size && merge.has(to); hops++) to = merge.get(to)!;
      merge.set(from, to);
    }

    for (let i = 0; i < words.length; i++) {
      const swap = merge.get(words[i]);
      if (swap === undefined || swap === words[i]) continue;
      words[i] = swap;
      changed++;
    }
  }

  return {
    before,
    after: changed > 0 ? count(words).size : before,
    changed,
    keptAlphas: keptAlphas.size,
    snappedAlphas,
    forced,
  };
}

function count(words: Uint32Array): Map<number, number> {
  const histogram = new Map<number, number>();
  for (let i = 0; i < words.length; i++) {
    histogram.set(words[i], (histogram.get(words[i]) ?? 0) + 1);
  }
  return histogram;
}

/**
 * The anchor a colour is closest to, and how far that was. Compared in
 * premultiplied space so what is nearly transparent lands on what is
 * transparent, rather than on whichever opaque colour happens to share its hue.
 */
function closest(colour: number, anchors: number[]): [number, number] {
  let best = anchors[0];
  let bestDistance = Infinity;

  for (const entry of anchors) {
    const distance = separation(colour, entry);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = entry;
      if (distance === 0) break;
    }
  }

  return [best, bestDistance];
}

/** Squared distance between two colours, premultiplied. */
function separation(one: number, other: number): number {
  const [r, g, b, a] = channels(one);
  const [pr, pg, pb, pa] = channels(other);
  const dr = (r * a - pr * pa) / 255;
  const dg = (g * a - pg * pa) / 255;
  const db = (b * a - pb * pa) / 255;
  const da = a - pa;
  return dr * dr + dg * dg + db * db + da * da;
}

/** Little-endian RGBA, the order `ImageData` packs into a word. */
function channels(colour: number): [number, number, number, number] {
  return [colour & 0xff, (colour >>> 8) & 0xff, (colour >>> 16) & 0xff, colour >>> 24];
}
