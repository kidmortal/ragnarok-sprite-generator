/**
 * The pieces a headless export needs that are not drawing.
 *
 * Rendering itself lives in `browser-sheets.ts` and happens in Chromium — see
 * that file for why a Node canvas could not be the one that ships. What is left
 * here is the shape of a request and the key a part is filed under, both of
 * which the route needs *before* anything is drawn.
 */

import type { HeldPart, PartMeta } from "../src/lib/partExport.ts";
import type { SheetActionSpec } from "../src/lib/partSheet.ts";

/** What one request asks for, once a route has resolved names to sprite ids. */
export type SheetRequest = {
  kind: PartMeta["kind"];
  /** The sprite's own name, for the manifest's `label`. */
  name: string;
  sprId: string;
  actId: string;
  specs: readonly SheetActionSpec[];
  direction: number;
  headDirection: number;
  race?: string;
  gender?: string;
  job?: string;
  /**
   * Sprites welded into this one's own cells, a pose at a time -- the guns a
   * gunner's three swings are drawn with. Resolved from the overrides table
   * before anything is rendered, because a name means nothing in the browser.
   */
  holds?: HeldPart[];
  /** Which pose is this body's ordinary swing; see `PartMeta.swing`. */
  swing?: string;
};

/**
 * The key a part is filed under, and it must match the browser's byte for byte
 * or a re-export from either half would land beside the old sheet rather than
 * on top of it.
 *
 * `partExport.ts` computes it with `crypto.subtle`, which Node has globally —
 * so this is the same four bytes of the same SHA-256 of the same id, not a
 * lookalike. It is duplicated rather than imported only because importing it
 * would drag `fetch("/api/file")` into a module the server loads at boot.
 */
export async function partKey(kind: string, sprId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sprId));
  const hex = Array.from(new Uint8Array(digest).slice(0, 4))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${kind}_${hex}`;
}
