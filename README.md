# ragnarok-sprite-generator

Browse and preview `.spr` / `.act` sprite folders from a local `sprite/` directory.

- **Client**: React + TypeScript (Vite), parses `.spr` and `.act` in the browser and renders them to canvas.
- **Server**: Node + Express, exposes `sprite/` read-only over `/api`.

Both run together with a single command.

## Usage

```bash
npm install
npm run dev      # server on :3001, client on :5173 (proxies /api)
```

Put your sprite folders in `data/` (gitignored):

```
data/
  몬스터/
    포링/
      포링.spr
      포링.act
```

Browse folders in the UI; each `.spr` renders a thumbnail, and clicking one opens
a viewer with zoom, per-frame thumbnails, and animation playback driven by the
matching `.act` (paired by file base name).

Production build:

```bash
npm run build && npm start   # server also serves dist/client
```

## Non-ASCII / Korean names

Paths are addressed by an opaque id — base64url of the *raw path bytes* — rather
than by decoded strings. Korean UTF-8 names work directly; names carrying legacy
EUC-KR bytes that are not valid UTF-8 are still openable, and get a best-effort
EUC-KR decode for display. Names are NFC-normalized and sorted with the `ko`
collator. Every request is checked to stay inside `sprite/`.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/list?id=<id>` | Directory listing (`id` omitted = `sprite/` root) plus breadcrumbs |
| `GET /api/file?id=<id>` | Raw file bytes; supports `Range` for partial reads |

## Browsing large folders

Folders with thousands of sprites stay responsive because a card costs almost
nothing until you actually look at it:

- **Viewport-only loading** — an `IntersectionObserver` fetches a thumbnail only
  once its card scrolls near view; cards are also added 200 at a time.
- **First frame only** — `parseSpr(buf, { maxFrames: 1 })` stops after one frame
  instead of decoding all of them.
- **Partial fetch** — a thumbnail pulls the 64KB header plus the trailing 1KB
  palette via HTTP `Range` and splices them, rather than downloading the file.
  `validBytes` makes the parser throw (not guess) if the first frame reaches
  past the head slice, and the loader refetches the whole file for those.
- **Cached and throttled** — thumbnails are memoized by id, with at most 6
  fetch+decode jobs in flight.

Measured over 2000 real sprites (553MB): decode 3205ms → 88ms, transfer 553MB →
116MB, with byte-identical first frames and ~1% needing the full-file fallback.

Full frame lists and `.act` animation are parsed only when a sprite is opened.

## Character generator

The **Character** tab composes a build out of separate parts and exports it.

- Pick race, gender, **body**, **head**, **weapon**, **shield**, **garment** and
  up to **three accessories** (headgears). Each picker is a filterable grid of
  64x64 previews that scrolls, and loads tiles only as they come into view.
- Weapons, shields and garments are job-specific: the job is read off the body
  sprite name (`{job}_{gender}`), so changing the body reloads those three lists.
- Choose action (stand/walk/attack/…), one of 8 facings, and the head facing,
  then watch it animate live.
- **Export animated PNG** writes an APNG at the chosen scale; **Export
  spritesheet** writes a horizontal strip plus a JSON sidecar with frame size,
  grid, delay and the part names.

### How the composition works

The rules follow [zrenderer](https://github.com/zhad3/zrenderer), which reads the
same file formats:

- An action index is `playerAction + direction` — every action occupies 8
  consecutive slots, one per facing (stand 0, walk 8, sit 16, attack 40, …).
- Head and headgears are parented to the **body**. For each frame a child's
  layers shift by `bodyAnchor[0] - ownAnchor[0]`, using the attach points stored
  per motion in the `.act` (which is why `act.ts` parses anchors).
- During stand/sit a head/headgear act holds one pose per head direction rather
  than an animation, so the head-facing control indexes into thirds of it.
- Draw order is by z-index: garment -1, body 0, head 1, weapon 2, shield 3,
  headgears 4+n. zrenderer derives shield and garment ordering from `.imf`/lua
  data that is not in this data set, so those two use fixed defaults and can be
  wrong for some facings.
- Only head and headgears are anchor-parented. Weapons, shields and garments
  carry their own per-action acts already aligned to the body, so they draw
  unparented -- matching zrenderer, which calls `.parent()` only for those two.

Part tiles are composed through the `.act` (frame 0 of stand) rather than taken
raw from the `.spr`: a body's first spr frame is just one fragment of the
sprite, which makes an unrecognisable thumbnail.

`compose.ts` owns these rules, `apng.ts` does the encoding. The APNG encoder has
no dependencies: it lets the browser encode each frame to a normal PNG, then
reassembles the pieces into `acTL`/`fcTL`/`fdAT` chunks.

### API additions

| Route | Purpose |
| --- | --- |
| `GET /api/parts?race=human\|doram&gender=male\|female` | Body, head and headgear lists, each pairing a `.spr` with its `.act` |
| `GET /api/equipment?race&gender&job=검사` | Weapon, shield and garment lists for one job |
