# Ragnarok Sprite Generator

A local web app for building Ragnarok Online characters and monsters out of the
game's sprites. Pick a body, head, weapon, shield, garment and headgears — or
just pick a monster — watch it animate, and export it as an **animated PNG** or
a **spritesheet**.

Everything runs on your machine: a small Node server reads your extracted sprite
folder and encodes the finished sheets, and the React app parses the `.spr`/`.act`
files and composes them in the browser. Both halves have to be running to export —
`npm run dev` starts them together.


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

- Pick which kinds to emit (bodies, heads, headgears, weapons, shields, garments, monsters,
  pets), which races and genders, and which actions.
- One lossless WebP sheet per part plus a single `manifest.json` carrying every part's metadata inline.
  Sheets are encoded by libwebp on the server rather than by `canvas.toBlob`, which selects lossless
  but not how hard to work at it — the same sprites came out 3.8x heavier from one browser build than
  the next. Each sheet is also snapped back onto the palette its art was drawn in, so anti-aliasing
  from a rotated frame cannot cost the encoder its palette transform. Both in `docs/how-it-works.md`.
- This is the path that feeds a game engine that composes characters at **runtime** — one
  sheet per body and one per head, rather than one per combination. See `PLAN.md`.
- **Monsters and pets are exported on their own terms**, in the same run and the same manifest:
  their own four actions (`stand`, `attack`, `hurt`, `dead`) and their own facing — **south-west**
  for monsters, **south-east** for pets, since a pet stands on the party's side of the field and
  an opponent faces across it. Both wear nothing, so they ship without the per-frame anchor table
  a body owes its heads — one sheet is the whole sprite, and an engine plays it as an ordinary
  spritesheet. Pets export their plain sprite; the accessory act is a preview-only toggle.

**Monsters tab** — the same preview and exports for any of the ~986 sprites in
`몬스터/`. Monsters are standalone sprites with no head, equipment or attach
points, so the tab is just a picker: choose one, pick an action (stand, move,
attack, hurt, dead) and a facing.

**Pets tab** — the monsters a player can tame (146 of them in the extraction
this was built against). The data has no pet folder, so the roster is mostly
derived from `몬스터/` itself: a pet either ships an *accessory act* — the same
sprite animated wearing its equipment, which the **Wearing accessory** toggle swaps in — or carries action
groups past `dead`, which only a pet is ever asked to play. Those extra groups
are offered as **Special 1…n**, taken from whichever act is loaded. Pets that
carry neither mark — the Puzzle & Dragons collaboration sprites animate like any
other monster — come from `server/resolver-data/pet_names.txt`, a copy of
rAthena's pet_db that also names the accessories in English. See
`docs/how-it-works.md`.

**Props tab** — the sprites that are not alive. Same picker and same exports,
over four folders chosen with the **Source** select:

| Source | Folder | Pairs | What is in it |
| --- | --- | --- | --- |
| NPCs & objects | `npc/` | 1572 | bonfires, signposts, postboxes, vending and gacha machines, warp portals, flags, boxes — and the shopkeepers standing among them |
| Effects | `이팩트/` | 189 | skill and status effects, top level only |
| Dropped items | `아이템/` | 13097 | the sprite an item wears lying on the ground |
| Ammunition | `item/` | 22 | bullets and cartridges |

There is no test that tells a prop from a person, so the tab does not claim one:
`npc/` holds a campfire and a shopkeeper side by side and nothing in either file
says which is which — the map did. The folder is the grouping, and the filter
box is how you find the campfire.

What these folders *do* vary is shape, so the action list and the facings are
read off each act rather than assumed. A dropped item is one group — one
picture, no facing at all, so the **Facing** select is not offered. Most of
`npc/` is one action of eight facings, shown as **Idle**. The ~290 monster
sprites that `npc/` reuses as quest NPCs carry the full stand/move/attack/hurt/dead.

**A prop exports headlessly too**, beside the monsters and the player parts:
`GET /api/catalog?kind=prop&source=npc` lists a folder (`source=all` sweeps the
four) and `POST /api/export` renders it like anything else. It ships exactly one
pose — `stand`, the one action these sprites have — and takes the **party's**
facing (south-east), since a prop is furniture a party stands beside rather than
an opponent facing across the field. `source` is asked for rather than optional
because there is no browsable list here: `npc/` alone is 1572 sprites and
`아이템/` is thirteen thousand.

What you will *not* find here is a building. Map structures — walls, houses,
terrain, the furniture you walk around — are not sprites in this game at all;
they are 3D `.rsm` models under `data/model/`, and nothing in this project reads
them. A campfire, yes. A house, no.

## You need Ragnarok sprite data

This app ships **no game assets**. You need a Ragnarok Online client's
`data.grf` and must extract it yourself.

1. Get `data.grf` from a Ragnarok Online client installation.
2. Extract it with **[zextractor](https://github.com/zhad3/zextractor/)**, which
   unpacks a GRF and converts the filenames to UTF-8.
3. Point this app at the extracted `data/sprite` directory: copy or symlink it to
   `data/` in the project root (gitignored).
4. Optional: copy the extracted `data/imf` folder in alongside it. Those files
   carry each job's per-frame draw order, which is what swings a weapon behind
   the body mid-attack when the character faces away. Without them the weapon
   simply always draws in front.

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
  npc/              # NPCs and props -- the Props tab
  이팩트/            # effects
  아이템/            # dropped items
  item/             # ammunition
  imf/              # per-job draw order (optional)
```

Sprites are addressed by their raw path bytes, so Korean names work, including
files whose names are legacy EUC-KR rather than UTF-8.

## Running it

```bash
npm install
npm run thumbs   # pre-render picker previews into cache/thumbs (once, after adding data)
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
in. The job tables in `server/resolver-data/` started as copies from that
project (MIT licensed); `server/resolver-data/README.md` records where they have
since been corrected, and which of them can be regenerated from a client.

**[zextractor](https://github.com/zhad3/zextractor/)**, also by zhad3, is what
you use to get the sprite data out of `data.grf` in the first place.

Neither project is affiliated with this one, and any bugs here are mine.

## Fixing a weapon that sits a few pixels off

A weapon is drawn at the character origin rather than held in a hand, so the
same art lands in the same place on every body offered it — and most third and
fourth jobs are offered art drawn for an earlier job, because their weapon
folders are byte-identical copies of it. When the newer body is a different
build, the grip misses. Nothing in the client says by how much; the format that
could say it, `.imf`, has every one of those offsets set to zero.

So corrections are written by hand in
`server/resolver-data/weapon_offsets.txt`, one row per body, weapon, action,
facing and frame range, and applied everywhere a character is composed.

Pick a body and a weapon and the Character tab shows a **Weapon offset** control
under the preview: X and Y move the weapon a pixel at a time, **Applies to**
sets how wide the row reaches, and **Save correction** writes it into that file
— so the next time anyone picks that pairing, it is already right.

The same loop offline, for reviewing more than one at a time:

```
npm run nudge -- 가드_여_2 --weapon=1463     # the frame at each candidate offset
npm run contact-sheet -- 가드_여_2 크루세이더_여 --gender=female   # next to the body the art was drawn for
```

[`docs/weapon-offsets.md`](docs/weapon-offsets.md) is the full description.

## How it works

File formats, the composition rules, job resolution, the separate-parts export
and the HTTP API are documented in [`docs/how-it-works.md`](docs/how-it-works.md).
[`docs/client-sources.md`](docs/client-sources.md) records which file in a game
client each table was extracted from, and what was searched for and confirmed
absent.
