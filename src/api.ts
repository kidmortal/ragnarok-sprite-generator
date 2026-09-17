import type { WeaponOffsetRule } from "./lib/weaponOffsets";

export async function fetchFile(id: string): Promise<ArrayBuffer> {
  const res = await fetch(`/api/file?id=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.arrayBuffer();
}

export type PartEntry = {
  /** The file's own name, in Korean where the extract is Korean. */
  name: string;
  /** The same name in English, or "" when it needs none. Display only. */
  label: string;
  sprId: string;
  actId: string;
};

/**
 * Where a body's weapons came from. Provenance, not proof: nothing in a sprite
 * says which body it was drawn for, so this reports whether the weapons are the
 * job's own or something it inherited -- see `WeaponOrigin` in `server/weapons.ts`.
 */
export type WeaponOrigin = "own" | "descendant" | "override" | "inherited" | "probe";

/** A body carries how its weapon folder was resolved, so the picker can filter. */
export type BodyEntry = PartEntry & {
  origin: WeaponOrigin | null;
  /** Whether the weapons are the job's own rather than an ancestor's. */
  trusted: boolean;
  /** Whether the body is big enough for the art it is offered. */
  fits: boolean;
};

export type PartsCatalog = {
  race: string;
  gender: string;
  bodies: BodyEntry[];
  heads: PartEntry[];
  headgears: PartEntry[];
};

export async function fetchParts(race: string, gender: string): Promise<PartsCatalog> {
  const res = await fetch(`/api/parts?race=${race}&gender=${gender}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export type Equipment = {
  job: string;
  origin: WeaponOrigin | null;
  /** The body's .imf, holding its per-frame draw order; null when it has none. */
  imfId: string | null;
  weapons: PartEntry[];
  shields: PartEntry[];
  garments: PartEntry[];
  /**
   * Hand-written corrections to where this body holds a weapon, from
   * `resolver-data/weapon_offsets.txt`. Empty for almost every body.
   */
  weaponOffsets: WeaponOffsetRule[];
};

/** `body` is the body sprite's file name; the server derives the job from it. */
export async function fetchEquipment(
  race: string,
  gender: string,
  body: string
): Promise<Equipment> {
  const res = await fetch(
    `/api/equipment?race=${race}&gender=${gender}&body=${encodeURIComponent(body)}`
  );
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

/** One row of `weapon_offsets.txt`, as the nudge control writes it. */
export type WeaponOffsetSave = {
  body: string;
  weapon: string;
  /** Action name (`attack-wait`), facing name (`south-east`), frame or range. */
  action: string;
  facing: string;
  frames: string;
  dx: number;
  dy: number;
  note?: string;
};

/**
 * Saves a correction into `server/resolver-data/weapon_offsets.txt`.
 *
 * Zero removes the row rather than writing one that says nothing, and saving
 * the same body, weapon, action and facing again rewrites its row in place.
 */
export async function saveWeaponOffset(row: WeaponOffsetSave): Promise<void> {
  const res = await fetch("/api/weapon-offsets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error ?? res.statusText);
  }
}

export async function fetchMonsters(): Promise<PartEntry[]> {
  const res = await fetch("/api/monsters");
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export type PetAccessory = PartEntry;
/**
 * A pet is a monster sprite that also ships an act of itself wearing its
 * equipment; that act usually shares the pet's `.spr`. See `server/pets.ts`.
 */
export type PetEntry = PartEntry & { accessory: PetAccessory | null };

export async function fetchPets(): Promise<PetEntry[]> {
  const res = await fetch("/api/pets");
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

/**
 * The folders behind the Props tab, in the order the picker offers them.
 *
 * These are groupings, not classifications -- `npc/` is where the game keeps
 * both a bonfire and the shopkeeper standing next to it. See `/api/props`.
 */
export const PROP_SOURCES = [
  { key: "npc", label: "NPCs & objects" },
  { key: "effect", label: "Effects" },
  { key: "drop", label: "Dropped items" },
  { key: "ammo", label: "Ammunition" },
] as const;

export type PropSource = (typeof PROP_SOURCES)[number]["key"];

export async function fetchProps(source: PropSource): Promise<PartEntry[]> {
  const res = await fetch(`/api/props?source=${source}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}
