import { useEffect, useMemo, useState } from "react";
import {
  fetchEquipment,
  fetchFile,
  fetchParts,
  type Equipment,
  type PartEntry,
  type PartsCatalog,
} from "../api";
import { parseSpr } from "../lib/spr";
import { parseAct } from "../lib/act";
import {
  PLAYER_ACTIONS,
  Z_INDEX,
  type ComposeOptions,
  type Part,
  type PartKind,
} from "../lib/compose";
import { PartPicker } from "./PartPicker";
import { Stage } from "./Stage";

const HEADGEAR_SLOTS = [0, 1, 2];

/** Load a .spr/.act pair into a composable part. */
async function loadPart(entry: PartEntry, kind: PartKind, zIndex: number): Promise<Part> {
  const [sprBuf, actBuf] = await Promise.all([fetchFile(entry.sprId), fetchFile(entry.actId)]);
  return { kind, zIndex, spr: parseSpr(sprBuf), act: parseAct(actBuf) };
}

export function Generator() {
  const [race, setRace] = useState("human");
  const [gender, setGender] = useState("male");
  const [catalog, setCatalog] = useState<PartsCatalog | null>(null);

  const [body, setBody] = useState<PartEntry | null>(null);
  const [head, setHead] = useState<PartEntry | null>(null);
  const [headgears, setHeadgears] = useState<(PartEntry | null)[]>([null, null, null]);
  const [equipment, setEquipment] = useState<Equipment | null>(null);
  const [weapon, setWeapon] = useState<PartEntry | null>(null);
  const [shield, setShield] = useState<PartEntry | null>(null);
  const [garment, setGarment] = useState<PartEntry | null>(null);

  const [options, setOptions] = useState<ComposeOptions>({
    actionBase: 8,
    direction: 0,
    headDirection: 0,
  });

  const [parts, setParts] = useState<Part[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchParts(race, gender)
      .then((data) => {
        if (cancelled) return;
        setCatalog(data);
        // Default to a plain body/head so the preview is never empty.
        setBody(data.bodies.find((b) => /초보자|novice/i.test(b.name)) ?? data.bodies[0] ?? null);
        setHead(data.heads[0] ?? null);
        setHeadgears([null, null, null]);
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [race, gender]);

  // Equipment is job-specific, so it reloads with the body.
  useEffect(() => {
    setWeapon(null);
    setShield(null);
    setGarment(null);
    if (!body) {
      setEquipment(null);
      return;
    }
    let cancelled = false;
    fetchEquipment(race, gender, body.name)
      .then((data) => !cancelled && setEquipment(data))
      .catch(() => !cancelled && setEquipment(null));
    return () => {
      cancelled = true;
    };
  }, [body, race, gender]);

  // Reload sprite data whenever the selected parts change.
  useEffect(() => {
    let cancelled = false;
    const selected: { entry: PartEntry; kind: PartKind; zIndex: number }[] = [];
    if (garment) selected.push({ entry: garment, kind: "garment", zIndex: Z_INDEX.garment });
    if (body) selected.push({ entry: body, kind: "body", zIndex: Z_INDEX.body });
    if (head) selected.push({ entry: head, kind: "head", zIndex: Z_INDEX.head });
    if (weapon) selected.push({ entry: weapon, kind: "weapon", zIndex: Z_INDEX.weapon });
    if (shield) selected.push({ entry: shield, kind: "shield", zIndex: Z_INDEX.shield });
    headgears.forEach((entry, slot) => {
      if (entry) selected.push({ entry, kind: "headgear", zIndex: Z_INDEX.headgear + slot });
    });

    if (selected.length === 0) {
      setParts([]);
      return;
    }

    setLoading(true);
    setError(null);
    Promise.all(selected.map((s) => loadPart(s.entry, s.kind, s.zIndex)))
      .then((loaded) => {
        if (cancelled) return;
        setParts(loaded);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [body, head, headgears, weapon, shield, garment]);

  const exportName = [body?.name, head?.name, weapon?.name, shield?.name, garment?.name]
    .filter(Boolean)
    .join("_");

  const exportMeta = useMemo(
    () => ({
      parts: {
        body: body?.name ?? null,
        head: head?.name ?? null,
        weapon: weapon?.name ?? null,
        shield: shield?.name ?? null,
        garment: garment?.name ?? null,
        headgears: headgears.map((h) => h?.name ?? null),
      },
    }),
    [body, head, weapon, shield, garment, headgears]
  );

  const setHeadgear = (slot: number, entry: PartEntry | null) =>
    setHeadgears((prev) => prev.map((item, i) => (i === slot ? entry : item)));

  return (
    <div className="generator">
      <aside className="panel">
        <div className="row">
          <label>
            Race
            <select value={race} onChange={(e) => setRace(e.target.value)}>
              <option value="human">Human</option>
              <option value="doram">Doram</option>
            </select>
          </label>
          <label>
            Gender
            <select value={gender} onChange={(e) => setGender(e.target.value)}>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </label>
        </div>

        {catalog && (
          <>
            <PartPicker label="Body" entries={catalog.bodies} value={body} onChange={setBody} />
            <PartPicker label="Head" entries={catalog.heads} value={head} onChange={setHead} />
            {equipment && (
              <>
                <PartPicker
                  label="Weapon"
                  entries={equipment.weapons}
                  value={weapon}
                  onChange={setWeapon}
                  optional
                />
                <PartPicker
                  label="Shield"
                  entries={equipment.shields}
                  value={shield}
                  onChange={setShield}
                  optional
                />
                <PartPicker
                  label="Garment"
                  entries={equipment.garments}
                  value={garment}
                  onChange={setGarment}
                  optional
                />
              </>
            )}
            {HEADGEAR_SLOTS.map((slot) => (
              <PartPicker
                key={slot}
                label={`Accessory ${slot + 1}`}
                entries={catalog.headgears}
                value={headgears[slot]}
                onChange={(entry) => setHeadgear(slot, entry)}
                optional
              />
            ))}
          </>
        )}
      </aside>

      <Stage
        parts={parts}
        actions={PLAYER_ACTIONS}
        options={options}
        onChange={(patch) => setOptions((prev) => ({ ...prev, ...patch }))}
        showHeadDirection
        exportName={exportName || "character"}
        exportMeta={exportMeta}
        loading={loading}
        error={error}
      />
    </div>
  );
}
