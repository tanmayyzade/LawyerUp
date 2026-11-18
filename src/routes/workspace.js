// Lawyer workspace (/api/lawyer/*) and admin (/api/admin/*)
import { Router } from 'express';
import { query, tx } from '../db/pool.js';
import { ah, badRequest, notFound } from '../lib/errors.js';
import { requireRole } from '../lib/auth.js';
import * as v from '../lib/validate.js';
import { isDay, toMinutes } from '../lib/time.js';
import { audit } from '../lib/audit.js';

// ================================================================= lawyer
export const lawyer = Router();
lawyer.use(requireRole('lawyer'));

lawyer.get('/profile', ah(async (req, res) => {
  const { rows: [p] } = await query(
    `SELECT lp.*, lp.modes::text[] AS modes, c.slug AS city,
            COALESCE((SELECT array_agg(s.slug) FROM lawyer_specializations ls JOIN specializations s ON s.id = ls.specialization_id
                       WHERE ls.lawyer_id = lp.user_id), '{}') AS specializations
       FROM lawyer_profiles lp JOIN cities c ON c.id = lp.city_id WHERE lp.user_id = $1`, [req.user.id]);
  if (!p) throw notFound('Profile not found.');
  const { rows: earnings } = await query(
    `SELECT count(*) FILTER (WHERE status = 'completed')::int AS completed,
            count(*) FILTER (WHERE status = 'confirmed' AND starts_at > now())::int AS upcoming,
            COALESCE(sum(fee_paise) FILTER (WHERE status = 'completed'), 0)::int AS earned_paise
       FROM bookings WHERE lawyer_id = $1`, [req.user.id]);
  res.json({ profile: p, stats: earnings[0] });
}));

lawyer.put('/profile', ah(async (req, res) => {
  const b = req.body || {};
  const fields = {
    headline: v.str(b.headline, 'Headline', { max: 140, optional: true }),
    bio: v.str(b.bio, 'Bio', { max: 3000, optional: true }),
    experience_years: v.int(b.experienceYears, 'Experience', { min: 0, max: 70 }),
    fee_paise: v.int(b.feeRupees, 'Fee', { min: 100, max: 100000 }) * 100,
    session_minutes: v.oneOf(Number(b.sessionMinutes), 'Session length', [15, 20, 30, 45, 60]),
    office_address: v.str(b.officeAddress, 'Office address', { max: 300, optional: true }),
  };
  const languages = (Array.isArray(b.languages) ? b.languages : []).slice(0, 8).map((l) => v.str(l, 'Language', { max: 30 }));
  const modes = (Array.isArray(b.modes) ? b.modes : []).map((m) => v.oneOf(m, 'Mode', ['video', 'phone', 'in_person']));
  if (!modes.length) throw badRequest('Offer at least one consultation mode.');
  if (!languages.length) throw badRequest('Add at least one language.');
  const specs = (Array.isArray(b.specializations) ? b.specializations : []).slice(0, 6);

  await tx(async (db) => {
    await db.query(
      `UPDATE lawyer_profiles SET headline=$2, bio=$3, experience_years=$4, fee_paise=$5, session_minutes=$6,
              office_address=$7, languages=$8, modes=$9::consult_mode[], updated_at=now() WHERE user_id=$1`,
      [req.user.id, fields.headline, fields.bio, fields.experience_years, fields.fee_paise, fields.session_minutes,
        fields.office_address, languages, modes]);
    await db.query('DELETE FROM lawyer_specializations WHERE lawyer_id = $1', [req.user.id]);
    if (specs.length) {
      await db.query(`INSERT INTO lawyer_specializations (lawyer_id, specialization_id)
                      SELECT $1, id FROM specializations WHERE slug = ANY($2::text[])`, [req.user.id, specs]);
    }
    await audit(db, req.user.id, 'lawyer.profile_updated', 'lawyer', req.user.id);
  });
  res.json({ ok: true });
}));

lawyer.get('/availability', ah(async (req, res) => {
  const [{ rows: rules }, { rows: blocks }] = await Promise.all([
    query(`SELECT weekday, to_char(start_time,'HH24:MI') AS start, to_char(end_time,'HH24:MI') AS end
             FROM availability_rules WHERE lawyer_id = $1 ORDER BY weekday, start_time`, [req.user.id]),
    query(`SELECT to_char(day,'YYYY-MM-DD') AS day, reason FROM availability_blocks
            WHERE lawyer_id = $1 AND day >= current_date ORDER BY day`, [req.user.id]),
  ]);
  res.json({ rules, blocks });
}));

/** Replace weekly hours. Existing bookings are unaffected. */
lawyer.put('/availability', ah(async (req, res) => {
  const rules = Array.isArray(req.body?.rules) ? req.body.rules : null;
  if (!rules || rules.length > 50) throw badRequest('Send a list of weekly time windows.');
  const clean = rules.map((r) => {
    const weekday = v.int(r.weekday, 'Weekday', { min: 0, max: 6 });
    if (!/^\d{2}:\d{2}$/.test(r.start) || !/^\d{2}:\d{2}$/.test(r.end)) throw badRequest('Times must be HH:MM.');
    if (toMinutes(r.end) <= toMinutes(r.start)) throw badRequest('Each window must end after it starts.');
    return { weekday, start: r.start, end: r.end };
  });
  // No overlapping windows on the same day.
  for (const a of clean) for (const b of clean) {
    if (a !== b && a.weekday === b.weekday && toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end)) {
      throw badRequest('Time windows on the same day overlap.');
    }
  }
  await tx(async (db) => {
    await db.query('DELETE FROM availability_rules WHERE lawyer_id = $1', [req.user.id]);
    for (const r of clean) {
      await db.query('INSERT INTO availability_rules (lawyer_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4)',
        [req.user.id, r.weekday, r.start, r.end]);
    }
    await audit(db, req.user.id, 'lawyer.availability_updated', 'lawyer', req.user.id, { windows: clean.length });
  });
  res.json({ ok: true });
}));

lawyer.post('/blocks', ah(async (req, res) => {
  if (!isDay(req.body?.day)) throw badRequest('Choose a date.');
  const reason = v.str(req.body?.reason, 'Reason', { max: 120, optional: true });
  await query(`INSERT INTO availability_blocks (lawyer_id, day, reason) VALUES ($1,$2,$3)
               ON CONFLICT (lawyer_id, day) DO UPDATE SET reason = EXCLUDED.reason`, [req.user.id, req.body.day, reason]);
  res.status(201).json({ ok: true });
}));

lawyer.delete('/blocks/:day', ah(async (req, res) => {
  if (!isDay(req.params.day)) throw badRequest('Invalid date.');
  await query('DELETE FROM availability_blocks WHERE lawyer_id = $1 AND day = $2', [req.user.id, req.params.day]);
  res.json({ ok: true });
}));

// ================================================================= admin
export const admin = Router();
admin.use(requireRole('admin'));

admin.get('/lawyers', ah(async (req, res) => {
  const status = v.oneOf(req.query.status || 'pending', 'status', ['pending', 'verified', 'rejected']);
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.phone, u.kyc_status, lp.bar_council, lp.enrollment_number, lp.enrollment_year,
            lp.experience_years, lp.area, c.name AS city, lp.verification_status, lp.verification_note, lp.created_at
       FROM lawyer_profiles lp JOIN users u ON u.id = lp.user_id JOIN cities c ON c.id = lp.city_id
      WHERE lp.verification_status = $1 ORDER BY lp.created_at`, [status]);
  res.json({ lawyers: rows });
}));

admin.post('/lawyers/:id/verification', ah(async (req, res) => {
  if (!v.isUuid(req.params.id)) throw notFound();
  const decision = v.oneOf(req.body?.decision, 'Decision', ['verified', 'rejected']);
  const note = v.str(req.body?.note, 'Note', { max: 500, optional: true });
  await tx(async (db) => {
    const { rowCount } = await db.query(
      `UPDATE lawyer_profiles SET verification_status = $2::verification_status, verification_note = $3,
              verified_at = CASE WHEN $2::verification_status = 'verified' THEN now() END, verified_by = $4, updated_at = now()
        WHERE user_id = $1`, [req.params.id, decision, note, req.user.id]);
    if (!rowCount) throw notFound('Lawyer not found.');
    await audit(db, req.user.id, `lawyer.${decision}`, 'lawyer', req.params.id, { note });
  });
  res.json({ ok: true });
}));

admin.get('/stats', ah(async (_req, res) => {
  const { rows: [s] } = await query(`SELECT
      (SELECT count(*) FROM users WHERE role = 'client')::int AS clients,
      (SELECT count(*) FROM lawyer_profiles WHERE verification_status = 'verified')::int AS verified_lawyers,
      (SELECT count(*) FROM lawyer_profiles WHERE verification_status = 'pending')::int AS pending_lawyers,
      (SELECT count(*) FROM bookings WHERE status = 'confirmed')::int AS confirmed_bookings,
      (SELECT COALESCE(sum(amount_paise - refunded_paise),0) FROM payments WHERE status IN ('captured','refunded'))::int AS gmv_paise`);
  res.json({ stats: s });
}));
