import { useEffect, useMemo, useRef, useState } from "react";
import { fetchFile, type Entry } from "../api";
import { parseSpr, type Spr } from "../lib/spr";
import { parseAct, type Act } from "../lib/act";

type Props = {
  entry: Entry;
  /** The matching .act, paired by base name -- may not exist. */
  actEntry?: Entry;
  onClose: () => void;
};

const VIEW = 320;

/** The full sprite (every frame, plus its .act) is only parsed once opened. */
export function SpriteViewer({ entry, actEntry, onClose }: Props) {
  const [spr, setSpr] = useState<Spr | null>(null);
  const [act, setAct] = useState<Act | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionIndex, setActionIndex] = useState(0);
  const [zoom, setZoom] = useState(2);
  const [playing, setPlaying] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    setSpr(null);
    setAct(null);
    setError(null);
    (async () => {
      try {
        const parsed = parseSpr(await fetchFile(entry.id));
        if (!cancelled) setSpr(parsed);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
        return;
      }
      if (!actEntry) return;
      try {
        const parsedAct = parseAct(await fetchFile(actEntry.id));
        if (!cancelled) setAct(parsedAct);
      } catch {
        /* an unreadable .act just means no animation */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.id, actEntry?.id]);

  const frameCanvases = useMemo(
    () =>
      (spr?.frames ?? []).map((frame) => {
        const c = document.createElement("canvas");
        c.width = Math.max(frame.width, 1);
        c.height = Math.max(frame.height, 1);
        if (frame.width && frame.height) {
          c.getContext("2d")!.putImageData(
            new ImageData(frame.pixels, frame.width, frame.height),
            0,
            0
          );
        }
        return c;
      }),
    [spr]
  );

  const action = act?.actions[actionIndex] ?? null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frameCanvases.length) return;
    const ctx = canvas.getContext("2d")!;
    let motion = 0;
    let raf = 0;
    let last = performance.now();

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;

      if (action && action.motions.length) {
        const layers = action.motions[motion % action.motions.length].layers;
        for (const layer of layers) {
          const source = frameCanvases[layer.sprIndex];
          if (!source) continue;
          ctx.save();
          ctx.globalAlpha = layer.color[3] / 255;
          ctx.translate(cx + layer.x * zoom, cy + layer.y * zoom);
          ctx.rotate((layer.rotation * Math.PI) / 180);
          ctx.scale(layer.scaleX * zoom * (layer.mirror ? -1 : 1), layer.scaleY * zoom);
          ctx.drawImage(source, -source.width / 2, -source.height / 2);
          ctx.restore();
        }
      } else {
        const source = frameCanvases[motion % frameCanvases.length];
        if (source) {
          ctx.drawImage(
            source,
            cx - (source.width * zoom) / 2,
            cy - (source.height * zoom) / 2,
            source.width * zoom,
            source.height * zoom
          );
        }
      }
    };

    const step = (now: number) => {
      const interval = (action ? action.delay : 6) * 25;
      if (playing && now - last >= interval) {
        motion += 1;
        last = now;
        draw();
      }
      raf = requestAnimationFrame(step);
    };

    draw();
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [action, frameCanvases, zoom, playing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2 title={entry.name}>{entry.name}</h2>
          <button onClick={onClose}>✕</button>
        </header>

        <canvas ref={canvasRef} width={VIEW} height={VIEW} className="stage" />

        {!spr && !error && <p className="meta">Loading sprite…</p>}
        {error && <p className="error-banner">{error}</p>}

        <div className="controls">
          <label>
            Zoom
            <input
              type="range"
              min={1}
              max={8}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
          </label>
          <button onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
          {act && (
            <label>
              Action
              <select value={actionIndex} onChange={(e) => setActionIndex(Number(e.target.value))}>
                {act.actions.map((a, i) => (
                  <option key={i} value={i}>
                    #{i} ({a.motions.length} frames)
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {spr && (
          <>
            <p className="meta">
              spr v{spr.version.toFixed(1)} · {spr.indexedCount} indexed · {spr.rgbaCount} rgba
              {act ? ` · act v${act.version.toFixed(1)}` : " · no .act"}
            </p>

            <div className="frames">
              {spr.frames.map((_, i) => (
                <FrameThumb key={i} canvas={frameCanvases[i]} label={`${i}`} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function FrameThumb({ canvas, label }: { canvas: HTMLCanvasElement; label: string }) {
  const holder = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = holder.current;
    if (!node) return;
    node.replaceChildren(canvas);
    canvas.style.imageRendering = "pixelated";
    canvas.style.maxWidth = "64px";
    canvas.style.maxHeight = "64px";
  }, [canvas]);
  return (
    <div className="frame">
      <div ref={holder} />
      <span>{label}</span>
    </div>
  );
}
