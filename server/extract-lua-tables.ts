/**
 * Regenerates `resolver-data/pc_jobs.txt` from a client's `luafiles514`.
 *
 *   npx tsx server/extract-lua-tables.ts <path to .../data/luafiles514>
 *
 * What the client's lua actually carries, and what it does not:
 *
 *   jobidentity.lub  JTtbl         JT_ROYAL_GUARD -> 4066
 *   pcjobname.lub    ReqPCJobName  JOBID.JT_ROYAL_GUARD -> "Royal Guard"
 *
 * Those two give the roster of *player* jobs and each one's id, which is what
 * indexes `job_names.txt`. They do not give the Korean sprite folder a job's
 * weapons live in: no `.lub` in the client carries one of those names at all.
 * That table is compiled into the client executable, which is why
 * `job_weapon_names.txt` is an extraction rather than something read at runtime
 * -- see `README.md`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTables } from "./lua.ts";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "resolver-data");

const root = process.argv[2];
if (!root) {
  console.error("usage: tsx server/extract-lua-tables.ts <path to data/luafiles514>");
  process.exit(1);
}

/** The client ships these under `lua files/datainfo`, with a space in the name. */
function datainfo(name: string): string {
  for (const dir of [path.join(root, "lua files", "datainfo"), path.join(root, "datainfo")]) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`${name} not found under ${root}`);
}

const identity = readTables(datainfo("jobidentity.lub")).get("JTtbl");
const pcJobs = readTables(datainfo("pcjobname.lub")).get("ReqPCJobName");
if (!identity || !pcJobs) throw new Error("expected JTtbl and ReqPCJobName tables");

const jobNames = fs
  .readFileSync(path.join(DATA, "job_names.txt"), "utf8")
  .split("\n")
  .map((line) => line.replace(/\r$/, ""));
/** A job id above 4000 has 3950 subtracted before indexing, as elsewhere. */
const spriteName = (id: number) => jobNames[id > 4000 ? id - 3950 : id] ?? "";

const rows: string[] = [];
for (const [key, english] of pcJobs) {
  const constant = key.replace(/^JOBID\./, "");
  const id = identity.get(constant);
  if (typeof id !== "number") continue; // mounted "_2ND" forms are not in JTtbl
  rows.push([id, constant, english, spriteName(id)].join("\t"));
}
rows.sort((a, b) => Number(a.split("\t")[0]) - Number(b.split("\t")[0]));

const header = [
  "# Player jobs, extracted from a client's luafiles514 by",
  "# `server/extract-lua-tables.ts`. Columns: job id, JT_ constant, English",
  "# name, and the sprite name job_names.txt gives that id.",
  "#",
  "# The client's lua carries no job-to-weapon-folder table; see README.md.",
].join("\n");
fs.writeFileSync(path.join(DATA, "pc_jobs.txt"), `${header}\n${rows.join("\n")}\n`);
console.log(`wrote pc_jobs.txt: ${rows.length} player jobs`);
