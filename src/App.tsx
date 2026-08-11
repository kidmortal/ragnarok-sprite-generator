import { useEffect, useMemo, useState } from "react";
import { listDir, type Entry, type Listing } from "./api";
import { SpriteCard } from "./components/SpriteCard";
import { useInView } from "./lib/useInView";
import { SpriteViewer } from "./components/SpriteViewer";
import { Generator } from "./components/Generator";

export function App() {
  const [tab, setTab] = useState<"browse" | "character">("browse");
  const [dirId, setDirId] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [opened, setOpened] = useState<Entry | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    listDir(dirId)
      .then((data) => !cancelled && setListing(data))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [dirId]);

  const dirs = useMemo(
    () => (listing?.items ?? []).filter((i) => i.type === "dir"),
    [listing]
  );
  const sprites = useMemo(
    () => (listing?.items ?? []).filter((i) => i.type === "file" && i.ext === ".spr"),
    [listing]
  );
  /** .act files pair with the .spr of the same base name. */
  const actByBase = useMemo(() => {
    const map = new Map<string, Entry>();
    for (const item of listing?.items ?? []) {
      if (item.type === "file" && item.ext === ".act") {
        map.set(item.name.slice(0, -4).toLowerCase(), item);
      }
    }
    return map;
  }, [listing]);

  /** Cards are added in pages so a folder with thousands of sprites still paints instantly. */
  const PAGE = 200;
  const [shown, setShown] = useState(PAGE);
  const { ref: sentinelRef, inView: sentinelInView } = useInView<HTMLDivElement>("600px", false);

  useEffect(() => setShown(PAGE), [dirId, filter]);
  // Keep growing while the sentinel stays in view (a short list may not scroll).
  useEffect(() => {
    if (sentinelInView) setShown((n) => n + PAGE);
  }, [sentinelInView, shown]);

  const needle = filter.trim().toLowerCase();
  const visibleDirs = dirs.filter((d) => !needle || d.name.toLowerCase().includes(needle));
  const visibleSprites = sprites.filter((s) => !needle || s.name.toLowerCase().includes(needle));

  return (
    <div className="app">
      <header className="topbar">
        <h1>Sprite Manager</h1>
        <div className="tabs">
          <button className={tab === "browse" ? "on" : ""} onClick={() => setTab("browse")}>
            Browse
          </button>
          <button className={tab === "character" ? "on" : ""} onClick={() => setTab("character")}>
            Character
          </button>
        </div>
        {tab === "browse" && (
        <nav className="crumbs">
          <button onClick={() => setDirId("")}>data</button>
          {listing?.crumbs.map((crumb) => (
            <span key={crumb.id}>
              <span className="sep">/</span>
              <button onClick={() => setDirId(crumb.id)}>{crumb.name}</button>
            </span>
          ))}
        </nav>
        )}
        {tab === "browse" && (
          <input
            className="filter"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
      </header>

      {tab === "character" ? (
        <Generator />
      ) : (
      <>
      {error && <p className="error-banner">{error}</p>}

      <main>
        {visibleDirs.length > 0 && (
          <section>
            <h2>Folders</h2>
            <div className="folders">
              {visibleDirs.map((dir) => (
                <button key={dir.id} className="folder" onClick={() => setDirId(dir.id)}>
                  📁 <span title={dir.name}>{dir.name}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        <section>
          <h2>Sprites ({visibleSprites.length})</h2>
          {visibleSprites.length === 0 ? (
            <p className="empty">
              No .spr files here. Drop sprite folders into <code>data/</code>.
            </p>
          ) : (
            <>
              <div className="grid">
                {visibleSprites.slice(0, shown).map((entry) => (
                  <SpriteCard key={entry.id} entry={entry} onOpen={setOpened} />
                ))}
              </div>
              {shown < visibleSprites.length && <div ref={sentinelRef} className="sentinel" />}
            </>
          )}
        </section>
      </main>
      </>
      )}

      {opened && (
        <SpriteViewer
          entry={opened}
          actEntry={actByBase.get(opened.name.slice(0, -4).toLowerCase())}
          onClose={() => setOpened(null)}
        />
      )}
    </div>
  );
}
