import crypto from 'node:crypto';

const N = 16384, r = 8, p = 1, KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, rr, pp, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: Number(rr), p: Number(pp) });
  return crypto.timingSafeEqual(actual, expected);
}

export function passwordProblem(pw: string): string | null {
  if (typeof pw !== 'string' || pw.length < 8) return 'Use at least 8 characters.';
  if (pw.length > 200) return 'That password is too long.';
  return null;
}
