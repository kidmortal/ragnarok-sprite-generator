import express from "express";
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { foldersForJob } from "./resolver.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(ROOT, "data");
const PORT = Number(process.env.PORT ?? 3001);

/**
 * Paths are addressed by an opaque id: base64url of the raw relative path
 * *bytes*. Folders/files here are often named in Korean, and some archives
 * carry legacy EUC-KR bytes that are not valid UTF-8 -- round-tripping the raw
 * bytes means we can always reopen the file even when its name cannot be
 * decoded losslessly.
 */
const encodeId = (rel: Buffer) => rel.toString("base64url");
const decodeId = (id: string) => Buffer.from(id, "base64url");

const utf8 = new TextDecoder("utf-8", { fatal: false });
let eucKr: TextDecoder | null = null;
try {
  eucKr = new TextDecoder("euc-kr", { fatal: true });
} catch {
  eucKr = null;
}

function displayName(raw: Buffer): string {
  const asUtf8 = utf8.decode(raw);
  if (!asUtf8.includes("�")) return asUtf8.normalize("NFC");
  if (eucKr) {
    try {
      return eucKr.decode(raw).normalize("NFC");
    } catch {
      /* fall through */
    }
  }
  return asUtf8;
}

/** Resolve an id to an absolute path, refusing anything outside data/. */
function resolveId(id: string | undefined): Buffer {
  const rel = id ? decodeId(id) : Buffer.alloc(0);
  if (rel.includes(0)) throw new Error("invalid path");
  const abs = rel.length
    ? Buffer.concat([Buffer.from(DATA_DIR + path.sep), rel])
    : Buffer.from(DATA_DIR);
  const normalized = path.resolve(abs.toString("binary"));
  const base = path.resolve(DATA_DIR.toString());
  if (normalized !== base && !normalized.startsWith(base + path.sep)) {
    throw new Error("path escapes data directory");
  }
  return abs;
}

const join = (parent: Buffer, name: Buffer): Buffer =>
  parent.length ? Buffer.concat([parent, Buffer.from(path.sep), name]) : name;

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
      const { weapons } = await weaponsForBody(race.root, gender, body.name, folders);
      return weapons.length > 0 ? body : null;
    })
  );
  const bodies = withWeapons.filter((body): body is PartEntry => body !== null);

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
 * Weapons for one body sprite, resolved through the job tables. `folders`
 * memoizes directory listings so scanning a whole body list stays cheap.
 */
async function weaponsForBody(
  raceRoot: string,
  gender: string,
  bodyName: string,
  folders: Map<string, Promise<PartEntry[]>>
): Promise<{ job: string; weaponFolder: string; weapons: PartEntry[] }> {
  const listCached = (relative: string) => {
    let pending = folders.get(relative);
    if (!pending) {
      pending = listParts(relative);
      folders.set(relative, pending);
    }
    return pending;
  };

  const resolved = foldersForJob(bodyName);
  let { weaponFolder, weaponPrefix } = resolved;

  // Bodies with no table entry (운영자2_남, 무희바지_남, costume sets) can still
  // have a weapon folder on disk whose name is a prefix of the body name --
  // note a *string* prefix, not a token one: 운영자2_남 lives under 운영자.
  let fallbackFolder = "";
  if (!resolved.matched) {
    for (const dir of await listDirs(raceRoot)) {
      if (bodyName.startsWith(dir) && dir.length > fallbackFolder.length) fallbackFolder = dir;
    }
    if (fallbackFolder) weaponFolder = fallbackFolder;
  }

  const files = await listCached(`${raceRoot}/${weaponFolder}`);

  // Table jobs have an authoritative prefix; fallback folders hold files named
  // either after the body itself (운영자2_남_검) or after the folder (무희_남_검).
  const prefixes = (
    resolved.matched
      ? [resolved.weaponHasGender ? `${weaponPrefix}_${gender}` : weaponPrefix]
      : [bodyName, `${fallbackFolder}_${gender}`]
  )
    .filter(Boolean)
    .map((prefix) => prefix.toLowerCase());

  const weapons = files.filter(
    (part) =>
      prefixes.some((prefix) => part.name.toLowerCase().startsWith(prefix)) &&
      !part.name.endsWith("_검광")
  );

  return { job: resolved.job, weaponFolder, weapons };
}

app.get("/api/equipment", async (req, res) => {
  const race = RACES[(req.query.race as keyof typeof RACES) ?? "human"] ?? RACES.human;
  const gender = GENDERS[(req.query.gender as keyof typeof GENDERS) ?? "male"] ?? GENDERS.male;
  const bodyName = typeof req.query.body === "string" ? req.query.body : "";

  if (!bodyName) return res.json({ job: "", weapons: [], shields: [], garments: [] });

  const { job, weaponFolder, weapons } = await weaponsForBody(
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

  res.json({ job, weaponFolder, weapons, shields, garments });
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

/** Monster sprites are standalone `.spr`/`.act` pairs in `몬스터/`. */
app.get("/api/monsters", async (_req, res) => {
  res.json(await listParts("몬스터"));
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
