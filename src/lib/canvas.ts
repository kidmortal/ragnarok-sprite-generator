/**
 * The one place a canvas is made, so the compositor can run outside a browser.
 *
 * Every pixel this app produces is drawn through a 2D context: `.spr` frames
 * are put down as `ImageData`, layers are rotated and flipped onto a frame, and
 * frames are laid into a sheet. All of that was written against
 * `document.createElement("canvas")`, which meant the *only* way to obtain a
 * spritesheet was to open the app in a browser and press a button — so nothing
 * automated could ask for one, and the export pipeline had a human in the
 * middle of it by construction.
 *
 * The fix is deliberately not a second compositor. A headless reimplementation
 * would be a second set of rounding, a second blend order and a second answer
 * to every edge case the browser path already settles — and the two would drift
 * the first time either was touched, which is the worst possible outcome for a
 * pipeline whose whole job is that the art is *the same art*.
 *
 * A Node canvas was tried through this seam and did not survive contact:
 * `@napi-rs/canvas` rasterises close enough to read the same and not close
 * enough to *be* the same. So the headless path drives a real browser instead
 * (`server/browser-sheets.ts`) and nothing calls `setCanvasFactory` today.
 *
 * The seam is kept because it is what makes the compositor's dependency on a
 * canvas explicit and typed — `SheetCanvas` and `SheetContext` name exactly the
 * handful of methods it uses, so the three places that genuinely need the DOM
 * are visible rather than assumed. If a Node canvas ever rasterises the way
 * Chromium does, this is the one line that would change.
 */

/**
 * What the compositor needs of a canvas, which is far less than either host
 * offers.
 *
 * Structural rather than `HTMLCanvasElement`, because a Node canvas is not one
 * and never will be: what both actually provide is a width, a height, a 2D
 * context and the ability to be drawn into another canvas. Typing the union of
 * the two implementations would tie this file to whichever Node canvas is
 * installed today.
 */
export interface SheetCanvas {
  width: number;
  height: number;
  getContext(type: "2d", options?: { willReadFrequently?: boolean }): SheetContext | null;
}

/**
 * The drawing surface, as the compositor uses it.
 *
 * Every member here is one the compositor actually calls. Anything a host
 * offers beyond this is deliberately not in the type: a method that is not
 * declared cannot quietly become a dependency on one of the two hosts.
 */
export interface SheetContext {
  canvas: SheetCanvas;
  imageSmoothingEnabled: boolean;
  globalAlpha: number;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: SheetCanvas, dx: number, dy: number): void;
  drawImage(image: SheetCanvas, dx: number, dy: number, dw: number, dh: number): void;
  putImageData(data: SheetImageData, x: number, y: number): void;
  getImageData(x: number, y: number, w: number, h: number): SheetImageData;
}

/** RGBA pixels, in the shape both hosts hand them over. */
export interface SheetImageData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray<ArrayBufferLike>;
}

export type CanvasFactory = {
  canvas(width: number, height: number): SheetCanvas;
  imageData(
    pixels: Uint8ClampedArray<ArrayBufferLike>,
    width: number,
    height: number,
  ): SheetImageData;
};

const domFactory: CanvasFactory = {
  canvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(width, 1);
    canvas.height = Math.max(height, 1);
    return canvas as unknown as SheetCanvas;
  },
  imageData(pixels, width, height) {
    // Through `unknown`: `ImageData` insists on a `Uint8ClampedArray<ArrayBuffer>`
    // and a `.spr` frame's pixels are the looser `ArrayBufferLike`, which is the
    // same bytes with a wider type on the buffer.
    return new ImageData(
      pixels as unknown as Uint8ClampedArray<ArrayBuffer>,
      width,
      height,
    ) as unknown as SheetImageData;
  },
};

let factory: CanvasFactory | null = null;

/**
 * Points the compositor at a host's canvas. Called once, before anything is
 * rendered; the browser never calls it.
 */
export function setCanvasFactory(next: CanvasFactory): void {
  factory = next;
}

function host(): CanvasFactory {
  if (factory) return factory;
  if (typeof document === "undefined") {
    throw new Error(
      "No canvas: call setCanvasFactory() before rendering outside a browser (see server/canvas.ts)",
    );
  }
  return domFactory;
}

/**
 * A blank canvas of at least 1x1.
 *
 * The floor is not defensive — a part that draws nothing anywhere still has to
 * produce a texture, or the packer has no frame size to work from, and a
 * zero-width canvas throws on one host and returns null on the other.
 */
export function createCanvas(width: number, height: number): SheetCanvas {
  return host().canvas(width, height);
}

export function createImageData(
  pixels: Uint8ClampedArray<ArrayBufferLike>,
  width: number,
  height: number,
): SheetImageData {
  return host().imageData(pixels, width, height);
}

/** The 2D context of a fresh canvas, which neither host ever fails to give. */
export function context2d(
  canvas: SheetCanvas,
  options?: { willReadFrequently?: boolean },
): SheetContext {
  const ctx = canvas.getContext("2d", options);
  if (!ctx) throw new Error("could not get a 2d context");
  return ctx;
}

/**
 * A sheet canvas as the DOM's own type, for the handful of places that hand one
 * back to a browser API.
 *
 * The compositor is host-agnostic; three things around it are not, and all of
 * them are browser-only by nature — drawing a finished frame into the on-screen
 * preview, and `toBlob`, which is how an APNG and a thumbnail leave. Rather
 * than widen `SheetContext` with methods the Node host would have to pretend to
 * have, the cast lives here once, named, so it is obvious at every call site
 * that this is the line where "either host" stops.
 *
 * Never call it in anything the server runs.
 */
export function asDomCanvas(canvas: SheetCanvas): HTMLCanvasElement {
  return canvas as unknown as HTMLCanvasElement;
}
