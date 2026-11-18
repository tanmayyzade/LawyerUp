import { Router } from 'express';
import { config } from '../config.js';
import { query, tx } from '../db/pool.js';
import { HttpError } from '../lib/errors.js';
import { ah, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import * as v from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import {
  BOOKING_COLUMNS, BOOKING_FROM, createBooking, getBookingFor, cancelBooking, completeBooking, retryPayment,
} from '../services/bookings.js';
import { expireStaleHolds } from '../services/availability.js';

const r = Router();
r.use(requireAuth);

const loadId = (req) => {
  if (!v.isUuid(req.params.id)) throw notFound('Booking not found.');
  return req.params.id;
};

// List my bookings (client: as client; lawyer: as lawyer). ?scope=upcoming|past
r.get('/', ah(async (req, res) => {
  await expireStaleHolds({ query });
  const scope = v.oneOf(req.query.scope || 'all', 'scope', ['all', 'upcoming', 'past']);
  const col = req.user.role === 'lawyer' ? 'b.lawyer_id' : 'b.client_id';
  const scopeSql = {
    all: '',
    upcoming: `AND b.ends_at >= now() AND b.status IN ('pending_payment','confirmed')`,
    past: `AND (b.ends_at < now() OR b.status IN ('cancelled','completed','expired'))`,
  }[scope];
  const { rows } = await query(
    `SELECT ${BOOKING_COLUMNS} ${BOOKING_FROM} WHERE ${col} = $1 ${scopeSql}
      ORDER BY b.starts_at ${scope === 'past' ? 'DESC' : 'ASC'} LIMIT 200`, [req.user.id]);
  rows.forEach((b) => { if (b.status !== 'confirmed') b.meeting_url = null; });
  res.json({ bookings: rows });
}));

// Create a booking (holds the slot) and open a payment order.
r.post('/', requireRole('client'), ah(async (req, res) => {
  const b = req.body || {};
  if (config.kyc.requiredForBooking && req.user.kyc_status !== 'verified') {
    throw new HttpError(403, 'Please verify your identity before booking a consultation.', 'kyc_required');
  }
  if (!v.isUuid(b.lawyerId)) throw badRequest('Choose a lawyer.');
  const startsAt = new Date(b.startsAt);
  if (Number.isNaN(startsAt.getTime())) throw badRequest('Choose a time slot.');
  const mode = v.oneOf(b.mode, 'Consultation mode', ['video', 'phone', 'in_person']);
  const issueSummary = v.rejectSensitive(v.str(b.issueSummary, 'Topic', { max: 500, optional: true }), 'Topic');
  const { booking, checkout } = await createBooking(req.user, { lawyerId: b.lawyerId, startsAt, mode, issueSummary });
  res.status(201).json({ booking: await getBookingFor(req.user, booking.id), checkout });
}));

r.get('/:id', ah(async (req, res) => {
  res.json({ booking: await getBookingFor(req.user, loadId(req)) });
}));

// Fresh / reused payment order for a booking still on hold.
r.post('/:id/payment-order', requireRole('client'), ah(async (req, res) => {
  res.json({ checkout: await retryPayment(req.user, loadId(req)) });
}));

r.post('/:id/cancel', ah(async (req, res) => {
  const reason = v.str(req.body?.reason, 'Reason', { max: 300, optional: true });
  res.json(await cancelBooking(req.user, loadId(req), reason));
}));

r.post('/:id/complete', requireRole('lawyer', 'admin'), ah(async (req, res) => {
  res.json({ booking: await completeBooking(req.user, loadId(req)) });
}));

// ---------------------------------------------------------------- messages (participants of a confirmed/completed booking)
async function chatBooking(user, id) {
  const b = await getBookingFor(user, id);
  if (user.role === 'admin') throw forbidden('Admins cannot read consultation messages.');
  if (!['confirmed', 'completed'].includes(b.status)) {
    throw conflict('Messaging opens once the booking is paid and confirmed.', 'chat_closed');
  }
  return b;
}

r.get('/:id/messages', ah(async (req, res) => {
  const b = await chatBooking(req.user, loadId(req));
  const after = v.int(req.query.after ?? 0, 'after', { min: 0 });
  const { rows } = await query(
    `SELECT m.id, m.sender_id, u.name AS sender_name, m.body, m.created_at
       FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.booking_id = $1 AND m.id > $2 ORDER BY m.id LIMIT 500`, [b.id, after]);
  res.json({ messages: rows });
}));

r.post('/:id/messages', ah(async (req, res) => {
  const b = await chatBooking(req.user, loadId(req));
  const body = v.rejectSensitive(v.str(req.body?.body, 'Message', { max: 2000 }), 'Message');
  const { rows: [m] } = await query(
    `INSERT INTO messages (booking_id, sender_id, body) VALUES ($1,$2,$3) RETURNING id, sender_id, body, created_at`,
    [b.id, req.user.id, body]);
  res.status(201).json({ message: { ...m, sender_name: req.user.name } });
}));

// ---------------------------------------------------------------- reviews
r.post('/:id/review', requireRole('client'), ah(async (req, res) => {
  const id = loadId(req);
  const rating = v.int(req.body?.rating, 'Rating', { min: 1, max: 5 });
  const comment = v.str(req.body?.comment, 'Comment', { max: 1000, optional: true });
  await tx(async (db) => {
    const { rows: [b] } = await db.query('SELECT * FROM bookings WHERE id = $1 AND client_id = $2 FOR UPDATE', [id, req.user.id]);
    if (!b) throw notFound('Booking not found.');
    if (b.status !== 'completed') throw conflict('You can review a lawyer after the consultation is completed.', 'not_reviewable');
    try {
      await db.query('INSERT INTO reviews (booking_id, client_id, lawyer_id, rating, comment) VALUES ($1,$2,$3,$4,$5)',
        [id, req.user.id, b.lawyer_id, rating, comment]);
    } catch (err) {
      if (err.code === '23505') throw conflict('You have already reviewed this consultation.', 'already_reviewed');
      throw err;
    }
    await db.query(
      `UPDATE lawyer_profiles SET rating_count = s.n, rating_avg = s.avg, updated_at = now()
         FROM (SELECT count(*) AS n, round(avg(rating)::numeric, 2) AS avg FROM reviews WHERE lawyer_id = $1) s
        WHERE user_id = $1`, [b.lawyer_id]);
    await audit(db, req.user.id, 'review.created', 'booking', id, { rating });
  });
  res.status(201).json({ ok: true });
}));

export default r;
