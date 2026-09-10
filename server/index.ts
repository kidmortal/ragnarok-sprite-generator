import express from "express";
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import { foldersForJob } from "./resolver.ts";
import { listPetsCached } from "./pets.ts";
import {
  DATA_DIR,
  displayName,
  encodeId,
  join,
  resolveId,
  ROOT,
  THUMB_DIR,
} from "./paths.ts";
import { thumbFile, TILE } from "./thumbnail.ts";

const PORT = Number(process.env.PORT ?? 3001);

const app = express();

/**
 * Character part folders, using the standard Ragnarok data layout. Gender and
 * race are folder names in Korean, which is why they are spelled out here.
 */
const RACES = {
  human: { label: "Human", root: "인간족", headgearSuffix: "" },
  doram: { label: "Doram", root: "도람족", headgearSuffix: "_doram" },
} as const;

const GENDERS = { male: "남", female: "여" } as const;

type PartEntry = { name: string; sprId: string; actId: string };

/**
 * Where a body's weapons came from, most trustworthy first.
 *
 * This records *provenance*, not correctness -- nothing in a .spr or .act says
 * which body it was drawn for, so there is no way to test a pairing. What can
 * be said is whether the weapons are the job's own sprites or something it
 * inherited, and that is what this distinguishes.
 *
 *   own         a folder named after the job itself, e.g. abyss_chaser
 *   descendant  the job's own folder, reached by name (타조레인져 -> 레인져)
 *   override    a hand-checked correction, see job_weapon_overrides.txt
 *   inherited   only the table's answer, usually an ancestor class
 *   probe       a filesystem guess for a body no table covers
 */
export type WeaponOrigin = "own" | "descendant" | "override" | "inherited" | "probe";

/** The origins we are confident actually belong to the job. */
const TRUSTED: readonly WeaponOrigin[] = ["own", "descendant", "override"];

/** List a folder and pair each .spr with the .act of the same base name. */
async function listParts(relative: string): Promise<PartEntry[]> {
  const rel = Buffer.from(relative);
  let abs: Buffer;
  try {
    abs = resolveId(encodeId(rel));
  } catch {
    return [];
  }

  let names: Buffer[];
  try {
    names = (await fs.readdir(abs, { encoding: "buffer" as never })) as unknown as Buffer[];
  } catch {
    return [];
  }

  const acts = new Set<string>();
  for (const name of names) {
    const display = displayName(name);
    if (display.toLowerCase().endsWith(".act")) acts.add(display.slice(0, -4).toLowerCase());
  }

  const parts: PartEntry[] = [];
  for (const name of names) {
    const display = displayName(name);
    if (!display.toLowerCase().endsWith(".spr")) continue;
    const base = display.slice(0, -4);
    if (!acts.has(base.toLowerCase())) continue; // a part needs both halves
    const sprRel = join(rel, name);
    const actRel = Buffer.concat([sprRel.subarray(0, sprRel.length - 4), Buffer.from(".act")]);
    parts.push({ name: base, sprId: encodeId(sprRel), actId: encodeId(actRel) });
  }

  return parts.sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

/** Names of the sub-directories of a folder inside the data directory. */
async function listDirs(relative: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(resolveId(encodeId(Buffer.from(relative))), {
      encoding: "buffer" as never,
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => displayName(entry.name as unknown as Buffer));
  } catch {
    return [];
  }
}

/**
 * `listDirs`, memoized. Weapon resolution asks for a race root's sub-folders
 * once per body, and the data directory does not change while the server runs.
 */
const dirCache = new Map<string, Promise<string[]>>();
const listDirsCached = (relative: string): Promise<string[]> => {
  let pending = dirCache.get(relative);
  if (!pending) {
    pending = listDirs(relative);
    dirCache.set(relative, pending);
  }
  return pending;
};

app.get("/api/parts", async (req, res) => {
  const race = RACES[(req.query.race as keyof typeof RACES) ?? "human"] ?? RACES.human;
  const gender = GENDERS[(req.query.gender as keyof typeof GENDERS) ?? "male"] ?? GENDERS.male;

  const [allBodies, heads, headgears] = await Promise.all([
    listParts(`${race.root}/몸통/${gender}`),
    listParts(`${race.root}/머리통/${gender}`),
    listParts(`악세사리/${gender}${race.headgearSuffix}`),
  ]);

  // Only offer bodies whose class actually has weapon sprites. The folder
  // listings are memoized across the whole sweep, so this costs a handful of
  // readdirs rather than one per body.
  const folders = new Map<string, Promise<PartEntry[]>>();
  const withWeapons = await Promise.all(
    allBodies.map(async (body) => {
      const { weapons, origin } = await weaponsForBody(race.root, gender, body.name, folders);
      if (weapons.length === 0) return null;
      // `trusted` drives the picker's "own weapon sprites only" filter.
      return { ...body, origin, trusted: origin !== null && TRUSTED.includes(origin) };
    })
  );
  const bodies = withWeapons.filter((body): body is NonNullable<typeof body> => body !== null);

  res.json({
    race: race.label,
    gender,
    bodies,
    heads,
    headgears,
  });
});

/**
 * Equipment folders come from zrenderer's resolver tables (see
 * `resolver-data/README.md`), because a job's weapon folder is often not its
 * own name:
 *
 *   weapons   인간족/{weaponFolder}/{weaponPrefix}_{gender}{name}
 *   shields   방패/{job}/{job}_{gender}{name}
 *   garments  로브/{garment}/{gender}/{job}_{gender}, else 로브/{garment}/{garment}
 *
 * The client sends the body sprite's file name and the resolver derives the job
 * from it, since body files are not always a bare `{job}_{gender}`.
 */
/**
 * The folder a job's weapons would live in if the data set has caught up with
 * it, given the folder the tables name.
 *
 * The tables were taken from a client that predates third-job weapon sprites,
 * so they answer with a job's *ancestor*: 룬나이트 is sent to 기사, 여우워록 to
 * 위저드, 슈라알파카 to 몽크. This data set has the descendants' own folders, so
 * the longest folder name spelled out inside the job name wins -- costume and
 * mount bodies carry their job in the middle of a longer name (타조레인져,
 * 켈베로스길로틴크로스, ARCH_MAGE_RIDING), which is why this is a substring
 * test and not the token walk `foldersForJob` does.
 *
 * A mounted body must stay mounted, though. When the table's answer is itself a
 * mount folder -- one spelling out a plainer folder inside it, 페코페코_기사
 * around 기사 -- the job is substituted into that name instead, and the result
 * only counts if it is really on disk: 룬나이트쁘띠2 becomes 페코페코_룬나이트,
 * never the dismounted 룬나이트. Nothing is invented; a job with no folder of
 * its own keeps the table's answer.
 */
function descendantFolder(job: string, tableFolder: string, dirs: string[]): string | null {
  const lower = job.toLowerCase();
  let own = "";
  for (const dir of dirs) {
    if (dir.length > own.length && lower.includes(dir.toLowerCase())) own = dir;
  }
  if (!own || own.toLowerCase() === tableFolder.toLowerCase()) return null;

  // The plainer folder the table's answer is built around, if it is a mount.
  let base = "";
  for (const dir of dirs) {
    if (dir.length === tableFolder.length || dir.length <= base.length) continue;
    if (tableFolder.toLowerCase().includes(dir.toLowerCase())) base = dir;
  }
  if (!base) return dirs.includes(own) ? own : null;

  const mounted = tableFolder.replace(base, own);
  return dirs.includes(mounted) ? mounted : null;
}

/**
 * Weapons for one body sprite, resolved through the job tables. `folders`
 * memoizes directory listings so scanning a whole body list stays cheap.
 *
 * Three sources, most specific first: the job's own folder, the descendant
 * folder the tables are too old to name, and the table's own answer. They are
 * merged rather than replaced, because a job can own a couple of weapons and
 * inherit the rest -- 쉐도우체이서 has exactly one of its own and takes the
 * other forty from 로그.
 */
async function weaponsForBody(
  raceRoot: string,
  gender: string,
  bodyName: string,
  folders: Map<string, Promise<PartEntry[]>>
): Promise<{
  job: string;
  weaponFolder: string;
  origin: WeaponOrigin | null;
  weapons: PartEntry[];
}> {
  const listCached = (relative: string) => {
    let pending = folders.get(relative);
    if (!pending) {
      pending = listParts(relative);
      folders.set(relative, pending);
    }
    return pending;
  };

  const resolved = foldersForJob(bodyName);
  const dirs = await listDirsCached(raceRoot);

  // `folder/prefix` pairs to draw weapons from, most specific first.
  const sources: { folder: string; prefix: string; origin: WeaponOrigin }[] = [];
  const add = (folder: string, prefix: string, origin: WeaponOrigin) => {
    if (!sources.some((s) => s.folder === folder && s.prefix === prefix)) {
      sources.push({ folder, prefix, origin });
    }
  };

  const own = dirs.find((dir) => dir.toLowerCase() === resolved.job.toLowerCase());
  if (own) add(own, `${own}_${gender}`, "own");

  if (resolved.matched) {
    const descendant = descendantFolder(resolved.job, resolved.weaponFolder, dirs);
    if (descendant) add(descendant, `${descendant}_${gender}`, "descendant");
    add(
      resolved.weaponFolder,
      resolved.weaponHasGender ? `${resolved.weaponPrefix}_${gender}` : resolved.weaponPrefix,
      resolved.weaponOverridden ? "override" : "inherited"
    );
  } else {
    // Bodies with no table entry (운영자2_남, 무희바지_남, costume sets) can still
    // have a weapon folder on disk whose name is a prefix of the body name --
    // note a *string* prefix, not a token one: 운영자2_남 lives under 운영자.
    // Those folders hold files named either after the body itself
    // (운영자2_남_검) or after the folder (무희_남_검).
    let fallback = "";
    for (const dir of dirs) {
      if (bodyName.startsWith(dir) && dir.length > fallback.length) fallback = dir;
    }
    if (fallback) {
      add(fallback, bodyName, "probe");
      add(fallback, `${fallback}_${gender}`, "probe");
    }
  }

  // Keyed by what follows the prefix -- the weapon's item id or Korean name --
  // so the same weapon from two folders collapses to the more specific one.
  const byWeapon = new Map<string, PartEntry>();
  let origin: WeaponOrigin | null = null;
  for (const source of sources) {
    const prefix = source.prefix.toLowerCase();
    if (!prefix) continue;
    let added = 0;
    for (const part of await listCached(`${raceRoot}/${source.folder}`)) {
      const name = part.name.toLowerCase();
      if (!name.startsWith(prefix) || part.name.endsWith("_검광")) continue;
      const weapon = name.slice(prefix.length);
      if (byWeapon.has(weapon)) continue;
      byWeapon.set(weapon, part);
      added++;
    }
    // The first source that actually supplies weapons is the one that counts.
    if (added && !origin) origin = source.origin;
  }

  const weapons = [...byWeapon.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));

  return {
    job: resolved.job,
    weaponFolder: sources[0]?.folder ?? resolved.weaponFolder,
    origin,
    weapons,
  };
}

/**
 * Id of the .imf holding a body's per-frame draw order, or null when the data
 * set has none for it.
 *
 * The file is named after the job's *imf* name rather than its sprite name --
 * 룬나이트 has no imf of its own and shares 기사's, which is exactly what the
 * client's own table says -- so the table is tried first and the body's own
 * name only as a fallback for sprites no table covers.
 */
async function imfIdForBody(gender: string, bodyName: string): Promise<string | null> {
  const { imfName } = foldersForJob(bodyName);
  for (const candidate of [`${imfName}_${gender}`, bodyName]) {
    const rel = Buffer.from(`imf/${candidate}.imf`);
    try {
      await fs.access(resolveId(encodeId(rel)));
      return encodeId(rel);
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

app.get("/api/equipment", async (req, res) => {
  const race = RACES[(req.query.race as keyof typeof RACES) ?? "human"] ?? RACES.human;
  const gender = GENDERS[(req.query.gender as keyof typeof GENDERS) ?? "male"] ?? GENDERS.male;
  const bodyName = typeof req.query.body === "string" ? req.query.body : "";

  if (!bodyName) {
    return res.json({ job: "", origin: null, imfId: null, weapons: [], shields: [], garments: [] });
  }

  const { job, weaponFolder, origin, weapons } = await weaponsForBody(
    race.root,
    gender,
    bodyName,
    new Map()
  );

  const shieldFiles = await listParts(`방패/${job}`);
  const shieldPrefixLower = `${job}_${gender}`.toLowerCase();
  const shields = shieldFiles.filter((p) => p.name.toLowerCase().startsWith(shieldPrefixLower));

  // Each garment folder holds one sprite per job and gender, with a shared
  // sprite at the top level as fallback.
  let garments: PartEntry[] = [];
  try {
    const folders = await fs.readdir(resolveId(encodeId(Buffer.from("로브"))), {
      encoding: "buffer" as never,
      withFileTypes: true,
    });
    const found = await Promise.all(
      folders.map(async (folder) => {
        if (!folder.isDirectory()) return null;
        const name = displayName(folder.name as unknown as Buffer);
        const perJob = await listParts(`로브/${name}/${gender}`);
        const match = perJob.find((p) => p.name.toLowerCase() === `${job}_${gender}`.toLowerCase());
        if (match) return { ...match, name };
        const shared = await listParts(`로브/${name}`);
        const fallback = shared.find((p) => p.name.toLowerCase() === name.toLowerCase());
        return fallback ? { ...fallback, name } : null;
      })
    );
    garments = found.filter((entry): entry is PartEntry => entry !== null);
  } catch {
    garments = [];
  }

  const imfId = await imfIdForBody(gender, bodyName);
  res.json({ job, weaponFolder, origin, imfId, weapons, shields, garments });
});

/**
 * Encodes a packed sheet, because the browser will not do it properly.
 *
 * `canvas.toBlob(…, "image/webp", 1)` selects lossless and then gives you no
 * say in the *effort* behind it — the search libwebp does for predictors,
 * transforms and entropy codings, which costs only time and changes only size.
 * Chromium's answer to that moved between two builds and the same sprites came
 * out 3.8x heavier: 70 sheets that libwebp packs into 564 KB were shipped at
 * 2139 KB. There is no flag to ask for the good one.
 *
 * So the canvas is sent here as raw RGBA and libwebp is asked directly, at the
 * top effort it has. Slower per sheet, and worth it several times over: the
 * bytes are now a function of the art rather than of whichever browser somebody
 * happened to export from.
 *
 * Body is the pixels themselves; `w` and `h` describe them. Raw rather than a
 * PNG the browser encodes first, because that would be the same trade again —
 * an encoder we do not control, in the way of one we do.
 */
app.post(
  "/api/encode",
  express.raw({ type: "application/octet-stream", limit: "256mb" }),
  async (req, res) => {
    const width = Number(req.query.w);
    const height = Number(req.query.h);
    const pixels = req.body as Buffer;

    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      return res.status(400).json({ error: "w and h must be positive integers" });
    }
    if (!Buffer.isBuffer(pixels) || pixels.length !== width * height * 4) {
      return res.status(400).json({
        error: `expected ${width * height * 4} bytes of RGBA, got ${pixels?.length ?? 0}`,
      });
    }

    try {
      const webp = await sharp(pixels, { raw: { width, height, channels: 4 } })
        // `effort` is the whole point of this route; `exact` keeps the colour of
        // fully transparent pixels rather than letting the encoder pick
        // whatever compresses best there, so a sheet stays byte-stable across
        // re-exports.
        .webp({ lossless: true, effort: 6, exact: true })
        .toBuffer();

      res.setHeader("Content-Type", "image/webp");
      res.send(webp);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }
);

/**
 * The other half of `/api/encode`: an encoded image back out as raw RGBA.
 *
 * `/api/encode` was enough while everything that came here started life as a
 * canvas. It stopped being enough the moment art already shipped as WebP needed
 * resizing — a consumer that can only encode has to decode with something else,
 * and the something else is either a second image library or a hand-rolled
 * decoder that handles exactly the subset of formats it has met so far.
 * (Ilumnia's icon script carries such a decoder for PNG, which is why it could
 * not touch the WebP icons it had itself produced.)
 *
 * So the bytes come in whole and go out flattened: RGBA, one channel order, no
 * palette, no interlacing, no format left to know about. The dimensions travel
 * in the headers rather than the body, because the caller usually does not know
 * them until it asks.
 */
app.post(
  "/api/decode",
  express.raw({ type: "application/octet-stream", limit: "256mb" }),
  async (req, res) => {
    const bytes = req.body as Buffer;

    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      return res.status(400).json({ error: "expected image bytes in the body" });
    }

    try {
      // `ensureAlpha` so the answer is always 4 channels: an opaque source
      // would otherwise come back 3-wide and every caller would need the branch
      // this route exists to remove.
      const { data, info } = await sharp(bytes)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      res.setHeader("X-Image-Width", String(info.width));
      res.setHeader("X-Image-Height", String(info.height));
      res.setHeader("Content-Type", "application/octet-stream");
      res.send(data);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }
);

/** Monster sprites are standalone `.spr`/`.act` pairs in `몬스터/`. */
app.get("/api/monsters", async (_req, res) => {
  res.json(await listParts("몬스터"));
});

/**
 * Pets are a subset of those same monsters -- see `pets.ts` for how they are
 * told apart, and for the memoization behind this.
 */
app.get("/api/pets", async (_req, res) => {
  try {
    res.json(await listPetsCached());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * A pre-rendered part preview, written by `npm run thumbs`.
 *
 * Misses answer 404 rather than rendering on the spot: the client can still
 * compose the preview itself, and a miss should be visible as "the cache has
 * not been built for this file" rather than quietly costing a render per hit.
 */
app.get("/api/thumb", async (req, res) => {
  const id = typeof req.query.id === "string" ? req.query.id : undefined;
  if (!id) return res.status(400).json({ error: "missing id" });
  try {
    resolveId(id); // reject ids that do not name a file under data/
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }

  const tile = Number(req.query.tile ?? TILE);
  if (!Number.isInteger(tile) || tile < 1 || tile > 512) {
    return res.status(400).json({ error: "tile out of range" });
  }

  try {
    const bytes = await fs.readFile(thumbFile(THUMB_DIR, id, tile));
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(bytes);
  } catch {
    res.status(404).end();
  }
});

app.get("/api/file", async (req, res) => {
  const id = typeof req.query.id === "string" ? req.query.id : undefined;
  if (!id) return res.status(400).json({ error: "missing id" });
  let abs: Buffer;
  try {
    abs = resolveId(id);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
  try {
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.send(await fs.readFile(abs));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    res.status(code === "ENOENT" ? 404 : 500).json({ error: (err as Error).message });
  }
});

if (process.env.NODE_ENV === "production") {
  const clientDir = path.resolve(ROOT, "dist/client");
  app.use(express.static(clientDir));
  app.get("*", (_req, res) => res.sendFile(path.join(clientDir, "index.html")));
}

await fs.mkdir(DATA_DIR, { recursive: true });
app.listen(PORT, () => {
  console.log(`[ragnarok-sprite-generator] api on http://localhost:${PORT} serving ${DATA_DIR}`);
});
