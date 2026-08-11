import { fetchFile, fetchRange } from "../api";
import { parseSpr } from "./spr";
import { parseAct } from "./act";
import { buildFrameCache, renderAction } from "./compose";

export type Thumb = { url: string; width: number; height: number };

const cache = new Map<string, Promise<Thumb>>();
const MAX_PARALLEL = 6;
const THUMB_BOX = 96;

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

const HEAD_BYTES = 64 * 1024;
const PALETTE_BYTES = 1024;

/**
 * Fetch only what a first-frame thumbnail needs: the header plus the trailing
 * palette, spliced into one buffer that parseSpr can read as-is. Falls back to
 * the whole file when the first frame does not fit in the head slice.
 */
async function fetchThumbBytes(id: string): Promise<{ buffer: ArrayBuffer; validBytes: number }> {
  try {
    const [head, palette] = await Promise.all([
      fetchRange(id, 0, HEAD_BYTES - 1),
      fetchRange(id, -PALETTE_BYTES),
    ]);
    if (head.byteLength >= HEAD_BYTES && palette.byteLength === PALETTE_BYTES) {
      const spliced = new Uint8Array(head.byteLength + palette.byteLength);
      spliced.set(new Uint8Array(head), 0);
      spliced.set(new Uint8Array(palette), head.byteLength);
      return { buffer: spliced.buffer, validBytes: head.byteLength };
    }
    // Small file: the head slice already held everything, palette included.
    return { buffer: head, validBytes: head.byteLength };
  } catch {
    const full = await fetchFile(id);
    return { buffer: full, validBytes: full.byteLength };
  }
}

/**
 * Decode just the first frame of a .spr into a small data URL. Results are
 * cached by id, so scrolling back over a folder costs nothing.
 */
export function loadThumb(id: string): Promise<Thumb> {
  const cached = cache.get(id);
  if (cached) return cached;

  const promise = schedule(async () => {
    let spr;
    try {
      const { buffer, validBytes } = await fetchThumbBytes(id);
      spr = parseSpr(buffer, { maxFrames: 1, validBytes });
    } catch {
      // First frame did not fit in the head slice -- pay for the full file.
      spr = parseSpr(await fetchFile(id), { maxFrames: 1 });
    }
    const frame = spr.frames[0];
    if (!frame || !frame.width || !frame.height) throw new Error("empty sprite");

    const source = document.createElement("canvas");
    source.width = frame.width;
    source.height = frame.height;
    source
      .getContext("2d")!
      .putImageData(new ImageData(frame.pixels, frame.width, frame.height), 0, 0);

    const scale = Math.min(THUMB_BOX / frame.width, THUMB_BOX / frame.height, 3);
    const out = document.createElement("canvas");
    out.width = Math.max(Math.round(frame.width * scale), 1);
    out.height = Math.max(Math.round(frame.height * scale), 1);
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, 0, 0, out.width, out.height);

    return { url: out.toDataURL("image/png"), width: out.width, height: out.height };
  });

  // Do not cache failures -- a retry on the next scroll-in is cheap.
  promise.catch(() => cache.delete(id));
  cache.set(id, promise);
  return promise;
}

/**
 * Preview of a *character part*, composed through its .act rather than taken
 * raw from the .spr. A body's first spr frame is only a fragment of the sprite,
 * so it makes an unrecognisable thumbnail -- rendering frame 0 of the stand
 * action assembles the layers into the actual part.
 */
export function loadPartThumb(sprId: string, actId: string): Promise<Thumb> {
  const key = `part:${sprId}|${actId}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = schedule(async () => {
    const [sprBuf, actBuf] = await Promise.all([fetchFile(sprId), fetchFile(actId)]);
    const part = {
      kind: "body" as const,
      zIndex: 0,
      spr: parseSpr(sprBuf),
      act: parseAct(actBuf),
    };

    const frameCache = buildFrameCache([part]);
    const { frames } = renderAction([part], frameCache, {
      actionBase: 0,
      direction: 0,
      headDirection: 0,
    });
    const source = frames[0];
    if (!source || !source.width || !source.height) throw new Error("empty part");

    // Fit inside the tile without ever upscaling past 3x.
    const scale = Math.min(TILE / source.width, TILE / source.height, 3);
    const out = document.createElement("canvas");
    out.width = Math.max(Math.round(source.width * scale), 1);
    out.height = Math.max(Math.round(source.height * scale), 1);
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, 0, 0, out.width, out.height);

    return { url: out.toDataURL("image/png"), width: out.width, height: out.height };
  });

  promise.catch(() => cache.delete(key));
  cache.set(key, promise);
  return promise;
}
