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

Line numbers are job ids, and a job id above 4000 has 3950 subtracted first.
