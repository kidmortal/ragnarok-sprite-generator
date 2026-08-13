# How it works

## File formats

`src/lib/spr.ts` and `src/lib/act.ts` parse the sprite and animation formats in
the browser — palette-indexed and RGBA frames, RLE decompression, per-motion
layers and attach points.

## Composing a character

Following zrenderer:

- An action index is `playerAction + direction` — every action occupies 8
  consecutive slots, one per facing (stand 0, walk 8, sit 16, attack 40, …).
- Head and headgears are parented to the **body**. For each frame a child's
  layers shift by `bodyAnchor[0] - ownAnchor[0]`, using the attach points stored
  per motion in the `.act`.
- During stand/sit a head/headgear act holds one pose per head direction rather
  than an animation, so the head-facing control indexes into thirds of it.
- Weapons, shields and garments are **not** parented; their acts are already
  aligned to the body.
- Monsters use a shorter action list of their own (stand 0, move 8, attack 16,
  hurt 24, dead 32) and compose as a single sprite.
- Draw order is by z-index: garment -1, body 0, head 1, weapon 2, shield 3,
  headgears 4+n. zrenderer takes shield and garment ordering from `.imf`/lua
  data that a plain sprite extract does not include, so those two use fixed
  defaults and can be wrong for some facings.

`src/lib/compose.ts` owns these rules; `src/lib/apng.ts` does the encoding. The
APNG encoder has no dependencies: it lets the browser encode each frame to a
normal PNG, then reassembles the pieces into `acTL`/`fcTL`/`fdAT` chunks.

## Resolving a job to its folders

A job's weapon folder is usually **not** its own name — true for 228 of the 411
jobs. High Wizard bodies are `하이위저드_{gender}`, but its weapons live under
`인간족/위저드/위저드_{gender}{weapon}`. `server/resolver.ts` resolves a body
sprite's file name by:

1. an exact hit in `job_names.txt`;
2. otherwise the longest underscore-prefix that hits the table, since body files
   are not always a bare `{job}_{gender}` (`기사_h_여` → `기사`,
   `무희_여_바지` → `무희`, `페코페코_기사_h_여` → `페코페코_기사`);
3. mercenaries (활용병/창용병/검용병), whose weapons share `인간족/용병` and carry
   no gender in the file name (`활용병_활`);
4. failing that, the longest *string* prefix of the body name that exists as a
   folder on disk — `운영자2_남` lives under `인간족/운영자`.

The Body picker only lists classes that actually resolve weapon sprites — 136 of
the 147 male human bodies, 138 of 150 female. The rest are dropped because the
data has nothing to give them: costume bodies such as 결혼 or 산타 have no weapon
folder at all, and Madogear has only weapon *slash* sprites. A Shield or Garment
picker can still read "None for this job" for a listed body.

## Exporting parts separately

The single-composition export bakes a finished character. The batch export does the opposite: it
renders each part **on its own**, in a frame a game engine can reassemble.

It works because zrenderer's child offset factors:

```
childLayer.x + bodyAnchor.x - ownAnchor.x
=  (childLayer.x - ownAnchor.x)  +  bodyAnchor.x
   \___ baked into the head sheet ___/  \_ shipped in the body's JSON _/
```

So `src/lib/partSheet.ts` renders a head or headgear with its origin **at its own attach point**,
which makes that sheet independent of whatever body it ends up on, and each body sheet carries its
per-frame anchor table. Heads x bodies becomes additive rather than multiplicative: 138 bodies plus
29 heads is 167 sheets, not 4002. Everything that is not parented — body, weapon, shield, garment —
is already aligned to the character origin and needs no correction at all.

Each sheet declares an `origin` pixel, and what that pixel *means* is the whole contract: the
character origin for an unparented part, the attach point for a head or headgear.

`src/lib/zip.ts` is a store-only zip writer, because a few hundred browser downloads is not a
usable export and the WebP sheets are already compressed. It reuses `crc32` from the APNG encoder.

## Previews in the pickers

A headgear folder holds well over a thousand entries and `몬스터/` nearly a
thousand, so a tile costs almost nothing until you look at it: an
`IntersectionObserver` loads a preview only once its tile scrolls into the grid,
tiles are added in pages, and results are memoized with at most 6 fetch+decode
jobs in flight.

Tiles are composed through the `.act` rather than taken raw from the `.spr`,
since a body's first spr frame is only a fragment of the sprite. Each tile shows
the first action that actually draws something — weapons and shields are blank
in the stand pose (`sprIndex: -1`, zero alpha) and only appear from attack-wait
onwards.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/file?id=<id>` | Raw file bytes |
| `GET /api/monsters` | Every `.spr`/`.act` pair in `몬스터/` |
| `GET /api/parts?race=human\|doram&gender=male\|female` | Body, head and headgear lists, each pairing a `.spr` with its `.act` |
| `GET /api/equipment?race&gender&body=<body sprite name>` | Weapon, shield and garment lists for that body's job |

Ids are base64url of the raw relative path bytes, which is what makes
non-UTF-8 names addressable. Every request is checked to stay inside the data
directory.
