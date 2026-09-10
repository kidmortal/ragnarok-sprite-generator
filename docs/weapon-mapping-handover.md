# Weapon mapping — handover

Context for continuing the body×weapon work. Everything below is **uncommitted**
in the working tree.

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

## Current unresolved bug

`가드_남_1` (Royal Guard armour variant) renders a floating sword. **This is not
a mapping bug and cannot be fixed by remapping.**

- `가드` = `JT_ROYAL_GUARD`, job id 4066 (confirmed from the client's own tables).
- There is no Royal Guard weapon art anywhere; `로얄가드/` is a copy of `크루세이더/`.
- The art is drawn for the Crusader silhouette. Body widths at attack-wait/East,
  frame 0: `크루세이더_남` **46px**, `가드_남` 45, **`가드_남_1` 39**, `_2` 52,
  `_3` 46, `_4` 52. `_1` is ~7px narrower, so the hilt hangs past the hand.
- The real client renders it identically — it resolves to the same file.

## Do not retry these — four failed validators

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

Only reliable check so far: **render it and look.** Scratch renderer pattern is
in the session scratchpad; it reuses `drawOpsForPart` + a nearest-neighbour
rasteriser (there is no canvas in node — see `server/thumbnail.ts` for the same
trick).

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

## Code state (all uncommitted)

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

### Modified

`server/index.ts` (`weaponsForBody`, `descendantFolder`, `imfIdForBody`,
`WeaponOrigin`), `server/resolver.ts` (override table, repeated-row tie-break,
`imfName`), `src/lib/compose.ts` (per-frame weapon z-index),
`src/components/Generator.tsx`, `src/components/PartPicker.tsx` (`aside` prop),
`src/api.ts`, `src/styles.css`, both READMEs, `imf_names.txt`,
`job_weapon_names.txt`.

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

Shipped and working, but it filters **provenance, not correctness** —
`own` / `descendant` / `override` shown, `inherited` / `probe` hidden.
155 of 213 male bodies pass.

Two known weaknesses:

1. **Conservative** — hides pairings that are fine. `팔라딘`→`크루세이더` is
   hidden as inherited but renders correctly (trans-2nd-job reskin on the same rig).
2. **Blind to the real bug** — `가드` passes as `override` yet `가드_남_1` still
   looks wrong, because the problem is body silhouette, not folder choice.

## Open decision — next step

Pick one:

1. **Body-width check.** Flag bodies materially narrower than the canonical body
   their weapon art was drawn for. Catches `가드_남_1` (39 vs 46), leaves `_2`/`_3`/`_4`.
   Cheap; it's a proxy for arm reach, so **validate on a sample before trusting it**
   (four heuristics have already failed).
2. **Manual allowlist.** Render a contact sheet of every body against its weapon
   set, mark the bad ones by eye, checkbox reads that list. Slow but actually correct.

Suggested: 1 first, fall back to 2 for what it misses.

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
