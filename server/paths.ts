/**
 * Path identity, shared by the API and the thumbnail generator.
 *
 * Paths are addressed by an opaque id: base64url of the raw relative path
 * *bytes*. Folders/files here are often named in Korean, and some archives
 * carry legacy EUC-KR bytes that are not valid UTF-8 -- round-tripping the raw
 * bytes means we can always reopen the file even when its name cannot be
 * decoded losslessly.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.resolve(ROOT, "data");
/** Pre-rendered part previews, written by `npm run thumbs`. */
export const THUMB_DIR = path.resolve(ROOT, "cache/thumbs");

export const encodeId = (rel: Buffer) => rel.toString("base64url");
export const decodeId = (id: string) => Buffer.from(id, "base64url");

const utf8 = new TextDecoder("utf-8", { fatal: false });
let eucKr: TextDecoder | null = null;
try {
  eucKr = new TextDecoder("euc-kr", { fatal: true });
} catch {
  eucKr = null;
}

export function displayName(raw: Buffer): string {
  const asUtf8 = utf8.decode(raw);
  if (!asUtf8.includes("�")) return asUtf8.normalize("NFC");
  if (eucKr) {
    try {
      return eucKr.decode(raw).normalize("NFC");
    } catch {
      /* fall through */
    }
  }
  return asUtf8;
}

/** Resolve an id to an absolute path, refusing anything outside data/. */
export function resolveId(id: string | undefined): Buffer {
  const rel = id ? decodeId(id) : Buffer.alloc(0);
  if (rel.includes(0)) throw new Error("invalid path");
  const abs = rel.length
    ? Buffer.concat([Buffer.from(DATA_DIR + path.sep), rel])
    : Buffer.from(DATA_DIR);
  const normalized = path.resolve(abs.toString("binary"));
  const base = path.resolve(DATA_DIR.toString());
  if (normalized !== base && !normalized.startsWith(base + path.sep)) {
    throw new Error("path escapes data directory");
  }
  return abs;
}

export const join = (parent: Buffer, name: Buffer): Buffer =>
  parent.length ? Buffer.concat([parent, Buffer.from(path.sep), name]) : name;
