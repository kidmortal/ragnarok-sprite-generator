# Correcting where a weapon sits

Some bodies hold their weapon a few pixels off. This is how to write the fix
down so it survives the next reload, the next export and the next person.

## Why it happens

A weapon is **not parented to anything**. Head and headgears hang off the body's
attach point, but a weapon act is drawn at the character origin — so the same
art lands in exactly the same place on every body offered it, and the only thing
deciding whether a hand is waiting there is the body's own outline.

Third and fourth jobs mostly do not have their own weapon art: 53 of the weapon
folders in `data/인간족/` are byte-identical copies of an earlier job's, so a
Royal Guard grips a sword drawn for a Crusader. When the newer body was drawn a
few pixels narrower or with the hand a little higher, the grip misses. The real
client renders it exactly the same way — it resolves to the same file. See
[`weapon-mapping-handover.md`](weapon-mapping-handover.md) for how far that
mapping was chased and where it stops.

**Nothing in the data says by how much.** Five automatic tests were tried and
rejected (that document lists them with evidence); the one measurement that
survives, `narrow_bodies.txt`, only says *whether* a body is too small, never
where the hand went. The client's own format for saying it is `.imf`, which
carries an (x, y) per layer per action per frame — and every one of those
offsets is zero in all 304 files here. So the correction is a judgement somebody
makes by looking at it, and this is where the judgement is kept.

## The table

`server/resolver-data/weapon_offsets.txt`, tab separated:

```
body	weapon	action	facing	frames	dx	dy	why
가드_여_2	로얄가드_여_1463	attack-wait	south-east	0	2	0	halberd shaft misses the fist
```

| column | takes |
| --- | --- |
| `body` | a body sprite name, or a glob: `가드_여*` |
| `weapon` | a weapon sprite name, a glob, or `*` |
| `action` | `stand` `walk` `sit` `pick-up` `attack-wait` `attack` `attack-2` `attack-3` `hurt` `hurt-2` `dead` `skill`, or `*` |
| `facing` | `south` … `south-east`, or `0`–`7`, or `*` |
| `frames` | a frame number, an inclusive range (`2-4`), or `*` |
| `dx`, `dy` | pixels to move the weapon; `+x` right, `+y` down |
| `why` | free text |

Every matching row applies in file order and a later row overrides an earlier
one, so the broad nudge for a body goes first and the frames that need something
else go under it. `frames` counts the **body's** frames, the ones the whole
composition is driven by, so a row means the same thing whether or not the
weapon act holds as many motions as the body does.

A malformed row is reported with its line number and the whole table is dropped,
rather than the row being skipped quietly — a correction that silently does
nothing would only ever be noticed by spotting the misfit all over again.

The table is re-read whenever its mtime changes, so an edit takes effect on the
next equipment request: re-pick the body in the picker, no restart.

## Finding the numbers — in the app

The Character tab carries a **Weapon offset** control under the preview,
whenever a body and a weapon are both selected. X and Y move the weapon a pixel
at a time and the preview updates as you go, so the number is found the only way
it can be: by looking at it.

- The fields show the **total** offset — what the table already says for this
  pairing plus whatever you are trying — so what you read is what gets written.
- **Applies to** decides how wide the row reaches: this action and facing (the
  default, and the honest one, since a hand is somewhere different in every
  facing), this action across all facings, or everything for that body and
  weapon.
- The row that would be written is printed under the buttons before you commit
  to it.
- **Save correction** appends it to `server/resolver-data/weapon_offsets.txt`
  and re-reads the table, so the preview keeps exactly what you set. Saving the
  same body, weapon, action and facing again rewrites that row rather than
  stacking another under it, and saving `0, 0` deletes the row — "no correction"
  is the absence of a row, not a row saying nothing.
- **Reset** drops what you are trying and goes back to what the table says.

The control writes `*` in the frames column, so a saved row covers the whole
action. A correction that should only apply to some frames of a swing is written
by hand — the format is below, and the file is plain text.

## Finding the numbers — offline

The same loop without a browser, which is what you want for a sweep of several
bodies rather than the one in front of you:

```
npm run nudge -- 가드_여_2 --weapon=1463
```

writes `cache/nudge.png`: the same frame drawn once per candidate offset, each
cell labelled with the numbers to paste, and prints the table row to fill in.
Whatever the table already says for that pairing is applied first, so `0, 0` is
always today's result and a second pass refines rather than restarts.

```
npm run nudge -- 가드_여_2 --weapon=검 --action=attack --facing=south --frame=3
npm run nudge -- 가드_여_2 --weapon=1463 --dx=-3,3 --dy=-2,2
```

To judge whether a pairing is wrong in the first place, the contact sheet is
still the tool — one row per body, three facings, one origin down the column:

```
npm run contact-sheet -- 가드_여_2 크루세이더_여 --gender=female --weapon=1463
npm run contact-sheet -- 가드_여_2 --raw          # without the corrections applied
```

Put the body next to the one the art was drawn for. What to look for is whether
the hilt or shaft finishes inside the hand or out in the air beside it.

## What is corrected and what is not

The table applies wherever a body and a weapon are composed together: the
Character tab preview, the animated PNG and the spritesheet exported from it,
the headless render routes, and the contact sheet.

It does **not** reach the batch export. That path writes one sheet per part,
shared across every body that uses it — which is the point of it, since heads ×
bodies becomes additive rather than multiplicative — so there is no per-body
weapon sheet to bake a correction into. An engine composing at runtime would
have to carry the table itself; the manifest does not currently include it.

Doram bodies work the same way but have never been reviewed; the whole weapon
sweep so far is `인간족` only.
