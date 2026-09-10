/**
 * Renders one part on its own, in a coordinate frame that lets a game engine
 * glue the parts back together at runtime.
 *
 * The whole design rests on the fact that zrenderer's child offset factors:
 *
 *     childLayer.x + bodyAnchor.x - ownAnchor.x
 *   = (childLayer.x - ownAnchor.x)  +  bodyAnchor.x
 *      \___ baked into the sheet ___/   \_ shipped in the body's JSON _/
 *
 * So a head sheet rendered with its origin *at its own attach point* is
 * body-independent, and the only runtime data needed is the body's per-frame
 * anchor table. Heads x bodies becomes additive rather than multiplicative.
 *
 * Everything that is not parented (body, weapon, shield, garment) is already
 * aligned to the character origin and needs no correction at all.
 */

import { context2d, createCanvas, type SheetCanvas } from "./canvas";
import {
  MONSTER_ACTIONS,
  PLAYER_ACTIONS,
  actionIndex,
  drawOpsForPart,
  growBounds,
  isParented,
  ownAnchor,
  ownFrameCount,
  paintOps,
  snapBounds,
  type DrawOp,
  type FrameCache,
  type Part,
  type Rect,
} from "./compose";

/** Columns a packed sheet uses; 8 keeps a walk cycle on one row. */
export const SHEET_COLUMNS = 8;

export type SheetActionSpec = {
  slug: string;
  base: number;
  /**
   * At most this many frames, whatever the act runs for.
   *
   * For a pose that is *held* rather than played. RO's sit is a short loop of a
   * character settling, and what a consumer wants out of it is the seated
   * figure - so the export takes the first frame and stops, rather than
   * shipping a cycle every caller would have to know to freeze.
   *
   * Absent on every action that is really an animation, which is nearly all of
   * them: a cap is a statement about the pose, not a size limit.
   */
  frames?: number;
};

export type SheetAction = {
  /** The `PLAYER_ACTIONS` base this came from, for cross-referencing. */
  base: number;
  /** First cell index in the sheet, row-major. */
  start: number;
  /** Frames this part itself runs for -- not what the body will ask of it. */
  count: number;
  frameDelayMs: number;
  /**
   * The body's attach point per frame, in native pixels. Body sheets only:
   * this is what a head or headgear is positioned at.
   */
  anchors?: [number, number][];
};

export type PartSheet = {
  /** One canvas per cell, all exactly `cell` big. */
  frames: SheetCanvas[];
  cell: { w: number; h: number };
  /**
   * The pixel inside a cell that anchors it. For an unparented part that is
   * the character origin; for a head or headgear it is the attach point.
   */
  origin: [number, number];
  columns: number;
  actions: Record<string, SheetAction>;
};

/**
 * Slugs that differ from the RO action name. "Attack wait" is the loop a
 * character plays while standing ready, which is what an engine means by
 * "idle" -- exporting it under its RO name only makes the consumer rename it.
 */
const SLUG_OVERRIDES: Record<string, string> = { attackwait: "idle" };

const slugify = (name: string) => {
  const slug = name.toLowerCase().replace(/\s+/g, "");
  return SLUG_OVERRIDES[slug] ?? slug;
};

/** Every player action, slugged for use as a JSON key and an animation name. */
export const PLAYER_SHEET_ACTIONS: SheetActionSpec[] = PLAYER_ACTIONS.map((action) => ({
  slug: slugify(action.name),
  base: action.base,
}));

export const MONSTER_SHEET_ACTIONS: SheetActionSpec[] = MONSTER_ACTIONS.map((action) => ({
  slug: slugify(action.name),
  base: action.base,
}));

type ActionPlan = {
  spec: SheetActionSpec;
  frames: DrawOp[][];
  frameDelayMs: number;
  anchors: [number, number][];
};

/**
 * Lays every action of one part into a single uniform grid, for one facing.
 *
 * Frame counts are the part's *own*, deliberately: normalising them to a body's
 * length is what would make a weapon sheet body-specific again. The runtime
 * drives a master counter from the body and indexes every other part with
 * `master % count`, exactly as `motionIndex` does here.
 */
export function renderPartSheet(
  part: Part,
  cache: FrameCache,
  specs: readonly SheetActionSpec[],
  direction: number,
  headDirection: number,
  /**
   * Whether to ship the per-frame attach table. True for a real body, whose
   * anchors are what heads and headgears hang off; false for a monster, which
   * renders on a body's terms but wears nothing, so an anchor table would be
   * a few hundred numbers per sheet that nothing can ever read.
   */
  emitAnchors = part.kind === "body"
): PartSheet {
  const parented = isParented(part.kind);
  const plans: ActionPlan[] = [];
  let bounds: Rect | null = null;

  for (const spec of specs) {
    const options = { actionBase: spec.base, direction, headDirection };
    // The part's own length, held to whatever the spec will take - see
    // `SheetActionSpec.frames`. Capped here rather than trimmed afterwards so a
    // frame nobody ships is a frame nobody draws, measures or packs.
    const own = ownFrameCount(part, options);
    const count = spec.frames === undefined ? own : Math.min(own, spec.frames);
    const frames: DrawOp[][] = [];
    const anchors: [number, number][] = [];

    for (let frame = 0; frame < count; frame++) {
      const anchor = ownAnchor(part, options, frame);
      anchors.push([anchor.x, anchor.y]);

      // Putting the origin on the attach point is what makes a head sheet
      // independent of whatever body it ends up on.
      const offset = parented ? { x: -anchor.x, y: -anchor.y } : { x: 0, y: 0 };
      const ops = drawOpsForPart(part, cache, options, frame, offset);
      bounds = growBounds(bounds, ops);
      frames.push(ops);
    }

    // ACT delays are in 25ms ticks.
    const ticks = part.act.actions[actionIndex(part, options)]?.delay ?? 4;
    plans.push({
      spec,
      frames,
      anchors,
      frameDelayMs: Math.max(Math.round(ticks * 25), 20),
    });
  }

  const rect = snapBounds(bounds);
  const cell = {
    w: Math.max(rect.x2 - rect.x1, 1),
    h: Math.max(rect.y2 - rect.y1, 1),
  };
  const origin: [number, number] = [-rect.x1, -rect.y1];

  const sheet: PartSheet = { frames: [], cell, origin, columns: SHEET_COLUMNS, actions: {} };

  for (const plan of plans) {
    sheet.actions[plan.spec.slug] = {
      base: plan.spec.base,
      start: sheet.frames.length,
      count: plan.frames.length,
      frameDelayMs: plan.frameDelayMs,
      ...(emitAnchors ? { anchors: plan.anchors } : {}),
    };

    for (const ops of plan.frames) {
      const canvas = createCanvas(cell.w, cell.h);
      paintOps(context2d(canvas), ops, origin[0], origin[1]);
      sheet.frames.push(canvas);
    }
  }

  // A part that draws nothing anywhere still has to produce a texture, or the
  // packer has no frame size to work from.
  if (sheet.frames.length === 0) {
    sheet.frames.push(createCanvas(cell.w, cell.h));
  }

  return sheet;
}
