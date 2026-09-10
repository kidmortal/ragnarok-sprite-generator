import { asDomCanvas, context2d, type SheetCanvas } from "./canvas";
import { fetchFile } from "../api";
import { parseSpr } from "./spr";
import { parseAct } from "./act";
import { buildFrameCache, firstDrawableAction, renderAction } from "./compose";

export type Thumb = { url: string; width: number; height: number };

const cache = new Map<string, Promise<Thumb>>();
const MAX_PARALLEL = 6;

let active = 0;
const queue: (() => void)[] = [];

/**
 * A folder can hold thousands of sprites, so keep only a handful of
 * fetch+decode jobs in flight; the rest wait their turn instead of all
 * competing for the network and the main thread at once.
 */
function schedule<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      active++;
      job()
        .then(resolve, reject)
        .finally(() => {
          active--;
          queue.shift()?.();
        });
    };
    if (active < MAX_PARALLEL) run();
    else queue.push(run);
  });
}

export const TILE = 64;

/**
 * Preview of one part, composed through its .act rather than taken raw from the
 * .spr: a body's first spr frame is only a fragment of the sprite, so it makes
 * an unrecognisable thumbnail.
 */
export function loadPartThumb(sprId: string, actId: string, tile = TILE): Promise<Thumb> {
  const key = `part:${sprId}|${actId}|${tile}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = schedule(async () => {
    const cached = await fetchCachedThumb(sprId, tile);
    if (cached) return cached;

    const [sprBuf, actBuf] = await Promise.all([fetchFile(sprId), fetchFile(actId)]);
    const part = {
      kind: "body" as const,
      zIndex: 0,
      spr: parseSpr(sprBuf),
      act: parseAct(actBuf),
    };

    const frameCache = buildFrameCache([part]);
    const { frames } = renderAction([part], frameCache, {
      // actionIndex is actionBase + direction, so this renders exactly this action.
      actionBase: firstDrawableAction(part),
      direction: 0,
      headDirection: 0,
    });

    // Within that action, show whichever frame has the most to look at.
    const source = frames.reduce<SheetCanvas | null>((best, frame) => {
      if (!frame.width || !frame.height) return best;
      if (!best) return frame;
      return opaquePixels(frame) > opaquePixels(best) ? frame : best;
    }, null);
    if (!source || !source.width || !source.height) throw new Error("empty part");

    // Fit inside the tile without ever upscaling past 3x.
    const scale = Math.min(tile / source.width, tile / source.height, 3);
    const out = document.createElement("canvas");
    out.width = Math.max(Math.round(source.width * scale), 1);
    out.height = Math.max(Math.round(source.height * scale), 1);
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    // Browser only, like the `toDataURL` below it.
    ctx.drawImage(asDomCanvas(source), 0, 0, out.width, out.height);

    return { url: out.toDataURL("image/png"), width: out.width, height: out.height };
  });

  promise.catch(() => cache.delete(key));
  cache.set(key, promise);
  return promise;
}

/**
 * The preview `npm run thumbs` rendered for this part, if there is one.
 *
 * Composing a preview costs a .spr and an .act download plus a canvas compose
 * per tile, so the pre-rendered WebP is tried first and the composer is left as
 * the fallback for parts the cache has not been built for.
 */
async function fetchCachedThumb(sprId: string, tile: number): Promise<Thumb | null> {
  let res: Response;
  try {
    res = await fetch(`/api/thumb?id=${encodeURIComponent(sprId)}&tile=${tile}`);
  } catch {
    return null; // offline or the API is down; the composer will fail too
  }
  if (!res.ok) return null;

  const url = URL.createObjectURL(await res.blob());
  try {
    const { width, height } = await measure(url);
    return { url, width, height };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

/** Natural size of an image url, since the tile is not told the dimensions. */
function measure(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("bad thumbnail"));
    img.src = url;
  });
}

/** Rough "how much is drawn here" measure, used to pick a preview frame. */
function opaquePixels(canvas: SheetCanvas): number {
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let count = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 8) count++;
  return count;
}
