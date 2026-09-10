/**
 * The two routes an automated caller needs, and the reason this file exists.
 *
 * Everything the app could do was reachable only by a person pressing a button
 * in a browser: the compositor drew on a DOM canvas and the export rules — the
 * facings, the action lists, the one-attack-pose rule — lived in a React
 * component. So the pipeline that feeds Ilumnia its entire sprite library had a
 * human at the centre of it by construction, and an agent asked to add a
 * monster could do everything except the one step that mattered.
 *
 * `GET /api/catalog` answers **what can be asked for**, searchable, with
 * everything needed to ask for it. `POST /api/export` answers **the sheets and
 * the manifest rows**. Between them a script can go from "add these three
 * monsters" to files on disk with nothing rendered by hand.
 *
 * Neither route writes anywhere. What comes back is bytes and metadata, and
 * where those belong is the consumer's business — Ilumnia has its own importer
 * that merges them into `public/ro`. A generator that knew about a particular
 * game's folder layout would be a generator with one consumer for ever.
 */

import type { Express, Request, Response } from "express";

import { renderSheetInBrowser } from "./browser-sheets.ts";
import { partKey, type SheetRequest } from "./sheets.ts";
import {
  loadOverrides,
  overrideFor,
  reloadOverrides,
  specsFor,
  ATTACK_VARIANTS,
  type AttackVariant,
} from "./export-plan.ts";
import { foldersForJob } from "./resolver.ts";
import { listPetsCached } from "./pets.ts";
import { GENDERS, listParts, RACES, weaponsForBody, type PartEntry } from "./weapons.ts";
import { displayName, encodeId, resolveId } from "./paths.ts";
import { label } from "./translate.ts";
import fs from "node:fs/promises";

/** One thing that can be exported, as the catalogue describes it. */
type CatalogEntry = {
  kind: string;
  /** The sprite's own name, Korean where the extract is Korean. */
  name: string;
  /** The same name in English, or the name again where it needs no translation. */
  label: string;
  sprId: string;
  actId: string;
  race?: string;
  gender?: string;
  job?: string;
};

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/** Case- and script-insensitive enough for a search box or an agent's guess. */
function matches(entry: CatalogEntry, needle: string): boolean {
  if (!needle) return true;
  const hay = `${entry.name} ${entry.label} ${entry.job ?? ""}`.toLowerCase();
  return hay.includes(needle.toLowerCase());
}

/**
 * Every garment that is valid on one body.
 *
 * A garment folder holds one sprite per job and gender with a shared sprite at
 * the top level as a fallback, so "the cape for this character" is a lookup
 * against the *body's* job and gender rather than a free choice — pick the
 * wrong one and the cape animates on a different skeleton from the person
 * wearing it. This is `/api/equipment`'s own resolution, reused rather than
 * restated, which is what stops the two answers drifting.
 */
async function garmentsForJob(job: string, gender: string): Promise<PartEntry[]> {
  const folders = await fs
    .readdir(resolveId(encodeId(Buffer.from("로브"))), {
      encoding: "buffer" as never,
      withFileTypes: true,
    })
    .catch(() => []);

  const found = await Promise.all(
    (folders as unknown as { name: Buffer; isDirectory(): boolean }[]).map(async (folder) => {
      if (!folder.isDirectory()) return null;
      const name = displayName(folder.name);
      const perJob = await listParts(`로브/${name}/${gender}`, "garment");
      const match = perJob.find((p) => p.name.toLowerCase() === `${job}_${gender}`.toLowerCase());
      if (match) return { ...match, name, label: label(name, "garment") };
      const shared = await listParts(`로브/${name}`, "garment");
      const fallback = shared.find((p) => p.name.toLowerCase() === name.toLowerCase());
      return fallback ? { ...fallback, name, label: label(name, "garment") } : null;
    }),
  );

  return found.filter((entry): entry is PartEntry => entry !== null);
}

export function registerExportRoutes(app: Express): void {
  /**
   * What can be exported, and everything needed to ask for it.
   *
   * `kind` narrows, `q` searches the sprite's own name, its English label and
   * its job. `body` is the one that matters for anything worn: given a body's
   * name it answers the weapons, shields and garments that are valid *on that
   * body*, resolved through the same job and gender rules the picker uses — so
   * a caller never has to know that a cape lives under `로브/<name>/<gender>`
   * and is chosen by the wearer's job.
   */
  app.get("/api/catalog", async (req: Request, res: Response) => {
    try {
      const kind = asString(req.query.kind);
      const needle = asString(req.query.q);
      const bodyName = asString(req.query.body);
      const raceKey = (asString(req.query.race) || "human") as keyof typeof RACES;
      const genderKey = (asString(req.query.gender) || "male") as keyof typeof GENDERS;
      const race = RACES[raceKey] ?? RACES.human;
      const gender = GENDERS[genderKey] ?? GENDERS.male;
      /**
       * The race as the **key**, not `RACES.label`.
       *
       * Anything downstream that cares compares it with `!==` - the dashboard's
       * wardrobe refuses a part "drawn for" another race that way - so the
       * casing is load-bearing: a body filed as `Human` matches none of the
       * hundred and forty-seven heads filed as `human`, and the figure is
       * offered nothing to wear. `label` is for reading, and nothing reads it.
       */
      const raceLabel = raceKey in RACES ? raceKey : "human";

      const entries: CatalogEntry[] = [];
      const wants = (name: string) => !kind || kind === name;

      if (wants("monster")) {
        for (const part of await listParts("몬스터", "monster")) {
          entries.push({ kind: "monster", ...part });
        }
      }

      if (wants("pet")) {
        for (const part of await listPetsCached()) {
          entries.push({ kind: "pet", name: part.name, label: part.label, sprId: part.sprId, actId: part.actId });
        }
      }

      if (wants("body")) {
        for (const part of await listParts(`${race.root}/몸통/${gender}`, "body")) {
          entries.push({
            kind: "body",
            ...part,
            race: raceLabel,
            gender: genderKey,
            // **The job, not the sprite's file name.** `기사_남` is a file;
            // `기사` is the job whose weapon, shield and garment folders that
            // body wears, and it is what everything downstream matches on - a
            // body filed under `룬나이트_남` matches no weapon, because every
            // weapon in that job is filed under `룬나이트`. `foldersForJob`
            // is the same resolver the weapon lookup uses, so the two answers
            // cannot disagree.
            job: foldersForJob(part.name).job,
          });
        }
      }

      if (wants("head")) {
        for (const part of await listParts(`${race.root}/머리통/${gender}`, "head")) {
          entries.push({ kind: "head", ...part, race: raceLabel, gender: genderKey });
        }
      }

      if (wants("headgear")) {
        for (const part of await listParts(`악세사리/${gender}${race.headgearSuffix}`, "headgear")) {
          entries.push({ kind: "headgear", ...part, race: raceLabel, gender: genderKey });
        }
      }

      // Anything worn hangs off a body, so it is only offered when one is named
      // — a weapon list with no wearer is a list of sprites that may or may not
      // animate on the character somebody has in mind.
      if (bodyName && (wants("weapon") || wants("shield") || wants("garment"))) {
        const { job, weapons } = await weaponsForBody(race.root, gender, bodyName, new Map());

        if (wants("weapon")) {
          for (const part of weapons) {
            entries.push({ kind: "weapon", ...part, race: raceLabel, gender: genderKey, job });
          }
        }

        if (wants("shield")) {
          const prefix = `${job}_${gender}`.toLowerCase();
          const shields = (await listParts(`방패/${job}`, "shield")).filter((p) =>
            p.name.toLowerCase().startsWith(prefix),
          );
          for (const part of shields) {
            entries.push({ kind: "shield", ...part, race: raceLabel, gender: genderKey, job });
          }
        }

        if (wants("garment")) {
          for (const part of await garmentsForJob(job, gender)) {
            entries.push({ kind: "garment", ...part, race: raceLabel, gender: genderKey, job });
          }
        }
      }

      const filtered = entries.filter((entry) => matches(entry, needle));
      res.json({ count: filtered.length, entries: filtered });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * Renders sheets for everything named, and answers them with their manifest
   * rows.
   *
   * The body is `{ parts: [ … ] }`, each entry a catalogue row — which is what
   * makes the two routes a pipeline rather than two lookups: whatever
   * `/api/catalog` handed over can be posted straight back.
   *
   * Per-sprite settings come from the checked-in table rather than the request,
   * deliberately. A caller *may* override the attack pose inline for a one-off
   * experiment, and the answer says which was used either way, so an export is
   * always self-describing — but the reproducible path is the table, because a
   * setting that only exists in somebody's command is a setting the next export
   * will get wrong.
   *
   * The sheets come back base64 in JSON. It is not the tightest encoding
   * available and it does not need to be: this runs on localhost against a few
   * hundred KB, and a format anything can read without a library is worth more
   * here than a third of the bytes.
   */
  app.post("/api/export", async (req: Request, res: Response) => {
    const body = req.body as {
      parts?: Array<Partial<CatalogEntry> & { attack?: string }>;
      /** Re-read the overrides table first, for an edit made mid-session. */
      reload?: boolean;
    };

    // **Before the parts check**, so the table can be reloaded on its own: an
    // edit to `sprite-overrides.json` is exactly the moment somebody wants to
    // re-read it, and making that require a render meant the reload silently
    // did not happen on the request that asked for it.
    if (body?.reload) reloadOverrides();

    const parts = Array.isArray(body?.parts) ? body.parts : [];
    if (parts.length === 0) {
      return res.json({ rendered: 0, failed: 0, parts: [], sheets: [], failures: [] });
    }

    const overrides = await loadOverrides();

    // The harness runs on this server's own origin, so it has to be told what
    // that is rather than assuming a port.
    const origin = `${req.protocol}://${req.get("host")}`;

    /**
     * **The run's poses, taken from the body in it.**
     *
     * An override belongs to a *run*, not to a sprite. RO gives a job three
     * attack animations and the job picks one; everything worn on that job has
     * to swing the same one, or a cape animates its own pose under the body's
     * name and the two drift apart frame by frame — which is exactly what
     * happened: a summoner's `skill` is attack 3 with eight frames while its
     * cape's was the real skill pose with six, the last two of them blank, so
     * the wings hung wrong and then vanished halfway through the cast.
     *
     * The Batch tab has always worked this way; making the headless route
     * per-sprite is what lost it. One body per run is the shape both take, so
     * the body's row governs and anything without one falls back to its own.
     */
    const anchors = parts.filter((part) => asString(part.kind) === "body");
    let runOverride: Awaited<ReturnType<typeof overrideFor>> | null = null;
    if (anchors.length === 1) {
      const anchor = anchors[0];
      runOverride = overrideFor(
        overrides,
        "body",
        asString(anchor.name),
        await partKey("body", asString(anchor.sprId)),
      );
    }

    const sheets: Array<{ path: string; base64: string; bytes: number }> = [];
    const metas: unknown[] = [];
    const failures: Array<{ name: string; error: string }> = [];

    for (const part of parts) {
      const kind = asString(part.kind);
      const name = asString(part.name);
      const sprId = asString(part.sprId);
      const actId = asString(part.actId);

      if (!kind || !sprId || !actId) {
        failures.push({ name: name || "(unnamed)", error: "kind, sprId and actId are required" });
        continue;
      }

      try {
        // By key first: the table is keyed on the manifest key because that is
        // what identifies a *sprite* rather than a name several sprites share.
        // It is computed here rather than inside the renderer so the settings
        // are chosen before anything is drawn with them.
        const key = await partKey(kind, sprId);
        // The run's poses where there is a body to take them from; the sprite's
        // own otherwise, which is what a refresh of the whole library wants.
        const table = runOverride
          ? { ...runOverride }
          : overrideFor(overrides, kind, name, key);
        // An inline attack pose is honoured but never remembered. See above.
        if (part.attack && (ATTACK_VARIANTS as readonly string[]).includes(part.attack)) {
          table.attack = part.attack as AttackVariant;
        }

        const { specs, direction, headDirection } = specsFor(kind, table);

        const request: SheetRequest = {
          kind: kind as SheetRequest["kind"],
          name,
          sprId,
          actId,
          specs,
          direction,
          headDirection,
          race: part.race,
          gender: part.gender,
          job: part.job,
        };

        // Drawn by Chromium, not by Node: see `browser-sheets.ts` for why the
        // Skia path could not be the one that ships.
        const rendered = await renderSheetInBrowser(origin, request);
        sheets.push({
          path: rendered.meta.image,
          base64: rendered.image.toString("base64"),
          bytes: rendered.image.length,
        });
        metas.push(rendered.meta);
      } catch (err) {
        // One bad sprite must not lose the rest of a batch: a run of three
        // hundred that threw on the first would be three hundred re-renders to
        // get back to where it was.
        failures.push({ name: name || sprId, error: (err as Error).message });
      }
    }

    res.json({ rendered: metas.length, failed: failures.length, parts: metas, sheets, failures });
  });
}
