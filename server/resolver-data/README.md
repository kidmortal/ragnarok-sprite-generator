# Resolver tables

Copied from [zrenderer](https://github.com/zhad3/zrenderer) (MIT, © 2021 zhad3),
`resolver_data/`. They map a job id to the folder names used by the Ragnarok
sprite layout, per that project's `RESOLVER.md`.

| File | Used for |
| --- | --- |
| `job_names.txt` | Line #job → job name: body folder `인간족/몸통/{gender}/{job}_{gender}`, shield folder `방패/{job}`, garment act `로브/{name}/{gender}/{job}_{gender}` |
| `job_weapon_names.txt` | Line #job → `folder\prefix` for weapons: `인간족/{folder}/{prefix}_{gender}{name}` — often **not** the job's own name (High Wizard's weapons live under 위저드) |
| `shield_names.txt` | Line #shield → shield name suffix (`_가드`, `_버클러`, …) |
| `imf_names.txt` | Per-job `.imf` name, used by zrenderer for shield/garment draw order. Unused here: this data set has no `.imf` files. |
| `job_pal_names.txt` | Palette base names. Unused here: this data set has no `.pal` files. |
| `pet_names.txt` | Pet roster: monster aegis name ⇥ accessory item name, the accessory blank when the pet has none. Not from zrenderer -- see below. |

Line numbers are job ids, and a job id above 4000 has 3950 subtracted first.

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
