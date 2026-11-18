import { config } from '../config.js';
import { tx, query } from '../db/pool.js';
import { conflict, badRequest, notFound, forbidden } from '../lib/errors.js';
import { priceBreakdown } from '../lib/money.js';
import { audit } from '../lib/audit.js';
import { expireStaleHolds, isPublishedSlot } from './availability.js';
import { paymentProvider } from '../providers/payments.js';
import { meetingUrlFor } from '../providers/video.js';

export const ACTIVE = ['pending_payment', 'confirmed'];

/** Translate Postgres exclusion violations into friendly 409s. */
export function mapOverlapError(err) {
  if (err.code !== '23P01') return err;
  if (err.constraint === 'bookings_no_client_overlap') {
    return conflict('You already have a consultation at this time.', 'client_overlap');
  }
  return conflict('Sorry — that slot was just booked. Please choose another time.', 'slot_taken');
}

export const BOOKING_COLUMNS = `
  b.id, b.client_id, b.lawyer_id, b.starts_at, b.ends_at, b.mode, b.status,
  b.fee_paise, b.platform_fee_paise, b.total_paise, b.issue_summary, b.meeting_url,
  b.hold_expires_at, b.cancel_reason, b.cancelled_at, b.completed_at, b.created_at,
  cu.name AS client_name, lu.name AS lawyer_name, lp.area AS lawyer_area, lp.office_address,
  lp.photo_url AS lawyer_photo,
  (SELECT row_to_json(p) FROM (
     SELECT id, provider, provider_order_id, status, amount_paise, refunded_paise, failure_reason
       FROM payments WHERE booking_id = b.id ORDER BY created_at DESC LIMIT 1) p) AS payment,
  EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id) AS reviewed`;

export const BOOKING_FROM = `
  FROM bookings b
  JOIN users cu ON cu.id = b.client_id
  JOIN users lu ON lu.id = b.lawyer_id
  JOIN lawyer_profiles lp ON lp.user_id = b.lawyer_id`;

export async function getBookingFor(user, bookingId, db = { query }) {
  const { rows: [b] } = await db.query(`SELECT ${BOOKING_COLUMNS} ${BOOKING_FROM} WHERE b.id = $1`, [bookingId]);
  if (!b) throw notFound('Booking not found.');
  const allowed = user.role === 'admin' || b.client_id === user.id || b.lawyer_id === user.id;
  if (!allowed) throw notFound('Booking not found.');   // don't reveal existence
  // Meeting link only for confirmed participants.
  if (b.status !== 'confirmed') b.meeting_url = null;
  // Lawyer-only context: private notes, client contact (once confirmed) and history with this client.
  if (user.id === b.lawyer_id) {
    const { rows: [x] } = await db.query(
      `SELECT bk.lawyer_notes,
              CASE WHEN bk.status IN ('confirmed','completed') THEN u.phone END AS client_phone,
              CASE WHEN bk.status IN ('confirmed','completed') THEN u.email END AS client_email,
              (SELECT count(*)::int FROM bookings o WHERE o.lawyer_id = bk.lawyer_id AND o.client_id = bk.client_id
                  AND o.status = 'completed' AND o.id <> bk.id) AS previous_consultations
         FROM bookings bk JOIN users u ON u.id = bk.client_id WHERE bk.id = $1`, [b.id]);
    Object.assign(b, x);
  }
  return b;
}

/** Create a payment order for a booking that is awaiting payment. */
async function createPaymentOrder(booking) {
  const provider = paymentProvider();
  const order = await provider.createOrder({
    amountPaise: booking.total_paise,
    receipt: booking.id.slice(0, 40),
    notes: { booking_id: booking.id },
  });
  await query(
    `INSERT INTO payments (booking_id, provider, provider_order_id, amount_paise) VALUES ($1,$2,$3,$4)`,
    [booking.id, provider.name, order.orderId, booking.total_paise]);
  return order.checkout;
}

export async function createBooking(client, { lawyerId, startsAt, mode, issueSummary }, { now = new Date() } = {}) {
  const booking = await tx(async (db) => {
    await expireStaleHolds(db);

    const { rows: [lawyer] } = await db.query(
      `SELECT lp.user_id, lp.fee_paise, lp.modes, lp.verification_status, u.is_active
         FROM lawyer_profiles lp JOIN users u ON u.id = lp.user_id WHERE lp.user_id = $1`, [lawyerId]);
    if (!lawyer || lawyer.verification_status !== 'verified' || !lawyer.is_active) throw notFound('Lawyer not found.');
    if (!lawyer.modes.includes(mode)) throw badRequest('This lawyer does not offer that consultation mode.');

    const slot = await isPublishedSlot(db, lawyerId, startsAt, { now });
    if (!slot.ok) {
      const msg = { too_soon: 'That time is too soon to book.', too_far: 'That date is too far ahead.' }[slot.reason]
        || 'That time is not one of this lawyer\'s available slots.';
      throw badRequest(msg);
    }

    const price = priceBreakdown(lawyer.fee_paise);
    const holdUntil = new Date(Date.now() + config.bookingHoldMinutes * 60_000);
    try {
      const { rows: [b] } = await db.query(
        `INSERT INTO bookings (client_id, lawyer_id, starts_at, ends_at, mode, fee_paise, platform_fee_paise,
                               total_paise, issue_summary, hold_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [client.id, lawyerId, startsAt, slot.endsAt, mode, price.fee_paise, price.platform_fee_paise,
          price.total_paise, issueSummary, holdUntil]);
      await audit(db, client.id, 'booking.created', 'booking', b.id, { startsAt, mode });
      return b;
    } catch (err) {
      throw mapOverlapError(err);
    }
  });

  try {
    const checkout = await createPaymentOrder(booking);
    return { booking, checkout };
  } catch (err) {
    // Couldn't start payment: release the slot straight away.
    await query(`UPDATE bookings SET status = 'cancelled', cancel_reason = 'payment_order_failed', cancelled_at = now()
                  WHERE id = $1`, [booking.id]);
    throw err;
  }
}

/** New payment attempt for a booking still within its hold. */
export async function retryPayment(user, bookingId) {
  const b = await getBookingFor(user, bookingId);
  if (b.client_id !== user.id) throw forbidden();
  if (b.status !== 'pending_payment' || new Date(b.hold_expires_at) < new Date()) {
    throw conflict('This booking can no longer be paid for. Please pick a slot again.', 'not_payable');
  }
  if (b.payment?.status === 'created') {
    // Reuse the open order.
    const provider = paymentProvider(b.payment.provider);
    return { provider: provider.name, orderId: b.payment.provider_order_id, amount: b.total_paise, currency: 'INR',
      ...(provider.name === 'razorpay' ? { keyId: config.payments.razorpayKeyId } : {}) };
  }
  return createPaymentOrder(b);
}

function refundAmount(booking, cancelledByRole, now = new Date()) {
  if (cancelledByRole !== 'client') return booking.total_paise;     // lawyer/admin cancels: always full refund
  const hoursBefore = (new Date(booking.starts_at) - now) / 3_600_000;
  return hoursBefore >= config.freeCancelHours ? booking.total_paise : Math.round(booking.total_paise / 2);
}

export async function cancelBooking(user, bookingId, reason) {
  const result = await tx(async (db) => {
    const { rows: [b] } = await db.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bookingId]);
    const isParty = b && (b.client_id === user.id || b.lawyer_id === user.id || user.role === 'admin');
    if (!isParty) throw notFound('Booking not found.');
    if (!ACTIVE.includes(b.status)) throw conflict(`A ${b.status.replace('_', ' ')} booking cannot be cancelled.`, 'not_cancellable');
    if (new Date(b.starts_at) <= new Date()) throw conflict('This consultation has already started.', 'not_cancellable');

    const role = user.role === 'admin' ? 'admin' : (b.client_id === user.id ? 'client' : 'lawyer');
    await db.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_by = $2, cancel_reason = $3, cancelled_at = now(),
              meeting_url = NULL, updated_at = now() WHERE id = $1`, [b.id, user.id, reason || null]);

    const { rows: [pay] } = await db.query(
      `SELECT * FROM payments WHERE booking_id = $1 AND status = 'captured' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [b.id]);
    let refund = null;
    if (pay) {
      const amount = refundAmount(b, role);
      const { refundId } = await paymentProvider(pay.provider).refund({ paymentId: pay.provider_payment_id, amountPaise: amount });
      await db.query(`UPDATE payments SET status = 'refunded', refunded_paise = $2, provider_refund_id = $3, updated_at = now()
                       WHERE id = $1`, [pay.id, amount, refundId]);
      refund = { amount_paise: amount, full: amount === b.total_paise };
    }
    // Close any unpaid orders.
    await db.query(`UPDATE payments SET status = 'failed', failure_reason = 'booking_cancelled', updated_at = now()
                     WHERE booking_id = $1 AND status = 'created'`, [b.id]);
    await audit(db, user.id, 'booking.cancelled', 'booking', b.id, { role, reason, refund });
    return { refund };
  });
  return { booking: await getBookingFor(user, bookingId), ...result };
}

export async function completeBooking(user, bookingId) {
  await tx(async (db) => {
    const { rows: [b] } = await db.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bookingId]);
    if (!b || (b.lawyer_id !== user.id && user.role !== 'admin')) throw notFound('Booking not found.');
    if (b.status !== 'confirmed') throw conflict('Only confirmed consultations can be marked complete.', 'not_completable');
    if (new Date(b.starts_at) > new Date()) throw conflict('You can mark it complete once the consultation has started.', 'not_completable');
    await db.query(`UPDATE bookings SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1`, [b.id]);
    await audit(db, user.id, 'booking.completed', 'booking', b.id);
  });
  return getBookingFor(user, bookingId);
}

// ------------------------------------------------------------------------------------------ payments

/**
 * Apply a successful, verified payment. Idempotent. Used by checkout verification and webhooks.
 * Returns { outcome: 'confirmed' | 'already' | 'refunded_slot_taken' | 'refunded_cancelled' }.
 */
export async function applyCapturedPayment(db, payment, providerPaymentId, actorId) {
  if (payment.status === 'captured' || payment.status === 'refunded') return { outcome: 'already' };

  await db.query(`UPDATE payments SET status = 'captured', provider_payment_id = $2, failure_reason = NULL, updated_at = now()
                   WHERE id = $1`, [payment.id, providerPaymentId]);
  const { rows: [b] } = await db.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [payment.booking_id]);

  const refundAll = async (why) => {
    const { refundId } = await paymentProvider(payment.provider).refund({ paymentId: providerPaymentId, amountPaise: payment.amount_paise });
    await db.query(`UPDATE payments SET status = 'refunded', refunded_paise = amount_paise, provider_refund_id = $2,
                           failure_reason = $3, updated_at = now() WHERE id = $1`, [payment.id, refundId, why]);
    await audit(db, actorId, 'payment.auto_refunded', 'payment', payment.id, { why });
  };

  if (b.status === 'confirmed' || b.status === 'completed') {
    // Paid twice for the same booking (e.g. two tabs) — refund the duplicate.
    await refundAll('duplicate_payment');
    return { outcome: 'refunded_duplicate' };
  }
  if (b.status === 'cancelled') { await refundAll('booking_cancelled'); return { outcome: 'refunded_cancelled' }; }

  // pending_payment, or expired but the slot may still be free: try to confirm.
  await db.query('SAVEPOINT confirm_booking');
  try {
    await db.query(`UPDATE bookings SET status = 'confirmed', meeting_url = $2, hold_expires_at = NULL, updated_at = now()
                     WHERE id = $1`, [b.id, meetingUrlFor(b)]);
    await db.query('RELEASE SAVEPOINT confirm_booking');
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT confirm_booking');
    if (err.code !== '23P01') throw err;
    await db.query(`UPDATE bookings SET status = 'expired', updated_at = now() WHERE id = $1`, [b.id]);
    await refundAll('slot_taken_after_hold_expired');
    return { outcome: 'refunded_slot_taken' };
  }
  await audit(db, actorId, 'booking.confirmed', 'booking', b.id, { paymentId: payment.id });
  return { outcome: 'confirmed' };
}

export async function applyFailedPayment(db, payment, reason, actorId) {
  if (payment.status !== 'created') return { outcome: 'already' };
  await db.query(`UPDATE payments SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1`,
    [payment.id, String(reason || 'payment_failed').slice(0, 200)]);
  await audit(db, actorId, 'payment.failed', 'payment', payment.id, { reason });
  return { outcome: 'failed' };   // booking stays on hold so the client can retry until the hold expires
}
