import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import path from "path";

// Compiles to server/util/amsFileStorage.js — __dirname there is
// backend/server/util, so ../../public/ams resolves to backend/public/ams,
// matching the existing convention in controller/amsController.ts and
// controller/authController.ts (fetchAmsFile).
const AMS_PUBLIC_DIR = path.join(__dirname, "../../public/ams");

function ensureDir() {
   if (!existsSync(AMS_PUBLIC_DIR)) mkdirSync(AMS_PUBLIC_DIR, { recursive: true });
}

// Relative paths (stored in the DB `path` column) are always POSIX-style
// and relative to backend/public/, e.g. "ams/25010195.jpg" — portable
// across OSes and doesn't bake in a domain the way the old
// `${UMS_DOMAIN}/api/auth/file/?tag=...` URLs did.
export function applicantPhotoPath(serial: string): string {
   return `ams/${serial}.jpg`;
}

export function stepDocumentPath(serial: string, id: string): string {
   return `ams/${serial}_${id}.pdf`;
}

function absoluteFromRelative(relativePath: string): string {
   return path.join(__dirname, "../../public", relativePath);
}

// Writes `buffer` to the given DB-relative path and verifies it landed on
// disk with the expected size before returning — callers should only clear
// the source blob column after this resolves, never before.
export function writeAmsFile(relativePath: string, buffer: Buffer): boolean {
   ensureDir();
   const dest = absoluteFromRelative(relativePath);
   // @types/node's Buffer here structurally mismatches the newer generic
   // Uint8Array<ArrayBufferLike> this TS version's lib expects — a version
   // skew between the two, not a real type error.
   writeFileSync(dest, buffer as any);
   return existsSync(dest) && statSync(dest).size === buffer.length;
}

export function removeAmsFile(relativePath: string): void {
   const dest = absoluteFromRelative(relativePath);
   if (existsSync(dest)) unlinkSync(dest);
}

export function amsFileExists(relativePath: string): boolean {
   return existsSync(absoluteFromRelative(relativePath));
}

// A stepDocument.base64 value that's already a URL (from the old buggy
// saveStepDocument, which overwrote base64 with a URL even when no file was
// ever written) isn't real base64 data — decoding it would silently
// corrupt/lose nothing further, but it can't be migrated either since the
// original bytes are already gone.
export function isUnrecoverableUrlReference(value: string | null | undefined): boolean {
   return !!value && /^https?:\/\//i.test(value);
}

// Strips a `data:<mime>;base64,` prefix if present and returns the decoded
// buffer plus the mime type (from the prefix, falling back to the caller's
// hint) — DB values seen in this schema are consistently either a bare
// base64 string or a full data URI.
export function decodeBase64Field(value: string, mimeHint?: string | null): { buffer: Buffer; mime: string | null } {
   const match = value.match(/^data:([^;]+);base64,([\s\S]*)$/);
   if (match) return { buffer: Buffer.from(match[2], "base64"), mime: match[1] };
   return { buffer: Buffer.from(value, "base64"), mime: mimeHint ?? null };
}
