import { useEffect, useMemo, useState } from "react";
import {
  fetchEquipment,
  fetchMonsters,
  fetchParts,
  type Equipment,
  type PartEntry,
  type PartsCatalog,
} from "../api";
import { download } from "../lib/apng";
import {
  buildManifest,
  exportPart,
  manifestKeys,
  partKey,
  type ExportOptions,
  type Manifest,
  type PartMeta,
} from "../lib/partExport";
import {
  MONSTER_SHEET_ACTIONS,
  PLAYER_SHEET_ACTIONS,
  type SheetActionSpec,
} from "../lib/partSheet";
import { DIRECTIONS, HEAD_DIRECTIONS, type PartKind } from "../lib/compose";
import { loadPartThumb, type Thumb } from "../lib/thumbs";
import { useInView } from "../lib/useInView";
import { ZipBuilder } from "../lib/zip";

/** Kinds that hang off the chosen body, in the order they are offered. */
const ATTACHABLE = [
  { id: "head", label: "Heads" },
  { id: "headgear", label: "Headgears" },
  { id: "weapon", label: "Weapons" },
  { id: "shield", label: "Shields" },
  { id: "garment", label: "Garments" },
] as const;

type AttachKind = (typeof ATTACHABLE)[number]["id"];

/**
 * Actions worth having by default. Sit, pick up and the alternate attacks are
 * left out because they multiply the archive for poses most games never play --
 * dropping actions is the cheapest size lever there is.
 */
const DEFAULT_ACTIONS = ["stand", "idle", "walk", "hurt", "dead", "skill"];

/**
 * RO gives a job three attack animations and each job really uses only one of
 * them; which one is a property of the job, not of the sprite. Exactly one is
 * always exported, under the name `attack`, for the body *and* for every weapon
 * in the same run -- that is what keeps the weapon on the hand, since a body
 * swinging `attack 2` against a weapon animated on `attack` drifts apart frame
 * by frame. They are picked from a select rather than the checkbox list for the
 * same reason: exporting two of them is never the right answer.
 */
const ATTACK_VARIANTS = ["attack", "attack2", "attack3"] as const;

/**
 * What a monster is exported with by default.
 *
 * A monster is a standalone sprite that wears nothing and walks nowhere on our
 * battlefield: it stands, it swings, it flinches and it dies. `move` is offered
 * because the sprite has it, but nothing in the game plays it yet, and an
 * action nobody plays is pure archive weight.
 */
const DEFAULT_MONSTER_ACTIONS = ["stand", "attack", "hurt", "dead"];

/**
 * Monsters face **south-west** unless told otherwise, while players are
 * exported facing south.
 *
 * They are not the same choice and must not share one control: the party
 * stands on the left of the battlefield facing right, so a monster on the right
 * reads as facing them only at three-quarters. South is what a player wants -
 * a character screen looks at you - and south-west is what an opponent wants.
 */
const MONSTER_DIRECTION = 1;

const isAttack = (slug: string): boolean =>
  (ATTACK_VARIANTS as readonly string[]).includes(slug);

/** The actions offered as checkboxes: everything the select does not own. */
const CHECKBOX_ACTIONS = PLAYER_SHEET_ACTIONS.filter((spec) => !isAttack(spec.slug));

const MAX_PARALLEL = 4;

/** Preview size in the selection grids. */
const TILE = 48;

/** Runs `worker` over every item, with at most `limit` in flight. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

type Job = {
  entry: PartEntry;
  kind: PartMeta["kind"];
  job?: string;
  race?: string;
  gender?: string;
};

type Progress = { done: number; total: number; label: string };

const emptySelection = (): Record<AttachKind, Set<string>> => ({
  head: new Set(),
  headgear: new Set(),
  weapon: new Set(),
  shield: new Set(),
  garment: new Set(),
});

/**
 * Batch export, built around one body.
 *
 * A weapon, shield or garment is only valid on a body of the same job, so the
 * body is the thing that decides what else can be exported -- picking it first
 * is what lets every other grid show *only* art that actually fits. Bodies emit
 * a per-frame anchor table and heads render around their own attach point, so
 * one export per body plus one per head is all a runtime builder needs.
 *
 * The export is incremental: load a previous `manifest.json` and the archive
 * skips everything already in it and ships a merged manifest, so a library can
 * be grown one body at a time.
 */
export function ExportTab() {
  const [race, setRace] = useState("human");
  const [gender, setGender] = useState("male");
  const [catalog, setCatalog] = useState<PartsCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [body, setBody] = useState<PartEntry | null>(null);
  const [equipment, setEquipment] = useState<Equipment | null>(null);
  const [loadingGear, setLoadingGear] = useState(false);
  const [picked, setPicked] = useState<Record<AttachKind, Set<string>>>(emptySelection);

  const [monsters, setMonsters] = useState<PartEntry[] | null>(null);
  const [pickedMonsters, setPickedMonsters] = useState<Set<string>>(new Set());
  const [monsterActions, setMonsterActions] = useState<string[]>(DEFAULT_MONSTER_ACTIONS);
  const [monsterDirection, setMonsterDirection] = useState(MONSTER_DIRECTION);

  const [actions, setActions] = useState<string[]>(DEFAULT_ACTIONS);
  const [attackVariant, setAttackVariant] = useState<string>("attack");
  const [direction, setDirection] = useState(0);
  const [headDirection, setHeadDirection] = useState(0);

  const [base, setBase] = useState<Manifest | null>(null);
  const [baseName, setBaseName] = useState<string | null>(null);
  const [skipExisting, setSkipExisting] = useState(true);

  const [progress, setProgress] = useState<Progress | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [failures, setFailures] = useState<string[]>([]);

  const specs = useMemo<SheetActionSpec[]>(() => {
    const chosen = PLAYER_SHEET_ACTIONS.find((spec) => spec.slug === attackVariant);
    return PLAYER_SHEET_ACTIONS.flatMap((spec) => {
      // Whichever variant is chosen ships under the plain `attack` name, in the
      // slot the base attack would have taken.
      if (spec.slug === "attack") return chosen ? [{ slug: "attack", base: chosen.base }] : [];
      if (isAttack(spec.slug)) return [];
      return actions.includes(spec.slug) ? [spec] : [];
    });
  }, [actions, attackVariant]);

  const monsterSpecs = useMemo<SheetActionSpec[]>(
    () => MONSTER_SHEET_ACTIONS.filter((spec) => monsterActions.includes(spec.slug)),
    [monsterActions]
  );

  // Bodies, heads and headgears are all race/gender-scoped, so they reload
  // together and any selection made against the old catalogue is dropped.
  useEffect(() => {
    let cancelled = false;
    setCatalog(null);
    setCatalogError(null);
    setBody(null);
    setPicked(emptySelection());
    fetchParts(race, gender)
      .then((data) => !cancelled && setCatalog(data))
      .catch((err) => !cancelled && setCatalogError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [race, gender]);

  // Equipment is job-specific, and the job comes from the body.
  useEffect(() => {
    setPicked((prev) => ({ ...prev, weapon: new Set(), shield: new Set(), garment: new Set() }));
    if (!body) {
      setEquipment(null);
      return;
    }
    let cancelled = false;
    setLoadingGear(true);
    fetchEquipment(race, gender, body.name)
      .then((data) => !cancelled && setEquipment(data))
      .catch(() => !cancelled && setEquipment(null))
      .finally(() => !cancelled && setLoadingGear(false));
    return () => {
      cancelled = true;
    };
  }, [body, race, gender]);

  const entriesFor = (kind: AttachKind): PartEntry[] => {
    switch (kind) {
      case "head":
        return catalog?.heads ?? [];
      case "headgear":
        return catalog?.headgears ?? [];
      case "weapon":
        return equipment?.weapons ?? [];
      case "shield":
        return equipment?.shields ?? [];
      case "garment":
        return equipment?.garments ?? [];
    }
  };

  const toggleKind = (kind: AttachKind, sprId: string) =>
    setPicked((prev) => {
      const next = new Set(prev[kind]);
      if (next.has(sprId)) next.delete(sprId);
      else next.add(sprId);
      return { ...prev, [kind]: next };
    });

  const setKindAll = (kind: AttachKind, ids: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev[kind]);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return { ...prev, [kind]: next };
    });

  async function loadMonsters() {
    if (monsters) return;
    try {
      setMonsters(await fetchMonsters());
    } catch (err) {
      setStatus(`Could not list monsters: ${(err as Error).message}`);
      setMonsters([]);
    }
  }

  /** Everything currently ticked, as render jobs. The body always comes along. */
  const jobs = useMemo<Job[]>(() => {
    const list: Job[] = [];
    const scope = { race, gender };

    if (body) {
      list.push({ entry: body, kind: "body", ...scope, job: equipment?.job });
      for (const { id } of ATTACHABLE) {
        const jobScoped = id === "weapon" || id === "shield" || id === "garment";
        for (const entry of entriesFor(id)) {
          if (!picked[id].has(entry.sprId)) continue;
          list.push({
            entry,
            kind: id as PartKind,
            ...scope,
            ...(jobScoped ? { job: equipment?.job } : {}),
          });
        }
      }
    }

    for (const entry of monsters ?? []) {
      if (pickedMonsters.has(entry.sprId)) list.push({ entry, kind: "monster" });
    }

    return list;
  }, [body, equipment, picked, catalog, monsters, pickedMonsters, race, gender]);

  async function loadBaseManifest(file: File) {
    try {
      const parsed = JSON.parse(await file.text()) as Manifest;
      if (!parsed || typeof parsed !== "object" || !parsed.parts) {
        throw new Error("not a manifest");
      }
      setBase(parsed);
      setBaseName(file.name);
      setStatus(`Merging into ${manifestKeys(parsed).size} existing parts.`);
    } catch (err) {
      setBase(null);
      setBaseName(null);
      setStatus(`Could not read manifest: ${(err as Error).message}`);
    }
  }

  async function run() {
    setFailures([]);
    setStatus(null);
    setProgress({ done: 0, total: 0, label: "Preparing…" });

    try {
      const known = skipExisting ? manifestKeys(base) : new Set<string>();

      // Keys are a pure function of kind + source file, so a part already in
      // the loaded manifest is byte-for-byte the same export.
      const keyed = await Promise.all(
        jobs.map(async (job) => ({ job, key: await partKey(job.kind, job.entry.sprId) }))
      );
      const pending = keyed.filter(({ key }) => !known.has(key)).map(({ job }) => job);
      const alreadyHave = keyed.length - pending.length;

      if (pending.length === 0) {
        setProgress(null);
        setStatus(
          alreadyHave > 0
            ? `Nothing new to export — all ${alreadyHave} selected parts are already in the manifest.`
            : "Nothing selected to export."
        );
        return;
      }

      const anyMonsters = pending.some((job) => job.kind === "monster");
      const anyPlayerParts = pending.some((job) => job.kind !== "monster");

      const zip = new ZipBuilder();
      const manifestEntries: PartMeta[] = [];
      const failed: string[] = [];
      let done = 0;

      setProgress({ done: 0, total: pending.length, label: "Rendering…" });

      await mapWithConcurrency(pending, MAX_PARALLEL, async (job) => {
        try {
          // A monster is exported on its own terms: its own action list, and
          // its own facing. Sharing the player's controls would point every
          // opponent at the camera and ship it with a walk cycle nothing plays.
          const monster = job.kind === "monster";
          const options: ExportOptions = {
            kind: job.kind,
            specs: monster ? monsterSpecs : specs,
            direction: monster ? monsterDirection : direction,
            headDirection,
            ...(job.race ? { race: job.race } : {}),
            ...(job.gender ? { gender: job.gender } : {}),
            ...(job.job ? { job: job.job } : {}),
          };
          const result = await exportPart(job.entry, options);
          await zip.add(result.meta.image, result.image);
          manifestEntries.push(result.meta);
        } catch (err) {
          // One unreadable sprite must not sink a long export.
          failed.push(`${job.kind}/${job.entry.name}: ${(err as Error).message}`);
        }
        done++;
        setProgress({ done, total: pending.length, label: job.entry.name });
      });

      await zip.add(
        "manifest.json",
        JSON.stringify(
          buildManifest(
            manifestEntries,
            // Both lists: the manifest's `actions` is what the archive
            // contains, and a monsters-only run contains monster actions.
            [...(anyPlayerParts ? specs : []), ...(anyMonsters ? monsterSpecs : [])],
            direction,
            headDirection,
            base
          ),
          null,
          2
        )
      );

      const blob = zip.build();
      const stem = anyPlayerParts
        ? `ro-${equipment?.job ?? body?.name ?? "parts"}`
        : "ro-monsters";
      const facing = DIRECTIONS[anyPlayerParts ? direction : monsterDirection];
      download(blob, `${stem}-${facing.toLowerCase()}.zip`);

      setProgress(null);
      setFailures(failed);
      setStatus(
        `Exported ${manifestEntries.length} parts · ${(blob.size / 1024 / 1024).toFixed(1)}MB` +
          (alreadyHave ? ` · ${alreadyHave} already in manifest` : "") +
          (failed.length ? ` · ${failed.length} skipped` : "")
      );
    } catch (err) {
      setProgress(null);
      setStatus(`Export failed: ${(err as Error).message}`);
    }
  }

  const busy = progress !== null;

  // Each half of a run needs its own actions ticked, and only the half that is
  // actually being exported: a monsters-only run is not held up by the player
  // action list being empty.
  const hasActions = jobs.every((job) =>
    job.kind === "monster" ? monsterSpecs.length > 0 : specs.length > 0
  );

  return (
    <div className="export-tab">
      <section className="panel one-column">
        <div className="row">
          <label>
            Race
            <select value={race} disabled={busy} onChange={(e) => setRace(e.target.value)}>
              <option value="human">Human</option>
              <option value="doram">Doram</option>
            </select>
          </label>
          <label>
            Gender
            <select value={gender} disabled={busy} onChange={(e) => setGender(e.target.value)}>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </label>
          {body && <span className="meta">Job: {equipment?.job ?? "—"}</span>}
        </div>

        {catalogError && <p className="error-banner">Could not list parts: {catalogError}</p>}

        <SelectGrid
          label="Body"
          hint="Pick one — everything below is what fits it."
          entries={catalog?.bodies ?? []}
          isOn={(entry) => body?.sprId === entry.sprId}
          onToggle={(entry) => setBody((prev) => (prev?.sprId === entry.sprId ? null : entry))}
          disabled={busy}
          empty={catalog ? "No bodies for this race and gender." : "Loading…"}
        />

        {body ? (
          ATTACHABLE.map(({ id, label }) => {
            const entries = entriesFor(id);
            return (
              <SelectGrid
                key={id}
                label={label}
                count={picked[id].size}
                entries={entries}
                isOn={(entry) => picked[id].has(entry.sprId)}
                onToggle={(entry) => toggleKind(id, entry.sprId)}
                onBulk={(ids, on) => setKindAll(id, ids, on)}
                disabled={busy}
                empty={
                  loadingGear && entries.length === 0
                    ? "Loading…"
                    : `No ${label.toLowerCase()} for this body's job.`
                }
                collapsible
              />
            );
          })
        ) : (
          <p className="meta">Choose a body to see the heads and gear that attach to it.</p>
        )}

        <details onToggle={(e) => e.currentTarget.open && void loadMonsters()}>
          <summary className="section-summary">
            Monsters {pickedMonsters.size > 0 && <em>{pickedMonsters.size} selected</em>}
          </summary>
          <SelectGrid
            label="Monsters"
            entries={monsters ?? []}
            count={pickedMonsters.size}
            isOn={(entry) => pickedMonsters.has(entry.sprId)}
            onToggle={(entry) =>
              setPickedMonsters((prev) => {
                const next = new Set(prev);
                if (next.has(entry.sprId)) next.delete(entry.sprId);
                else next.add(entry.sprId);
                return next;
              })
            }
            onBulk={(ids, on) =>
              setPickedMonsters((prev) => {
                const next = new Set(prev);
                for (const id of ids) {
                  if (on) next.add(id);
                  else next.delete(id);
                }
                return next;
              })
            }
            disabled={busy}
            empty={monsters ? "No monsters found." : "Loading…"}
            hint="Standalone sprites — not tied to the body above."
          />

          <div className="row">
            <fieldset className="picker">
              <legend>Monster actions</legend>
              <div className="action-grid">
                {MONSTER_SHEET_ACTIONS.map((spec) => (
                  <label key={spec.slug} className="check">
                    <input
                      type="checkbox"
                      checked={monsterActions.includes(spec.slug)}
                      disabled={busy}
                      onChange={() =>
                        setMonsterActions((prev) =>
                          prev.includes(spec.slug)
                            ? prev.filter((slug) => slug !== spec.slug)
                            : [...prev, spec.slug]
                        )
                      }
                    />
                    {spec.slug}
                  </label>
                ))}
              </div>
              <p className="meta">
                A monster wears nothing and walks nowhere in a turn-based fight, so the four
                default poses are the whole of what it needs: <code>stand</code>,{" "}
                <code>attack</code>, <code>hurt</code> and <code>dead</code>.
              </p>
            </fieldset>

            <fieldset className="picker">
              <legend>Monster facing</legend>
              <label>
                Facing
                <select
                  value={monsterDirection}
                  disabled={busy}
                  onChange={(e) => setMonsterDirection(Number(e.target.value))}
                >
                  {DIRECTIONS.map((name, i) => (
                    <option key={name} value={i}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="meta">
                Separate from the body facing above. South-west is the default because an
                opponent faces the party across the field, where a player is exported facing the
                camera.
              </p>
            </fieldset>
          </div>
        </details>

        <div className="row">
          <fieldset className="picker">
            <legend>Actions</legend>
            <div className="action-grid">
              {CHECKBOX_ACTIONS.map((spec) => (
                <label key={spec.slug} className="check">
                  <input
                    type="checkbox"
                    checked={actions.includes(spec.slug)}
                    disabled={busy}
                    onChange={() =>
                      setActions((prev) =>
                        prev.includes(spec.slug)
                          ? prev.filter((slug) => slug !== spec.slug)
                          : [...prev, spec.slug]
                      )
                    }
                  />
                  {spec.slug}
                </label>
              ))}
            </div>
            <label className="attack-pick">
              Attack pose
              <select
                value={attackVariant}
                disabled={busy}
                onChange={(e) => setAttackVariant(e.target.value)}
              >
                {ATTACK_VARIANTS.map((slug) => (
                  <option key={slug} value={slug}>
                    {slug}
                  </option>
                ))}
              </select>
            </label>
            <p className="meta">
              Always exported, as <code>attack</code>. Body and weapons share the pose, so they
              stay in sync — most jobs swing on <code>attack</code>, some on <code>attack2</code>{" "}
              or <code>attack3</code>.
            </p>
          </fieldset>

          <fieldset className="picker">
            <legend>Facing</legend>
            <label>
              Body
              <select
                value={direction}
                disabled={busy}
                onChange={(e) => setDirection(Number(e.target.value))}
              >
                {DIRECTIONS.map((name, i) => (
                  <option key={name} value={i}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Head
              <select
                value={headDirection}
                disabled={busy}
                onChange={(e) => setHeadDirection(Number(e.target.value))}
              >
                {HEAD_DIRECTIONS.map((name, i) => (
                  <option key={name} value={i}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>

          <fieldset className="picker">
            <legend>Add to an existing export</legend>
            <input
              type="file"
              accept="application/json,.json"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void loadBaseManifest(file);
              }}
            />
            {base && (
              <>
                <p className="meta">
                  <code>{baseName}</code> · {manifestKeys(base).size} parts{" "}
                  <button
                    className="linkish"
                    disabled={busy}
                    onClick={() => {
                      setBase(null);
                      setBaseName(null);
                    }}
                  >
                    clear
                  </button>
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={skipExisting}
                    disabled={busy}
                    onChange={() => setSkipExisting((on) => !on)}
                  />
                  Skip parts already in it
                </label>
              </>
            )}
          </fieldset>
        </div>

        <p className="meta">
          One sheet per part at native scale, plus a <code>manifest.json</code>. Bodies carry a
          per-frame anchor table; heads and headgears are rendered around their own attach point,
          so any head fits any body without re-exporting either. Drop the archive's folders into
          your asset directory and replace <code>manifest.json</code> with the merged one — export
          one body now and the next one later.
        </p>

        <div className="controls">
          <button onClick={run} disabled={busy || jobs.length === 0 || !hasActions}>
            {busy ? "Exporting…" : `Export ${jobs.length} part${jobs.length === 1 ? "" : "s"}`}
          </button>
        </div>

        {progress && (
          <>
            <div className="progress">
              <div
                className="progress-fill"
                style={{
                  width: progress.total ? `${(progress.done / progress.total) * 100}%` : "0%",
                }}
              />
            </div>
            <p className="meta">
              {progress.done}/{progress.total} · {progress.label}
            </p>
          </>
        )}

        {status && <p className="meta">{status}</p>}

        {failures.length > 0 && (
          <details className="failures">
            <summary>{failures.length} sprites skipped</summary>
            <ul>
              {failures.slice(0, 50).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}

type GridProps = {
  label: string;
  hint?: string;
  entries: PartEntry[];
  count?: number;
  isOn: (entry: PartEntry) => boolean;
  onToggle: (entry: PartEntry) => void;
  /** Absent for a single-select grid, where bulk actions make no sense. */
  onBulk?: (sprIds: string[], on: boolean) => void;
  disabled?: boolean;
  empty: string;
  collapsible?: boolean;
};

/** How many tiles to mount at once; the rest arrive as the grid is scrolled. */
const PAGE = 60;

/** A filterable grid of 48px previews, single- or multi-select. */
function SelectGrid({
  label,
  hint,
  entries,
  count,
  isOn,
  onToggle,
  onBulk,
  disabled,
  empty,
  collapsible,
}: GridProps) {
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState(!collapsible);
  const { ref: sentinelRef, inView: sentinelInView } = useInView<HTMLDivElement>("200px", false);

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? entries.filter((e) => e.name.toLowerCase().includes(needle)) : entries;
  }, [entries, filter]);

  useEffect(() => setShown(PAGE), [filter, entries]);
  useEffect(() => {
    if (sentinelInView) setShown((n) => n + PAGE);
  }, [sentinelInView, shown]);

  return (
    <section className="select-grid">
      <header>
        <button
          className="section-summary"
          onClick={() => collapsible && setOpen((on) => !on)}
          disabled={!collapsible}
        >
          {collapsible && <span className="caret">{open ? "▾" : "▸"}</span>}
          {label}
          <em>
            {count !== undefined && count > 0 ? `${count} of ` : ""}
            {entries.length}
          </em>
        </button>
        {open && entries.length > 0 && (
          <>
            <input
              className="filter"
              placeholder="Filter…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {onBulk && (
              <>
                <button
                  className="linkish"
                  disabled={disabled}
                  onClick={() => onBulk(matches.map((e) => e.sprId), true)}
                >
                  select {filter ? "matching" : "all"}
                </button>
                <button
                  className="linkish"
                  disabled={disabled}
                  onClick={() => onBulk(matches.map((e) => e.sprId), false)}
                >
                  clear
                </button>
              </>
            )}
          </>
        )}
      </header>

      {hint && open && <p className="meta">{hint}</p>}

      {open &&
        (entries.length === 0 ? (
          <p className="picker-empty">{empty}</p>
        ) : (
          <div className="tile-grid small">
            {matches.slice(0, shown).map((entry) => (
              <ExportTile
                key={entry.sprId}
                entry={entry}
                selected={isOn(entry)}
                disabled={disabled}
                onToggle={() => onToggle(entry)}
              />
            ))}
            {shown < matches.length && <div ref={sentinelRef} className="sentinel" />}
          </div>
        ))}
    </section>
  );
}

/** 48px preview tile; nothing is fetched until it scrolls into view. */
function ExportTile({
  entry,
  selected,
  disabled,
  onToggle,
}: {
  entry: PartEntry;
  selected: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const { ref, inView } = useInView<HTMLButtonElement>("150px");
  const [thumb, setThumb] = useState<Thumb | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!inView) return;
    let cancelled = false;
    loadPartThumb(entry.sprId, entry.actId, TILE)
      .then((result) => !cancelled && setThumb(result))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [inView, entry.sprId, entry.actId]);

  return (
    <button
      ref={ref}
      className={`tile${selected ? " on" : ""}`}
      onClick={onToggle}
      disabled={disabled}
      title={entry.name}
    >
      <div className="tile-preview">
        {thumb ? <img src={thumb.url} alt="" /> : failed ? <span className="error">!</span> : null}
      </div>
      <span className="tile-name">{entry.name}</span>
    </button>
  );
}
