import crypto from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(crypto.scrypt);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), 64);
  const expected = Buffer.from(keyB64, 'base64');
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Very small in-memory fixed-window rate limiter (per process). Swap for Redis when scaling out. */
export function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const k = key(req);
    const entry = hits.get(k);
    if (!entry || entry.reset < now) { hits.set(k, { count: 1, reset: now + windowMs }); return next(); }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many attempts. Please wait and try again.' } });
    }
    next();
  };
}
