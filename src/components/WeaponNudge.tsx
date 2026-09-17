import { useEffect, useState } from "react";
import { saveWeaponOffset, type WeaponOffsetSave } from "../api";
import { DIRECTIONS, PLAYER_ACTIONS, type ComposeOptions } from "../lib/compose";
import { weaponOffset, type Offset, type WeaponOffsetRule } from "../lib/weaponOffsets";

type Props = {
  body: string;
  weapon: string;
  options: ComposeOptions;
  /** Rows already in the table for this pairing; the nudge sits on top. */
  rules: readonly WeaponOffsetRule[];
  /** The live nudge, which the preview adds to the weapon's position. */
  nudge: Offset;
  onNudge: (offset: Offset) => void;
  /** Called after a row is written, so the table can be re-fetched. */
  onSaved: () => void;
};

/**
 * How wide a correction reaches. A hand is in a different place in every
 * facing, so the honest default is the narrowest: this action, this facing.
 * The wider ones are there because plenty of misfits do turn out to be the
 * whole pose, and re-nudging eight facings by hand to find that out is a waste.
 */
const SCOPES = [
  { key: "facing", label: "this action + facing" },
  { key: "action", label: "this action, all facings" },
  { key: "all", label: "every action and facing" },
] as const;

type Scope = (typeof SCOPES)[number]["key"];

const actionSlug = (base: number) =>
  (PLAYER_ACTIONS.find((action) => action.base === base)?.name ?? "stand")
    .toLowerCase()
    .replace(/ /g, "-");

/**
 * The nudge control: move a weapon a pixel at a time and watch the preview,
 * then write what you land on into `weapon_offsets.txt`.
 *
 * There is no measurement that can find these numbers -- see
 * `docs/weapon-offsets.md` -- so the loop is deliberately by eye: nudge, look,
 * save. What the buttons change is only the preview until Save is pressed; what
 * Save writes is one readable row in a checked-in text file, not a hidden
 * setting.
 */
export function WeaponNudge({ body, weapon, options, rules, nudge, onNudge, onSaved }: Props) {
  const [scope, setScope] = useState<Scope>("facing");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // What the table already says here, so the numbers shown are the ones that
  // end up in the file rather than a delta from an invisible starting point.
  const base = weaponOffset(rules, options, 0);
  const total = { x: base.x + nudge.x, y: base.y + nudge.y };

  const row: WeaponOffsetSave = {
    body,
    weapon,
    action: scope === "all" ? "*" : actionSlug(options.actionBase),
    facing: scope === "facing" ? DIRECTIONS[options.direction].toLowerCase() : "*",
    frames: "*",
    dx: total.x,
    dy: total.y,
  };

  // A new pairing starts from what the table says about it, not from the last
  // one's status line.
  useEffect(() => setStatus(null), [body, weapon]);

  const step = (dx: number, dy: number) => onNudge({ x: nudge.x + dx, y: nudge.y + dy });

  const save = async () => {
    setSaving(true);
    try {
      await saveWeaponOffset(row);
      setStatus(
        total.x === 0 && total.y === 0
          ? "Correction removed"
          : `Saved ${total.x}, ${total.y} for ${row.action} / ${row.facing}`
      );
      // The nudge folds into the table, so the preview must not add it twice.
      onNudge({ x: 0, y: 0 });
      onSaved();
    } catch (error) {
      setStatus(`Could not save: ${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const field = (axis: "x" | "y") => (
    <span className="nudge-field">
      <button onClick={() => step(axis === "x" ? -1 : 0, axis === "y" ? -1 : 0)} title="One pixel left/up">
        −
      </button>
      <input
        type="number"
        value={total[axis]}
        onChange={(event) => {
          // An empty box is mid-typing, not a request to move to zero.
          const text = event.target.value.trim();
          const value = Number(text);
          if (text !== "" && Number.isInteger(value)) {
            onNudge({ ...nudge, [axis]: value - base[axis] });
          }
        }}
      />
      <button onClick={() => step(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0)} title="One pixel right/down">
        +
      </button>
    </span>
  );

  return (
    <div className="nudge">
      <span className="nudge-title" title="Move the weapon until it sits in the hand, then save it into server/resolver-data/weapon_offsets.txt">
        Weapon offset
      </span>
      <label>
        X{field("x")}
      </label>
      <label>
        Y{field("y")}
      </label>
      <label>
        Applies to
        <select value={scope} onChange={(event) => setScope(event.target.value as Scope)}>
          {SCOPES.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      <button onClick={save} disabled={saving || (nudge.x === 0 && nudge.y === 0)}>
        {saving ? "Saving…" : "Save correction"}
      </button>
      <button onClick={() => onNudge({ x: 0, y: 0 })} disabled={nudge.x === 0 && nudge.y === 0}>
        Reset
      </button>
      {/* The row is shown whether or not it is saved: it is the thing that gets
          committed, and reading it is how you check the scope is what you meant. */}
      <code className="nudge-row">
        {[row.body, row.weapon, row.action, row.facing, row.frames, row.dx, row.dy].join("  ")}
      </code>
      {status && <span className="nudge-status">{status}</span>}
    </div>
  );
}
