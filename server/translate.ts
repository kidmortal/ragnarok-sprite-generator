/**
 * English labels for Korean sprite file names.
 *
 * Display only. Nothing here touches a path, an id, or a file: the data
 * directory is a GRF extract and its names are the only handle we have on it,
 * so the Korean name stays the identity and this is a second string carried
 * beside it. Every part also gets a romanisation appended to what the picker
 * searches, so a name with no translation is still reachable from a Latin
 * keyboard.
 *
 * Three sources, most specific first:
 *
 *   item_names.txt  the client's own English item table, by item id (weapons
 *                   and shields) or by resource name (headgears)
 *   pc_jobs.txt     the client's own job names, for bodies and weapon folders
 *   glossary.txt    hand-written, for the words neither table carries
 *
 * and romanisation underneath, for everything else. What comes out is a label,
 * not a translation: `크루세이더_남_1116` reads "Crusader Katana" because both
 * halves resolved, while `라크마` reads "rakma" because nothing did.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasHangul, romanise } from "./romanise.ts";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "resolver-data");

const lines = (name: string): string[] => {
  try {
    return fs
      .readFileSync(path.join(DATA, name), "utf8")
      .split("\n")
      .map((line) => line.replace(/\r$/, "").trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
};

/** What a word may be translated inside: everything, or one kind of part. */
export type Scope = "body" | "weapon";
const scopeOf = (kind: string): Scope | null =>
  kind === "body" ? "body" : kind === "weapon" || kind === "shield" ? "weapon" : null;

const itemById = new Map<string, string>();
/** Item id -> the Korean word the sprite is named after, for ids with no English. */
const resourceById = new Map<string, string>();
const itemByResource = new Map<string, string>();
for (const line of lines("item_names.txt")) {
  const [id, resource, english] = line.split("\t");
  if (resource) resourceById.set(id, resource.normalize("NFC"));
  if (!english) continue;
  itemById.set(id, english);
  // First row wins: several ids share a resource name (a costume and its
  // original), and they are the same picture.
  const key = resource?.normalize("NFC").toLowerCase();
  if (key && !itemByResource.has(key)) itemByResource.set(key, english);
}

/** Korean job sprite name -> English job name, from the client's job table. */
const jobs = new Map<string, string>();
for (const line of lines("pc_jobs.txt")) {
  const [, , english, sprite] = line.split("\t");
  const key = sprite?.normalize("NFC").toLowerCase();
  if (key && english && !jobs.has(key)) jobs.set(key, english);
}

/** Hand-written words, keyed by scope; `null` is the unscoped table. */
const glossary = new Map<Scope | null, Map<string, string>>([
  [null, new Map()],
  ["body", new Map()],
  ["weapon", new Map()],
]);
for (const line of lines("glossary.txt")) {
  const [korean, english, scope] = line.split("\t");
  if (!korean || !english) continue;
  const table = glossary.get((scope?.trim() as Scope) ?? null);
  table?.set(korean.normalize("NFC"), english.trim());
}

/** Every word that may match inside `scope`, longest first. */
const vocabularies = new Map<Scope | null, [string, string][]>();
function vocabulary(scope: Scope | null): [string, string][] {
  let words = vocabularies.get(scope);
  if (!words) {
    const merged = new Map<string, string>(jobs);
    for (const [korean, english] of glossary.get(null)!) merged.set(korean, english);
    if (scope) for (const [korean, english] of glossary.get(scope)!) merged.set(korean, english);
    words = [...merged.entries()].sort((a, b) => b[0].length - a[0].length);
    vocabularies.set(scope, words);
  }
  return words;
}

/**
 * One token in English, by eating the longest known word at each position.
 *
 * Korean sprite names run their words together -- 켈베로스길로틴크로스 is a
 * Cerberus and a Guillotine Cross with nothing between them -- so there is
 * nothing to split on and the vocabulary has to do the splitting. Whatever no
 * word matches is romanised rather than dropped, so the output always accounts
 * for the whole input.
 */
function segment(token: string, scope: Scope | null): string {
  const words = vocabulary(scope);

  // First pass: does the vocabulary account for the whole token? If it does,
  // every word in it is a word, so 검광 is 검 + 광 -- "Sword Glow".
  const whole: string[] = [];
  let at = 0;
  while (at < token.length) {
    const word = words.find(
      ([korean]) => korean.length <= token.length - at && token.startsWith(korean, at)
    );
    if (!word) break;
    whole.push(word[1]);
    at += word[0].length;
  }
  if (at === token.length) return whole.join(" ");

  // Second pass, for a token the vocabulary only partly covers. Here a
  // one-syllable word counts only as a suffix: 광 at the end of 단검광 is
  // "glow", but 귀 inside 까마귀 ("crow") is a syllable of it, not the word
  // for "ear", and romanising the run it belongs to is the better answer.
  const out: string[] = [];
  let rest = "";
  const flush = () => {
    if (!rest) return;
    out.push(hasHangul(rest) ? romanise(rest) : rest);
    rest = "";
  };

  at = 0;
  outer: while (at < token.length) {
    for (const [korean, english] of words) {
      if (korean.length > token.length - at || !token.startsWith(korean, at)) continue;
      if (korean.length === 1 && at + 1 !== token.length) continue;
      flush();
      out.push(english);
      at += korean.length;
      continue outer;
    }
    rest += token[at];
    at += 1;
  }
  flush();
  return out.join(" ");
}

/** Underscore-separated Latin already in the file name, tidied for display. */
const prettify = (token: string): string =>
  token
    .split(/[-]/)
    .map((word) => (word.length > 2 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");

const GENDER = /^(남|여)_|_(남|여)(?=$|_)/;

/**
 * An English label for one sprite file name, or "" when the name is already
 * Latin and needs none.
 *
 * The gender marker is dropped: the picker is showing one gender at a time and
 * repeating it in every row says nothing.
 */
export function label(name: string, kind: string): string {
  const scope = scopeOf(kind);
  const stem = name.normalize("NFC").replace(GENDER, "").replace(/^_+|_+$/g, "");
  if (!stem) return "";

  // A headgear names its item outright, and the item table has better English
  // for it than taking the name apart word by word would. Only a headgear,
  // though: 가드 is an item resource name as well as the Royal Guard's sprite
  // name, and on a body it is the job that is meant.
  if (kind === "headgear" || kind === "garment") {
    const whole = itemByResource.get(stem.toLowerCase());
    if (whole) return whole;
  }

  const parts: string[] = [];
  for (const token of stem.split("_")) {
    if (!token) continue;
    if (/^\d+$/.test(token)) {
      // Only a weapon or a shield names its item by id. Elsewhere a number is
      // a variant marker or part of the name -- the garment `2018_rtc_cape1`
      // is a year, and item 2018 is a staff.
      const isItemId = scope === "weapon" && token.length >= 3;
      const item = isItemId ? itemById.get(token) : undefined;
      const resource = isItemId ? resourceById.get(token) : undefined;
      parts.push(item ?? (resource ? segment(resource, scope) : token));
      continue;
    }
    const job = jobs.get(token.toLowerCase());
    if (job) {
      parts.push(job);
      continue;
    }
    parts.push(hasHangul(token) ? segment(token, scope) : prettify(token));
  }

  const english = parts.join(" ").replace(/\s+/g, " ").trim();
  return english === stem ? "" : english;
}

/**
 * Everything the picker's filter should match on: the name as it is on disk,
 * its label, and its romanisation.
 *
 * All three, because each is what somebody might type -- the Korean if they can
 * read it, the English if the tables knew the item, and the romanisation when
 * neither applies and all they can do is spell what they see.
 */
export function searchText(name: string, kind: string): string {
  const english = label(name, kind);
  const roman = hasHangul(name) ? romanise(name) : "";
  return [name, english, roman].filter(Boolean).join(" ").toLowerCase();
}
