# Weapon mapping — handover

Context for continuing the body×weapon work.

## The original complaint

Weapons rendered detached from the body and drifting mid-animation. Root cause
was real: an Abyss Chaser body was being offered **Novice** (`초보자`) weapons.

## The single most important finding

**Third and fourth jobs do NOT have their own weapon sprites.** The per-job
folders exist but hold byte-identical copies. Measured across all of
`data/인간족/`: **53 weapon folders are ≥90% byte-identical to another folder.**

```
룬나이트         ≡ 기사                100%
로얄가드         ≡ 크루세이더          100%
arch_mage        ≡ 워록 ≡ 위저드       100%
windhawk         ≡ 레인져 ≡ 헌터       100%
페코페코_룬나이트 ≡ 페코페코_기사       100%
imperial_guard   ≡ 로얄가드            100%
abyss_chaser     ≡ 로그                 97%   <-- and NOT 초보자
```

Regenerate with the scratch script pattern: hash every `{folder}_{gender}_{id}.spr`
and compare folders pairwise on shared ids.

### What this invalidates

An earlier pass remapped 198 bodies from "ancestor folder" to "own folder"
(`기사`→`룬나이트`, `크루세이더`→`로얄가드`, …). Because the folders are copies,
**most of those changed the folder name and produced no visible difference.**

The Abyss Chaser fix *is* real — `abyss_chaser` shares nothing with `초보자` —
and so is the `peco_rebellion` fix (`초보자` → `rebellion`). Treat the rest of the
remap as cosmetic until proven otherwise.

## The original unresolved bug — now hand-marked

`가드_남_1` (Royal Guard armour variant) renders a floating sword. **This is not
a mapping bug and cannot be fixed by remapping.** It is hidden by the picker's
filter via the hand-marked section of `narrow_bodies.txt`, because the width
check cannot reach it — see "The width check" below.

- `가드` = `JT_ROYAL_GUARD`, job id 4066 (confirmed from the client's own tables).
- There is no Royal Guard weapon art anywhere; `로얄가드/` is a copy of `크루세이더/`.
- The art is drawn for the Crusader silhouette. Body widths at attack-wait/East,
  frame 0: `크루세이더_남` **46px**, `가드_남` 45, **`가드_남_1` 39**, `_2` 52,
  `_3` 46, `_4` 52. `_1` is ~7px narrower, so the hilt hangs past the hand.
- The real client renders it identically — it resolves to the same file.

## Do not retry these — five failed validators

There is no signal inside a `.spr`/`.act` saying which body it was drawn for.
Attempts, all rejected with evidence:

1. **Pixel adjacency** ("a held weapon touches the body") — a wrong weapon still
   overlaps the torso. No separation.
2. **Attach-point (anchor) agreement** — looked perfect (`초보자` body vs `초보자`
   weapon = 1.000, others 0.000) but tracks *export lineage*, not fit:
   `abyss_chaser` body vs its own correct weapons scores 0.000.
3. **Gap distance** — gives 0.00 to `기사` and `신페코크루세이더` on the `가드`
   body, both visually wrong.
4. **Weapon/body pixel overlap ratio** — scores `크루세이더_남_검` (correct) at
   24 frames with zero overlap. No better than the others.
5. **Grip-band reach** (body reach measured only across the rows the hilt
   occupies) — the intuitive refinement of the width check, and *worse* than it:
   the band lands on a mount's neck as readily as on an arm, so it scored
   `가드_남_1` at 3 in a crowd of correct bodies at 7–11. Not shipped; the
   plain width test below is the one that works.

Only reliable check: **render it and look.** That is now
`npm run contact-sheet` (see below) rather than a scratch script.

## Where the mapping actually lives

- **Not in the GRF.** Searched a full 17 GB extract: all 473 `.lub` (decompiled,
  not grepped), every `.txt`/`.imf`/`.db`/`.fna`/`.ezv`/`.str`, both UTF-8 and
  EUC-KR. Zero hits for a sprite-folder name in a mapping context.
- **Not in the client's lua.** `luafiles514` gives job identity only.
- **Not in this client's exe either.** The unpacked client builds three job
  tables (job names, palette names, imf names) — there is **no weapon-folder
  table**. zrenderer's `job_weapon_names.txt` came from an older client that had
  one; this build constructs weapon paths in code.

So `job_weapon_names.txt` cannot be regenerated. It stays hand-corrected.

## Code state

### Added

| file | purpose |
| --- | --- |
| `server/lua.ts` | Lua 5.1 bytecode reader for `.lub` tables |
| `server/extract-lua-tables.ts` | → `resolver-data/pc_jobs.txt` (150 player jobs) |
| `server/pe.ts` | PE reader + recovers job tables from the client's unrolled initialiser |
| `server/extract-exe-tables.ts` | → refreshes `resolver-data/imf_names.txt` |
| `server/resolver-data/job_weapon_overrides.txt` | 2 hand-checked rows, evidence inline |
| `server/resolver-data/pc_jobs.txt` | id, `JT_` constant, English name, sprite name |
| `src/lib/imf.ts` | `.imf` parser + `weaponInFront()` |
| `server/weapons.ts` | weapon resolution, lifted out of `index.ts` so the offline tools resolve a body exactly as the server does |
| `server/silhouette.ts` | outline measurement: extents, reach, narrowing |
| `server/measure-silhouettes.ts` | → `resolver-data/narrow_bodies.txt` (`npm run silhouettes`) |
| `server/silhouette-table.ts` | reads that table at startup; `isNarrow()` |
| `server/contact-sheet.ts` | renders bodies wearing their weapons (`npm run contact-sheet`) |
| `server/resolver-data/narrow_bodies.txt` | 18 measured rows + a hand-marked section |

### Modified

`server/index.ts` (`imfIdForBody`, and `fits` on each body; `weaponsForBody`,
`descendantFolder` and `WeaponOrigin` now live in `weapons.ts`),
`server/thumbnail.ts` (`paintOps` exported, so the contact sheet reuses the
rasteriser rather than carrying a second one), `server/resolver.ts` (override
table, repeated-row tie-break, `imfName`), `src/lib/compose.ts` (per-frame weapon z-index),
`src/components/Generator.tsx`, `src/components/PartPicker.tsx` (`aside` prop),
`src/api.ts` (`fits` on `BodyEntry`), `src/styles.css`, both READMEs,
`imf_names.txt`, `job_weapon_names.txt`, `package.json` (two scripts).

**Pre-existing edits not mine, leave alone:** `ExportTab.tsx`, `Stage.tsx`,
`apng.ts`, `partExport.ts` (and `compose.ts` had prior edits too).

### Data

`data/imf/` — 304 `.imf` files copied in from the extract. `data/` is gitignored;
it is a GRF extract and must not otherwise be modified.

## Verified facts worth keeping

- Exe extraction is **validated**: the recovered job-name table reproduces
  `job_names.txt` **352/352**. `extract-exe-tables.ts` refuses to write unless
  that control matches 100%.
- The 15 `imf_names.txt` rows it changed all resolve to files that exist; two
  (`DRAGON_KNIGHT`, `IMPERIAL_GUARD`) previously named files that don't.
- `.imf` contains **exactly 2 layers, layer1 always the complement of layer0**
  (all 138,552 cells), priorities only 0/1, **every (x,y) offset is zero**. So it
  affects draw order only — it can never fix weapon *position*. Non-default in
  1.81% of cells, concentrated in attack/pick-up/skill/hurt.
- 412/428 offered bodies resolve an `.imf`.
- Table fixes in `job_weapon_names.txt`: rows 305 (`SHADOW_CROSS`) and 311
  (`ABYSS_CHASER`) were placeholders. `peco_rebellion` is fixed by the
  repeated-row tie-break in `resolver.ts`, not by editing the table.
- Every weapon folder in the data set is now reachable by some body (was:
  `신페코로얄가드`, 172 sprites, orphaned).
- Counts hold at 213 male / 215 female human bodies; doram unaffected.

## The checkbox ("Own weapon sprites only")

It filters **provenance, not correctness** — `own` / `descendant` / `override`
shown, `inherited` / `probe` hidden.

It now requires `trusted && fits`: provenance *and* silhouette. 146 of 213 male
bodies pass (was 155 on provenance alone), 145 of 215 female.

One known weakness remains:

- **Conservative** — hides pairings that are fine. `팔라딘`→`크루세이더` is
  hidden as inherited but renders correctly (trans-2nd-job reskin on the same rig).

The second weakness is fixed: `가드` still passes as `override`, but `가드_남_1`
now fails on `fits`.

## The width check — what it does and does not reach

Shipped. `npm run silhouettes` measures every body and writes
`server/resolver-data/narrow_bodies.txt`; the server reads that table and each
body now carries `fits` alongside `trusted`, both of which the picker's checkbox
requires. See `server/silhouette.ts` for the measurement and
`server/measure-silhouettes.ts` for the calibration.

**What is measured.** A weapon is drawn at the character origin, not hung off an
attach point, so its hilt lands in the same place on every body and only the
body's own outline decides whether a hand is there. Reach in one direction and
reach in its opposite are the two lateral extremes of the same outline, so the
score is the **mean of each opposite pair**, not the worst single direction.
That is what makes it a width test rather than a position test — and it matters:
`페코팔라딘_남` measures 9px short facing east and 9px *wide* facing west, and
renders perfectly. Worst-direction scoring flags it; pair-averaging does not.

**The reference** is the narrowest body sprite named after a folder holding that
exact art, byte for byte. Which of the copies came first is not recoverable, and
taking the narrowest only flags bodies smaller than every body the art is known
to have been drawn for.

**Calibration.** 425 bodies heap between −57 and +2.5, then one at 3, nothing
until 6.5, eleven above 9. Threshold is **3px**, and every row at or above it was
rendered and looks wrong. Re-check the tail after any data change with
`npm run silhouettes -- --min=1 --dry`.

### What it caught — 18 bodies, all newly found

| bodies | px | what is wrong |
| --- | --- | --- |
| `룬나이트쁘띠{,2..5}_{남,여}_4`, `그리폰가드_{남,여}_4` | 13–21.5 | rider drawn *without the mount*; the sword floats where the peco's neck would be |
| `night_watch_*_기관총`, `rebellion_*_기관총`, `night_watch_여_권총` | 6.5–15.5 | limbs-only gun poses — the body sprite is arms and legs, no torso |
| `가드_여_4` | 3 | genuine silhouette mismatch, the female counterpart of the original bug |

### What it cannot reach

`가드_남_1` — the case that started all this — measures **2px**, which is where
correct bodies sit. Going to a 2px threshold would take `로드페코_여` and the
five `룬나이트쁘띠*_여_2` mounts (2.5px) with it, and those were rendered and are
fine. Higher-ranked false positives below a true positive is not a threshold
problem; it is the resolution limit of the test.

So `가드_남_1` is **hand-marked** in `narrow_bodies.txt`, below a marker line
that `npm run silhouettes` preserves across regeneration. That is option 2,
scoped to what option 1 misses rather than to all 428 bodies.

## The manual pass — `npm run contact-sheet`

The tool for extending that hand-marked list:

```
npm run contact-sheet -- --min=1                      # everything in the borderline band
npm run contact-sheet -- 가드_남_1 크루세이더_남         # named bodies, side by side
npm run contact-sheet -- --min=1 --gender=female --out=cache/review.png
```

One row per body, three facings, one origin down the column. What to look for is
whether the crossguard finishes against the shoulder or hangs in the air beside
it — on `가드_남_1` next to `크루세이더_남` the gap is unmistakable.

Note the labels render Korean as boxes unless sharp finds a CJK font. The
picture is the point; the rows come out in the order given.

## Still open

- The 2–2.5px band is six bodies wide and only partly reviewed. Render it and
  hand-mark what is wrong.
- Only `attack wait` frame 0 is measured. A body that fits at rest and not
  mid-swing would pass. No evidence yet that any does.
- Doram bodies are not measured at all — the sweep is `인간족` only.

## Environment notes

- `node` is not on PATH: `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`.
  Use `node_modules/.bin/tsx`; `npx` is unavailable.
- Dev server runs on **:3001** under `tsx watch` (auto-reloads on server edits).
  Use a different port for test instances.
- Scratch scripts need a `node_modules` symlink beside them to resolve `sharp`.
- Unpacked client: `C:\Gravity\Ragnarok\RagexeU.exe`
  (WSL: `/mnt/c/Gravity/Ragnarok/RagexeU.exe`). Produced with Magicmida +
  ScyllaHide; stock `Ragexe.exe` is Themida-packed and useless for this.
- Full GRF extract: `/mnt/c/Users/kidmo/Desktop/zextractor/output/data`.
- `tsc -b --noEmit` is clean as of handover.
