import { useEffect, useMemo, useState } from "react";
import { PROP_SOURCES, fetchFile, fetchProps, type PartEntry, type PropSource } from "../api";
import { parseSpr } from "../lib/spr";
import { parseAct } from "../lib/act";
import { Z_INDEX, actionsForAct, facingCount, type ComposeOptions, type Part } from "../lib/compose";
import { PartPicker } from "./PartPicker";
import { Stage } from "./Stage";

/**
 * Everything the game draws that is neither a player nor a monster: the props
 * standing on a map, the skill effects, the sprite an item wears on the ground.
 *
 * Like a monster these are standalone sprites with no head or attach points, so
 * this is the monster tab with two differences, both of which come from the fact
 * that these folders were never held to one shape:
 *
 * - a source select, because the folder is the only thing that groups them;
 * - actions and facings read off the act in hand rather than assumed. A dropped
 *   item is one group -- one picture, no facing -- a bonfire is one action of
 *   eight, and the ~290 monster sprites that `npc/` reuses as quest NPCs carry
 *   the full five. Asking the act is what covers all three.
 */
export function PropTab() {
  const [source, setSource] = useState<PropSource>("npc");
  const [props, setProps] = useState<PartEntry[]>([]);
  const [selected, setSelected] = useState<PartEntry | null>(null);
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
    setProps([]);
    setSelected(null);
    setError(null);
    fetchProps(source)
      .then((list) => {
        if (cancelled) return;
        setProps(list);
        setSelected(list[0] ?? null);
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [source]);

  useEffect(() => {
    if (!selected) {
      setParts([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([fetchFile(selected.sprId), fetchFile(selected.actId)])
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
  }, [selected]);

  const act = parts[0]?.act ?? null;
  const actions = useMemo(() => (act ? actionsForAct(act) : []), [act]);
  const facings = act ? facingCount(act) : 1;

  // Two props rarely agree on how many groups they carry, so a pose or a facing
  // the new sprite does not have falls back rather than rendering the wrap
  // `actionIndex` would otherwise hand it.
  useEffect(() => {
    setOptions((prev) => {
      const action = actions.some((a) => a.base === prev.actionBase) ? prev.actionBase : 0;
      const direction = prev.direction < facings ? prev.direction : 0;
      return action === prev.actionBase && direction === prev.direction
        ? prev
        : { ...prev, actionBase: action, direction };
    });
  }, [actions, facings]);

  const exportMeta = useMemo(
    () => ({ prop: selected?.name ?? null, source }),
    [selected, source]
  );

  return (
    <div className="generator">
      <aside className="panel one-column monster-panel">
        {/*
          Keyed on the source so switching folders remounts the picker: its
          filter is the one piece of state that does not survive the move, since
          a word typed at `npc/` matches nothing in `아이템/` and the grid would
          come back empty as though the tab had broken.
        */}
        <PartPicker
          key={source}
          label="Prop"
          entries={props}
          value={selected}
          onChange={setSelected}
          aside={
            <label className="picker-toggle" title="Which folder to list. These are groupings, not classifications: npc/ holds a bonfire and the shopkeeper standing beside it.">
              <span>Source</span>
              <select
                value={source}
                onChange={(event) => setSource(event.target.value as PropSource)}
              >
                {PROP_SOURCES.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
          }
        />
      </aside>

      <Stage
        parts={parts}
        actions={actions}
        options={options}
        onChange={(patch) => setOptions((prev) => ({ ...prev, ...patch }))}
        facings={facings}
        exportName={selected?.name ?? "prop"}
        exportMeta={exportMeta}
        loading={loading}
        error={error}
      />
    </div>
  );
}
