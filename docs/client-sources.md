# Where the data came from

Everything this app knows that is not in a sprite file was taken out of one
game client install. The install itself is 4.4 GB of GRF and a packed
executable, so it is not in this repository — but what was learned from it is,
and this page is the record of which file each table came from, so any of them
can be regenerated or audited without going looking again.

The install this was built against:

```
C:\Gravity\Ragnarok            (WSL: /mnt/c/Gravity/Ragnarok)
```

## The files that matter

| file | size | sha256 | what it gave |
| --- | --- | --- | --- |
| `data.grf` | 4,422,464,667 | — | every sprite, act and `.imf` in `data/`, plus `luafiles514` |
| `RagexeU.exe` | 51,387,392 | `9f6e12fe6bcc…48fe5a6` | the job tables: `job_names.txt`, `job_pal_names.txt`, `imf_names.txt` |
| `System\english\iteminfo_new.lub` | 7,136,894 | `9e81a71bb1d4…f4f87a9` | `item_names.txt` — 16,937 rows of id, resource name, English name |
| `luafiles514` (inside the GRF) | — | — | `pc_jobs.txt` — 150 player jobs, id and `JT_` constant |
| `Ragexe.exe` | 20,716,040 | — | nothing: Themida-packed, none of the strings are reachable |

`RagexeU.exe` is `Ragexe.exe` unpacked with Magicmida + ScyllaHide. That step
has to be redone against a new client before any of the exe tables can be.

The scripts, all of which take the path as an argument:

```
tsx server/extract-exe-tables.ts   /mnt/c/Gravity/Ragnarok/RagexeU.exe
tsx server/extract-item-names.ts   /mnt/c/Gravity/Ragnarok/System
tsx server/extract-lua-tables.ts   <extract>/luafiles514
```

Exe extraction is self-checking: it rebuilds `job_names.txt` from the client and
refuses to write anything unless that control reproduces the existing table
352/352.

## The sprite extract

`data/` is a [zextractor](https://github.com/zhad3/zextractor/) dump of
`data.grf` — 17 GB, gitignored, and treated as read-only input. The one thing
copied into it by hand is `data/imf/`, the 304 `.imf` files that carry per-frame
draw order, which the app serves like any other file.

The extract this was built against:

```
/mnt/c/Users/kidmo/Desktop/zextractor/output/data
```

## What is confirmed *not* in the client

Recorded here because each of these cost a search, and the next person should
not repeat one:

- **No weapon-folder mapping table, anywhere.** Not in the GRF: all 473 `.lub`
  decompiled rather than grepped, every `.txt`/`.imf`/`.db`/`.fna`/`.ezv`/`.str`
  read in both UTF-8 and EUC-KR, zero hits for a sprite-folder name in a mapping
  context. Not in `luafiles514`, which gives job identity only. Not in this
  client's exe either — it builds the three job tables and then constructs
  weapon paths in code. zrenderer's `job_weapon_names.txt` came from an older
  client that did carry one, which is why the copy here is hand-corrected rather
  than regenerated. See [`weapon-mapping-handover.md`](weapon-mapping-handover.md).
- **No weapon position data.** `.imf` has the field for it — an (x, y) per layer
  per action per frame — and every one of those offsets is zero across all 304
  files. The client ships the misfits too. Corrections are therefore hand
  written; see [`weapon-offsets.md`](weapon-offsets.md).
- **The 23 `.fna` files** beside the `.imf` files in the extract are not another
  format worth parsing: each is a short list of absolute paths on the artist's
  build machine (`D:\작업\...\spr\...`). No animation or positional data at all.

## What is not copied in, and why

`data.grf`, the unpacked exe and the 17 GB extract stay outside the repository:
they are large, they are the vendor's, and every fact this project needs from
them is already extracted into `server/resolver-data/` — which is checked in,
readable, and documented file by file in
[`server/resolver-data/README.md`](../server/resolver-data/README.md).
