export async function fetchFile(id: string): Promise<ArrayBuffer> {
  const res = await fetch(`/api/file?id=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.arrayBuffer();
}

export type PartEntry = { name: string; sprId: string; actId: string };

export type PartsCatalog = {
  race: string;
  gender: string;
  bodies: PartEntry[];
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
  weapons: PartEntry[];
  shields: PartEntry[];
  garments: PartEntry[];
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

export async function fetchMonsters(): Promise<PartEntry[]> {
  const res = await fetch("/api/monsters");
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export type PetAccessory = { name: string; sprId: string; actId: string };
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
