import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { query, tx } from '../db/pool.js';
import { ah, badRequest, conflict, unauthorized, HttpError } from '../lib/errors.js';
import { issueSession, clearSession, requireAuth } from '../lib/auth.js';
import { hashPassword, verifyPassword, sha256, rateLimit } from '../lib/security.js';
import * as v from '../lib/validate.js';
import { otpProvider } from '../providers/otp.js';
import { kycProvider } from '../providers/kyc.js';
import jwt from 'jsonwebtoken';
import { googleEnabled, pkcePair, authorizeUrl, identityFromCode } from '../providers/google.js';
import { audit } from '../lib/audit.js';

const r = Router();
const limiter = (max) => (config.isTest ? (_q, _s, n) => n() : rateLimit({ windowMs: 15 * 60_000, max }));

const publicUser = (u) => ({
  id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone,
  phoneVerified: u.phone_verified, kycStatus: u.kyc_status, avatarUrl: u.avatar_url || null,
  needsPhone: !u.phone,
  signIn: { password: u.has_password ?? Boolean(u.password_hash), google: u.has_google ?? Boolean(u.google_sub) },
});

// ---------------------------------------------------------------- OTP
r.post('/otp/request', limiter(10), ah(async (req, res) => {
  const phone = v.phone(req.body.phone);
  const recent = await query(
    `SELECT count(*)::int AS n FROM otp_codes WHERE phone = $1 AND created_at > now() - interval '10 minutes'`, [phone]);
  if (recent.rows[0].n >= 5) throw conflict('Too many codes requested. Try again in a few minutes.', 'otp_throttled');

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await query(
    `INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [phone, sha256(`${phone}:${code}`), config.otp.ttlMinutes]);
  const provider = otpProvider();
  await provider.send(phone, code);
  // In development (console provider) we return the code so you can sign up without an SMS gateway.
  res.json({ sent: true, ...(provider.exposesCodeInDev && (!config.isProd || config.demoMode) ? { devCode: code } : {}) });
}));

async function consumeOtp(db, phone, code) {
  const { rows: [otp] } = await db.query(
    `SELECT * FROM otp_codes WHERE phone = $1 AND consumed_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [phone]);
  if (!otp) throw badRequest('Your code has expired. Request a new one.');
  if (otp.attempts >= config.otp.maxAttempts) throw badRequest('Too many wrong attempts. Request a new code.');
  if (otp.code_hash !== sha256(`${phone}:${String(code || '').trim()}`)) {
    await db.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
    throw badRequest('That code is not correct.');
  }
  await db.query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [otp.id]);
}

// ---------------------------------------------------------------- register
r.post('/register', limiter(20), ah(async (req, res) => {
  const b = req.body || {};
  const role = v.oneOf(b.role, 'Account type', ['client', 'lawyer']);   // admins are created by seed/CLI only
  const name = v.str(b.name, 'Name', { min: 2, max: 120 });
  const email = v.email(b.email);
  const phone = v.phone(b.phone);
  const password = v.password(b.password);

  let lawyer = null;
  if (role === 'lawyer') {
    const cityRow = (await query('SELECT id, lat, lng FROM cities WHERE slug = $1', [b.city || config.defaultCity])).rows[0];
    if (!cityRow) throw badRequest('Choose a supported city.');
    let lat = cityRow.lat; let lng = cityRow.lng;
    if (b.area) {
      const loc = (await query('SELECT lat, lng FROM localities WHERE city_id = $1 AND lower(name) = lower($2)', [cityRow.id, b.area])).rows[0];
      if (loc) ({ lat, lng } = loc);
    }
    const specs = Array.isArray(b.specializations) ? b.specializations.slice(0, 6) : [];
    lawyer = {
      barCouncil: v.str(b.barCouncil, 'Bar Council', { max: 120 }),
      enrollmentNumber: v.str(b.enrollmentNumber, 'Enrolment number', { min: 3, max: 40 }).toUpperCase(),
      enrollmentYear: v.int(b.enrollmentYear, 'Enrolment year', { min: 1950, max: new Date().getFullYear(), optional: true }),
      experienceYears: v.int(b.experienceYears ?? 0, 'Years of experience', { min: 0, max: 70 }),
      feePaise: v.int(b.feeRupees, 'Consultation fee', { min: 100, max: 100000 }) * 100,
      sessionMinutes: v.oneOf(Number(b.sessionMinutes || 30), 'Session length', [15, 20, 30, 45, 60]),
      cityId: cityRow.id, area: v.str(b.area, 'Area', { max: 80, optional: true }), lat, lng,
      languages: (Array.isArray(b.languages) ? b.languages : ['English']).slice(0, 8).map((l) => v.str(l, 'Language', { max: 30 })),
      specs,
    };
  }

  const user = await tx(async (db) => {
    await consumeOtp(db, phone, b.otpCode);
    const dupe = await db.query('SELECT 1 FROM users WHERE lower(email) = $1 OR phone = $2', [email, phone]);
    if (dupe.rowCount) throw conflict('An account with this email or phone already exists.', 'account_exists');

    const { rows: [u] } = await db.query(
      `INSERT INTO users (role, name, email, phone, password_hash, phone_verified)
       VALUES ($1,$2,$3,$4,$5,true) RETURNING *`, [role, name, email, phone, await hashPassword(password)]);

    if (lawyer) {
      try {
        await db.query(
          `INSERT INTO lawyer_profiles (user_id, bar_council, enrollment_number, enrollment_year, experience_years, fee_paise,
                                        session_minutes, city_id, area, lat, lng, languages)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [u.id, lawyer.barCouncil, lawyer.enrollmentNumber, lawyer.enrollmentYear, lawyer.experienceYears, lawyer.feePaise,
            lawyer.sessionMinutes, lawyer.cityId, lawyer.area, lawyer.lat, lawyer.lng, lawyer.languages]);
      } catch (err) {
        if (err.code === '23505') throw conflict('This Bar Council enrolment number is already registered.', 'enrollment_exists');
        throw err;
      }
      if (lawyer.specs.length) {
        await db.query(
          `INSERT INTO lawyer_specializations (lawyer_id, specialization_id)
           SELECT $1, id FROM specializations WHERE slug = ANY($2::text[])`, [u.id, lawyer.specs]);
      }
      // Default availability: Mon–Fri 10:00–13:00 and 15:00–18:00 — editable in the workspace.
      await db.query(
        `INSERT INTO availability_rules (lawyer_id, weekday, start_time, end_time)
         SELECT $1, d, s::time, e::time FROM generate_series(1,5) d,
                (VALUES ('10:00','13:00'), ('15:00','18:00')) w(s, e)`, [u.id]);
    }
    await audit(db, u.id, 'user.registered', 'user', u.id, { role });
    return u;
  });

  issueSession(res, user);
  res.status(201).json({ user: publicUser(user) });
}));

// ---------------------------------------------------------------- login / logout / me
const PORTAL_LOGIN = { client: '#/login', lawyer: '#/lawyer/login', admin: '#/admin/login' };
const PORTAL_HINT = {
  client: 'This is a client account. Sign in on the client sign-in page.',
  lawyer: 'This is a lawyer account. Sign in on the LawyerUp for Lawyers page.',
  admin: 'This is a staff account. Sign in on the admin page.',
};

r.post('/login', limiter(20), ah(async (req, res) => {
  const portal = req.body.portal === undefined ? null : v.oneOf(req.body.portal, 'Sign-in page', ['client', 'lawyer', 'admin']);
  const email = v.email(req.body.email);
  const { rows: [u] } = await query('SELECT * FROM users WHERE lower(email) = $1', [email]);
  // Same error and similar timing whether or not the account exists.
  const ok = u ? await verifyPassword(String(req.body.password || ''), u.password_hash) : (await hashPassword('x'), false);
  if (u && !u.password_hash && u.google_sub) throw unauthorized('This account uses Google sign-in. Choose "Continue with Google".');
  if (!ok || !u.is_active) throw unauthorized('Email or password is incorrect.');
  // Each audience signs in on its own page. Only after the password is correct do we say which page fits.
  if (portal && u.role !== portal) {
    throw new HttpError(403, PORTAL_HINT[u.role], 'wrong_portal', { portal: u.role, href: PORTAL_LOGIN[u.role] });
  }
  issueSession(res, u);
  res.json({ user: publicUser(u) });
}));

r.post('/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

r.get('/me', ah(async (req, res) => {
  if (!req.user) return res.json({ user: null });
  let lawyer = null;
  if (req.user.role === 'lawyer') {
    lawyer = (await query('SELECT verification_status, verification_note FROM lawyer_profiles WHERE user_id = $1', [req.user.id])).rows[0] || null;
  }
  res.json({ user: { ...publicUser(req.user), lawyer } });
}));

// ---------------------------------------------------------------- add a mobile number (Google accounts)
r.post('/phone', requireAuth, limiter(20), ah(async (req, res) => {
  const phone = v.phone(req.body.phone);
  const user = await tx(async (db) => {
    await consumeOtp(db, phone, req.body.otpCode);
    const taken = await db.query('SELECT 1 FROM users WHERE phone = $1 AND id <> $2', [phone, req.user.id]);
    if (taken.rowCount) throw conflict('This mobile number is already used by another account.', 'phone_taken');
    const { rows: [u] } = await db.query(
      `UPDATE users SET phone = $2, phone_verified = true WHERE id = $1 RETURNING *`, [req.user.id, phone]);
    await audit(db, req.user.id, 'user.phone_added', 'user', req.user.id);
    return u;
  });
  res.json({ user: publicUser(user) });
}));

// ---------------------------------------------------------------- Sign in with Google
const OAUTH_COOKIE = 'lu_oauth';
const safeNext = (n) => (typeof n === 'string' && /^#\/[\w\-/?=&%.]*$/.test(n) ? n : '');
const redirectUri = (req) => `${config.publicUrl || `${req.protocol}://${req.get('host')}`}/api/auth/google/callback`;
const homeFor = (u) => (u.role === 'lawyer' ? '#/practice' : u.role === 'admin' ? '#/admin' : '#/find');

r.get('/google/start', (req, res) => {
  if (!googleEnabled()) return res.redirect('/#/login?error=google_off');
  const { verifier, challenge } = pkcePair();
  const state = crypto.randomBytes(16).toString('base64url');
  const token = jwt.sign({ state, verifier, next: safeNext(req.query.next) }, config.jwtSecret, { expiresIn: '10m' });
  res.cookie(OAUTH_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 600_000, path: '/api/auth/google' });
  res.redirect(authorizeUrl({ redirectUri: redirectUri(req), state, challenge }));
});

r.get('/google/callback', ah(async (req, res) => {
  const fail = (code) => { res.clearCookie(OAUTH_COOKIE, { path: '/api/auth/google' }); res.redirect(`/#/login?error=${code}`); };
  if (!googleEnabled()) return fail('google_off');
  if (req.query.error) return fail('google_cancelled');
  let saved;
  try { saved = jwt.verify(req.cookies?.[OAUTH_COOKIE] || '', config.jwtSecret); } catch { return fail('google_expired'); }
  if (!req.query.state || req.query.state !== saved.state || !req.query.code) return fail('google_state');

  let id;
  try { id = await identityFromCode({ code: String(req.query.code), redirectUri: redirectUri(req), verifier: saved.verifier }); }
  catch (err) { if (!config.isTest) console.error('[google]', err.message); return fail('google_failed'); }
  if (!id.emailVerified) return fail('google_unverified');

  const user = await tx(async (db) => {
    let { rows: [u] } = await db.query('SELECT * FROM users WHERE google_sub = $1', [id.sub]);
    if (!u) {
      // Same verified email as an existing account: link it.
      ({ rows: [u] } = await db.query('SELECT * FROM users WHERE lower(email) = $1 FOR UPDATE', [id.email]));
      if (u) {
        ({ rows: [u] } = await db.query(
          `UPDATE users SET google_sub = $2, email_verified = true, avatar_url = COALESCE(avatar_url, $3) WHERE id = $1 RETURNING *`,
          [u.id, id.sub, id.picture]));
        await audit(db, u.id, 'user.google_linked', 'user', u.id);
      } else {
        ({ rows: [u] } = await db.query(
          `INSERT INTO users (role, name, email, google_sub, avatar_url, email_verified)
           VALUES ('client', $1, $2, $3, $4, true) RETURNING *`,
          [id.name.length >= 2 ? id.name : id.email, id.email, id.sub, id.picture]));
        await audit(db, u.id, 'user.registered', 'user', u.id, { role: 'client', via: 'google' });
      }
    }
    return u;
  });
  if (!user.is_active) return fail('account_disabled');

  res.clearCookie(OAUTH_COOKIE, { path: '/api/auth/google' });
  issueSession(res, user);
  const next = saved.next || homeFor(user);
  res.redirect(!user.phone && user.role === 'client' ? `/#/complete-profile?next=${encodeURIComponent(next)}` : `/${next}`);
}));

// ---------------------------------------------------------------- identity verification (sandbox in M1)
r.post('/kyc/start', requireAuth, ah(async (req, res) => {
  if (req.user.kyc_status === 'verified') return res.json({ kycStatus: 'verified' });
  const result = await kycProvider().start(req.user);
  await query(
    `UPDATE users SET kyc_status = $2::kyc_status, kyc_provider = $3, kyc_reference = $4,
            kyc_verified_at = CASE WHEN $2::kyc_status = 'verified' THEN now() END WHERE id = $1`,
    [req.user.id, result.status, kycProvider().name, result.reference]);
  await audit({ query }, req.user.id, 'kyc.completed', 'user', req.user.id, { provider: kycProvider().name, status: result.status });
  res.json({ kycStatus: result.status, note: result.note });
}));

export default r;
