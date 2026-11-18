// Lawyer practice portal API — mounted at /api/lawyer (alongside profile/availability in workspace.js).
import { Router } from 'express';
import { query } from '../db/pool.js';
import { ah, badRequest, notFound } from '../lib/errors.js';
import { requireRole } from '../lib/auth.js';
import * as v from '../lib/validate.js';
import { isDay } from '../lib/time.js';
import { expireStaleHolds } from '../services/availability.js';

const r = Router();
r.use(requireRole('lawyer'));

const IST = `'Asia/Kolkata'`;
const TODAY = `(now() AT TIME ZONE ${IST})::date`;
const istStart = (dateExpr) => `((${dateExpr})::timestamp AT TIME ZONE ${IST})`;

const ROW = `
  b.id, b.client_id, cu.name AS client_name, b.starts_at, b.ends_at, b.mode, b.status, b.fee_paise,
  b.issue_summary, b.meeting_url, b.hold_expires_at, b.cancel_reason, b.cancelled_at, b.completed_at,
  CASE WHEN b.status IN ('confirmed','completed') THEN cu.phone END AS client_phone,
  (SELECT count(*)::int FROM messages m WHERE m.booking_id = b.id AND m.sender_id <> b.lawyer_id
      AND m.id > COALESCE((SELECT last_read_id FROM message_reads mr WHERE mr.booking_id = b.id AND mr.user_id = b.lawyer_id), 0)) AS unread`;
const FROM = `FROM bookings b JOIN users cu ON cu.id = b.client_id`;

const unreadTotal = async (lawyerId) => (await query(
  `SELECT count(*)::int AS n FROM messages m JOIN bookings b ON b.id = m.booking_id
    WHERE b.lawyer_id = $1 AND m.sender_id <> $1
      AND m.id > COALESCE((SELECT last_read_id FROM message_reads mr WHERE mr.booking_id = b.id AND mr.user_id = $1), 0)`,
  [lawyerId])).rows[0].n;

// ---------------------------------------------------------------- Today
r.get('/dashboard', ah(async (req, res) => {
  await expireStaleHolds({ query });
  const id = req.user.id;
  const [{ rows: today }, { rows: [next] }, { rows: [stats] }, { rows: [profile] }, { rows: week }] = await Promise.all([
    query(`SELECT ${ROW} ${FROM} WHERE b.lawyer_id = $1 AND b.status IN ('confirmed','completed','pending_payment')
             AND b.starts_at >= ${istStart(TODAY)} AND b.starts_at < ${istStart(`${TODAY} + 1`)} ORDER BY b.starts_at`, [id]),
    query(`SELECT ${ROW} ${FROM} WHERE b.lawyer_id = $1 AND b.status = 'confirmed' AND b.ends_at > now()
            ORDER BY b.starts_at LIMIT 1`, [id]),
    query(`SELECT
        (SELECT count(*) FROM bookings WHERE lawyer_id = $1 AND status IN ('confirmed','completed')
            AND starts_at >= ${istStart(`date_trunc('week', ${TODAY})`)} AND starts_at < ${istStart(`date_trunc('week', ${TODAY}) + interval '7 days'`)})::int AS week_count,
        (SELECT count(*) FROM bookings WHERE lawyer_id = $1 AND status = 'confirmed' AND starts_at > now())::int AS upcoming,
        (SELECT count(*) FROM bookings WHERE lawyer_id = $1 AND status = 'confirmed' AND ends_at < now())::int AS to_complete,
        (SELECT count(*) FROM bookings WHERE lawyer_id = $1 AND status = 'pending_payment')::int AS awaiting_payment,
        (SELECT COALESCE(sum(earned_paise),0) FROM lawyer_earnings WHERE lawyer_id = $1
            AND starts_at >= ${istStart(`date_trunc('month', ${TODAY})`)})::int AS month_earned,
        (SELECT COALESCE(sum(earned_paise),0) FROM lawyer_earnings WHERE lawyer_id = $1
            AND starts_at >= ${istStart(`date_trunc('month', ${TODAY}) - interval '1 month'`)}
            AND starts_at < ${istStart(`date_trunc('month', ${TODAY})`)})::int AS last_month_earned`, [id]),
    query(`SELECT verification_status, verification_note, rating_avg, rating_count, session_minutes, fee_paise
             FROM lawyer_profiles WHERE user_id = $1`, [id]),
    query(`SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE((SELECT sum(extract(epoch FROM end_time - start_time) / 60) FROM availability_rules ar
                  WHERE ar.lawyer_id = $1 AND ar.weekday = extract(dow FROM d)::int), 0)::int AS open_minutes,
                  EXISTS (SELECT 1 FROM availability_blocks ab WHERE ab.lawyer_id = $1 AND ab.day = d::date) AS blocked,
                  (SELECT count(*) FROM bookings b WHERE b.lawyer_id = $1 AND b.status IN ('confirmed','completed','pending_payment')
                     AND b.starts_at >= ${istStart('d')} AND b.starts_at < ${istStart(`d + interval '1 day'`)})::int AS booked
             FROM generate_series(${TODAY}, ${TODAY} + 6, interval '1 day') d`, [id]),
  ]);
  res.json({ today, next: next || null, stats: { ...stats, unread: await unreadTotal(id) }, profile, week });
}));

// ---------------------------------------------------------------- Schedule (week grid)
r.get('/schedule', ah(async (req, res) => {
  const from = req.query.from;
  if (!isDay(from)) throw badRequest('from must be YYYY-MM-DD.');
  const days = v.int(req.query.days ?? 7, 'days', { min: 1, max: 31 });
  const [{ rows: bookings }, { rows: rules }, { rows: blocks }] = await Promise.all([
    query(`SELECT ${ROW} ${FROM} WHERE b.lawyer_id = $1 AND b.status IN ('confirmed','completed','pending_payment')
             AND b.starts_at >= ${istStart('$2::date')} AND b.starts_at < ${istStart('$2::date + $3::int')} ORDER BY b.starts_at`,
      [req.user.id, from, days]),
    query(`SELECT weekday, to_char(start_time,'HH24:MI') AS start, to_char(end_time,'HH24:MI') AS end
             FROM availability_rules WHERE lawyer_id = $1 ORDER BY weekday, start_time`, [req.user.id]),
    query(`SELECT to_char(day,'YYYY-MM-DD') AS day, reason FROM availability_blocks
            WHERE lawyer_id = $1 AND day >= $2::date AND day < $2::date + $3::int`, [req.user.id, from, days]),
  ]);
  res.json({ from, days, bookings, rules, blocks });
}));

// ---------------------------------------------------------------- Appointments
r.get('/appointments', ah(async (req, res) => {
  await expireStaleHolds({ query });
  const view = v.oneOf(req.query.view || 'upcoming', 'view', ['upcoming', 'awaiting_payment', 'to_complete', 'completed', 'cancelled']);
  const where = {
    upcoming: `b.status = 'confirmed' AND b.ends_at >= now()`,
    awaiting_payment: `b.status = 'pending_payment'`,
    to_complete: `b.status = 'confirmed' AND b.ends_at < now()`,
    completed: `b.status = 'completed'`,
    cancelled: `b.status IN ('cancelled','expired')`,
  }[view];
  const params = [req.user.id];
  let search = '';
  const q = v.str(req.query.q, 'q', { max: 80, optional: true });
  if (q) { params.push(q); search = `AND (cu.name ILIKE '%' || $2 || '%' OR b.issue_summary ILIKE '%' || $2 || '%')`; }
  const asc = ['upcoming', 'awaiting_payment'].includes(view);
  const { rows } = await query(
    `SELECT ${ROW}, e.earned_paise ${FROM} JOIN lawyer_earnings e ON e.booking_id = b.id
      WHERE b.lawyer_id = $1 AND ${where} ${search} ORDER BY b.starts_at ${asc ? 'ASC' : 'DESC'} LIMIT 300`, params);
  const { rows: [counts] } = await query(`SELECT
      count(*) FILTER (WHERE status = 'confirmed' AND ends_at >= now())::int AS upcoming,
      count(*) FILTER (WHERE status = 'pending_payment')::int AS awaiting_payment,
      count(*) FILTER (WHERE status = 'confirmed' AND ends_at < now())::int AS to_complete,
      count(*) FILTER (WHERE status = 'completed')::int AS completed,
      count(*) FILTER (WHERE status IN ('cancelled','expired'))::int AS cancelled
    FROM bookings WHERE lawyer_id = $1`, [req.user.id]);
  res.json({ view, appointments: rows, counts });
}));

// ---------------------------------------------------------------- Clients
r.get('/clients', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.name,
            count(*) FILTER (WHERE b.status IN ('confirmed','completed'))::int AS consultations,
            max(b.starts_at) FILTER (WHERE b.status = 'completed') AS last_at,
            min(b.starts_at) FILTER (WHERE b.status = 'confirmed' AND b.starts_at > now()) AS next_at,
            COALESCE(sum(e.earned_paise), 0)::int AS earned_paise
       FROM bookings b JOIN users u ON u.id = b.client_id JOIN lawyer_earnings e ON e.booking_id = b.id
      WHERE b.lawyer_id = $1 AND b.status IN ('confirmed','completed','cancelled')
      GROUP BY u.id ORDER BY COALESCE(min(b.starts_at) FILTER (WHERE b.status = 'confirmed' AND b.starts_at > now()), max(b.starts_at)) DESC`,
    [req.user.id]);
  res.json({ clients: rows });
}));

r.get('/clients/:id', ah(async (req, res) => {
  if (!v.isUuid(req.params.id)) throw notFound('Client not found.');
  const { rows: bookings } = await query(
    `SELECT ${ROW}, e.earned_paise ${FROM} JOIN lawyer_earnings e ON e.booking_id = b.id
      WHERE b.lawyer_id = $1 AND b.client_id = $2 AND b.status <> 'expired' ORDER BY b.starts_at DESC`, [req.user.id, req.params.id]);
  if (!bookings.length) throw notFound('Client not found.');   // only clients who booked this lawyer
  const hasActive = bookings.some((b) => ['confirmed', 'completed'].includes(b.status));
  const { rows: [c] } = await query(
    `SELECT id, name, ${hasActive ? 'phone, email,' : ''} created_at FROM users WHERE id = $1`, [req.params.id]);
  res.json({ client: c, bookings });
}));

// ---------------------------------------------------------------- Messages inbox
r.get('/inbox', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT b.id AS booking_id, cu.name AS client_name, b.starts_at, b.status, lm.body AS last_body, lm.created_at AS last_at,
            lm.sender_id = $1 AS last_from_me,
            (SELECT count(*)::int FROM messages m WHERE m.booking_id = b.id AND m.sender_id <> $1
               AND m.id > COALESCE((SELECT last_read_id FROM message_reads mr WHERE mr.booking_id = b.id AND mr.user_id = $1), 0)) AS unread
       FROM bookings b JOIN users cu ON cu.id = b.client_id
       JOIN LATERAL (SELECT body, created_at, sender_id FROM messages WHERE booking_id = b.id ORDER BY id DESC LIMIT 1) lm ON true
      WHERE b.lawyer_id = $1 ORDER BY lm.created_at DESC LIMIT 200`, [req.user.id]);
  res.json({ threads: rows });
}));

// ---------------------------------------------------------------- Earnings
r.get('/earnings', ah(async (req, res) => {
  const id = req.user.id;
  const [{ rows: months }, { rows: [totals] }, { rows: items }] = await Promise.all([
    query(`SELECT to_char(m, 'YYYY-MM') AS month,
                  COALESCE((SELECT sum(earned_paise) FROM lawyer_earnings e WHERE e.lawyer_id = $1
                     AND e.starts_at >= ${istStart('m')} AND e.starts_at < ${istStart(`m + interval '1 month'`)}), 0)::int AS earned_paise,
                  (SELECT count(*) FROM lawyer_earnings e WHERE e.lawyer_id = $1 AND e.status = 'completed'
                     AND e.starts_at >= ${istStart('m')} AND e.starts_at < ${istStart(`m + interval '1 month'`)})::int AS consultations
             FROM generate_series(date_trunc('month', ${TODAY}) - interval '5 months', date_trunc('month', ${TODAY}), interval '1 month') m`, [id]),
    query(`SELECT COALESCE(sum(earned_paise),0)::int AS all_time,
                  COALESCE(sum(earned_paise) FILTER (WHERE status = 'cancelled'),0)::int AS from_late_cancellations,
                  count(*) FILTER (WHERE status = 'completed')::int AS completed,
                  COALESCE((SELECT sum(fee_paise) FROM bookings WHERE lawyer_id = $1 AND status = 'confirmed'),0)::int AS booked_upcoming
             FROM lawyer_earnings WHERE lawyer_id = $1`, [id]),
    query(`SELECT e.booking_id, e.starts_at, e.status, e.earned_paise, e.fee_paise, cu.name AS client_name, b.mode
             FROM lawyer_earnings e JOIN bookings b ON b.id = e.booking_id JOIN users cu ON cu.id = e.client_id
            WHERE e.lawyer_id = $1 AND e.earned_paise > 0 ORDER BY e.starts_at DESC LIMIT 100`, [id]),
  ]);
  res.json({ months, totals, items });
}));

// ---------------------------------------------------------------- Reviews
r.get('/reviews', ah(async (req, res) => {
  const [{ rows: reviews }, { rows: dist }] = await Promise.all([
    query(`SELECT r.rating, r.comment, r.created_at, r.booking_id, u.name AS client_name
             FROM reviews r JOIN users u ON u.id = r.client_id WHERE r.lawyer_id = $1 ORDER BY r.created_at DESC`, [req.user.id]),
    query(`SELECT s AS rating, (SELECT count(*) FROM reviews WHERE lawyer_id = $1 AND rating = s)::int AS n
             FROM generate_series(5, 1, -1) s`, [req.user.id]),
  ]);
  res.json({ reviews, distribution: dist });
}));

export default r;
