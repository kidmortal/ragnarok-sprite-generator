import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { PartEntry } from "../api";
import { loadPartThumb, type Thumb } from "../lib/thumbs";
import { useInView } from "../lib/useInView";

type Props = {
  label: string;
  entries: PartEntry[];
  value: PartEntry | null;
  onChange: (entry: PartEntry | null) => void;
  optional?: boolean;
  /** Extra control rendered under the filter box, e.g. a scope toggle. */
  aside?: ReactNode;
};

/** How many tiles to mount at once; the rest arrive as the grid is scrolled. */
const PAGE = 60;

/**
 * Thumbnail grid of parts. Same lazy first-frame previews as the browse tab --
 * headgear folders run past a thousand entries, so nothing is fetched until its
 * tile is scrolled into view.
 */
export function PartPicker({ label, entries, value, onChange, optional, aside }: Props) {
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(PAGE);
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
    <div className="picker">
      <span className="picker-label">
        {label}
        <em>{matches.length === entries.length ? entries.length : `${matches.length}/${entries.length}`}</em>
      </span>
      <input
        className="filter"
        placeholder="Filter…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {aside}
      {entries.length === 0 ? (
        <p className="picker-empty">None for this job</p>
      ) : (
      <div className="tile-grid">
        {optional && (
          <button
            className={`tile${value === null ? " on" : ""}`}
            onClick={() => onChange(null)}
            title="None"
          >
            <div className="tile-preview none">—</div>
            <span className="tile-name">None</span>
          </button>
        )}
        {matches.slice(0, shown).map((entry) => (
          <PartTile
            key={entry.sprId}
            entry={entry}
            selected={value?.sprId === entry.sprId}
            onSelect={() => onChange(entry)}
          />
        ))}
        {shown < matches.length && <div ref={sentinelRef} className="sentinel" />}
      </div>
      )}
    </div>
  );
}

function PartTile({
  entry,
  selected,
  onSelect,
}: {
  entry: PartEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const { ref, inView } = useInView<HTMLButtonElement>("150px");
  const [thumb, setThumb] = useState<Thumb | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!inView) return;
    let cancelled = false;
    loadPartThumb(entry.sprId, entry.actId)
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
      onClick={onSelect}
      title={entry.name}
    >
      <div className="tile-preview">
        {thumb ? <img src={thumb.url} alt="" /> : failed ? <span className="error">!</span> : null}
      </div>
      <span className="tile-name">{entry.name}</span>
    </button>
  );
}
