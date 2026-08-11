# Plan: per-part spritesheet export for runtime composition in Phaser

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
  other (`isParented()` returns false for them, `src/lib/compose.ts:75`).
- Head and headgears are the only parented parts. Their correction is a single
  2D offset per frame: `bodyAnchor[frame] - ownAnchor[motion]`
  (`anchorOffset()`, `src/lib/compose.ts:118`).

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
instead (`setScale(3)` on the container, with `pixelArt: true` in the game
config), which also keeps one texture usable at any zoom.

## Frame-count semantics (the second gotcha)

Parts do **not** agree on frame counts for the same action. `compose.ts` already
handles this: the body defines the length (`frameCount()`, line 89) and every
other part indexes with `frame % motions` (`motionIndex()`, line 105).

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
  manifest.json
  body/<key>.png      body/<key>.json
  head/<key>.png      head/<key>.json
  weapon/<key>.png    weapon/<key>.json
  shield/…  garment/…  headgear/…
```

`<key>` must be ASCII and stable: the source file names are Korean (and some are
legacy EUC-KR, see the README), which makes bad texture keys and bad filenames.
Use `<kind>_<first 8 hex of sha1 of the raw relative path bytes>`. Deterministic
across re-exports, collision-free in practice, and the manifest keeps the real
Korean name as a human-readable `label`.

### Per-part JSON

```jsonc
{
  "key": "body_3f2a91c4",
  "kind": "body",
  "label": "하이프리 여",          // original sprite name, for your UI
  "sourcePath": "인간족/몸통/여/하이프리_여",
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
      "frameDelayMs": 100,         // act.delay * 25, clamped (compose.ts:333)
      "anchors": [                 // BODY SHEETS ONLY - what heads hang off
        [0, -46], [0, -47], [0, -47], [0, -46],
        [0, -45], [0, -46], [0, -47], [0, -46]
      ]
    }
    // ... stand, sit, pickup, attackwait, attack, hurt, hurt2, dead,
    //     attack2, attack3, skill
  }
}
```

Notes on the fields:

- `anchors` is present only on body sheets, and is the *raw* `bodyAnchor` from
  the act — not a delta. It is what heads and headgears are positioned at.
- `frameDelayMs` is per action, taken from `ActAction.delay * 25` exactly as
  `renderAction()` does today (`src/lib/compose.ts:333`).
- Nothing here depends on which head/weapon was selected. That is the point.

### `manifest.json`

Index of everything, so the game can build a character-creator UI without
reading 167 files:

```jsonc
{
  "version": 1,
  "scale": 1,
  "direction": 0,
  "headDirection": 0,
  "actions": ["stand","walk","sit","pickup","attackwait","attack",
              "hurt","hurt2","dead","attack2","attack3","skill"],
  "zOrder": { "garment": -1, "body": 0, "head": 1,
              "weapon": 2, "shield": 3, "headgear": 4 },
  "parts": {
    "body":   [{ "key": "body_3f2a91c4", "label": "하이프리 여",
                 "race": "human", "gender": "female", "job": "하이프리",
                 "json": "body/body_3f2a91c4.json" }],
    "head":   [ /* … */ ],
    "weapon": [{ "key": "weapon_9c1d…", "job": "프리스트" }]  // weapons are job-scoped
  }
}
```

The `job` field on weapons/shields/garments matters: those lists come from
`/api/equipment` and are only valid for bodies of that job (`server/resolver.ts`).
The manifest has to preserve that constraint or the character creator will offer
a Priest staff to a Knight and get a missing texture.

## Implementation in this repo

### 1. `src/lib/compose.ts` — render a single part

Today `renderAction()` renders *all* parts into a bounding box computed from the
composition. Add a sibling that renders one part in the contract's frame:

```ts
export type PartOrigin = "character" | "anchor";

/** All exported actions of one part, in a single uniform grid. */
export function renderPartSheet(
  part: Part,
  actions: readonly { name: string; base: number }[],
  direction: number,
  headDirection: number
): {
  frames: HTMLCanvasElement[];
  cell: { w: number; h: number };
  origin: [number, number];
  actions: Record<string, { start: number; count: number; frameDelayMs: number;
                            anchors?: [number, number][] }>;
};
```

Refactoring needed:

- Split `anchorOffset()` into an origin-mode switch: `"character"` → `{0,0}`,
  `"anchor"` → `{-ownAnchor.x, -ownAnchor.y}`. The existing
  `bodyAnchor - ownAnchor` path stays for the live preview.
- Make `drawOpsForFrame()` take a single part + an origin mode, and have the
  existing multi-part version call it in a loop. This is a small extraction; the
  layer loop itself does not change.
- `actionBounds()` becomes "bounds over one part, over every exported action,
  every frame". Union those to get a single cell, then round outward and pick
  `origin = [-x1, -y1]`.
- Frame count for a part's own action: `action.motions.length`, except the
  stand/sit head case where it is `floor(motions / 3)`.

### 2. `src/lib/zip.ts` — a store-only ZIP writer (~120 lines, no deps)

A batch export produces hundreds of files; 300 browser downloads is not usable.
`apng.ts` already hand-rolls PNG chunks and CRC32 — **reuse that same `crc32`**
(export it) and write local file headers + central directory with
`compressionMethod = 0`. PNGs are already deflated, so storing costs nothing.

### 3. `src/components/BatchExport.tsx` — the batch UI

New panel (its own tab, or a section under the Character tab):

- Checkboxes for which kinds to export: bodies / heads / weapons / shields /
  garments / headgears / monsters.
- Filters: race, gender, and a job filter (headgears are ~1522 entries — do not
  export all of them by default).
- Which actions to include (default: all 12).
- Runs a queue: for each entry `fetchFile(sprId/actId)` → `parseSpr`/`parseAct`
  → `buildFrameCache` → `renderPartSheet` → `encodeSpritesheet` → push into the
  zip. Cap concurrency at ~6, matching the pattern already used in
  `src/lib/thumbs.ts`.
- Progress bar plus a running byte total, because this is a multi-minute job.
- Free each part's `FrameCache` canvases as you go, or a few hundred decoded
  sprites will exhaust memory.

Weapons/shields/garments have to be enumerated per job: loop the body list,
call `/api/equipment` for each, and dedupe by `sourcePath` — many jobs share
the same weapon sprites and there is no reason to export a sheet twice.

### 4. Keep the existing single-composition export

`Stage.tsx`'s "Export spritesheet" stays as-is. It is the right tool for a
one-off flat sprite; the new path is for the character creator.

### Optional phase 2: run the export headlessly

`compose.ts` calls `document.createElement("canvas")` directly
(`buildFrameCache`, line 158). Inject a canvas factory instead, and the same
code runs under `@napi-rs/canvas` in a Node script — so the export becomes
`npm run export:parts` in CI rather than a browser session. Worth doing once the
browser version has proven the format, not before.

## Using it in Phaser

### Loading

```js
preload() {
  this.load.json('manifest', 'assets/ro/manifest.json');
}

// then, for each part you actually need:
loadPart(def) {
  this.load.json(`${def.key}:def`, def.json);
  // after the def resolves, or with the cell size inlined into the manifest:
  this.load.spritesheet(def.key, def.image, {
    frameWidth: def.cell.w, frameHeight: def.cell.h
  });
}
```

Game config must use `pixelArt: true` (or `roundPixels: true` +
`antialias: false`) or every part will bleed at the seams when scaled.

### Composition

Drive one master clock and set frames manually. Do not give each part its own
Phaser animation — they have different frame counts, and the head must be
repositioned every frame from the body's anchor table.

```js
class RoCharacter extends Phaser.GameObjects.Container {
  constructor(scene, x, y, defs) {          // defs = { body, head, weapon, ... }
    super(scene, x, y);
    this.defs = defs;
    this.sprites = {};

    // z order comes straight from the manifest
    const order = ['garment', 'body', 'head', 'weapon', 'shield',
                   'headgear0', 'headgear1', 'headgear2'];

    for (const slot of order) {
      const def = defs[slot];
      if (!def) continue;
      const s = scene.add.sprite(0, 0, def.key);
      s.setOrigin(def.origin[0] / def.cell.w, def.origin[1] / def.cell.h);
      this.add(s);
      this.sprites[slot] = s;
    }

    this.frame = 0;
    this.elapsed = 0;
    this.play('stand');
    scene.add.existing(this);
  }

  play(action) {
    this.action = action;
    this.frame = 0;
    this.elapsed = 0;
    this.apply();
  }

  apply() {
    const bodyAct = this.defs.body.actions[this.action];
    const anchor  = bodyAct.anchors[this.frame % bodyAct.count];

    for (const [slot, sprite] of Object.entries(this.sprites)) {
      const def = this.defs[slot];
      const act = def.actions[this.action];
      if (!act || act.count === 0) { sprite.setVisible(false); continue; }

      sprite.setVisible(true);
      sprite.setFrame(act.start + (this.frame % act.count));

      // head + headgears hang off the body's attach point; everything
      // else is already in the character's coordinate system
      const parented = def.kind === 'head' || def.kind === 'headgear';
      sprite.setPosition(parented ? anchor[0] : 0, parented ? anchor[1] : 0);
    }
  }

  update(_time, delta) {
    const bodyAct = this.defs.body.actions[this.action];
    this.elapsed += delta;
    if (this.elapsed >= bodyAct.frameDelayMs) {
      this.elapsed -= bodyAct.frameDelayMs;
      this.frame = (this.frame + 1) % bodyAct.count;   // body defines length
      this.apply();
    }
  }
}
```

Swapping a head at runtime is then `sprite.setTexture(newDef.key)` +
`setOrigin(...)` from the new def. That is the character creator.

## Gotchas, ranked by how much time they will cost you

1. **Anchors are per action *and* per frame.** A walk cycle bobs; if you take a
   single anchor per action the head detaches on half the frames. Export the
   full array.
2. **Weapon/shield/garment are not parented.** Do not "fix" them with the anchor
   — they will drift. `isParented()` in `compose.ts:75` is the authority.
3. **Some frames are intentionally empty.** Weapons and shields draw nothing in
   the stand pose (`sprIndex: -1`, zero alpha — see `firstDrawableAction()`,
   `compose.ts:213`). An empty cell in the sheet is correct, not a bug. Do not
   let a "trim empty frames" optimization renumber your indices.
4. **Shield and garment z-order is a known approximation.** zrenderer takes it
   from `.imf`/lua data a plain sprite extract does not include, so the fixed
   defaults in `Z_INDEX` can be wrong for some facings. Since you only need
   South, verify it once for South and hard-code what looks right.
5. **Rotation, mirror and per-layer alpha get baked** into the sheet by the
   canvas draw. Fine — but it means the bounding box must account for rotated
   quads, which `actionBounds()` already does (`compose.ts:230`).
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

## Milestones

1. **Prove the format on one character.** Export exactly one body + one head as
   two sheets and hand-write the JSON. Load in Phaser, walk it. If the head
   stays glued for all 8 walk frames, the entire design is validated.
2. `renderPartSheet()` in `compose.ts` + the per-part JSON writer, wired to a
   single "Export this part" button next to the existing export buttons.
3. `zip.ts` + the batch panel, bodies and heads only.
4. Extend the batch to weapons/shields/garments (with job scoping) and
   headgears (filtered).
5. The Phaser `RoCharacter` class and a character-creator scene.
6. Optional: headless Node export; Left/Right head slices; extra facings (the
   format already has a `direction` field — adding facings is another axis in
   the sheet, not a redesign).
