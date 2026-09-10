/**
 * Server-side thumbnail rendering.
 *
 * The browser builds previews by composing a part through its .act onto a
 * canvas (see `src/lib/thumbs.ts`). That work is identical for every visitor
 * and for every reload, and a folder holds thousands of parts, so it is done
 * once here instead -- see `generate-thumbs.ts`.
 *
 * There is no canvas in node, and pulling one in for six lines of blitting
 * would be a heavy dependency for a build step. Instead the compose module's
 * pure half (draw ops, bounds) is reused as-is and the ops are painted by the
 * nearest-neighbour rasteriser below, which is what the canvas does anyway once
 * `imageSmoothingEnabled` is off.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import type { SheetCanvas } from "../src/lib/canvas.ts";
import { parseSpr } from "../src/lib/spr.ts";
import { parseAct } from "../src/lib/act.ts";
import {
  drawOpsForPart,
  firstDrawableAction,
  growBounds,
  ownFrameCount,
  snapBounds,
  Z_INDEX,
  type ComposeOptions,
  type DrawOp,
  type FrameCache,
  type Part,
  type Rect,
} from "../src/lib/compose.ts";

/** Tile size the client asks for; thumbnails are generated to fit it. */
export const TILE = 64;

/**
 * A stand-in for the canvas the compose module caches per frame.
 *
 * **The server paints two different ways, on purpose.** This file is a build
 * step - thousands of one-frame previews, rendered once and cached - and the
 * rasteriser below is what a canvas does anyway with smoothing off, for none of
 * the dependency. Shipped game art is drawn the other way, in a real browser
 * (`server/browser-sheets.ts`), because there "near enough" is exactly what
 * must not happen.
 */
type Bitmap = { width: number; height: number; pixels: Uint8ClampedArray };

/** Where one part's thumbnail lives, sharded so no directory holds them all. */
export function thumbFile(cacheDir: string, sprId: string, tile = TILE): string {
  const digest = createHash("sha256").update(`${sprId}|${tile}`).digest("hex");
  return path.join(cacheDir, digest.slice(0, 2), `${digest.slice(2)}.webp`);
}

/**
 * Lossless WebP thumbnail of one part, or null when the part draws nothing.
 *
 * Same choices as the browser preview so the two are interchangeable: the first
 * action that actually draws, facing south, cropped to that action's bounds,
 * and whichever of its frames has the most opaque pixels.
 */
export async function renderThumb(
  sprBuffer: ArrayBuffer,
  actBuffer: ArrayBuffer,
  tile = TILE
): Promise<Buffer | null> {
  const part: Part = {
    kind: "body",
    zIndex: Z_INDEX.body,
    spr: parseSpr(sprBuffer),
    act: parseAct(actBuffer),
  };

  const cache: FrameCache = new Map();
  cache.set(
    part,
    part.spr.frames.map((frame) => ({
      width: Math.max(frame.width, 1),
      height: Math.max(frame.height, 1),
      pixels: frame.pixels,
    })) as unknown as SheetCanvas[]
  );

  const options: ComposeOptions = {
    actionBase: firstDrawableAction(part),
    direction: 0,
    headDirection: 0,
  };

  const total = ownFrameCount(part, options);
  const perFrame: DrawOp[][] = [];
  let bounds: Rect | null = null;
  for (let frame = 0; frame < total; frame++) {
    const ops = drawOpsForPart(part, cache, options, frame, { x: 0, y: 0 });
    perFrame.push(ops);
    bounds = growBounds(bounds, ops);
  }
  if (!bounds) return null;

  const box = snapBounds(bounds);
  const width = Math.max(box.x2 - box.x1, 1);
  const height = Math.max(box.y2 - box.y1, 1);
  if (width > 4096 || height > 4096) return null;

  // Whichever frame has the most to look at, exactly as the browser picks.
  let best: Uint8ClampedArray | null = null;
  let bestOpaque = 0;
  for (const ops of perFrame) {
    const canvas = new Uint8ClampedArray(width * height * 4);
    paintOps(canvas, width, height, ops, -box.x1, -box.y1);
    let opaque = 0;
    for (let i = 3; i < canvas.length; i += 4) if (canvas[i] > 8) opaque++;
    if (!best || opaque > bestOpaque) {
      best = canvas;
      bestOpaque = opaque;
    }
  }
  if (!best || bestOpaque === 0) return null;

  // Fit inside the tile without ever upscaling past 3x, as the client does.
  const scale = Math.min(tile / width, tile / height, 3);
  const outWidth = Math.max(Math.round(width * scale), 1);
  const outHeight = Math.max(Math.round(height * scale), 1);

  return sharp(Buffer.from(best.buffer, best.byteOffset, best.byteLength), {
    raw: { width, height, channels: 4 },
  })
    .resize(outWidth, outHeight, { kernel: "nearest", fit: "fill" })
    .webp({ lossless: true, effort: 4, exact: true })
    .toBuffer();
}

/**
 * Paints draw ops into an RGBA buffer with the character origin at
 * (originX, originY).
 *
 * Each op is a source bitmap placed at its centre, then rotated and scaled, so
 * the destination box is walked and inverse-transformed back into source
 * pixels: nearest sample, source-over blend. Layer tints are ignored here
 * because `paintOps` in the browser ignores them too.
 */
export function paintOps(
  out: Uint8ClampedArray,
  width: number,
  height: number,
  ops: DrawOp[],
  originX: number,
  originY: number
) {
  for (const op of ops) {
    const src = op.canvas as unknown as Bitmap;
    if (!src.width || !src.height || op.alpha <= 0) continue;

    const rad = (op.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const centreX = originX + op.x;
    const centreY = originY + op.y;

    // Destination box the op can possibly touch, rotation swing included.
    const halfW = (src.width * Math.abs(op.scaleX)) / 2;
    const halfH = (src.height * Math.abs(op.scaleY)) / 2;
    const extentX = halfW * Math.abs(cos) + halfH * Math.abs(sin);
    const extentY = halfW * Math.abs(sin) + halfH * Math.abs(cos);
    const x0 = Math.max(Math.floor(centreX - extentX), 0);
    const y0 = Math.max(Math.floor(centreY - extentY), 0);
    const x1 = Math.min(Math.ceil(centreX + extentX), width);
    const y1 = Math.min(Math.ceil(centreY + extentY), height);

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        // Undo translate -> rotate -> scale to land back in source pixels.
        const dx = x + 0.5 - centreX;
        const dy = y + 0.5 - centreY;
        const rx = dx * cos + dy * sin;
        const ry = -dx * sin + dy * cos;
        const u = Math.floor(rx / op.scaleX + src.width / 2);
        const v = Math.floor(ry / op.scaleY + src.height / 2);
        if (u < 0 || v < 0 || u >= src.width || v >= src.height) continue;

        const s = (v * src.width + u) * 4;
        const alpha = (src.pixels[s + 3] / 255) * op.alpha;
        if (alpha <= 0) continue;

        const d = (y * width + x) * 4;
        const dstAlpha = out[d + 3] / 255;
        const outAlpha = alpha + dstAlpha * (1 - alpha);
        for (let c = 0; c < 3; c++) {
          out[d + c] = (src.pixels[s + c] * alpha + out[d + c] * dstAlpha * (1 - alpha)) / outAlpha;
        }
        out[d + 3] = outAlpha * 255;
      }
    }
  }
}
