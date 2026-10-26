import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';

const KEY_LEN = 64;
let defaultCost = 2 ** 15;

export function setScryptCost(n) {
  defaultCost = n;
}

function scryptAsync(secret, salt, N) {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, KEY_LEN, { N, r: 8, p: 1, maxmem: 128 * N * 8 * 2 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashSecret(secret) {
  const salt = randomBytes(16);
  const key = await scryptAsync(secret.normalize('NFKC'), salt, defaultCost);
  return `scrypt$${defaultCost}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifySecret(secret, stored) {
  const [algo, cost, saltB64, keyB64] = String(stored).split('$');
  const N = Number(cost);
  if (algo !== 'scrypt' || !Number.isInteger(N) || N < 2 || N > 2 ** 20) return false;
  const expected = Buffer.from(keyB64 || '', 'base64');
  if (expected.length !== KEY_LEN) return false;
  const key = await scryptAsync(String(secret).normalize('NFKC'), Buffer.from(saltB64, 'base64'), N);
  return timingSafeEqual(key, expected);
}

// Hash used when an account does not exist, so the response time does not reveal it.
let dummyHash;
export async function burnVerifyTime(secret) {
  dummyHash ??= await hashSecret('dummy-password-for-timing');
  await verifySecret(secret, dummyHash);
  return false;
}

// Unambiguous alphabet: no 0/O, 1/I/L.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function randomCode(length) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function newOrderReference() {
  return `HV-${randomCode(8)}`;
}

// 12 characters over a 31-symbol alphabet ≈ 59 bits of entropy.
export function newAccessCode() {
  const raw = randomCode(12);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

export function normalizeCode(value) {
  return String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
}

export function normalizeReference(value) {
  const v = String(value ?? '').toUpperCase().replace(/\s/g, '');
  return v.startsWith('HV-') ? v : `HV-${v.replace(/^HV/, '')}`;
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Only same-site relative paths: "/compte" ok, "//evil.com", "/\evil.com", "https://…" rejected.
// Encoded slashes (%2F, %5C) are refused too, in case a proxy in front decodes them into "//evil.com".
export function safeRedirectPath(value, fallback = '/') {
  if (typeof value !== 'string' || value.length > 200) return fallback;
  if (/%(2f|5c)/i.test(value)) return fallback;
  return /^\/(?![/\\])[\w\-./?=&%]*$/.test(value) ? value : fallback;
}
