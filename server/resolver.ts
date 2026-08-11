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
  });
}

/**
 * Resolve a job name taken off a body sprite (`{job}_{gender}`). Unknown names
 * -- mercenaries and costume bodies that are not in the table -- fall back to
 * using the name for everything, which is what the folders look like anyway.
 */
export function foldersForJob(job: string): JobFolders {
  return (
    byJobName.get(job.toLowerCase()) ?? { job, weaponFolder: job, weaponPrefix: job }
  );
}

export const jobCount = byJobName.size;
