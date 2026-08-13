# Ragnarok Sprite Generator

A local web app for building Ragnarok Online characters and monsters out of the
game's sprites. Pick a body, head, weapon, shield, garment and headgears — or
just pick a monster — watch it animate, and export it as an **animated PNG** or
a **spritesheet**.

Everything runs on your machine: a small Node server reads your extracted sprite
folder, and the React app parses the `.spr`/`.act` files and composes them in the
browser.


<img width="1235" height="897" alt="image" src="https://github.com/user-attachments/assets/439a5cc4-7e64-4371-a033-3cc5a344b626" />


## What it does

**Character tab** — compose a character:

- Race, gender, **body**, **head**, **weapon**, **shield**, **garment**, and up
  to **three accessories** (headgears), each a filterable grid of previews.
- Any action (stand, walk, attack, sit, …), all 8 facings, and the head facing.
- Live animated preview with a scale control.
- **Export animated PNG** — an APNG at the chosen scale.
- **Export spritesheet** — a strip plus a JSON sidecar with frame size, grid,
  delay and the part names.

**Batch export tab** — every selected part as its **own** spritesheet, in one zip:

- Pick which kinds to emit (bodies, heads, headgears, weapons, shields, garments, monsters),
  which races and genders, and which actions.
- One lossless WebP sheet per part plus a single `manifest.json` carrying every part's metadata inline.
- This is the path that feeds a game engine that composes characters at **runtime** — one
  sheet per body and one per head, rather than one per combination. See `PLAN.md`.
- **Monsters are exported on their own terms**, in the same run and the same manifest: their own
  four actions (`stand`, `attack`, `hurt`, `dead`) and their own facing, **south-west** by
  default. They wear nothing, so they ship without the per-frame anchor table a body owes its
  heads — one sheet is the whole monster, and an engine plays it as an ordinary spritesheet.

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

File formats, the composition rules, job resolution, the separate-parts export
and the HTTP API are documented in [`docs/how-it-works.md`](docs/how-it-works.md).
