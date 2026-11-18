import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { query, tx } from '../db/pool.js';
import { ah, badRequest, notFound } from '../lib/errors.js';
import { requireRole } from '../lib/auth.js';
import * as v from '../lib/validate.js';
import { paymentProvider, mockProvider } from '../providers/payments.js';
import { applyCapturedPayment, applyFailedPayment, getBookingFor } from '../services/bookings.js';

const r = Router();

async function lockPaymentForClient(db, user, orderId) {
  const { rows: [p] } = await db.query(
    `SELECT p.* FROM payments p JOIN bookings b ON b.id = p.booking_id
      WHERE p.provider_order_id = $1 AND b.client_id = $2 FOR UPDATE OF p`, [orderId, user.id]);
  if (!p) throw notFound('Payment not found.');
  return p;
}

const outcomeMessage = {
  confirmed: 'Payment received. Your consultation is confirmed.',
  already: 'This payment was already processed.',
  refunded_slot_taken: 'Your hold expired and the slot was taken before payment completed. A full refund has been issued.',
  refunded_cancelled: 'This booking was cancelled, so the payment has been refunded in full.',
  refunded_duplicate: 'This booking was already paid for. The duplicate payment has been refunded.',
  failed: 'Payment failed. You can try again while your slot is held.',
};

/** Client-side checkout finished: verify the provider signature and confirm the booking. */
r.post('/verify', requireRole('client'), ah(async (req, res) => {
  const orderId = v.str(req.body?.orderId, 'orderId', { max: 100 });
  const paymentId = v.str(req.body?.paymentId, 'paymentId', { max: 100 });
  const signature = v.str(req.body?.signature, 'signature', { max: 200 });

  const result = await tx(async (db) => {
    const payment = await lockPaymentForClient(db, req.user, orderId);
    if (!paymentProvider(payment.provider).verifyCheckout({ orderId, paymentId, signature })) {
      throw badRequest('Payment could not be verified.', { code: 'bad_signature' });
    }
    return { bookingId: payment.booking_id, ...(await applyCapturedPayment(db, payment, paymentId, req.user.id)) };
  });
  res.json({ outcome: result.outcome, message: outcomeMessage[result.outcome], booking: await getBookingFor(req.user, result.bookingId) });
}));

/** Client reports a failed/dismissed checkout. */
r.post('/failed', requireRole('client'), ah(async (req, res) => {
  const orderId = v.str(req.body?.orderId, 'orderId', { max: 100 });
  const reason = v.str(req.body?.reason, 'reason', { max: 200, optional: true }) || 'checkout_failed';
  const result = await tx(async (db) => {
    const payment = await lockPaymentForClient(db, req.user, orderId);
    return { bookingId: payment.booking_id, ...(await applyFailedPayment(db, payment, reason, req.user.id)) };
  });
  res.json({ outcome: result.outcome, message: outcomeMessage[result.outcome], booking: await getBookingFor(req.user, result.bookingId) });
}));

/**
 * Development only (PAYMENT_PROVIDER=mock): stands in for the payment gateway's hosted checkout.
 * Produces the same signed result a real gateway would, which the browser then sends to /verify.
 */
r.post('/mock/checkout', requireRole('client'), ah(async (req, res) => {
  if (config.payments.provider !== 'mock' || (config.isProd && !config.demoMode)) throw notFound();
  const orderId = v.str(req.body?.orderId, 'orderId', { max: 100 });
  const outcome = v.oneOf(req.body?.outcome, 'outcome', ['success', 'failure']);
  await tx((db) => lockPaymentForClient(db, req.user, orderId));   // ownership check
  if (outcome === 'failure') return res.json({ status: 'failed', reason: 'Card declined (simulated)' });
  const paymentId = `mock_pay_${crypto.randomBytes(8).toString('hex')}`;
  res.json({ status: 'success', orderId, paymentId, signature: mockProvider.sign(orderId, paymentId) });
}));

/**
 * Razorpay webhook — the source of truth if the browser closes mid-payment.
 * Mounted with express.raw() in app.js so the signature is checked over the exact bytes received.
 */
export const razorpayWebhook = ah(async (req, res) => {
  const raw = req.body instanceof Buffer ? req.body.toString('utf8') : '';
  const provider = paymentProvider('razorpay');
  if (!provider.verifyWebhook(raw, req.get('x-razorpay-signature'))) {
    return res.status(400).json({ error: { code: 'bad_signature', message: 'Invalid webhook signature.' } });
  }
  const event = JSON.parse(raw);
  const eventId = req.get('x-razorpay-event-id') || crypto.createHash('sha256').update(raw).digest('hex');
  const entity = event?.payload?.payment?.entity;

  await tx(async (db) => {
    const fresh = await db.query(
      `INSERT INTO payment_events (provider, event_id, event_type, payload) VALUES ('razorpay', $1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING id`, [eventId, event.event || 'unknown', event]);
    if (!fresh.rowCount || !entity?.order_id) return;   // duplicate delivery or irrelevant event

    const { rows: [payment] } = await db.query(
      `SELECT * FROM payments WHERE provider = 'razorpay' AND provider_order_id = $1 FOR UPDATE`, [entity.order_id]);
    if (!payment) return;
    if (event.event === 'payment.captured' || event.event === 'order.paid') {
      await applyCapturedPayment(db, payment, entity.id, null);
    } else if (event.event === 'payment.failed') {
      await applyFailedPayment(db, payment, entity.error_description || 'payment_failed', null);
    }
  });
  res.json({ ok: true });
});

export default r;
