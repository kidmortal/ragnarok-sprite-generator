import { useEffect, useMemo, useState } from "react";
import { fetchFile, fetchMonsters, type PartEntry } from "../api";
import { parseSpr } from "../lib/spr";
import { parseAct } from "../lib/act";
import { MONSTER_ACTIONS, Z_INDEX, type ComposeOptions, type Part } from "../lib/compose";
import { PartPicker } from "./PartPicker";
import { Stage } from "./Stage";

/**
 * Monsters are single sprites in `몬스터/` -- no head, equipment or attach
 * points -- so the tab is just a picker and the stage.
 */
export function MonsterTab() {
  const [monsters, setMonsters] = useState<PartEntry[]>([]);
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
    fetchMonsters()
      .then((list) => {
        if (cancelled) return;
        setMonsters(list);
        setSelected(list[0] ?? null);
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, []);

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

  const exportMeta = useMemo(() => ({ monster: selected?.name ?? null }), [selected]);

  return (
    <div className="generator">
      <aside className="panel one-column">
        <PartPicker
          label="Monster"
          entries={monsters}
          value={selected}
          onChange={setSelected}
        />
      </aside>

      <Stage
        parts={parts}
        actions={MONSTER_ACTIONS}
        options={options}
        onChange={(patch) => setOptions((prev) => ({ ...prev, ...patch }))}
        exportName={selected?.name ?? "monster"}
        exportMeta={exportMeta}
        loading={loading}
        error={error}
      />
    </div>
  );
}
