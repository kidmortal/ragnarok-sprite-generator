/**
 * Rendering spritesheets by driving the real browser compositor.
 *
 * **Why a browser and not a Node canvas.** The compositor is host-agnostic now
 * (`src/lib/canvas.ts`), and running it on `@napi-rs/canvas` does produce
 * sheets — different ones. Skia antialiases layer edges with no way to turn it
 * off, and `quantiseSheet`, whose whole job is to put a rotated frame's
 * half-colours back on the sprite's palette, is calibrated to *Chromium's*
 * fringe: it lands within a level or two where Skia's lands at alpha 171-254.
 * One monster came back at 121,984 distinct colours instead of 63, and 1.2 MB
 * instead of 204 KB; the library as a whole would have grown by more than half.
 *
 * The art this game ships was drawn by Chromium. A pipeline whose value is that
 * the art does not change has to keep drawing it with Chromium, so this launches
 * one and runs the app's own `exportPart` inside it. Not a second implementation
 * of anything: the page fetches `.spr`/`.act` through `/api/file` and encodes
 * through `/api/encode`, exactly as a person pressing the button does.
 *
 * The browser is started once and kept, because a cold start is most of a second
 * and a batch is hundreds of sheets.
 */

import { chromium, type Browser, type Page } from "playwright";
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PartMeta } from "../src/lib/partExport.ts";
import type { SheetRequest } from "./sheets.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_ENTRY = path.join(HERE, "../src/harness.ts");

export type RenderedSheet = { meta: PartMeta; image: Buffer };

let browser: Browser | null = null;
let page: Page | null = null;
let bundle: string | null = null;

/**
 * The harness, bundled to one script.
 *
 * Built here rather than added to `vite.config.ts` as a second entry, because
 * the export path must work against a plain `npm start` with no client build in
 * front of it — and because a bundle produced at the moment it is used cannot
 * be stale against the modules it came from.
 */
async function harnessBundle(): Promise<string> {
  if (bundle) return bundle;

  const built = await esbuild.build({
    entryPoints: [HARNESS_ENTRY],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "chrome110",
  });

  bundle = built.outputFiles[0].text;
  return bundle;
}

/**
 * A page with the compositor loaded, on the server's own origin.
 *
 * Same-origin matters: the harness fetches sprites from `/api/file` and encodes
 * through `/api/encode` with relative URLs, which is what keeps it identical to
 * the code the app runs. `about:blank` would put it on an opaque origin and
 * every fetch would fail.
 */
async function ready(origin: string): Promise<Page> {
  if (page && !page.isClosed()) return page;

  browser ??= await chromium.launch();
  const fresh = await browser.newPage();

  // A route that answers a bare document; anything served from this origin
  // would do, and an empty one keeps the app's own bundle out of the picture.
  await fresh.goto(`${origin}/api/render-harness`);
  await fresh.addScriptTag({ content: await harnessBundle() });
  await fresh.waitForFunction(() => typeof (window as never as { renderSheet?: unknown }).renderSheet === "function");

  page = fresh;
  return page;
}

/** Renders one part, in the browser, and hands the bytes back. */
export async function renderSheetInBrowser(
  origin: string,
  request: SheetRequest,
): Promise<RenderedSheet> {
  const target = await ready(origin);

  const answer = await target.evaluate(
    (input) => window.renderSheet(input as never),
    {
      kind: request.kind,
      name: request.name,
      sprId: request.sprId,
      actId: request.actId,
      specs: request.specs,
      direction: request.direction,
      headDirection: request.headDirection,
      race: request.race,
      gender: request.gender,
      job: request.job,
      holds: request.holds,
      swing: request.swing,
    },
  );

  return { meta: answer.meta as PartMeta, image: Buffer.from(answer.base64, "base64") };
}

/**
 * Lets the browser go.
 *
 * Called when the process is shutting down. A page that has rendered a few
 * hundred sheets holds a fair amount of decoded pixel data, and nothing else
 * reclaims it while the server is idle.
 */
export async function closeBrowser(): Promise<void> {
  await page?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  page = null;
  browser = null;
}
