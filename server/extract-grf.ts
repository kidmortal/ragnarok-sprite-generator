/**
 * Unpacks the sprite data the app reads straight out of a client's data.grf.
 *
 *   npm run extract                       -- every *.grf in the project root
 *   npm run extract -- --grf=path/to.grf  -- that archive instead
 *   npm run extract -- --only=인간족/몸통  -- just the entries under a folder
 *   npm run extract -- --list=여름         -- print matching paths, write nothing
 *   npm run extract -- --force            -- rewrite files that already exist
 *   npm run extract -- --out=some/dir     -- write there instead of data/
 *
 * Only `data\sprite\` and `data\imf\` come out, laid out the way README.md
 * describes: `data\sprite\X` lands at `data/X` and `data\imf\X` at
 * `data/imf/X`. Textures, models and sound stay in the archive -- nothing here
 * reads them, and they are most of the 4 GB. Names are converted from EUC-KR to
 * UTF-8, as zextractor does; the few that are not EUC-KR keep their raw bytes.
 *
 * A file already on disk at the same size is left alone, so re-running after a
 * client patch only writes what changed. Several archives at once go in name
 * order, later ones overwriting earlier ones.
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ROOT } from "./paths.ts";
import { FLAG_FILE, readEntry, readTable, type GrfEntry } from "./grf.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const force = args.includes("--force");
const only = flag("only")?.replaceAll("\\", "/").replace(/\/+$/, "");
const list = flag("list")?.toLowerCase();
const outDir = flag("out") ? path.resolve(flag("out")!) : DATA_DIR;

const archives = flag("grf")
  ? [path.resolve(flag("grf")!)]
  : fs
      .readdirSync(ROOT)
      .filter((f) => f.toLowerCase().endsWith(".grf"))
      .sort()
      .map((f) => path.join(ROOT, f));

if (archives.length === 0) {
  console.error(`no .grf in ${ROOT}; drop a client's data.grf there or pass --grf=<path>`);
  process.exit(1);
}

/** Where an entry goes under data/, or null when it is nothing the app reads. */
function destination(entry: GrfEntry): { rel: string; bytes: Buffer } | null {
  if (!(entry.flags & FLAG_FILE) || entry.size === 0) return null;
  const lower = entry.name.toLowerCase();
  let prefix: string;
  let sub: string;
  if (lower.startsWith("data/sprite/")) {
    prefix = "data/sprite/";
    sub = "";
  } else if (lower.startsWith("data/imf/")) {
    prefix = "data/imf/";
    sub = "imf/";
  } else {
    return null;
  }
  const rel = sub + entry.name.slice(prefix.length);
  if (rel.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  if (only && !rel.startsWith(only + "/") && rel !== only) return null;
  // Raw bytes for the undecodable names: the app addresses files by path
  // bytes, so an undecodable name still round-trips as long as it is kept.
  const bytes = entry.nameDecoded
    ? Buffer.from(rel, "utf8")
    : Buffer.concat([
        Buffer.from(sub, "utf8"),
        Buffer.from(entry.rawName.subarray(prefix.length).map((b) => (b === 0x5c ? 0x2f : b))),
      ]);
  return { rel, bytes };
}

let written = 0;
let skipped = 0;
let failed = 0;

for (const archive of archives) {
  const fd = fs.openSync(archive, "r");
  const { version, entries } = readTable(fd);
  console.log(`[extract] ${path.relative(ROOT, archive)}: GRF 0x${version.toString(16)}, ${entries.length} entries`);

  if (list !== undefined) {
    let hits = 0;
    for (const entry of entries) {
      if (entry.name.toLowerCase().includes(list)) {
        console.log(entry.name);
        hits++;
      }
    }
    console.log(`[extract] ${hits} match "${list}"`);
    fs.closeSync(fd);
    continue;
  }

  // Reading in archive order keeps the disk sequential across 4 GB.
  const wanted = entries
    .map((entry) => ({ entry, dest: destination(entry) }))
    .filter((job): job is { entry: GrfEntry; dest: { rel: string; bytes: Buffer } } => job.dest !== null)
    .sort((a, b) => a.entry.offset - b.entry.offset);
  console.log(`[extract] ${wanted.length} files to consider under ${path.relative(ROOT, outDir) || "."}/`);

  const madeDirs = new Set<string>();
  let done = 0;
  for (const { entry, dest } of wanted) {
    const abs = Buffer.concat([Buffer.from(outDir + path.sep), dest.bytes]);
    if (!force) {
      try {
        if (fs.statSync(abs).size === entry.size) {
          skipped++;
          continue;
        }
      } catch {
        /* not there yet */
      }
    }
    try {
      const dir = path.dirname(dest.rel);
      if (!madeDirs.has(dir)) {
        const dirBytes = Buffer.concat([Buffer.from(outDir + path.sep), dest.bytes.subarray(0, dest.bytes.lastIndexOf(0x2f))]);
        fs.mkdirSync(dirBytes, { recursive: true });
        madeDirs.add(dir);
      }
      fs.writeFileSync(abs, readEntry(fd, entry));
      written++;
    } catch (err) {
      failed++;
      console.error(`[extract] ${entry.name}: ${err instanceof Error ? err.message : err}`);
    }
    if (++done % 5000 === 0) console.log(`[extract]   ${done}/${wanted.length}`);
  }
  fs.closeSync(fd);
}

if (list === undefined) {
  console.log(`[extract] ${written} written, ${skipped} already up to date, ${failed} failed`);
  if (written > 0) console.log(`[extract] run \`npm run thumbs\` to render previews for the new parts`);
  if (failed > 0) process.exit(1);
}
