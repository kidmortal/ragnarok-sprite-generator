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
 *   headgears 4+n.
 */

import type { Act } from "./act";
import type { Spr } from "./spr";

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
 * Draw order. zrenderer derives shield and garment ordering from .imf/lua data
 * that is not present here, so those use fixed defaults: a garment sits behind
 * the body, weapon and shield in front of it.
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
const isParented = (kind: PartKind) => kind === "head" || kind === "headgear";

export type Part = {
  kind: PartKind;
  spr: Spr;
  act: Act;
  /** Draw order; lower is further back. */
  zIndex: number;
};

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

function actionIndex(part: Part, options: ComposeOptions): number {
  const index = options.actionBase + options.direction;
  return index < part.act.actions.length ? index : index % part.act.actions.length;
}

/**
 * Which motion of a part to show for a given body frame. Head and headgears
 * hold a pose per head direction during stand/sit instead of animating.
 */
function motionIndex(part: Part, options: ComposeOptions, frame: number, motions: number): number {
  if (motions === 0) return 0;
  if (isParented(part.kind) && isStandOrSit(options.actionBase) && motions >= 3) {
    // Animated headgears carry several frames per head direction.
    const perDirection = Math.floor(motions / 3);
    return options.headDirection * perDirection + (frame % perDirection);
  }
  return frame % motions;
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

type DrawOp = {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  alpha: number;
  tint: [number, number, number];
};

/** Per-part cache of decoded frames, so scrubbing an animation is cheap. */
export type FrameCache = Map<Part, HTMLCanvasElement[]>;

export function buildFrameCache(parts: Part[]): FrameCache {
  const cache: FrameCache = new Map();
  for (const part of parts) {
    cache.set(
      part,
      part.spr.frames.map((frame) => {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(frame.width, 1);
        canvas.height = Math.max(frame.height, 1);
        if (frame.width && frame.height) {
          canvas
            .getContext("2d")!
            .putImageData(new ImageData(frame.pixels, frame.width, frame.height), 0, 0);
        }
        return canvas;
      })
    );
  }
  return cache;
}

function drawOpsForFrame(
  parts: Part[],
  cache: FrameCache,
  options: ComposeOptions,
  frame: number
): DrawOp[] {
  const body = parts.find((p) => p.kind === "body");
  const ops: DrawOp[] = [];

  for (const part of [...parts].sort((a, b) => a.zIndex - b.zIndex)) {
    const action = part.act.actions[actionIndex(part, options)];
    if (!action || action.motions.length === 0) continue;

    const motion = action.motions[motionIndex(part, options, frame, action.motions.length)];
    const offset = anchorOffset(part, body, options, frame);
    const canvases = cache.get(part) ?? [];

    for (const layer of motion.layers) {
      const canvas = canvases[layer.sprIndex];
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

/** Bounding box of every frame of the action, relative to the character origin. */
export function actionBounds(parts: Part[], cache: FrameCache, options: ComposeOptions): Rect {
  const total = frameCount(parts, options);
  let bounds: Rect | null = null;

  for (let frame = 0; frame < total; frame++) {
    for (const op of drawOpsForFrame(parts, cache, options, frame)) {
      // Corners of the transformed quad, which rotation may swing outward.
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
  }

  if (!bounds) return { x1: -1, y1: -1, x2: 1, y2: 1 };
  return {
    x1: Math.floor(bounds.x1),
    y1: Math.floor(bounds.y1),
    x2: Math.ceil(bounds.x2),
    y2: Math.ceil(bounds.y2),
  };
}

/**
 * Draw one composed frame into `ctx`, with the character origin at
 * (originX, originY) in destination pixels.
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  parts: Part[],
  cache: FrameCache,
  options: ComposeOptions,
  frame: number,
  originX: number,
  originY: number,
  scale = 1
) {
  ctx.imageSmoothingEnabled = false;
  for (const op of drawOpsForFrame(parts, cache, options, frame)) {
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
): { frames: HTMLCanvasElement[]; width: number; height: number; delay: number } {
  const bounds = actionBounds(parts, cache, options);
  const width = Math.max(Math.round((bounds.x2 - bounds.x1) * scale), 1);
  const height = Math.max(Math.round((bounds.y2 - bounds.y1) * scale), 1);
  const total = frameCount(parts, options);

  const frames: HTMLCanvasElement[] = [];
  for (let frame = 0; frame < total; frame++) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    drawFrame(
      canvas.getContext("2d")!,
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
