// Credential vault: keeps the portal password the system last issued to a
// student so it can be re-sent (bulk credentials SMS) and pushed unchanged
// to Google Workspace when the institutional email is generated later --
// the portal itself only ever stores a hash.
//
// Passwords are encrypted with AES-256-GCM under CREDENTIAL_VAULT_KEY
// (any secret of 32+ characters, e.g. `openssl rand -base64 48`; it is
// hashed to a 256-bit key). The student id is bound in as associated
// data, so a cipher copied onto another student's row fails to decrypt.
// Rotating or losing the key makes stored credentials unreadable: those
// students simply get a fresh password the next time one is needed.
//
// Only system-issued passwords are kept. A password the student chose
// (changePassword) clears their entry -- see clearCredential.

import crypto from "crypto";

const VERSION = "v1";

export class CredentialVaultError extends Error {}

function vaultKey(): Buffer {
  const secret = process.env.CREDENTIAL_VAULT_KEY || "";
  if (secret.length < 32) throw new CredentialVaultError("Credential vault is not configured: set CREDENTIAL_VAULT_KEY (32+ characters) in the backend .env.");
  return crypto.createHash("sha256").update(secret).digest();
}

export const isVaultConfigured = () => (process.env.CREDENTIAL_VAULT_KEY || "").length >= 32;
export const assertVaultConfigured = () => { vaultKey(); };

export function encryptCredential(studentId: string, password: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", vaultKey(), iv);
  cipher.setAAD(Buffer.from(studentId));
  const data = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

// null when the cipher can't be opened (wrong/rotated key, tampered row).
export function decryptCredential(studentId: string, value: string): string | null {
  const [version, iv, tag, data] = value.split(":");
  if (version !== VERSION || !iv || !tag || !data) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", vaultKey(), Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(studentId));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof CredentialVaultError) throw error;
    return null;
  }
}

// A newly issued password replaces the old one and is "not yet sent".
// Everything below is best-effort: the vault backs bulk re-sending and the
// Google push, but must never break sign-in, staging or a password reset --
// e.g. before CREDENTIAL_VAULT_KEY is set or the ais_student_credential
// migration has run. Failures are logged and the caller carries on as it
// did before the vault existed. Only the bulk actions require the vault
// (assertVaultConfigured).
const warn = (action: string, error: any) =>
  console.warn(`Credential vault ${action} skipped: ${String(error?.message || error).trim().split("\n").pop()}`);

// Saves a newly issued password as "not yet sent" (or sent). Without a
// usable vault the stale entry is dropped instead, so a stored password
// never outlives the one actually in use. Returns whether it was saved.
export async function storeCredential(db: any, studentId: string, password: string, sent = false): Promise<boolean> {
  if (!isVaultConfigured()) { await clearCredential(db, studentId); return false; }
  try {
    const cipher = encryptCredential(studentId, password);
    const sentAt = sent ? new Date() : null;
    await db.studentCredential.upsert({ where: { studentId }, create: { studentId, cipher, sentAt }, update: { cipher, sentAt } });
    return true;
  } catch (error) {
    warn("store", error);
    await clearCredential(db, studentId);
    return false;
  }
}

export async function readCredential(db: any, studentId: string): Promise<string | null> {
  if (!isVaultConfigured()) return null;
  try {
    const row = await db.studentCredential.findUnique({ where: { studentId } });
    return row ? decryptCredential(studentId, row.cipher) : null;
  } catch (error) {
    warn("read", error);
    return null;
  }
}

export async function markCredentialSent(db: any, studentId: string) {
  try { await db.studentCredential.updateMany({ where: { studentId }, data: { sentAt: new Date() } }); }
  catch (error) { warn("mark-sent", error); }
}

export async function clearCredential(db: any, studentId: string) {
  try { await db.studentCredential.deleteMany({ where: { studentId } }); }
  catch (error) { warn("clear", error); }
}
