/**
 * Refreshes `resolver-data/imf_names.txt` from an unpacked Ragnarok client.
 *
 *   npx tsx server/extract-exe-tables.ts <path to RagexeU.exe>
 *
 * The client must be unpacked first -- a stock Ragexe.exe is Themida-packed and
 * carries none of these strings. Magicmida writes its output beside the input
 * with a `U` suffix.
 *
 * The client builds four job tables; three are recoverable here, and the run is
 * only trusted when the job-name table it recovers reproduces `job_names.txt`
 * exactly. That table is the control: it is the one we already know is right,
 * so if the decoder replays it byte for byte then the tables beside it were
 * decoded the same way and can be believed.
 *
 * There is deliberately no weapon table. This client has none -- see README.md.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJobTables, agreement, type ClientTable } from "./pe.ts";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "resolver-data");

const exe = process.argv[2];
if (!exe) {
  console.error("usage: tsx server/extract-exe-tables.ts <path to unpacked RagexeU.exe>");
  process.exit(1);
}

const reference = (name: string) =>
  fs
    .readFileSync(path.join(DATA, name), "utf8")
    .split("\n")
    .map((line) => line.replace(/\r$/, "").split("\\")[0]);

const jobNames = reference("job_names.txt");
const palNames = reference("job_pal_names.txt");
const imfNames = reference("imf_names.txt");

const tables = readJobTables(exe);
console.log(`recovered ${tables.length} tables of 40+ entries`);

const best = (ref: string[]): { table: ClientTable; score: number } | null => {
  let winner: { table: ClientTable; score: number } | null = null;
  for (const table of tables) {
    const score = agreement(table, ref);
    if (!winner || score > winner.score) winner = { table, score };
  }
  return winner;
};

const job = best(jobNames);
const pal = best(palNames);
const imf = best(imfNames);
for (const [label, hit] of [["job names", job], ["palette names", pal], ["imf names", imf]] as const) {
  console.log(`  ${label.padEnd(14)} ${hit ? `${hit.table.size} entries, ${(hit.score * 100).toFixed(1)}% vs the current file` : "not found"}`);
}

if (!job || job.score < 1) {
  console.error(
    `\nRefusing to write: the job-name table came back ${((job?.score ?? 0) * 100).toFixed(1)}% ` +
      `rather than 100%. Either the client is not fully unpacked or its table layout has moved.`
  );
  process.exit(1);
}
if (!imf) {
  console.error("\nRefusing to write: no imf table recovered.");
  process.exit(1);
}

// Keep the existing line count; the client covers only part of the id range.
const merged = [...imfNames];
let changed = 0;
for (const [index, value] of imf.table) {
  if (index >= merged.length) continue;
  if (merged[index] !== value) changed++;
  merged[index] = value;
}
fs.writeFileSync(path.join(DATA, "imf_names.txt"), merged.join("\n"));
console.log(`\njob-name control table matched 100% -- writing imf_names.txt (${changed} rows changed)`);
