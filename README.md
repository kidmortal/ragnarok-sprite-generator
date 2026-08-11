# Ragnarok Sprite Generator

A local web app for building Ragnarok Online characters and monsters out of the
game's sprites. Pick a body, head, weapon, shield, garment and headgears — or
just pick a monster — watch it animate, and export it as an **animated PNG** or
a **spritesheet**.

Everything runs on your machine: a small Node server reads your extracted sprite
folder, and the React app parses the `.spr`/`.act` files and composes them in the
browser.

<!-- TODO: add a screenshot of the Character tab here -->

![Dashboard screenshot](docs/screenshot.png)

## What it does

**Character tab** — compose a character:

- Race, gender, **body**, **head**, **weapon**, **shield**, **garment**, and up
  to **three accessories** (headgears), each a filterable grid of previews.
- Any action (stand, walk, attack, sit, …), all 8 facings, and the head facing.
- Live animated preview with a scale control.
- **Export animated PNG** — an APNG at the chosen scale.
- **Export spritesheet** — a strip plus a JSON sidecar with frame size, grid,
  delay and the part names.

**Monsters tab** — the same preview and exports for any of the ~986 sprites in
`몬스터/`. Monsters are standalone sprites with no head, equipment or attach
points, so the tab is just a picker: choose one, pick an action (stand, move,
attack, hurt, dead) and a facing.

## You need Ragnarok sprite data

This app ships **no game assets**. You need a Ragnarok Online client's
`data.grf` and must extract it yourself.

1. Get `data.grf` from a Ragnarok Online client installation.
2. Extract it with **[zextractor](https://github.com/zhad3/zextractor/)**, which
   unpacks a GRF and converts the filenames to UTF-8.
3. Point this app at the extracted `data/sprite` directory: copy or symlink it to
   `data/` in the project root (gitignored).

The result should look like this — the folder names are Korean, and that is
expected:

```
data/
  인간족/            # human
    몸통/{남,여}/     # bodies, by gender
    머리통/{남,여}/   # heads
    검사/            # per-job weapon sprites
  도람족/            # doram
  악세사리/{남,여}/   # headgears
  방패/{job}/        # shields
  로브/{garment}/    # garments
  몬스터/            # monsters
```

Sprites are addressed by their raw path bytes, so Korean names work, including
files whose names are legacy EUC-KR rather than UTF-8.

## Running it

```bash
npm install
npm run dev      # server on :3001, client on :5173
```

Production build:

```bash
npm run build && npm start   # the server also serves dist/client
```

## Credits

This project stands on **[zrenderer](https://github.com/zhad3/zrenderer)** by
[zhad3](https://github.com/zhad3) — **a huge thank you**. Its source and its
excellent [`RESOLVER.md`](https://github.com/zhad3/zrenderer/blob/main/RESOLVER.md)
are where the composition rules below come from: how a head attaches to a body,
how action indices map to facings, and which folder each job's equipment lives
in. The job tables in `server/resolver-data/` are copied straight from that
project (MIT licensed).

**[zextractor](https://github.com/zhad3/zextractor/)**, also by zhad3, is what
you use to get the sprite data out of `data.grf` in the first place.

Neither project is affiliated with this one, and any bugs here are mine.

## How it works

### File formats

`src/lib/spr.ts` and `src/lib/act.ts` parse the sprite and animation formats in
the browser — palette-indexed and RGBA frames, RLE decompression, per-motion
layers and attach points.

### Composing a character

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

### Resolving a job to its folders

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

### Previews in the pickers

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
