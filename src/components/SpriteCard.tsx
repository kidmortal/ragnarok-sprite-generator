import { useEffect, useState } from "react";
import type { Entry } from "../api";
import { loadThumb, type Thumb } from "../lib/thumbs";
import { useInView } from "../lib/useInView";

type Props = {
  entry: Entry;
  onOpen: (entry: Entry) => void;
};

/**
 * A cheap preview: nothing is fetched until the card scrolls into view, and
 * only the first frame is decoded. Full sprite details are loaded on open.
 */
export function SpriteCard({ entry, onOpen }: Props) {
  const { ref, inView } = useInView<HTMLButtonElement>();
  const [thumb, setThumb] = useState<Thumb | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!inView) return;
    let cancelled = false;
    loadThumb(entry.id)
      .then((result) => !cancelled && setThumb(result))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [inView, entry.id]);

  return (
    <button ref={ref} className="card" onClick={() => onOpen(entry)}>
      <div className="card-preview">
        {thumb ? (
          <img src={thumb.url} width={thumb.width} height={thumb.height} alt="" />
        ) : failed ? (
          <span className="error">!</span>
        ) : null}
      </div>
      <div className="card-name" title={entry.name}>
        {entry.name}
      </div>
    </button>
  );
}
