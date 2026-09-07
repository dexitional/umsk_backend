const bcrypt = require('bcryptjs');
const sha1 = require('sha1');

const BCRYPT_PREFIX = /^\$2[aby]\$/;
const SHA1_HEX = /^[a-f0-9]{40}$/i;

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
