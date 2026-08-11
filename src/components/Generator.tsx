import { useEffect, useMemo, useRef, useState } from "react";
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
  DIRECTIONS,
  HEAD_DIRECTIONS,
  PLAYER_ACTIONS,
  Z_INDEX,
  buildFrameCache,
  renderAction,
  type ComposeOptions,
  type Part,
  type PartKind,
} from "../lib/compose";
import { download, encodeApng, encodeSpritesheet } from "../lib/apng";
import { PartPicker } from "./PartPicker";

const HEADGEAR_SLOTS = [0, 1, 2];

/** A body sprite is named `{job}_{gender}`; equipment folders key off the job. */
function jobOf(bodyName: string | undefined): string {
  if (!bodyName) return "";
  return bodyName.replace(/_(남|여)$/, "");
}

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

  const [actionBase, setActionBase] = useState(0);
  const [direction, setDirection] = useState(0);
  const [headDirection, setHeadDirection] = useState(0);
  const [zoom, setZoom] = useState(3);
  const [playing, setPlaying] = useState(true);

  const [parts, setParts] = useState<Part[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);

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
    const job = jobOf(body?.name);
    setWeapon(null);
    setShield(null);
    setGarment(null);
    if (!job) {
      setEquipment(null);
      return;
    }
    let cancelled = false;
    fetchEquipment(race, gender, job)
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

  const options: ComposeOptions = useMemo(
    () => ({ actionBase, direction, headDirection }),
    [actionBase, direction, headDirection]
  );

  const cache = useMemo(() => buildFrameCache(parts), [parts]);

  const rendered = useMemo(
    () => (parts.length === 0 ? null : renderAction(parts, cache, options, 1)),
    [parts, cache, options]
  );

  // Play the composed frames back on the preview canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !rendered || rendered.frames.length === 0) return;
    const ctx = canvas.getContext("2d")!;
    let frame = 0;
    let last = performance.now();
    let raf = 0;

    const paint = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      const source = rendered.frames[frame % rendered.frames.length];
      ctx.drawImage(
        source,
        Math.round((canvas.width - source.width * zoom) / 2),
        Math.round((canvas.height - source.height * zoom) / 2),
        source.width * zoom,
        source.height * zoom
      );
    };

    const step = (now: number) => {
      if (playing && now - last >= rendered.delay) {
        frame = (frame + 1) % rendered.frames.length;
        last = now;
        paint();
      }
      raf = requestAnimationFrame(step);
    };

    paint();
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [rendered, zoom, playing]);

  const buildName = () => {
    const bits = [
      body?.name,
      head?.name,
      weapon?.name,
      shield?.name,
      garment?.name,
      ...headgears.map((h) => h?.name),
    ].filter(Boolean);
    const action = PLAYER_ACTIONS.find((a) => a.base === actionBase)?.name ?? "action";
    return `${bits.join("_")}_${action}_${DIRECTIONS[direction]}`.replace(/\s+/g, "-");
  };

  const exportApng = async () => {
    if (!rendered) return;
    setStatus("Encoding APNG…");
    try {
      const { frames, delay } = renderAction(parts, cache, options, zoom);
      const blob = await encodeApng(frames, { delay });
      download(blob, `${buildName()}.png`);
      setStatus(`Saved APNG · ${frames.length} frames · ${(blob.size / 1024).toFixed(0)}KB`);
    } catch (err) {
      setStatus(`APNG failed: ${(err as Error).message}`);
    }
  };

  const exportSheet = async () => {
    if (!rendered) return;
    setStatus("Packing spritesheet…");
    try {
      const { frames, delay } = renderAction(parts, cache, options, zoom);
      const sheet = await encodeSpritesheet(frames);
      download(sheet.blob, `${buildName()}_sheet.png`);

      const meta = {
        name: buildName(),
        action: PLAYER_ACTIONS.find((a) => a.base === actionBase)?.name,
        direction: DIRECTIONS[direction],
        frames: frames.length,
        frameWidth: sheet.frameWidth,
        frameHeight: sheet.frameHeight,
        columns: sheet.columns,
        rows: sheet.rows,
        delayMs: delay,
        scale: zoom,
        parts: {
          body: body?.name ?? null,
          head: head?.name ?? null,
          weapon: weapon?.name ?? null,
          shield: shield?.name ?? null,
          garment: garment?.name ?? null,
          headgears: headgears.map((h) => h?.name ?? null),
        },
      };
      download(
        new Blob([JSON.stringify(meta, null, 2)], { type: "application/json" }),
        `${buildName()}_sheet.json`
      );
      setStatus(`Saved sheet · ${sheet.columns}×${sheet.rows} @ ${sheet.frameWidth}×${sheet.frameHeight}`);
    } catch (err) {
      setStatus(`Spritesheet failed: ${(err as Error).message}`);
    }
  };

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

      <section className="stage-panel">
        <div className="row">
          <label>
            Action
            <select value={actionBase} onChange={(e) => setActionBase(Number(e.target.value))}>
              {PLAYER_ACTIONS.map((action) => (
                <option key={action.base} value={action.base}>
                  {action.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Facing
            <select value={direction} onChange={(e) => setDirection(Number(e.target.value))}>
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
              onChange={(e) => setHeadDirection(Number(e.target.value))}
            >
              {HEAD_DIRECTIONS.map((name, i) => (
                <option key={name} value={i}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <canvas ref={canvasRef} width={420} height={420} className="stage" />

        <div className="controls">
          <label>
            Scale
            <input
              type="range"
              min={1}
              max={6}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
            <span>{zoom}×</span>
          </label>
          <button onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
          <button onClick={exportApng} disabled={!rendered}>
            Export animated PNG
          </button>
          <button onClick={exportSheet} disabled={!rendered}>
            Export spritesheet
          </button>
        </div>

        <p className="meta">
          {loading
            ? "Loading sprites…"
            : rendered
              ? `${rendered.frames.length} frames · ${rendered.width}×${rendered.height}px · ${rendered.delay}ms/frame`
              : "Select a body to begin"}
        </p>
        {error && <p className="error-banner">{error}</p>}
        {status && <p className="meta">{status}</p>}
      </section>
    </div>
  );
}
