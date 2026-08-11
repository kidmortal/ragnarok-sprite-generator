export type Entry = {
  id: string;
  name: string;
  type: "dir" | "file";
  ext: string;
};

export type Listing = {
  id: string;
  crumbs: { id: string; name: string }[];
  items: Entry[];
};

export async function listDir(id: string): Promise<Listing> {
  const res = await fetch(`/api/list?id=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

export async function fetchFile(id: string): Promise<ArrayBuffer> {
  const res = await fetch(`/api/file?id=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.arrayBuffer();
}

/** Fetch a byte range. `start < 0` requests that many bytes from the end. */
export async function fetchRange(id: string, start: number, end?: number): Promise<ArrayBuffer> {
  const spec = start < 0 ? `-${-start}` : `${start}-${end ?? ""}`;
  const res = await fetch(`/api/file?id=${encodeURIComponent(id)}`, {
    headers: { Range: `bytes=${spec}` },
  });
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

export async function fetchEquipment(
  race: string,
  gender: string,
  job: string
): Promise<Equipment> {
  const res = await fetch(
    `/api/equipment?race=${race}&gender=${gender}&job=${encodeURIComponent(job)}`
  );
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}
