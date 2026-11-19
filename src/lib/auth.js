import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { unauthorized, forbidden } from './errors.js';

export const COOKIE = 'lu_session';

export function issueSession(res, user) {
  const token = jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: `${config.sessionDays}d` });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: config.sessionDays * 86_400_000,
    path: '/',
  });
  return token;
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

/** Attaches req.user if a valid session is present. Never throws. */
export async function loadUser(req, _res, next) {
  const bearer = req.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  const token = req.cookies?.[COOKIE] || bearer;
  if (!token) return next();
  try {
    const { sub } = jwt.verify(token, config.jwtSecret);
    const { rows } = await query(
      `SELECT id, role, name, email, phone, phone_verified, kyc_status, is_active, avatar_url,
              password_hash IS NOT NULL AS has_password, google_sub IS NOT NULL AS has_google FROM users WHERE id = $1`, [sub]);
    if (rows[0]?.is_active) req.user = rows[0];
  } catch { /* invalid/expired token: treat as signed out */ }
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (!roles.includes(req.user.role)) return next(forbidden());
  next();
};
