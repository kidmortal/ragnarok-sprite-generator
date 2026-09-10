import {
  context2d,
  createCanvas,
  createImageData,
  type SheetCanvas,
  type SheetContext,
} from "./canvas";

/**
 * Composes a character out of several .spr/.act pairs, following the same rules
 * as zrenderer (https://github.com/zhad3/zrenderer):
 *
 * - An action index is `playerAction + direction`, so every action occupies 8
 *   consecutive slots -- one per facing.
 * - Head and headgears are parented to the *body*, not to each other. A child's
 *   layers are shifted by `bodyAnchor[0] - ownAnchor[0]` for the frame.
 * - For the stand and sit actions a head/headgear act holds one frame per head
 *   direction (straight/left/right) rather than an animation.
 * - Layers are drawn by z-index: garment -1, body 0, head 1, weapon 2, shield 3,
 *   headgears 4+n. The weapon's is per-frame rather than fixed, taken from the
 *   body's .imf, which drops it behind the body during a swing away from the
 *   camera.
 */

import type { Act } from "./act";
import type { Spr } from "./spr";
import { weaponInFront, type Imf } from "./imf";

export const PLAYER_ACTIONS = [
  { name: "Stand", base: 0 },
  { name: "Walk", base: 8 },
  { name: "Sit", base: 16 },
  { name: "Pick up", base: 24 },
  { name: "Attack wait", base: 32 },
  { name: "Attack", base: 40 },
  { name: "Hurt", base: 48 },
  { name: "Hurt 2", base: 56 },
  { name: "Dead", base: 64 },
  { name: "Attack 2", base: 80 },
  { name: "Attack 3", base: 88 },
  { name: "Skill", base: 96 },
] as const;

/**
 * Monsters use a shorter action list than players (zrenderer's MonsterAction).
 */
export const MONSTER_ACTIONS = [
  { name: "Stand", base: 0 },
  { name: "Move", base: 8 },
  { name: "Attack", base: 16 },
  { name: "Hurt", base: 24 },
  { name: "Dead", base: 32 },
] as const;

/**
 * Actions offered for a sprite whose act runs past the monster list.
 *
 * Pets carry three or four action groups beyond die -- the idle and performance
 * animations the client plays for a cordial pet. The client's own names for
 * them are not documented anywhere I can point at, so they are numbered rather
 * than guessed at, and the list is taken from the act in hand so a seven-group
 * pet is not offered slots it does not have.
 */
export function actionsForAct(act: Act): readonly { name: string; base: number }[] {
  const groups = Math.floor(act.actions.length / 8);
  const actions: { name: string; base: number }[] = MONSTER_ACTIONS.filter(
    (action) => action.base / 8 < groups
  ).map((action) => ({ name: action.name, base: action.base }));
  for (let group = MONSTER_ACTIONS.length; group < groups; group++) {
    actions.push({ name: `Special ${group - MONSTER_ACTIONS.length + 1}`, base: group * 8 });
  }
  return actions;
}

export const DIRECTIONS = [
  "South",
  "South-west",
  "West",
  "North-west",
  "North",
  "North-east",
  "East",
  "South-east",
] as const;

/** Head facing within a stand/sit pose. */
export const HEAD_DIRECTIONS = ["Straight", "Left", "Right"] as const;

export type PartKind = "body" | "head" | "headgear" | "weapon" | "shield" | "garment";

/**
 * Base draw order. A garment sits behind the body, weapon and shield in front.
 *
 * The weapon's is only a starting point: a body's .imf overrides it per frame,
 * swinging the weapon behind the body on the frames the client draws it there
 * (see `weaponZIndex`). The shield and garment keep these fixed values --
 * an .imf's second layer is the exact complement of its first in every file in
 * this data set, so it carries no information about them to derive.
 */
export const Z_INDEX: Record<PartKind, number> = {
  garment: -1,
  body: 0,
  head: 1,
  weapon: 2,
  shield: 3,
  headgear: 4,
};

/** Only the head and headgears hang off the body's attach point. */
export const isParented = (kind: PartKind) => kind === "head" || kind === "headgear";

export type Part = {
  kind: PartKind;
  spr: Spr;
  act: Act;
  /** Draw order; lower is further back. */
  zIndex: number;
  /**
   * Per-frame draw order, on the body part only. Parsed from the job's .imf.
   */
  imf?: Imf | null;
};

/**
 * Where the weapon sits for one frame.
 *
 * The client draws a weapon in front of the body most of the time, but swings
 * it behind on the later frames of an attack when the character faces away.
 * That is what the body's .imf records, so it decides, and without one the
 * weapon keeps its fixed place in front.
 */
function weaponZIndex(body: Part | undefined, options: ComposeOptions, frame: number): number {
  if (!body?.imf) return Z_INDEX.weapon;
  const action = actionIndex(body, options);
  const motions = body.act.actions[action]?.motions.length ?? 0;
  const motion = motions ? frame % motions : frame;
  return weaponInFront(body.imf, action, motion) ? Z_INDEX.weapon : Z_INDEX.body - 0.5;
}

/**
 * Whether any of these parts carries true-colour (`sprType 1`) frames.
 *
 * Only SPR 2.0 and up has them, and only a handful of sprites use them — an
 * effect layer such as smoke or a glow, drawn as rgba rather than as palette
 * indices. What they cost is the palette pass on export; see
 * `SheetOptions.trueColour` in `apng.ts`.
 */
export function hasTrueColour(parts: readonly Part[]): boolean {
  return parts.some((part) => part.spr.rgbaCount > 0);
}

export type ComposeOptions = {
  /** Base action offset, e.g. 0 for stand -- see PLAYER_ACTIONS. */
  actionBase: number;
  /** Facing, 0-7. */
  direction: number;
  /** Head facing for stand/sit, 0-2. */
  headDirection: number;
};

export type Rect = { x1: number; y1: number; x2: number; y2: number };

const isStandOrSit = (base: number) => base === 0 || base === 16;

/** Frames a body action runs for; the whole composition follows its length. */
export function frameCount(parts: Part[], options: ComposeOptions): number {
  const body = parts.find((p) => p.kind === "body") ?? parts[0];
  if (!body) return 0;
  const action = body.act.actions[actionIndex(body, options)];
  return action?.motions.length ?? 0;
}

export function actionIndex(part: Part, options: ComposeOptions): number {
  const index = options.actionBase + options.direction;
  return index < part.act.actions.length ? index : index % part.act.actions.length;
}

/**
 * Which motion of a part to show for a given body frame. Head and headgears
 * hold a pose per head direction during stand/sit instead of animating.
 */
export function motionIndex(
  part: Part,
  options: ComposeOptions,
  frame: number,
  motions: number
): number {
  if (motions === 0) return 0;
  if (isParented(part.kind) && isStandOrSit(options.actionBase) && motions >= 3) {
    // Animated headgears carry several frames per head direction.
    const perDirection = Math.floor(motions / 3);
    return options.headDirection * perDirection + (frame % perDirection);
  }
  return frame % motions;
}

/**
 * How many frames this part *itself* runs for in the action, as opposed to how
 * many the body will ask it for. Exporting a part on its own has to use this;
 * live composition uses the body's count and wraps every other part with
 * `motionIndex`.
 */
export function ownFrameCount(part: Part, options: ComposeOptions): number {
  const motions = part.act.actions[actionIndex(part, options)]?.motions.length ?? 0;
  if (isParented(part.kind) && isStandOrSit(options.actionBase) && motions >= 3) {
    // A pose per head direction rather than an animation, so only a third of
    // the motions belong to the facing being exported.
    return Math.floor(motions / 3);
  }
  return motions;
}

/** The part's own attach point for a frame, in character coordinates. */
export function ownAnchor(
  part: Part,
  options: ComposeOptions,
  frame: number
): { x: number; y: number } {
  const motions = part.act.actions[actionIndex(part, options)]?.motions ?? [];
  const anchor = motions[motionIndex(part, options, frame, motions.length)]?.anchors[0];
  return { x: anchor?.x ?? 0, y: anchor?.y ?? 0 };
}

/** Offset that hangs a child part on the body's attach point. */
function anchorOffset(
  part: Part,
  body: Part | undefined,
  options: ComposeOptions,
  frame: number
): { x: number; y: number } {
  if (!isParented(part.kind) || !body) return { x: 0, y: 0 };

  const bodyMotions = body.act.actions[actionIndex(body, options)]?.motions ?? [];
  const bodyAnchor = bodyMotions[frame % Math.max(bodyMotions.length, 1)]?.anchors[0];

  const ownMotions = part.act.actions[actionIndex(part, options)]?.motions ?? [];
  const own = ownMotions[motionIndex(part, options, frame, ownMotions.length)]?.anchors[0];

  return {
    x: (bodyAnchor?.x ?? 0) - (own?.x ?? 0),
    y: (bodyAnchor?.y ?? 0) - (own?.y ?? 0),
  };
}

export type DrawOp = {
  canvas: SheetCanvas;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  alpha: number;
  tint: [number, number, number];
};

/** Per-part cache of decoded frames, so scrubbing an animation is cheap. */
export type FrameCache = Map<Part, SheetCanvas[]>;

export function buildFrameCache(parts: Part[]): FrameCache {
  const cache: FrameCache = new Map();
  for (const part of parts) {
    cache.set(
      part,
      part.spr.frames.map((frame) => {
        const canvas = createCanvas(frame.width, frame.height);
        if (frame.width && frame.height) {
          context2d(canvas).putImageData(
            createImageData(frame.pixels, frame.width, frame.height),
            0,
            0,
          );
        }
        return canvas;
      })
    );
  }
  return cache;
}

/**
 * Ops for one part at one frame, with every layer shifted by `offset`.
 *
 * Live composition passes the anchor offset that hangs the part on the body;
 * exporting a part on its own passes zero, or minus the part's own anchor to
 * put the origin *at* the attach point.
 */
export function drawOpsForPart(
  part: Part,
  cache: FrameCache,
  options: ComposeOptions,
  frame: number,
  offset: { x: number; y: number }
): DrawOp[] {
  const action = part.act.actions[actionIndex(part, options)];
  if (!action || action.motions.length === 0) return [];

  const motion = action.motions[motionIndex(part, options, frame, action.motions.length)];
  const canvases = cache.get(part) ?? [];
  const ops: DrawOp[] = [];

  for (const layer of motion.layers) {
    // `sprType` picks the frame list: 0 is the palette-indexed frames, 1 the
    // rgba ones, each numbered from zero. `spr.frames` holds them end to end,
    // indexed first, so an rgba layer has to be shifted past them -- otherwise
    // an effect layer silently draws a *body* frame with the same number, and
    // a monster like Lilith renders as several scaled, rotated copies of itself.
    if (layer.sprIndex < 0) continue;
    const index = layer.sprType === 1 ? part.spr.indexedCount + layer.sprIndex : layer.sprIndex;
    const canvas = canvases[index];
    if (!canvas || layer.color[3] === 0) continue;
    ops.push({
      canvas,
      x: layer.x + offset.x,
      y: layer.y + offset.y,
      scaleX: layer.scaleX * (layer.mirror ? -1 : 1),
      scaleY: layer.scaleY,
      rotation: layer.rotation,
      alpha: layer.color[3] / 255,
      tint: [layer.color[0], layer.color[1], layer.color[2]],
    });
  }

  return ops;
}

function drawOpsForFrame(
  parts: Part[],
  cache: FrameCache,
  options: ComposeOptions,
  frame: number
): DrawOp[] {
  const body = parts.find((p) => p.kind === "body");
  const ops: DrawOp[] = [];

  const zIndexOf = (part: Part) =>
    part.kind === "weapon" ? weaponZIndex(body, options, frame) : part.zIndex;

  for (const part of [...parts].sort((a, b) => zIndexOf(a) - zIndexOf(b))) {
    ops.push(
      ...drawOpsForPart(part, cache, options, frame, anchorOffset(part, body, options, frame))
    );
  }

  return ops;
}

/**
 * Index of the first action that actually draws something.
 *
 * Weapons and shields are blank in the stand pose -- their layers carry
 * `sprIndex: -1` and zero alpha -- so a preview has to look further along the
 * act to find a frame with content.
 */
export function firstDrawableAction(part: Part): number {
  for (let index = 0; index < part.act.actions.length; index++) {
    for (const motion of part.act.actions[index].motions) {
      if (motion.layers.some((layer) => layer.sprIndex >= 0 && layer.color[3] > 0)) {
        return index;
      }
    }
  }
  return 0;
}

/** Widens `bounds` to cover every op, which rotation may swing outward. */
export function growBounds(bounds: Rect | null, ops: DrawOp[]): Rect | null {
  for (const op of ops) {
    const halfW = (op.canvas.width * Math.abs(op.scaleX)) / 2;
    const halfH = (op.canvas.height * Math.abs(op.scaleY)) / 2;
    const rad = (op.rotation * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const extentX = halfW * cos + halfH * sin;
    const extentY = halfW * sin + halfH * cos;
    const box = {
      x1: op.x - extentX,
      y1: op.y - extentY,
      x2: op.x + extentX,
      y2: op.y + extentY,
    };
    bounds = bounds
      ? {
          x1: Math.min(bounds.x1, box.x1),
          y1: Math.min(bounds.y1, box.y1),
          x2: Math.max(bounds.x2, box.x2),
          y2: Math.max(bounds.y2, box.y2),
        }
      : box;
  }
  return bounds;
}

/** Rounds a bounds outward to whole pixels; an empty box becomes a 2x2 stub. */
export function snapBounds(bounds: Rect | null): Rect {
  if (!bounds) return { x1: -1, y1: -1, x2: 1, y2: 1 };
  return {
    x1: Math.floor(bounds.x1),
    y1: Math.floor(bounds.y1),
    x2: Math.ceil(bounds.x2),
    y2: Math.ceil(bounds.y2),
  };
}

/** Bounding box of every frame of the action, relative to the character origin. */
export function actionBounds(parts: Part[], cache: FrameCache, options: ComposeOptions): Rect {
  const total = frameCount(parts, options);
  let bounds: Rect | null = null;

  for (let frame = 0; frame < total; frame++) {
    bounds = growBounds(bounds, drawOpsForFrame(parts, cache, options, frame));
  }

  return snapBounds(bounds);
}

/**
 * Draw one composed frame into `ctx`, with the character origin at
 * (originX, originY) in destination pixels.
 */
export function drawFrame(
  ctx: SheetContext,
  parts: Part[],
  cache: FrameCache,
  options: ComposeOptions,
  frame: number,
  originX: number,
  originY: number,
  scale = 1
) {
  paintOps(ctx, drawOpsForFrame(parts, cache, options, frame), originX, originY, scale);
}

/** Paints draw ops with the character origin at (originX, originY). */
export function paintOps(
  ctx: SheetContext,
  ops: DrawOp[],
  originX: number,
  originY: number,
  scale = 1
) {
  ctx.imageSmoothingEnabled = false;
  for (const op of ops) {
    ctx.save();
    ctx.globalAlpha = op.alpha;
    ctx.translate(originX + op.x * scale, originY + op.y * scale);
    ctx.rotate((op.rotation * Math.PI) / 180);
    ctx.scale(op.scaleX * scale, op.scaleY * scale);
    ctx.drawImage(op.canvas, -op.canvas.width / 2, -op.canvas.height / 2);
    ctx.restore();
  }
}

/** Render every frame of the action to its own tightly-cropped canvas. */
export function renderAction(
  parts: Part[],
  cache: FrameCache,
  options: ComposeOptions,
  scale = 1
): { frames: SheetCanvas[]; width: number; height: number; delay: number } {
  const bounds = actionBounds(parts, cache, options);
  const width = Math.max(Math.round((bounds.x2 - bounds.x1) * scale), 1);
  const height = Math.max(Math.round((bounds.y2 - bounds.y1) * scale), 1);
  const total = frameCount(parts, options);

  const frames: SheetCanvas[] = [];
  for (let frame = 0; frame < total; frame++) {
    const canvas = createCanvas(width, height);
    drawFrame(
      context2d(canvas),
      parts,
      cache,
      options,
      frame,
      -bounds.x1 * scale,
      -bounds.y1 * scale,
      scale
    );
    frames.push(canvas);
  }

  const body = parts.find((p) => p.kind === "body") ?? parts[0];
  const action = body?.act.actions[actionIndex(body, options)];
  // ACT delays are in 25ms ticks.
  const delay = Math.max(Math.round((action?.delay ?? 4) * 25), 20);

  return { frames, width, height, delay };
}
