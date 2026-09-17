import express from "express";
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import { foldersForJob } from "./resolver.ts";
import { listPetsCached } from "./pets.ts";
import { GENDERS, listParts, RACES, TRUSTED, weaponsForBody, type PartEntry } from "./weapons.ts";
import { isNarrow } from "./silhouette-table.ts";
import { saveWeaponOffset, weaponOffsetsForBody } from "./weapon-offsets.ts";
import {
  DATA_DIR,
  displayName,
  encodeId,
  join,
  resolveId,
  ROOT,
  THUMB_DIR,
} from "./paths.ts";
import { registerExportRoutes } from "./export-routes.ts";
import { PROP_SOURCES } from "./props.ts";
import { thumbFile, TILE } from "./thumbnail.ts";
import { label } from "./translate.ts";

const PORT = Number(process.env.PORT ?? 3001);

const app = express();

/**
 * The headless half: a searchable catalogue and a render route, so a pipeline
 * can ask for art without a browser in the middle of it. See `export-routes.ts`.
 *
 * `express.json` is scoped to it rather than mounted globally: every other
 * route here either takes a query string or raw bytes, and a body parser in
 * front of `/api/encode` would try to read a spritesheet as JSON.
 */
app.use("/api/export", express.json({ limit: "4mb" }));
registerExportRoutes(app);

/**
 * A bare document on this origin, for the headless renderer to stand on.
 *
 * The harness fetches sprites from `/api/file` and encodes through
 * `/api/encode` with relative URLs — the same code the app runs — so it has to
 * be loaded from the server's own origin. `about:blank` is an opaque one and
 * every fetch from it would fail.
 */
app.get("/api/render-harness", (_req, res) => {
  res.type("html").send("<!doctype html><meta charset=utf-8><title>render harness</title>");
});

app.get("/api/parts", async (req, res) => {
  const race = RACES[(req.query.race as keyof typeof RACES) ?? "human"] ?? RACES.human;
  const gender = GENDERS[(req.query.gender as keyof typeof GENDERS) ?? "male"] ?? GENDERS.male;

  const [allBodies, heads, headgears] = await Promise.all([
    listParts(`${race.root}/몸통/${gender}`, "body"),
    listParts(`${race.root}/머리통/${gender}`, "head"),
    listParts(`악세사리/${gender}${race.headgearSuffix}`, "headgear"),
  ]);

  // Only offer bodies whose class actually has weapon sprites. The folder
  // listings are memoized across the whole sweep, so this costs a handful of
  // readdirs rather than one per body.
  const folders = new Map<string, Promise<PartEntry[]>>();
  const withWeapons = await Promise.all(
    allBodies.map(async (body) => {
      const { weapons, origin } = await weaponsForBody(race.root, gender, body.name, folders);
      if (weapons.length === 0) return null;
      // Two separate questions, and the picker's filter asks both. `trusted`
      // is provenance: are these the job's own sprites or an ancestor's?
      // `fits` is shape: is this body big enough for whichever art it got? A
      // body can pass one and fail the other -- 가드 resolves to its own folder
      // through a hand-checked override and still wears a Crusader's sword.
      return {
        ...body,
        origin,
        trusted: origin !== null && TRUSTED.includes(origin),
        fits: !isNarrow(gender, body.name),
      };
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
    return res.json({
      job: "",
      origin: null,
      imfId: null,
      weapons: [],
      shields: [],
      garments: [],
      weaponOffsets: [],
    });
  }

  const { job, weaponFolder, origin, weapons } = await weaponsForBody(
    race.root,
    gender,
    bodyName,
    new Map()
  );

  const shieldFiles = await listParts(`방패/${job}`, "shield");
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
        const perJob = await listParts(`로브/${name}/${gender}`, "garment");
        const match = perJob.find((p) => p.name.toLowerCase() === `${job}_${gender}`.toLowerCase());
        if (match) return { ...match, name, label: label(name, "garment") };
        const shared = await listParts(`로브/${name}`, "garment");
        const fallback = shared.find((p) => p.name.toLowerCase() === name.toLowerCase());
        return fallback ? { ...fallback, name, label: label(name, "garment") } : null;
      })
    );
    garments = found.filter((entry): entry is PartEntry => entry !== null);
  } catch {
    garments = [];
  }

  const imfId = await imfIdForBody(gender, bodyName);
  // Hand-written corrections for this body, which the browser applies as it
  // composes -- see `resolver-data/weapon_offsets.txt`.
  const weaponOffsets = weaponOffsetsForBody(bodyName);
  res.json({ job, weaponFolder, origin, imfId, weapons, shields, garments, weaponOffsets });
});

/**
 * Writes one weapon correction, from the preview's nudge control.
 *
 * The point of the control is that the number can only be found by looking, and
 * the point of this route is that having found it you are not then asked to go
 * and edit a file by hand -- the loop closes where it started. The table is the
 * record either way: what lands in it is a plain row, which anybody can read,
 * reorder or delete.
 */
app.post("/api/weapon-offsets", express.json({ limit: "16kb" }), async (req, res) => {
  const row = req.body ?? {};
  try {
    const result = await saveWeaponOffset({
      body: String(row.body ?? ""),
      weapon: String(row.weapon ?? ""),
      action: String(row.action ?? "*"),
      facing: String(row.facing ?? "*"),
      frames: String(row.frames ?? "*"),
      dx: Number(row.dx),
      dy: Number(row.dy),
      note: String(row.note ?? ""),
    });
    res.json({ ok: true, result });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
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
  res.json(await listParts("몬스터", "monster"));
});

/** Props, effects and dropped items: standalone sprites, like a monster. */
app.get("/api/props", async (req, res) => {
  const source = typeof req.query.source === "string" ? req.query.source : "npc";
  const folder = PROP_SOURCES[source];
  if (!folder) return res.status(400).json({ error: `unknown source: ${source}` });
  res.json(await listParts(folder, "prop"));
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
