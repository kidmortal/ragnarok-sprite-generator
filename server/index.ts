import express from "express";
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

/** Minimal single-range parser: `bytes=a-b`, `bytes=a-`, `bytes=-suffix`. */
function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number; size: number } | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "invalid";
  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;
  if (rawStart === "") {
    if (rawEnd === "") return "invalid";
    start = Math.max(size - Number(rawEnd), 0); // suffix range
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return "invalid";
  }
  return { start, end, size };
}

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

app.get("/api/parts", async (req, res) => {
  const race = RACES[(req.query.race as keyof typeof RACES) ?? "human"] ?? RACES.human;
  const gender = GENDERS[(req.query.gender as keyof typeof GENDERS) ?? "male"] ?? GENDERS.male;

  const [bodies, heads, headgears] = await Promise.all([
    listParts(`${race.root}/몸통/${gender}`),
    listParts(`${race.root}/머리통/${gender}`),
    listParts(`악세사리/${gender}${race.headgearSuffix}`),
  ]);

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
 * The job is taken from the chosen body sprite, whose name is `{job}_{gender}`.
 */
app.get("/api/equipment", async (req, res) => {
  const race = RACES[(req.query.race as keyof typeof RACES) ?? "human"] ?? RACES.human;
  const gender = GENDERS[(req.query.gender as keyof typeof GENDERS) ?? "male"] ?? GENDERS.male;
  const requested = typeof req.query.job === "string" ? req.query.job : "";

  if (!requested) return res.json({ job: "", weapons: [], shields: [], garments: [] });

  const { job, weaponFolder, weaponPrefix } = foldersForJob(requested);

  const [weaponFiles, shieldFiles] = await Promise.all([
    listParts(`${race.root}/${weaponFolder}`),
    listParts(`방패/${job}`),
  ]);

  const weaponPrefixLower = `${weaponPrefix}_${gender}`.toLowerCase();
  const weapons = weaponFiles.filter(
    (p) => p.name.toLowerCase().startsWith(weaponPrefixLower) && !p.name.endsWith("_검광")
  );

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

app.get("/api/list", async (req, res) => {
  const id = typeof req.query.id === "string" ? req.query.id : undefined;
  let abs: Buffer;
  let rel: Buffer;
  try {
    abs = resolveId(id);
    rel = id ? decodeId(id) : Buffer.alloc(0);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }

  try {
    const entries = await fs.readdir(abs, { encoding: "buffer" as never, withFileTypes: true });
    const items = entries.map((entry) => {
      const nameBuf = entry.name as unknown as Buffer;
      const childRel = join(rel, nameBuf);
      const name = displayName(nameBuf);
      const ext = path.extname(name).toLowerCase();
      return {
        id: encodeId(childRel),
        name,
        type: entry.isDirectory() ? ("dir" as const) : ("file" as const),
        ext,
      };
    });

    items.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name, "ko") : a.type === "dir" ? -1 : 1
    );

    const crumbs: { id: string; name: string }[] = [];
    if (rel.length) {
      let acc: Buffer = Buffer.alloc(0);
      for (const part of rel.toString("binary").split(path.sep)) {
        const partBuf = Buffer.from(part, "binary");
        acc = join(acc, partBuf);
        crumbs.push({ id: encodeId(acc), name: displayName(partBuf) });
      }
    }

    res.json({ id: id ?? "", crumbs, items });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    res.status(code === "ENOENT" ? 404 : 500).json({ error: (err as Error).message });
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
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-cache");

    // Range support lets thumbnails pull just the header and the trailing
    // palette instead of a whole multi-megabyte sprite.
    const range = parseRange(req.headers.range, (await fs.stat(abs)).size);
    if (range === "invalid") return res.status(416).end();
    if (!range) return res.send(await fs.readFile(abs));

    const { start, end, size } = range;
    const handle = await fs.open(abs, "r");
    try {
      const buf = Buffer.alloc(end - start + 1);
      const { bytesRead } = await handle.read(buf, 0, buf.length, start);
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.send(buf.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
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
  console.log(`[sprite-manager] api on http://localhost:${PORT} serving ${DATA_DIR}`);
});
