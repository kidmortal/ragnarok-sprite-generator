import { asDomCanvas } from "../lib/canvas";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DIRECTIONS,
  HEAD_DIRECTIONS,
  buildFrameCache,
  hasTrueColour,
  renderAction,
  type ComposeOptions,
  type Part,
} from "../lib/compose";
import { SHEET_EXTENSION, download, encodeApng, encodeSpritesheet } from "../lib/apng";

type Props = {
  parts: Part[];
  /** Actions offered for this kind of sprite; players and monsters differ. */
  actions: readonly { readonly name: string; readonly base: number }[];
  options: ComposeOptions;
  onChange: (patch: Partial<ComposeOptions>) => void;
  /** Head facing only applies to a composed player. */
  showHeadDirection?: boolean;
  /** Base name for exported files. */
  exportName: string;
  /** Extra fields for the spritesheet's JSON sidecar. */
  exportMeta?: Record<string, unknown>;
  loading?: boolean;
  error?: string | null;
};

/** Animated preview of a composed sprite, plus the export controls. */
export function Stage({
  parts,
  actions,
  options,
  onChange,
  showHeadDirection,
  exportName,
  exportMeta,
  loading,
  error,
}: Props) {
  const [zoom, setZoom] = useState(3);
  const [playing, setPlaying] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const cache = useMemo(() => buildFrameCache(parts), [parts]);
  const rendered = useMemo(
    () => (parts.length === 0 ? null : renderAction(parts, cache, options, 1)),
    [parts, cache, options]
  );

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
        asDomCanvas(source),
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

  const actionName = actions.find((a) => a.base === options.actionBase)?.name ?? "action";
  const fileName = `${exportName}_${actionName}_${DIRECTIONS[options.direction]}`.replace(
    /\s+/g,
    "-"
  );

  const exportApng = async () => {
    if (!rendered) return;
    setStatus("Encoding APNG…");
    try {
      const { frames, delay } = renderAction(parts, cache, options, zoom);
      const blob = await encodeApng(frames, { delay });
      download(blob, `${fileName}.png`);
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
      const sheet = await encodeSpritesheet(frames, frames.length, {
        trueColour: hasTrueColour(parts),
      });
      download(sheet.blob, `${fileName}_sheet.${SHEET_EXTENSION}`);

      const meta = {
        name: fileName,
        action: actionName,
        direction: DIRECTIONS[options.direction],
        frames: frames.length,
        frameWidth: sheet.frameWidth,
        frameHeight: sheet.frameHeight,
        columns: sheet.columns,
        rows: sheet.rows,
        delayMs: delay,
        scale: zoom,
        ...exportMeta,
      };
      download(
        new Blob([JSON.stringify(meta, null, 2)], { type: "application/json" }),
        `${fileName}_sheet.json`
      );
      setStatus(
        `Saved sheet · ${sheet.columns}×${sheet.rows} @ ${sheet.frameWidth}×${sheet.frameHeight}`
      );
    } catch (err) {
      setStatus(`Spritesheet failed: ${(err as Error).message}`);
    }
  };

  return (
    <section className="stage-panel">
      <div className="row">
        <label>
          Action
          <select
            value={options.actionBase}
            onChange={(e) => onChange({ actionBase: Number(e.target.value) })}
          >
            {actions.map((action) => (
              <option key={action.base} value={action.base}>
                {action.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Facing
          <select
            value={options.direction}
            onChange={(e) => onChange({ direction: Number(e.target.value) })}
          >
            {DIRECTIONS.map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {showHeadDirection && (
          <label>
            Head
            <select
              value={options.headDirection}
              onChange={(e) => onChange({ headDirection: Number(e.target.value) })}
            >
              {HEAD_DIRECTIONS.map((name, i) => (
                <option key={name} value={i}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
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
            : "Nothing selected yet"}
      </p>
      {error && <p className="error-banner">{error}</p>}
      {status && <p className="meta">{status}</p>}
    </section>
  );
}
