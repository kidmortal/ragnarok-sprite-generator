import { useEffect, useMemo, useState } from "react";
import { fetchFile, fetchPets, type PetEntry } from "../api";
import { parseSpr } from "../lib/spr";
import { parseAct } from "../lib/act";
import { Z_INDEX, actionsForAct, type ComposeOptions, type Part } from "../lib/compose";
import { PartPicker } from "./PartPicker";
import { Stage } from "./Stage";

/**
 * Pets are monster sprites that a player can tame, so this is the monster tab
 * with the two things that make a pet a pet:
 *
 * - the accessory toggle, which swaps in the act of the pet wearing its
 *   equipment -- same sprite, different animation;
 * - the pet-only action groups past `dead`, which `actionsForAct` derives from
 *   whichever act is loaded.
 */
export function PetTab() {
  const [pets, setPets] = useState<PetEntry[]>([]);
  const [selected, setSelected] = useState<PetEntry | null>(null);
  const [wearing, setWearing] = useState(false);
  const [parts, setParts] = useState<Part[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<ComposeOptions>({
    actionBase: 0,
    direction: 0,
    headDirection: 0,
  });

  useEffect(() => {
    let cancelled = false;
    fetchPets()
      .then((list) => {
        if (cancelled) return;
        setPets(list);
        setSelected(list[0] ?? null);
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const accessory = selected?.accessory ?? null;
  // A pet without an accessory sprite keeps the toggle off rather than asking
  // for an act that is not there.
  const dressed = wearing && accessory !== null;
  const source = dressed ? accessory! : selected;

  useEffect(() => {
    if (!source) {
      setParts([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([fetchFile(source.sprId), fetchFile(source.actId)])
      .then(([sprBuf, actBuf]) => {
        if (cancelled) return;
        setParts([
          { kind: "body", zIndex: Z_INDEX.body, spr: parseSpr(sprBuf), act: parseAct(actBuf) },
        ]);
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
  }, [source?.sprId, source?.actId]);

  const actions = useMemo(
    () => (parts[0] ? actionsForAct(parts[0].act) : []),
    [parts]
  );

  // Two pets rarely have the same number of action groups, so a pose that does
  // not exist on the new pet falls back to stand rather than rendering nothing.
  useEffect(() => {
    if (actions.length && !actions.some((action) => action.base === options.actionBase)) {
      setOptions((prev) => ({ ...prev, actionBase: 0 }));
    }
  }, [actions, options.actionBase]);

  const exportName = selected ? (dressed ? `${selected.name}_${accessory!.name}` : selected.name) : "pet";
  const exportMeta = useMemo(
    () => ({ pet: selected?.name ?? null, accessory: dressed ? accessory!.name : null }),
    [selected, dressed, accessory]
  );

  return (
    <div className="generator">
      <aside className="panel one-column monster-panel">
        <PartPicker label="Pet" entries={pets} value={selected} onChange={(entry) => setSelected(entry as PetEntry | null)} />
        <label className="check" title={accessory ? accessory.name : "This pet has no accessory sprite"}>
          <input
            type="checkbox"
            checked={dressed}
            disabled={!accessory}
            onChange={(event) => setWearing(event.target.checked)}
          />
          <span>Wearing accessory{accessory ? ` (${accessory.name})` : ""}</span>
        </label>
      </aside>

      <Stage
        parts={parts}
        actions={actions}
        options={options}
        onChange={(patch) => setOptions((prev) => ({ ...prev, ...patch }))}
        exportName={exportName}
        exportMeta={exportMeta}
        loading={loading}
        error={error}
      />
    </div>
  );
}
