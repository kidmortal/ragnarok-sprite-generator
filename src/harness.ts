/**
 * The compositor, exposed to whatever is driving the page.
 *
 * This is the entry point the headless export bundles and injects: it is the
 * *browser* half of the pipeline with no user interface attached, so a server
 * can ask for a sheet and get back exactly what the Batch tab would have
 * produced — because it is the same `exportPart`, running in the same engine,
 * against the same two routes.
 *
 * It exists because the alternative did not work. A Node canvas (`@napi-rs/canvas`)
 * runs the same compositing code and still rasterises differently: its
 * antialiased edges defeat `quantiseSheet`, which is calibrated to Chromium's
 * fringe, and one monster came out at 121,984 colours and six times the bytes.
 * The art this game already ships was drawn by Chromium, so Chromium is what
 * has to draw the next of it.
 *
 * Nothing here decides anything. The facings, the action list and the attack
 * pose are chosen server-side and arrive as arguments, so the rules stay in one
 * place and this stays a rendering surface.
 */

import { exportPart, type HeldPart } from "./lib/partExport";
import type { SheetActionSpec } from "./lib/partSheet";

type HarnessRequest = {
  kind: string;
  name: string;
  sprId: string;
  actId: string;
  specs: SheetActionSpec[];
  direction: number;
  headDirection: number;
  race?: string;
  gender?: string;
  job?: string;
  holds?: HeldPart[];
  swing?: string;
};

/** A sheet as it crosses back out of the page: base64, because a Blob cannot. */
async function renderOne(request: HarnessRequest) {
  const exported = await exportPart(
    { name: request.name, label: request.name, sprId: request.sprId, actId: request.actId },
    {
      kind: request.kind as never,
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

  const bytes = new Uint8Array(await exported.image.arrayBuffer());

  // Chunked rather than one spread: a sheet is megabytes of pixels and
  // `String.fromCharCode(...bytes)` blows the argument limit somewhere north of
  // a hundred thousand of them.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }

  return { meta: exported.meta, base64: btoa(binary), bytes: bytes.length };
}

declare global {
  interface Window {
    renderSheet: typeof renderOne;
  }
}

window.renderSheet = renderOne;
