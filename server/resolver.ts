/**
 * Job-to-folder resolution, following zrenderer's RESOLVER.md.
 *
 * The tables in `resolver-data/` are line-indexed by job id (a job id above
 * 4000 has 3950 subtracted first). The important part is that a job's weapon
 * folder is frequently *not* its own name -- High Wizard bodies live in
 * `인간족/몸통/{gender}/하이위저드_{gender}` but its weapons are under
 * `인간족/위저드/위저드_{gender}{weapon}` -- which holds for 228 of the 411 jobs.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "resolver-data");

const readTable = (name: string): string[] => {
  try {
    return fs
      .readFileSync(path.join(DATA, name), "utf8")
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .filter((line, index, all) => index < all.length - 1 || line.length > 0);
  } catch {
    return [];
  }
};

const jobNames = readTable("job_names.txt");
const jobWeaponNames = readTable("job_weapon_names.txt");

/** Shield name suffixes; index 0 is intentionally empty in the source table. */
export const shieldNames = readTable("shield_names.txt");

export type JobFolders = {
  /** Job name, used for the body, shield folder and garment act. */
  job: string;
  /** Folder holding this job's weapon sprites. */
  weaponFolder: string;
  /** Filename prefix of this job's weapon sprites. */
  weaponPrefix: string;
  /** Whether weapon file names carry the gender: `검사_남_검` but `활용병_활`. */
  weaponHasGender: boolean;
  /** False when no table entry matched, so callers can probe the filesystem. */
  matched: boolean;
};

/** Job name (as it appears in a body sprite filename) → folders. */
const byJobName = new Map<string, JobFolders>();

for (let id = 0; id < jobNames.length; id++) {
  const job = jobNames[id];
  if (!job) continue;
  const key = job.toLowerCase();
  if (byJobName.has(key)) continue; // 102 names repeat across ids; first wins

  // Stored as `folder\prefix`, a Windows path fragment.
  const [weaponFolder, weaponPrefix] = (jobWeaponNames[id] ?? "").split("\\");
  byJobName.set(key, {
    job,
    weaponFolder: weaponFolder || job,
    weaponPrefix: weaponPrefix || weaponFolder || job,
    weaponHasGender: true,
    matched: true,
  });
}

/**
 * Mercenaries keep their weapons in one shared folder, named after the
 * mercenary rather than a job (RESOLVER.md, "Weapon / Mercenary").
 */
const MERCENARIES: Record<string, JobFolders> = Object.fromEntries(
  ["활용병", "창용병", "검용병"].map((name) => [
    name,
    {
      job: name,
      weaponFolder: "용병",
      weaponPrefix: name,
      weaponHasGender: false, // 인간족/용병/활용병_활, with no gender segment
      matched: true,
    },
  ])
);

/**
 * Resolve the job of a body sprite file name.
 *
 * Body files are not always a bare `{job}_{gender}`: the data set also carries
 * variants like `기사_h_여` and `무희_여_바지` whose full name is in no table.
 * Walking the underscore-separated prefixes longest-first finds the real job
 * (`기사_h_여` → `기사`, `페코페코_기사_h_여` → `페코페코_기사`) while still
 * preferring an exact table hit when there is one.
 *
 * Names that match nothing -- costume bodies such as 결혼 or 산타 -- keep their
 * own name, and simply have no weapon folder on disk.
 */
export function foldersForJob(bodyName: string): JobFolders {
  const name = bodyName.replace(/\.(spr|act)$/i, "");

  const exact = byJobName.get(name.toLowerCase());
  if (exact) return exact;

  const tokens = name.split("_");
  for (let length = tokens.length; length > 0; length--) {
    const candidate = tokens.slice(0, length).join("_");
    const merc = MERCENARIES[candidate];
    if (merc) return merc;
    const hit = byJobName.get(candidate.toLowerCase());
    if (hit) return hit;
  }

  return { job: name, weaponFolder: name, weaponPrefix: name, weaponHasGender: true, matched: false };
}

export const jobCount = byJobName.size;

