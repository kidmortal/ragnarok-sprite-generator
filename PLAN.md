# Per-part spritesheet export for runtime composition in Phaser

> **Status: built.** This was the design; it is now implemented across three repos. Where the
> shipped code diverged from the original plan it is noted inline, and the file paths below are
> real. See "What shipped where" at the end.

## Goal

Stop exporting *one composed character* as a spritesheet. Instead export **one
spritesheet per part** (every body, every head, every weapon, …) plus a JSON
manifest, so that Phaser can glue an arbitrary body + head + weapon + shield +
garment + headgears back together at runtime and play them in sync.

Only one facing is needed: **South (`direction = 0`)**.

## Verdict: yes, this works, and it is not a hack

The reason it works is that RO's own format already solves the hard part. The
composition rules in `src/lib/compose.ts` are:

- Every part's layers are placed at `layer.x, layer.y` in a **shared coordinate
  system whose origin is the character origin**. Body, weapon, shield and
  garment need *no* per-frame correction — they are already aligned to each
  other (`isParented()` returns false for them).
- Head and headgears are the only parented parts. Their correction is a single
  2D offset per frame: `bodyAnchor[frame] - ownAnchor[motion]`
  (`anchorOffset()` in `src/lib/compose.ts`).

That last line is the whole design. It factors cleanly:

```
childLayer.x + bodyAnchor.x - ownAnchor.x
=  (childLayer.x - ownAnchor.x)   +   bodyAnchor.x
   \_______ bake into the head sheet ______/    \_ ship in the body's JSON _/
```

So if we **bake `-ownAnchor` into every head/headgear sheet at export time**,
a head sheet becomes completely body-independent, and the only runtime data
needed is the body's per-frame anchor table (8-ish `[x, y]` pairs per action).

That is what makes the whole thing tractable: heads × bodies is **additive**,
not multiplicative. 138 bodies + 29 heads = 167 sheets, not 4002.

## The coordinate contract

Every exported sheet is a uniform grid. Each sheet declares, in the manifest, an
**origin pixel** `[ox, oy]` inside its cell. The meaning of that pixel differs by
part kind, and that difference is the entire runtime API:

| Part kind | Origin pixel means | Where Phaser puts it |
| --- | --- | --- |
| `body`, `weapon`, `shield`, `garment` | the character origin | `(charX, charY)` |
| `head`, `headgear` | the part's own attach point | `(charX + anchor[f].x, charY + anchor[f].y)` |

`anchor[f]` comes from the **body's** manifest, for the current action and
frame. Nothing else is needed. No per-frame offsets in the head sheet, no
re-derivation of RO math in Phaser.

Cell size does **not** need to match across sheets — a peco body cell can be
200×200 while a head cell is 60×60 — because positioning depends only on the
declared origin pixel, applied through `setOrigin(ox / w, oy / h)`.

Export at **1× native scale**. Anchors in the manifest are native pixels; if you
bake a zoom into the sheets you must scale the anchors too. Scale in Phaser
instead, which also keeps one texture usable at any zoom. Note that Ilumnia runs with
`pixelArt: false`, so the part sheets have to be point-filtered explicitly — see the Phaser section.

## Frame-count semantics (the second gotcha)

Parts do **not** agree on frame counts for the same action. `compose.ts` already
handles this: the body defines the length (`frameCount()`) and every other part
indexes with `frame % motions` (`motionIndex()`).

Do not normalize this away at export time — that would make weapon sheets
body-dependent again. Instead:

- Each sheet stores its **own natural frame count per action**.
- Phaser drives a **master frame counter from the body's count** and sets each
  other part to `master % part.count`.

Two special cases to carry over verbatim from `motionIndex()`:

1. **Stand and sit** (`actionBase` 0 and 16): a head/headgear act holds one pose
   *per head direction* rather than an animation. The usable frames are
   `motions / 3`, offset by `headDirection * (motions / 3)`. Since we only need
   one look, export the `headDirection = 0` (Straight) slice — the manifest
   should record which slice was baked so a later export can add Left/Right as
   extra animations.
2. **Action index overflow**: head and equipment acts have fewer actions than a
   body. `actionIndex()` falls back to `index % act.actions.length`. This
   already happens at bake time (we export per action), so exported sheets just
   end up with duplicate rows for the actions that alias. Correct, and no
   runtime cost.

## What the export must produce

### Files

```
export/
  manifest.json        every part's metadata, inline
  body/<key>.png
  head/<key>.png
  weapon/<key>.png     shield/…  garment/…  headgear/…  monster/…
```

> **Changed from the original plan.** This started out as a JSON file *per part*, next to each PNG.
> It ships as one `manifest.json` with the metadata inline instead: a runtime character builder
> wants one fetch, not one per sprite, and the whole table for a few hundred parts is a few hundred
> KB before compression. The per-part JSON would also have duplicated the manifest almost exactly.

`<key>` must be ASCII and stable: the source file names are Korean (and some are
legacy EUC-KR, see the README), which makes bad texture keys and bad filenames.
`partKey()` in `src/lib/partExport.ts` uses `<kind>_<first 8 hex of SHA-256 of the file's id>`,
where the id is the base64url of the raw path bytes the server already addresses files by.
Deterministic across re-exports, collision-free in practice, and the manifest keeps the real Korean
name as a human-readable `label`.

The manifest records that id as `source` rather than a decoded path: some names are legacy EUC-KR,
so decoding them to a string would be lossy.

### One part's entry in the manifest

```jsonc
{
  "key": "body_3f2a91c4",
  "kind": "body",
  "label": "하이프리 여",          // original sprite name, for your UI
  "source": "7J247rCE7KGxLy4uLg",   // base64url of the raw path bytes
  "image": "body/body_3f2a91c4.png",
  "cell": { "w": 118, "h": 142 },  // uniform grid cell
  "origin": [59, 108],             // see "coordinate contract" above
  "columns": 12,
  "direction": 0,                  // South
  "zIndex": 0,
  "actions": {
    "walk": {
      "base": 8,                   // PLAYER_ACTIONS base, for cross-referencing
      "start": 8,                  // first cell index in the sheet
      "count": 8,                  // frames in this action for THIS part
      "frameDelayMs": 100,         // act.delay * 25, clamped
      "anchors": [                 // BODY SHEETS ONLY - what heads hang off
        [0, -46], [0, -47], [0, -47], [0, -46],
        [0, -45], [0, -46], [0, -47], [0, -46]
      ]
    }
    // ... whichever of stand, walk, sit, pickup, attackwait, attack,
    //     hurt, hurt2, dead, attack2, attack3, skill were exported
  }
}
```

Notes on the fields:

- `anchors` is present only on body sheets, and is the *raw* `bodyAnchor` from
  the act — not a delta. It is what heads and headgears are positioned at.
- `frameDelayMs` is per action, taken from `ActAction.delay * 25` exactly as
  `renderAction()` does (`src/lib/compose.ts`).
- Nothing here depends on which head/weapon was selected. That is the point.

### `manifest.json`

The envelope around those entries, grouped by kind:

```jsonc
{
  "version": 1,
  "scale": 1,
  "direction": 0,
  "headDirection": 0,
  "actions": ["stand","walk","attack","hurt","dead","skill"],
  "zOrder": { "garment": -1, "body": 0, "head": 1,
              "weapon": 2, "shield": 3, "headgear": 4 },
  "generatedAt": "2026-08-11T…",
  "parts": {
    "body":   [ /* the entry above */ ],
    "head":   [ /* … */ ],
    "weapon": [ /* … */ ]
  }
}
```

The `job` field matters on **both** sides: weapons, shields and garments come from
`/api/equipment` and are only valid for bodies of that job (`server/resolver.ts`), so bodies carry
their resolved job too. Without it there is nothing to compare a weapon against, and the character
creator would offer a Priest staff to a Knight. The realm server enforces the same rule on save.

## How it is built, in the sprite generator

`src/lib/compose.ts` was refactored so a single part can be drawn on its own: `drawOpsForPart()`
takes an explicit offset, and `growBounds` / `snapBounds` / `paintOps` were split out of the
multi-part path so both share one implementation. `ownFrameCount()` and `ownAnchor()` expose the
per-part numbers the exporter needs. Live composition is unchanged and still goes through
`drawOpsForFrame()`.

`src/lib/partSheet.ts` is the new piece. `renderPartSheet()` walks every requested action, computes
the union bounding box across all of them, and lays the frames into one uniform grid — rendering a
head or headgear around its own attach point and everything else around the character origin. It
returns the cell size, the origin pixel and the per-action `start` / `count` / `frameDelayMs` /
`anchors`.

`src/lib/zip.ts` is a store-only ZIP writer, reusing `crc32` from `apng.ts` rather than carrying a
second copy of the table. Store rather than deflate because PNGs are already compressed. Bit 11 is
set so the Korean names survive.

`src/lib/partExport.ts` turns one catalogue entry into its PNG and its manifest row;
`src/components/ExportTab.tsx` is the UI — kind, race, gender and action selection, a
concurrency-capped queue, a progress bar, and a failure list so one unreadable sprite cannot sink a
long export. Equipment is walked per body (it is job-scoped) and deduped by source file, since many
jobs share one weapon sprite.

The existing single-composition export in `Stage.tsx` is untouched. It is still the right tool for a
one-off flat sprite.

### Still worth doing later

`compose.ts` calls `document.createElement("canvas")` directly, so the export needs a browser.
Injecting a canvas factory would let the same code run under `@napi-rs/canvas` as
`npm run export:parts` in CI. Worth doing now that the format has proven itself, but not required.

## Using it in Phaser

> **Changed from the original plan.** This section originally proposed a `Container` of sprites with
> a master clock repositioning the head every frame. What shipped instead **bakes the composition
> into a texture** inside the running game — which is both what was asked for and a much smaller
> change: `Entity` extends `Phaser.GameObjects.Sprite`, and a Container would have meant rewriting
> the health bar, the animation events and every scene that spawns a combatant.

All the part sheets are loaded up front in `BootScene`; a character is assembled later out of
textures already in memory, with nothing to await.

`CharacterCompositor.acquireComposedSkin(scene, appearance)`:

1. picks the exported action for each game animation (`idle` ← `stand`, `cast` ← `skill`, with
   fallbacks so a trimmed export still works);
2. computes the composed cell from the union of every layer's placement across every frame;
3. draws the layers into a `DynamicTexture`, one per animation, wrapping onto extra rows if the
   strip would exceed the maximum texture width;
4. adds numbered frames to that texture and registers `<key>-<animation>`.

The placement is the coordinate contract above, applied once at bake time instead of every frame:

```ts
const [ax, ay] = layer.parented ? bodyAction.anchors[frame] : [0, 0];
const x = ax - layer.meta.origin[0];
const y = ay - layer.meta.origin[1];
const sourceFrame = layer.action.start + (frame % layer.action.count);
```

The result is an ordinary spritesheet texture, so the composed character is a plain `Sprite` and
nothing downstream knows the difference. `createPlayerEntity()` in `objects/players/index.ts` is the
seam: it composes when it can and falls back to `PlayerRegistry` when it cannot.

Baked skins are reference counted with a small cold cache, so ending one battle and starting another
does not re-bake the party, while the character creator can rebuild its preview on every click
without leaking textures.

One trap the plan did not anticipate: the game runs with `pixelArt: false`, so the part sheets load
with linear filtering and would bleed a neighbouring cell into every composed frame's edges.
`applyPixelFiltering()` in `BootScene.create` switches them to nearest.

## Gotchas, ranked by how much time they will cost you

1. **Anchors are per action *and* per frame.** A walk cycle bobs; if you take a
   single anchor per action the head detaches on half the frames. Export the
   full array.
2. **Weapon/shield/garment are not parented.** Do not "fix" them with the anchor
   — they will drift. `isParented()` in `compose.ts` is the authority.
3. **Some frames are intentionally empty.** Weapons and shields draw nothing in
   the stand pose (`sprIndex: -1`, zero alpha — see `firstDrawableAction()`). An empty cell in the sheet is correct, not a bug. Do not
   let a "trim empty frames" optimization renumber your indices.
4. **Shield and garment z-order is a known approximation.** zrenderer takes it
   from `.imf`/lua data a plain sprite extract does not include, so the fixed
   defaults in `Z_INDEX` can be wrong for some facings. Since you only need
   South, verify it once for South and hard-code what looks right.
5. **Rotation, mirror and per-layer alpha get baked** into the sheet by the
   canvas draw. Fine — but it means the bounding box must account for rotated
   quads, which `growBounds()` already does.
6. **Anchor arrays can be missing.** `anchors[0]` is optional in the act;
   `anchorOffset()` falls back to 0. Keep that fallback and emit `[0, 0]`.
7. **Output size.** Single-direction cuts 8× off the obvious approach, but 138
   bodies × 12 actions is still substantial. Measure before committing: export
   ten bodies, look at the total, and decide whether to (a) export only the jobs
   your game actually offers, (b) drop actions you never play (sit, pickup,
   skill, hurt2), or (c) move to a trimmed texture atlas instead of a uniform
   grid. Do (a) and (b) first — they are free.
8. **No shadow.** RO draws a separate shadow sprite under the character. It is
   not part of this composition and is not exported; draw an ellipse in Phaser
   or export `shadow.spr` separately.

## What shipped where

**`sprite-manager`** — `src/lib/partSheet.ts`, `src/lib/partExport.ts`, `src/lib/zip.ts`,
`src/components/ExportTab.tsx`, plus the single-part refactor in `src/lib/compose.ts`.

**`ilumnia-discord-activity`** — `src/phaser/objects/players/composed/` (appearance types, part
catalogue, `CharacterCompositor`, `ComposedPreview`, the composed `Entity`),
`src/phaser/scenes/AppearanceScene.ts`, `src/websocket/modules/appearance.ts`, and the appearance
field threaded through the user, party and battle payloads.

**`ilumnia-server`** — `SpritePart` and `Appearance` tables with a migration,
`src/appearance/` (service, module, spec), `appearance:catalog` / `appearance:set` on the gateway,
`prisma/seed-sprite-parts.ts`, and appearance included in `user:get`, `party:roster` and the battle
snapshot.

### Left undone

- Only **South** is exported. The format already carries a `direction` field, so more facings are
  another axis in the sheet rather than a redesign.
- Only the **Straight** head slice is baked for stand/sit; Left and Right would be extra animations.
- Headgear slots 2 and 3 are stored and composed but the customisation page only exposes the first.
- No shadow sprite — RO draws one separately and it is not part of this composition.
