/**
 * Pre-renders a preview for every part under `data/`.
 *
 *   npm run thumbs           -- render what is missing
 *   npm run thumbs -- --force  render everything again
 *
 * Previews used to be composed in the browser, once per tile that scrolled into
 * view: a folder of a thousand headgears meant a thousand .spr/.act downloads
 * and a thousand canvas composes, on every visit. Rendering them here turns
 * that into one ~1 KB WebP per part, served straight off disk by `/api/thumb`.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, displayName, encodeId, join, resolveId, THUMB_DIR } from "./paths.ts";
import { renderThumb, thumbFile, TILE } from "./thumbnail.ts";

const force = process.argv.includes("--force");
const tileArg = process.argv.find((arg) => arg.startsWith("--tile="));
const tile = tileArg ? Number(tileArg.slice("--tile=".length)) : TILE;

if (!Number.isInteger(tile) || tile < 1 || tile > 512) {
  console.error(`invalid --tile=${tileArg}`);
  process.exit(1);
}

type Job = { sprRel: Buffer; actRel: Buffer; label: string };

/** Every .spr under `data/` that has an .act of the same name beside it. */
async function collect(rel: Buffer, out: Job[]): Promise<void> {
  // Paths stay Buffers all the way to fs: some names are not valid UTF-8, and
  // routing them through a JS string mangles the bytes back on the way out.
  const abs = resolveId(encodeId(rel));
  let entries;
  try {
    entries = (await fs.readdir(abs, {
      encoding: "buffer" as never,
      withFileTypes: true,
    })) as unknown as { name: Buffer; isDirectory(): boolean }[];
  } catch {
    return;
  }

  const acts = new Set<string>();
  for (const entry of entries) {
    const name = displayName(entry.name).toLowerCase();
    if (!entry.isDirectory() && name.endsWith(".act")) acts.add(name.slice(0, -4));
  }

  for (const entry of entries) {
    const name = displayName(entry.name);
    if (entry.isDirectory()) {
      await collect(join(rel, entry.name), out);
      continue;
    }
    if (!name.toLowerCase().endsWith(".spr")) continue;
    if (!acts.has(name.slice(0, -4).toLowerCase())) continue; // a part needs both halves
    const sprRel = join(rel, entry.name);
    out.push({
      sprRel,
      actRel: Buffer.concat([sprRel.subarray(0, sprRel.length - 4), Buffer.from(".act")]),
      label: displayName(sprRel),
    });
  }
}

const read = async (rel: Buffer): Promise<ArrayBuffer> => {
  const buf = await fs.readFile(resolveId(encodeId(rel)));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

const jobs: Job[] = [];
await collect(Buffer.alloc(0), jobs);
console.log(`[thumbs] ${jobs.length} parts under ${DATA_DIR}, tile ${tile}px`);

let done = 0;
let written = 0;
let skipped = 0;
let empty = 0;
const failures: string[] = [];

async function run(job: Job): Promise<void> {
  const target = thumbFile(THUMB_DIR, encodeId(job.sprRel), tile);
  try {
    if (!force) {
      try {
        await fs.access(target);
        skipped++;
        return;
      } catch {
        /* not cached yet */
      }
    }

    const [spr, act] = await Promise.all([read(job.sprRel), read(job.actRel)]);
    const webp = await renderThumb(spr, act, tile);
    if (!webp) {
      // Nothing is drawn in any action -- an effect or placeholder sprite.
      empty++;
      return;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, webp);
    written++;
  } catch (err) {
    failures.push(`${job.label}: ${(err as Error).message}`);
  } finally {
    done++;
    if (done % 200 === 0 || done === jobs.length) {
      process.stdout.write(`\r[thumbs] ${done}/${jobs.length}`);
    }
  }
}

// Rendering is CPU-bound (rasterise + WebP), so run one job per core.
const workers = Math.max(os.cpus().length - 1, 1);
let next = 0;
await Promise.all(
  Array.from({ length: workers }, async () => {
    while (next < jobs.length) await run(jobs[next++]);
  })
);

process.stdout.write("\n");
console.log(
  `[thumbs] ${written} written, ${skipped} already cached, ${empty} drew nothing, ${failures.length} failed`
);
for (const failure of failures.slice(0, 20)) console.log(`  ! ${failure}`);
if (failures.length > 20) console.log(`  ... and ${failures.length - 20} more`);
