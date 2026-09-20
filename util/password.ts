const bcrypt = require('bcryptjs');
const sha1 = require('sha1');
const { customAlphabet } = require('nanoid');

const BCRYPT_PREFIX = /^\$2[aby]\$/;
const SHA1_HEX = /^[a-f0-9]{40}$/i;

// Google Workspace rejects any password under 8 characters outright (its
// own technical floor, independent of whatever minimum an admin configures
// in the Workspace policy) -- this is the same bar used for both generating
// system passwords and validating user-chosen ones, so a student's portal
// password is always one Google will actually accept when synced.
const MIN_PASSWORD_LENGTH = Number(process.env.GSUITE_MIN_PASSWORD_LENGTH) || 8;

// Character sets exclude commonly-confused glyphs (0/O, 1/l/I) since these
// passwords get read off an SMS and typed back in by hand.
const genUpper = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ', 2);
const genLower = customAlphabet('abcdefghijkmnpqrstuvwxyz', 4);
const genDigits = customAlphabet('23456789', 3);
const genSymbol = customAlphabet('!@#$%&*', 1);

// Always-compliant system-generated password (10 chars: 2 upper, 4 lower,
// 3 digit, 1 symbol) for reset/forgot/stage flows -- no user input to
// validate there, so the generator just needs to guarantee strength.
export function generateStrongPassword(): string {
  const chars = (genUpper() + genLower() + genDigits() + genSymbol()).split('');
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// For self-service password changes, where the user picks their own value.
export function isStrongPassword(password: string): { ok: boolean; reason?: string } {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.` };
  }
  if (!/[a-z]/.test(password)) return { ok: false, reason: 'Password must include a lowercase letter.' };
  if (!/[A-Z]/.test(password)) return { ok: false, reason: 'Password must include an uppercase letter.' };
  if (!/[0-9]/.test(password)) return { ok: false, reason: 'Password must include a number.' };
  return { ok: true };
}

// New/changed passwords are always bcrypt going forward.
export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

// Accepts both bcrypt hashes and legacy sha1 hex digests so existing
// accounts keep working without a database migration. Any password that
// is set or changed via hashPassword() moves off sha1 permanently.
export function verifyPassword(stored: string | null | undefined, candidate: string): boolean {
  if (!stored || !candidate) return false;
  if (BCRYPT_PREFIX.test(stored)) return bcrypt.compareSync(candidate, stored);
  if (SHA1_HEX.test(stored)) return sha1(candidate) === stored;
  return false;
}
