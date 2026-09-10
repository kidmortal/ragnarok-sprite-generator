# Resolver tables

Copied from [zrenderer](https://github.com/zhad3/zrenderer) (MIT, © 2021 zhad3),
`resolver_data/`. They map a job id to the folder names used by the Ragnarok
sprite layout, per that project's `RESOLVER.md`.

| File | Used for |
| --- | --- |
| `job_names.txt` | Line #job → job name: body folder `인간족/몸통/{gender}/{job}_{gender}`, shield folder `방패/{job}`, garment act `로브/{name}/{gender}/{job}_{gender}` |
| `job_weapon_names.txt` | Line #job → `folder\prefix` for weapons: `인간족/{folder}/{prefix}_{gender}{name}` — often **not** the job's own name (High Wizard's weapons live under 위저드) |
| `shield_names.txt` | Line #shield → shield name suffix (`_가드`, `_버클러`, …) |
| `imf_names.txt` | Line #job → the base name of that job's `.imf`, which carries its per-frame draw order. Refreshed from the client -- see below. |
| `job_pal_names.txt` | Palette base names. Unused here: this data set has no `.pal` files. |
| `pc_jobs.txt` | The client's own roster of *player* jobs: id, `JT_` constant, English name, sprite name. Generated -- see below. |
| `job_weapon_overrides.txt` | Hand-checked weapon-folder corrections applied on top of `job_weapon_names.txt`, with the evidence for each in the file. |
| `pet_names.txt` | Pet roster: monster aegis name ⇥ accessory item name, the accessory blank when the pet has none. Not from zrenderer -- see below. |

Line numbers are job ids, and a job id above 4000 has 3950 subtracted first.

## Deviations from zrenderer

Two rows are corrected here, both placeholders left over from a client that did
not yet have the job's own sprites:

| line | job | upstream | corrected |
| --- | --- | --- | --- |
| 305 | `SHADOW_CROSS` | `ABYSS_CHASER` | `SHADOW_CROSS` |
| 311 | `ABYSS_CHASER` | `초보자` | `ABYSS_CHASER` |

`peco_rebellion` (line 267) is filed against `초보자` and is left alone, because
the same job is filed correctly against `rebellion` on line 288 -- `resolver.ts`
prefers whichever repeated row names a folder that looks like the job itself.

The tables were taken from a client that predates third-job weapon sprites, so
they answer with a job's *ancestor*: 룬나이트 is sent to 기사, 여우워록 to 위저드,
슈라알파카 to 몽크. Those answers were right for that client and are wrong for
these files, which carry all three of those folders. Rather than rewrite 200
rows by hand, `weaponsForBody` in `server/index.ts` treats the table as the
fallback and prefers a folder named after the job when the data set has one --
including for costume and mount bodies, where the job is spelled out in the
middle of a longer name (타조레인져, 켈베로스길로틴크로스, ARCH_MAGE_RIDING).

A mounted body stays mounted: when the table's answer is itself a mount folder,
the job is substituted into it (페코페코_기사 → 페코페코_룬나이트) and the result
is used only if it exists on disk.

## Tables recovered from the client executable

`imf_names.txt` is refreshed from an unpacked client with:

```
npx tsx server/extract-exe-tables.ts <path to RagexeU.exe>
```

A stock `Ragexe.exe` is Themida-packed and carries none of these strings; it has
to be unpacked first. The tables are not static arrays either -- the client
builds them with an unrolled initialiser, thousands of
`mov dword ptr [eax+id*4], <string>` instructions -- so `server/pe.ts` decodes
that instruction stream and segments it on repeated job ids.

Three tables come back: job names, palette names and imf names. **There is no
weapon-folder table.** It is not in the initialiser, not a pointer array in
`.rdata`/`.data`, and there is no weapon-class suffix table either. zrenderer's
`job_weapon_names.txt` came from an older client that carried one; this build
constructs weapon paths in code. So that file stays as it is, corrected by hand
where the evidence is clear (see above) -- it cannot be regenerated.

The extractor refuses to write anything unless the job-name table it recovers
reproduces `job_names.txt` **exactly**. That table is the control: it is the one
already known to be right, so a byte-for-byte replay is what licenses trusting
the tables decoded beside it. On this client it matches 100% (290 entries), the
palette table matches 100% (215), and the imf table changed 15 rows -- every one
of which resolves to an `.imf` that exists on disk, including two
(`DRAGON_KNIGHT`, `IMPERIAL_GUARD`) that previously named files that do not.

Incidentally, the client's own tables confirm the two weapon-folder overrides:
the palette table gives job 116 → 로얄가드 and job 104 → 룬나이트, agreeing that
가드 is the Royal Guard and that Rune Knight's own identity is 룬나이트, not 기사.

## What the client's lua does and does not carry

`pc_jobs.txt` is regenerated from a client's `luafiles514` with:

```
npx tsx server/extract-lua-tables.ts <path to .../data/luafiles514>
```

It reads two compiled-Lua tables (`server/lua.ts` is a small Lua 5.1 bytecode
reader):

| chunk | table | gives |
| --- | --- | --- |
| `jobidentity.lub` | `JTtbl` | `JT_ROYAL_GUARD` → `4066` |
| `pcjobname.lub` | `ReqPCJobName` | `JOBID.JT_ROYAL_GUARD` → `"Royal Guard"` |

Together they identify which jobs are player jobs and what each one's id is,
and a job id indexes `job_names.txt`. That is how 가드 was identified as the
Royal Guard rather than a city-guard NPC.

**The job-to-weapon-folder mapping is not in the lua at all.** Searching every
`.lub` in a full client extract -- 473 of them -- for the raw bytes of a sprite
folder name such as 초보자 or `abyss_chaser`, in UTF-8 and in EUC-KR, returns
nothing. The client builds weapon paths from a table compiled into its
executable, which is why `job_weapon_names.txt` is an extraction and not
something read at runtime. Pulling a newer client's lua will not improve the
weapon mapping; only a fresh extraction of that exe table would.

## `pet_names.txt`

Extracted from [rAthena](https://github.com/rathena/rathena) (GPLv3),
`db/pre-re/pet_db.yml` and `db/re/pet_db.yml`, taking each `Mob` and its
`EquipItem`. Commented-out entries are kept: the Puzzle & Dragons collaboration
pets are all unimplemented server-side, but their sprites are real, and they
carry none of the marks `server/pets.ts` derives from the folder.

Aegis names are not sprite file names, so the resolver matches them
case-insensitively and tries the name both with and without a `pad_` prefix --
the collaboration sprites are filed inconsistently (`emelit.spr`, but
`pad_mythlit.spr`). Names that resolve to nothing are ignored, which is most of
the misses: they are mobs whose sprite is spelled differently (`CHONCHON` is
`chocho.spr`) or content this extraction does not carry.

To regenerate, pull both files and take the `Mob` / `EquipItem` pairs, including
the commented block.
