"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.applicantPhotoPath = applicantPhotoPath;
exports.stepDocumentPath = stepDocumentPath;
exports.writeAmsFile = writeAmsFile;
exports.removeAmsFile = removeAmsFile;
exports.amsFileExists = amsFileExists;
exports.isUnrecoverableUrlReference = isUnrecoverableUrlReference;
exports.decodeBase64Field = decodeBase64Field;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
// Compiles to server/util/amsFileStorage.js — __dirname there is
// backend/server/util, so ../../public/ams resolves to backend/public/ams,
// matching the existing convention in controller/amsController.ts and
// controller/authController.ts (fetchAmsFile).
const AMS_PUBLIC_DIR = path_1.default.join(__dirname, "../../public/ams");
function ensureDir() {
    if (!(0, fs_1.existsSync)(AMS_PUBLIC_DIR))
        (0, fs_1.mkdirSync)(AMS_PUBLIC_DIR, { recursive: true });
}
// Relative paths (stored in the DB `path` column) are always POSIX-style
// and relative to backend/public/, e.g. "ams/25010195.jpg" — portable
// across OSes and doesn't bake in a domain the way the old
// `${UMS_DOMAIN}/api/auth/file/?tag=...` URLs did.
function applicantPhotoPath(serial) {
    return `ams/${serial}.jpg`;
}
function stepDocumentPath(serial, id) {
    return `ams/${serial}_${id}.pdf`;
}
function absoluteFromRelative(relativePath) {
    return path_1.default.join(__dirname, "../../public", relativePath);
}
// Writes `buffer` to the given DB-relative path and verifies it landed on
// disk with the expected size before returning — callers should only clear
// the source blob column after this resolves, never before.
function writeAmsFile(relativePath, buffer) {
    ensureDir();
    const dest = absoluteFromRelative(relativePath);
    // @types/node's Buffer here structurally mismatches the newer generic
    // Uint8Array<ArrayBufferLike> this TS version's lib expects — a version
    // skew between the two, not a real type error.
    (0, fs_1.writeFileSync)(dest, buffer);
    return (0, fs_1.existsSync)(dest) && (0, fs_1.statSync)(dest).size === buffer.length;
}
function removeAmsFile(relativePath) {
    const dest = absoluteFromRelative(relativePath);
    if ((0, fs_1.existsSync)(dest))
        (0, fs_1.unlinkSync)(dest);
}
function amsFileExists(relativePath) {
    return (0, fs_1.existsSync)(absoluteFromRelative(relativePath));
}
// A stepDocument.base64 value that's already a URL (from the old buggy
// saveStepDocument, which overwrote base64 with a URL even when no file was
// ever written) isn't real base64 data — decoding it would silently
// corrupt/lose nothing further, but it can't be migrated either since the
// original bytes are already gone.
function isUnrecoverableUrlReference(value) {
    return !!value && /^https?:\/\//i.test(value);
}
// Strips a `data:<mime>;base64,` prefix if present and returns the decoded
// buffer plus the mime type (from the prefix, falling back to the caller's
// hint) — DB values seen in this schema are consistently either a bare
// base64 string or a full data URI.
function decodeBase64Field(value, mimeHint) {
    const match = value.match(/^data:([^;]+);base64,([\s\S]*)$/);
    if (match)
        return { buffer: Buffer.from(match[2], "base64"), mime: match[1] };
    return { buffer: Buffer.from(value, "base64"), mime: mimeHint !== null && mimeHint !== void 0 ? mimeHint : null };
}
